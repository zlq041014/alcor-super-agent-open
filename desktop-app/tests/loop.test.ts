import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Hub } from "../src/hub/service";
import { DshWork, MissingDshReceipt } from "../src/hub/dsh-work";
import { entity } from "../src/hub/store";
import {
  defaults,
  type Command,
  type Run,
  type Settings,
  type Task,
} from "../src/shared/contracts";
import type { CheckRun, Loop, LoopView, NativeLoopNode } from "../src/shared/loop-contracts";
import { workspaceMcp } from "../src/adapter/dsh-files";

class FakeDsh extends DshWork {
  prompts: string[] = [];
  answers: string[] = [];
  scripts: ((
    run: Run,
    text: string,
  ) => Promise<"completed" | "failed" | "interrupted">)[] = [];
  last?: Run;
  failure?: Error;
  constructor(private fixtureHub: Hub) {
    super(fixtureHub);
  }
  override async probe() {
    return { status: "ACP 就绪", version: "fixture" };
  }
  override async start(
    task: Task,
    run: Run,
    command: Command,
    _cfg: Settings,
    text: string,
  ) {
    const hub = this.fixtureHub;
    this.prompts.push(text);
    this.last = run;
    run.threadId = "fixture:" + run.id;
    run.turnId = command.id;
    hub.store.put("run", run);
    hub.store.put("command", { ...command, state: "accepted" });
    const send = (method: string, params: object) =>
      hub.handleEvent(
        {
          method,
          params: { threadId: run.threadId, turnId: run.turnId, ...params },
        },
        "dsh",
      );
    const play = this.scripts.shift();
    setImmediate(() => {
      void (async () => {
        await send("turn/started", {});
        if (!play) return;
        const status = await play(run, text);
        await send("item/completed", {
          item: {
            id: run.id + ":answer",
            type: "agentMessage",
            text: this.answers.shift() || "已完成。",
          },
        });
        await send("turn/completed", { turn: { id: run.turnId, status } });
      })().catch((e) => {
        this.failure = e;
      });
    });
  }
  override cancel() {}
}
const file = (name: string, contains = "ok") => ({
  kind: "file",
  name,
  path: name + ".txt",
  contains,
});
const criterion = (name: string) => ({
  title: name,
  method: "file",
  checks: [name],
});
async function fixture(
  t: TestContext,
  budget: Partial<Settings["loopBudget"]> = {},
) {
  const base = resolve(".test-data/loop");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "fixture-"));
  const root = join(dir, "project"),
    data = join(dir, "data");
  await mkdir(root);
  let hub = new Hub(data),
    fake = new FakeDsh(hub);
  hub.dsh = fake;
  await hub.request({
    op: "settings",
    value: {
      ...defaults,
      executorBackend: "codex",
      checkPath: [dirname(process.execPath)],
      loopBudget: { ...defaults.loopBudget, ...budget },
    },
  });
  const p = await hub.request({
    op: "project.add",
    path: root,
    name: "测试项目",
  });
  const cleanup = async () => {
    hub.shuttingDown = true;
    await hub.loop.shutdown();
    await hub.eventQueue;
    hub.store.close();
  };
  t.after(async () => {
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const restart = async () => {
    await cleanup();
    hub = new Hub(data);
    fake = new FakeDsh(hub);
    hub.dsh = fake;
  };
  const fault = { value: "" };
  const listen = () =>
    hub.on("fault", (message) => {
      fault.value = message;
    });
  listen();
  const wait = async (fn: () => boolean, timeoutMs = 12500) => {
    const until = Date.now() + timeoutMs;
    do {
      if (fake.failure) throw fake.failure;
      if (fault.value) throw Error(fault.value);
      if (fn()) return;
      await hub.tick();
      await delay(15);
    } while (Date.now() < until);
    assert.fail(
      "未等到指定状态：" +
        JSON.stringify(hub.store.all("task").map((x) => [x.state, x.reason])),
    );
  };
  const create = (
    criteria: object[],
    loopChecks: object[],
    extra: object = {},
    requestId = "fixture",
  ) =>
    hub.request({
      op: "task.create",
      requestId,
      value: {
        projectId: p.id,
        goal: "完成夹具任务",
        advance: "loop",
        mode: "write",
        criteria,
        loopChecks,
        ...extra,
      },
    });
  return {
    get hub() {
      return hub;
    },
    get fake() {
      return fake;
    },
    dir,
    root,
    wait,
    create,
    task: (id: string) => hub.getTask(id),
    view: (id: string): LoopView => hub.loop.view(hub.getTask(id)),
    control: (id: string, action: string) =>
      hub.request({
        op: "task.control",
        id,
        action,
        revision: hub.getTask(id).revision,
      }),
    restart: async () => {
      await restart();
      listen();
    },
  };
}

test("原生循环直接执行，独立复核的自然语言交回执行并可收口", async (t) => {
  const f = await fixture(t, { executorRuns: 4 });
  f.hub.brain.complete = async () => { throw new Error("不应调用无工具角色"); };
  f.fake.answers.push("已写出首页", "交互反馈需要补做。", "已补做交互", "实际检查了页内交互。\n**建议收口。**");
  f.fake.scripts.push(
    async () => "completed",
    async (run, text) => {
      assert.equal(run.loopRole, "reviewer");
      assert.match(text, /已写出首页/);
      return "completed";
    },
    async (run, text) => {
      assert.equal(run.loopRole, undefined);
      assert.match(text, /交互反馈需要补做/);
      return "completed";
    },
    async () => "completed",
  );
  const { id } = await f.create([], [], { advance: "loop-native" });
  assert.equal(f.view(id).loop.phase, "advancing");
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 4);
  assert.deepEqual(f.hub.store.all("invocation"), []);
  assert.equal(f.view(id).loop.report?.outcome, "completed");
  const { loop } = f.view(id);
  const node = f.hub.store.get<NativeLoopNode>("loop-node", loop.nativePlan!.nodeId)!;
  assert.equal(f.hub.store.get<Loop>("loop", loop.id)?.step, undefined);
  assert.equal(node.step.state, "done");
  const runs = f.hub.store.all<Run>("run");
  assert.equal(new Set(runs.map((run) => run.nativeAttempt?.stepId)).size, 4);
  assert.ok(runs.every((run) => run.nativeAttempt?.nodeId === node.id));
  assert.equal(f.hub.store.all("acceptance")[0].runId, node.step.runId);
  assert.equal(f.hub.store.all("acceptance")[0].nodeId, node.id);
});

test("原生循环在发送前退出，重启回收预占并只发送一次当前步骤", async (t) => {
  const f = await fixture(t, { executorRuns: 2 });
  let prepared: Run | undefined;
  f.fake.start = async (_task, run) => { prepared = run; };
  const { id } = await f.create([], [], { advance: "loop-native" });
  await f.wait(() => !!prepared && !f.hub.scheduling);
  const first = prepared!;
  assert.equal(f.hub.store.get<Command>("command", first.commandId)?.state, "prepared");
  assert.equal(f.view(id).loop.budget.spent.executorRuns, 1);

  await f.restart();
  assert.equal(f.task(id).state, "ready");
  assert.equal(f.hub.store.get<Command>("command", first.commandId)?.state, "voided");
  assert.equal(f.view(id).loop.budget.spent.executorRuns, 0);
  assert.equal(f.view(id).loop.step?.state, "pending");
  await f.restart();
  assert.equal(f.view(id).loop.budget.spent.executorRuns, 0);

  f.fake.answers.push("已完成交付", "实际核对通过。\n建议收口");
  f.fake.scripts.push(async () => "completed", async () => "completed");
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 2);
  const runs = f.hub.store.all<Run>("run").filter((run) => run.id !== first.id);
  assert.equal(runs.find((run) => !run.loopRole)?.nativeAttempt?.stepId, first.nativeAttempt?.stepId);
  assert.equal(f.view(id).loop.report?.usage.executorRuns, 2);
  assert.equal(f.view(id).loop.report?.roleUsage?.reduce((sum, role) => sum + role.calls, 0), 2);
});

test("原生循环在发送后退出，未知回合保留占用，回执只触发一次复核", async (t) => {
  const f = await fixture(t, { executorRuns: 2 });
  const { id } = await f.create([], [], { advance: "loop-native" });
  await f.wait(() => !!f.fake.last && !f.hub.scheduling);
  const sent = f.fake.last!;
  assert.equal(f.hub.store.get<Command>("command", sent.commandId)?.state, "accepted");
  await f.restart();
  assert.equal(f.hub.store.get<Run>("run", sent.id)?.state, "unknown");
  assert.equal(f.view(id).loop.budget.spent.executorRuns, 1);
  await assert.rejects(f.control(id, "resume"), /仍有活动或未知执行/);
  await assert.rejects(f.hub.backup(), /活动或未知执行/);
  let checks = 0;
  f.hub.dsh.reconcile = async (run) => {
    checks++;
    assert.equal(run?.threadId, sent.threadId);
    assert.equal(run?.commandId, sent.commandId);
    throw new MissingDshReceipt();
  };
  await f.wait(() => checks === 1);
  for (const attempts of [2, 3]) {
    const record = f.hub.store.get("run-reconcile", sent.id);
    f.hub.store.put("run-reconcile", { ...record, nextAt: 0 });
    await f.wait(() => checks === attempts);
  }
  await f.wait(() => f.view(id).loop.halt?.reason === "unknown_run");
  assert.equal(f.fake.prompts.length, 0);
  assert.equal(f.view(id).loop.step?.runId, sent.id);

  const terminal = { status: "completed", items: [{ id: "original", type: "agentMessage", text: "原回合完成交付" }] };
  f.hub.dsh.reconcile = async (run) => {
    await f.hub.finishRun(run!, terminal);
    await f.hub.finishRun(run!, terminal);
  };
  f.fake.answers.push("已独立核对。\n建议收口");
  f.fake.scripts.push(async (run, prompt) => {
    assert.equal(run.loopRole, "reviewer");
    assert.match(prompt, /原回合完成交付/);
    return "completed";
  });
  await f.control(id, "reconcile");
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(f.hub.store.all<Run>("run").length, 2);
  assert.equal(f.view(id).loop.report?.usage.executorRuns, 2);
});

test("v3 旧原生循环重开后仍从原步骤推进", async (t) => {
  const f = await fixture(t, { executorRuns: 2 });
  f.hub.scheduling = true;
  const { id } = await f.create([], [], { advance: "loop-native" });
  const { nativePlan, ...legacy } = f.view(id).loop;
  f.hub.store.tx(() => {
    f.hub.store.remove("loop-node", nativePlan!.nodeId);
    f.hub.store.put("loop", legacy);
    f.hub.store.db.exec("PRAGMA user_version=3");
  });
  await f.restart();
  assert.equal(f.view(id).loop.nativePlan, undefined);
  assert.deepEqual(f.view(id).loop.step, legacy.step);
  f.fake.answers.push("已交付", "实际检查通过。\n建议收口");
  f.fake.scripts.push(async () => "completed", async () => "completed");
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 2);
  assert.deepEqual(f.hub.store.all("loop-node"), []);
});

test("恢复 v4 备份保留成果节点，但不自动启动待运行的循环", async (t) => {
  const f = await fixture(t);
  f.hub.scheduling = true;
  const { id } = await f.create([], [], { advance: "loop-native" });
  f.hub.scheduling = false;
  const before = f.view(id).loop;
  const { path } = await f.hub.backup();
  assert.equal(await f.hub.restore(path), true);
  assert.equal(f.task(id).state, "paused");
  assert.equal(f.view(id).loop.halt?.reason, "restored");
  assert.deepEqual(f.view(id).loop.nativePlan, before.nativePlan);
  assert.deepEqual(f.view(id).loop.step, before.step);
  await f.hub.tick();
  assert.equal(f.fake.prompts.length, 0);
});

test("改进只派发有证据、有授权的发现，并报告无效、反驳和越界项", async (t) => {
  const f = await fixture(t, {
    improveRounds: 1,
    comparisonsPerRound: 2,
    roleCalls: 30,
  });
  const blank = "function exportLabel() {}",
    complete = "function exportLabel() { return '可用正文'; }",
    actualText = "const reportTitle = '当前任务的报告';";
  const initial = [blank, actualText].join("\n");
  await writeFile(join(f.root, "label.mjs"), initial);
  await writeFile(join(f.root, "gate.txt"), "ok");
  f.hub.brain.configured = async () => true;
  const model = "fixture";
  let lensCalls = 0,
    rankingCalls = 0;
  const makeFinding = (title: string, quote = blank, path = "label.mjs") => ({
    title,
    claim: title,
    impact: "对验收结果有影响",
    evidence: [{ path, quote }],
    severity: "major",
  });
  const real = "修复导出正文";
  f.hub.brain.complete = async (_cfg, messages, instructions) => {
    const input = JSON.parse(messages);
    let output: object;
    if (instructions.includes("视角评审者")) {
      lensCalls++;
      const findings = instructions.includes("只从「完整性」")
        ? [
            makeFinding(real),
            makeFinding("伪造不存在的文件", blank, "invented.mjs"),
          ]
        : instructions.includes("只从「目标符合」")
          ? [makeFinding("导出正文仍为空")]
          : instructions.includes("只从「一致性」")
            ? [
                makeFinding("改名无关标题", actualText),
                makeFinding("加新报表", actualText),
              ]
            : instructions.includes("只从「正确性与边界」")
              ? [
                  makeFinding("标题不存在", actualText),
                  makeFinding("需要上游环境", actualText),
                ]
              : [];
      if (instructions.includes("只从「完整性」"))
        assert.ok(input.signals.some((signal: any) => signal.kind === "empty"));
      output = { findings };
    } else if (instructions.includes("同组内")) {
      const duplicate = input.candidates
        .flat()
        .filter((item: any) => [real, "导出正文仍为空"].includes(item.title));
      assert.equal(duplicate.length, 2);
      output = { groups: [duplicate.map((item: any) => item.id)] };
    } else if (instructions.includes("反驳者")) {
      output =
        input.finding.title === "标题不存在"
          ? {
              verdict: "refuted",
              reason: "标题已存在",
              evidence: [{ path: "label.mjs", quote: actualText }],
            }
          : input.finding.title === "需要上游环境"
            ? { verdict: "uncertain", reason: "不能确认环境", evidence: [] }
            : { verdict: "holds", reason: "存在该行为", evidence: [] };
    } else if (instructions.includes("排序者")) {
      rankingCalls++;
      output = { higher: "A", reason: "两次比较故意不一致" };
    } else if (instructions.includes("判断是否允许修改")) {
      const belongs = [real, "导出正文仍为空"].includes(input.finding.title);
      output = {
        scope: "in-goal",
        criterionIndex: null,
        sourceQuote: belongs ? real : "用户没有说过的话",
        reason: belongs ? "本次目标内" : "无授权",
      };
    } else {
      assert.match(instructions, /逐项核对/);
      const passed = input.materials.some((m: any) =>
        m.content.includes(complete),
      );
      output = {
        verdict: passed ? "pass" : "fail",
        points: input.points.map((point: string) => ({
          point,
          met: passed,
          evidence: passed ? { path: "label.mjs", quote: complete } : null,
          note: "",
        })),
      };
    }
    return { text: JSON.stringify(output), model, usage: null };
  };
  f.fake.scripts.push(async (_run, prompt) => {
    assert.match(prompt, /修复导出正文|导出正文仍为空/);
    assert.doesNotMatch(prompt, /改名无关标题|加新报表|伪造不存在的文件/);
    await writeFile(
      join(f.root, "label.mjs"),
      initial.replace(blank, complete),
    );
    return "completed";
  });
  const { id } = await f.create([criterion("gate")], [file("gate")], {
    advance: "loop-improve",
    goal: "修复导出正文，只修改 label.mjs",
  });
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.loop.mode, "loop-improve");
  assert.equal(view.loop.reviewedRounds, 1);
  assert.equal(lensCalls, 6);
  assert.equal(rankingCalls, 4);
  assert.equal(view.findings.filter((x) => x.status === "fixed").length, 1);
  assert.equal(view.findings.filter((x) => x.status === "duplicate").length, 1);
  assert.equal(view.findings.filter((x) => x.status === "refuted").length, 1);
  assert.equal(
    view.findings.filter((x) => x.status === "unverified").length,
    1,
  );
  assert.equal(
    view.findings.filter((x) => x.status === "invalid_evidence").length,
    1,
  );
  assert.equal(
    view.findings.filter((x) => x.scope === "beyond-goal").length,
    2,
  );
  assert.equal(view.loop.report?.deferredFindings.length, 3);
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(f.hub.launches.pending().length, 0);
  assert.equal(f.hub.store.all("approval").length, 0);
});

test("分诊重开不会放宽原有程序检查", async (t) => {
  const f = await fixture(t, { improveRounds: 1, roleCalls: 25 });
  const before = "export function formatLabel() {}";
  const after = "export function formatLabel() { return 'label'; }";
  await writeFile(join(f.root, "label.mjs"), before);
  await writeFile(join(f.root, "gate.txt"), "ok");
  f.hub.brain.configured = async () => true;
  f.hub.verification.available = async () => true;
  f.hub.brain.complete = async (_cfg, prompt, system) => {
    const input = JSON.parse(prompt);
    let output;
    if (system.includes("视角评审者")) {
      output = {
        findings: system.includes("「完整性」")
          ? [
              {
                title: "标签函数没有返回内容",
                claim: "输出正文是空实现",
                severity: "major",
                impact: "用户看不到正文",
                evidence: [
                  { path: "label.mjs", quote: before },
                  { criterion: 0 },
                ],
              },
            ]
          : [],
      };
    } else if (system.includes("反驳者")) {
      output = { verdict: "holds", reason: "已核对", evidence: [] };
    } else if (system.includes("判断是否允许修改")) {
      output = {
        scope: "reopen",
        criterionIndex: 0,
        sourceQuote: "修复标签正文",
        reason: "同一个交付",
      };
    } else {
      assert.match(system, /逐项核对/);
      output = {
        verdict: "pass",
        points: input.points.map((point: string) => ({
          point,
          met: true,
          evidence: { path: "label.mjs", quote: after },
          note: "",
        })),
      };
    }
    return { text: JSON.stringify(output), model: "fixture", usage: null };
  };
  f.fake.scripts.push(
    async () => {
      await writeFile(join(f.root, "label.mjs"), after);
      await writeFile(join(f.root, "gate.txt"), "regressed");
      return "completed";
    },
    async (_run, prompt) => {
      assert.match(prompt, /检查未通过：gate/);
      await writeFile(join(f.root, "gate.txt"), "ok");
      return "completed";
    },
  );
  const { id } = await f.create([criterion("gate")], [file("gate")], {
    advance: "loop-improve",
    goal: "修复标签正文",
  });
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.criteria.length, 1);
  assert.equal(view.findings[0].scope, "reopen");
  assert.equal(view.findings[0].status, "fixed");
  assert.ok(view.criteria[0].passed?.checkRunIds.length);
  assert.equal(f.fake.prompts.length, 2);
});

test("直接创建 DSH 循环；失败输出回灌，回合额度用尽仍能验证成功", async (t) => {
  const f = await fixture(t, { executorRuns: 2 });
  f.fake.scripts.push(
    async () => "completed",
    async () => {
      await writeFile(join(f.root, "result.txt"), "ok");
      return "completed";
    },
  );
  const checks = [
    file("result"),
    { kind: "command", name: "missing", program: "alcor-check-nonexisting" },
  ];
  const { id } = await f.create([criterion("result")], checks);
  assert.equal(f.task(id).backend, "dsh");
  assert.equal(f.hub.launches.pending().length, 0);
  assert.equal((await f.create([criterion("result")], checks)).id, id);
  await f.wait(() => f.task(id).state === "done");
  const v = f.view(id);
  assert.deepEqual(
    v.criteria.map((c) => c.status),
    ["passed"],
  );
  assert.equal(v.criteria[0].attempts, 2);
  assert.equal(v.loop.report?.outcome, "completed");
  assert.deepEqual(v.checks.map((c) => c.baseline).sort(), [
    "failed",
    "unavailable",
  ]);
  assert.equal(
    v.checkRuns.filter(
      (x) => x.checkId === v.checks.find((x) => x.input.name === "missing")?.id,
    ).length,
    1,
  );
  assert.match(f.fake.prompts[1], /文件不存在/);
  assert.equal(f.hub.store.all("acceptance").at(-1)?.method, "loop-contract");
  assert.deepEqual(f.hub.store.all("approval"), []);
  assert.equal(
    f.hub.store.all("message").filter((m) => m.id.startsWith("loop-result:"))
      .length,
    1,
  );
});

test("清单满时回归阻塞能提交，并仅领取一次已落盘的系统通知", async (t) => {
  const f = await fixture(t, { criteria: 1 });
  await f.hub.request({ op: "settings", value: { ...f.hub.settings(), notifications: true } });
  await writeFile(join(f.root, "existing.txt"), "保持可用");
  f.fake.scripts.push(async () => {
    await writeFile(join(f.root, "result.txt"), "ok");
    await writeFile(join(f.root, "existing.txt"), "引入回归");
    return "completed";
  });
  const notices: Parameters<Hub["claimResultNotice"]>[0][] = [];
  f.hub.on("result", (notice) => notices.push(notice));
  const { id } = await f.create([criterion("result")], [file("result"), file("existing", "保持可用")]);
  await f.wait(() => f.view(id).loop.phase === "halted");
  assert.match(f.view(id).loop.halt?.detail ?? "", /清单条目上限/);
  assert.equal(f.task(id).state, "blocked");
  assert.equal(notices.length, 1);
  assert.equal(f.hub.claimResultNotice({ ...notices[0], loopEvent: "not-committed" }), undefined);
  assert.deepEqual(f.hub.claimResultNotice(notices[0]), { title: f.task(id).title });
  assert.equal(f.hub.claimResultNotice(notices[0]), undefined);
  assert.equal(f.task(id).unread, true);
});

test("基线已通过的条目能不派发执行；无法自行评审的必需项不会假通过", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "ready.txt"), "ok");
  const { id } = await f.create([criterion("ready")], [file("ready")]);
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 0);
  assert.equal(f.view(id).loop.report?.preexistingPasses.length, 1);
  const other = await f.create(
    [{ title: "可访问性", method: "judge" }],
    [],
    {},
    "judge",
  );
  await f.wait(() => f.task(other.id).state === "blocked");
  assert.match(f.view(other.id).loop.report!.blockedRequired[0].reason, /评审/);
  await assert.rejects(f.create([], [], { mode: "read" }, "read"), /只读/);
});

test("工作区回归撤销通过记录，并优先修复回归", async (t) => {
  const f = await fixture(t);
  f.fake.scripts.push(
    async () => {
      await writeFile(join(f.root, "a.txt"), "ok");
      return "completed";
    },
    async () => {
      await writeFile(join(f.root, "a.txt"), "regressed");
      await writeFile(join(f.root, "b.txt"), "ok");
      return "completed";
    },
    async (_run, text) => {
      assert.match(text, /"title": "a"/);
      assert.match(text, /检查未通过：a/);
      await writeFile(join(f.root, "a.txt"), "ok");
      return "completed";
    },
    async () => "completed",
  );
  const { id } = await f.create(
    [criterion("a"), criterion("b")],
    [file("a"), file("b")],
  );
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 4);
  assert.ok(
    f
      .view(id)
      .checkRuns.some(
        (x) => x.purpose === "regression" && x.outcome === "failed",
      ),
  );
  assert.equal(
    f.view(id).criteria.filter((x) => x.status === "passed").length,
    2,
  );
});

test("重试用尽仍处理后续条目；三个连续受阻停止，不要求确认", async (t) => {
  const f = await fixture(t, { retries: 0 });
  f.fake.scripts.push(
    ...Array.from({ length: 3 }, () => async () => "completed" as const),
  );
  const names = ["a", "b", "c", "d"];
  const { id } = await f.create(
    names.map(criterion),
    names.map((name) => file(name)),
  );
  await f.wait(() => f.view(id).loop.phase === "halted");
  assert.equal(f.view(id).loop.halt?.reason, "no_progress");
  assert.equal(f.fake.prompts.length, 3);
  assert.deepEqual(
    f.view(id).criteria.map((c) => c.status),
    ["blocked", "blocked", "blocked", "pending"],
  );
});

test("诊断保留失败差异和检查依据，只回退在途改动，再用新会话重试", async (t) => {
  const f = await fixture(t, { retries: 0, executorRuns: 2 });
  const p = join(f.root, "answer.txt"), previous = "原目录既有内容\n";
  await writeFile(p, previous);
  f.hub.verification.available = async () => true;
  f.hub.verification.review = async () => ({ action: "program", detail: "测试程序证据" });
  let diagnosed = 0;
  f.hub.brain.complete = async (_settings, messages, system) => {
    assert.match(String(system), /诊断者/);
    const data = JSON.parse(messages);
    assert.equal(await readFile(p, "utf8"), previous);
    assert.ok(data.materials.some((x: any) => x.kind === "diff" && x.content.includes("一次偏离的改动")));
    assert.ok(data.materials.some((x: any) => x.kind === "check-output"));
    diagnosed++;
    return {
      text: JSON.stringify({
        causes: ["该次保存没有满足文件检查。"],
        approaches: [
          { title: "追加验收标记", plan: "先保留既有内容，再增加约定标记。" },
          { title: "按行定位", plan: "读取目标行，使用既有行内容确认位置。" },
        ],
      }),
      model: "fixture", usage: { total_tokens: 77 },
    };
  };
  const write = async (run: Run, text: string, fresh: boolean) => {
    const options = f.hub.loop.writerOptions(f.task(run.taskId), run);
    assert.equal(options.fresh, fresh);
    const tool = workspaceMcp(run.workPath, { write: true, ...options });
    const out = await tool({ jsonrpc: "2.0", id: "fixture", method: "tools/call", params: {
      name: "edit_file", arguments: { path: "answer.txt", old_text: previous, new_text: text },
    } });
    assert.ok("result" in out && "isError" in out.result && !out.result.isError);
    return "completed" as const;
  };
  f.fake.scripts.push(
    (run) => write(run, "一次偏离的改动\n", false),
    async (run, prompt) => {
      assert.equal(await readFile(p, "utf8"), previous);
      assert.match(prompt, /追加验收标记/);
      assert.doesNotMatch(prompt, /按行定位/);
      return write(run, previous + "新验收标记\n", true);
    },
  );
  const { id } = await f.create([criterion("answer")], [file("answer", "新验收标记")]);
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  const row = view.criteria[0];
  assert.equal(diagnosed, 1);
  assert.equal(view.loop.budget.spent.executorRuns, 2);
  assert.equal(view.loop.budget.spent.roleCalls, 1);
  assert.equal(row.escalation?.stage, "attempted");
  assert.equal(row.escalation?.diagnosis?.approaches.length, 2);
  assert.ok(row.escalation?.invocationId);
  assert.equal(await readFile(p, "utf8"), previous + "新验收标记\n");
  const runs = f.hub.store.all<Run>("run").filter((r) => r.taskId === id);
  assert.equal(new Set(runs.map((r) => r.threadId)).size, 2);
});

test("诊断请求跨清单修订结束时，旧思路不会派发给替换后的条目", async (t) => {
  const f = await fixture(t, { retries: 0, executorRuns: 2 });
  f.hub.verification.available = async () => true;
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  f.hub.brain.complete = async () => {
    ready();
    await delayed;
    return {
      text: JSON.stringify({
        causes: ["旧执行未实现要求"],
        approaches: [
          { title: "旧思路甲", plan: "旧条目处理路径甲" },
          { title: "旧思路乙", plan: "旧条目处理路径乙" },
        ],
      }),
      usage: null, model: "fixture",
    };
  };
  f.fake.scripts.push(async () => "completed");
  const { id } = await f.create([criterion("answer")], [file("answer")]);
  await f.wait(() => f.view(id).loop.step?.kind === "diagnose");
  await started;
  try {
    const view = f.view(id);
    await f.hub.request({
      op: "loop.revise", id, revision: view.loop.contractRevision,
      changes: [{ action: "waive", id: view.criteria[0].id }],
    });
  } finally {
    finish();
  }
  await f.wait(() => f.view(id).loop.phase === "closed");
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(f.view(id).criteria[0].escalation, undefined);
  assert.ok(!f.hub.store.all("invocation").some((i) => i.role === "diagnoser" && i.status === "completed"));
});

test("并行候选各用自己的源码与依赖，只整合检查通过且改动较小的版本", async (t) => {
  const f = await fixture(t, { retries: 0, executorRuns: 4, candidates: 2 });
  const git = (...args: string[]) => promisify(execFile)("D:/dev/git/cmd/git.exe", args, { cwd: f.root, windowsHide: true, timeout: 15000 });
  await git("init", "--quiet");
  await writeFile(join(f.root, ".gitignore"), "node_modules/\n");
  await writeFile(join(f.root, "seed.txt"), "初始工作\n");
  await git("add", "--", ".gitignore", "seed.txt");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  await writeFile(join(f.root, "seed.txt"), "用户暂存\n");
  await git("add", "--", "seed.txt");
  await writeFile(join(f.root, "seed.txt"), "用户在途改动\n");
  const staging = (await git("diff", "--cached", "--binary")).stdout;
  await mkdir(join(f.root, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(f.root, "node_modules", "fixture", "main.js"), "module.exports = '独立依赖';\n");
  f.hub.verification.available = async () => true;
  f.hub.verification.review = async () => ({ action: "program", detail: "测试程序证据" });
  f.hub.brain.complete = async () => ({ model: "fixture", usage: null, text: JSON.stringify({
    causes: ["上一回合没有交付正确文件"],
    approaches: [{ title: "直接交付", plan: "只写约定的文件" }, { title: "另一路径", plan: "增加说明，并写交付文件" }],
  }) });
  f.fake.scripts.push(async () => "completed", async () => "completed");
  const paths: string[] = [];
  let both!: () => void;
  const together = new Promise<void>((resolve) => { both = resolve; });
  f.hub.candidateWriter.write = async (_loop, _task, _criterion, row, work, approach) => {
    paths.push(work);
    if (paths.length === 2) both();
    await together;
    assert.notEqual(paths[0], paths[1]);
    assert.equal(await readFile(join(work, "seed.txt"), "utf8"), "用户在途改动\n");
    assert.match(await readFile(join(work, "node_modules", "fixture", "main.js"), "utf8"), /独立依赖/);
    assert.notEqual(work, f.root);
    await assert.rejects(readFile(join(work, ".git", "HEAD")), /ENOENT/);
    await assert.rejects(readFile(join(f.root, "answer.txt")), /ENOENT/);
    await writeFile(join(work, "answer.txt"), "ok\n");
    const touched = new Set(["answer.txt"]);
    if (approach.title === "另一路径") {
      await writeFile(join(work, "extra.txt"), "多余行一\n多余行二\n");
      touched.add("extra.txt");
    }
    return { reason: "end_turn", accepted: true, threadId: row.id, touched, error: "" };
  };
  const { id } = await f.create([criterion("answer")], [file("answer")]);
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.loop.budget.spent.executorRuns, 4);
  assert.deepEqual(view.candidates.map((r) => [r.approach, r.status]).sort(), [["另一路径", "discarded"], ["直接交付", "selected"]]);
  assert.match(view.candidates.find((r) => r.status === "discarded")!.diff!, /多余行二/);
  assert.equal(await readFile(join(f.root, "answer.txt"), "utf8"), "ok\n");
  assert.equal(await readFile(join(f.root, "seed.txt"), "utf8"), "用户在途改动\n");
  assert.equal((await git("diff", "--cached", "--binary")).stdout, staging);
  await assert.rejects(readFile(join(f.root, "extra.txt")), /ENOENT/);
  for (const path of paths) await assert.rejects(readdir(path), /ENOENT/);
});

for (const completeParent of [true, false]) {
  test(completeParent ? "拆分后按依赖完成各子条目，再实测父条目" : "子条目通过也不会替代父条目的原有检查", async (t) => {
    const f = await fixture(t, { retries: 0, executorRuns: 4 });
    f.hub.verification.available = async () => true;
    f.hub.verification.review = async () => ({ action: "program", detail: "测试程序证据" });
    let splitCalls = 0;
    f.hub.brain.complete = async (_cfg, _text, system) => {
      const split = String(system).includes("只拆分父条目");
      if (split) splitCalls++;
      return { model: "fixture", usage: null, text: JSON.stringify(split ? {
        items: [
          { title: "第一部分", detail: "写入 a.txt", checks: ["a"] },
          { title: "第二部分", detail: "写入 b.txt", checks: ["b"] },
        ],
      } : {
        causes: ["未取得原要求的文件证据"],
        approaches: [{ title: "路径一", plan: "检查目录" }, { title: "路径二", plan: "重读验收" }],
      }) };
    };
    f.fake.scripts.push(
      async () => "completed",
      async () => "completed",
      async (_run, prompt) => {
        assert.match(prompt, /第一部分/);
        await writeFile(join(f.root, "a.txt"), "ok\n");
        return "completed";
      },
      async (_run, prompt) => {
        assert.match(prompt, /第二部分/);
        await writeFile(join(f.root, "b.txt"), "ok\n");
        return "completed";
      },
    );
    const { id } = await f.create([
      { title: "保留的原要求", method: "file", checks: completeParent ? ["a", "b"] : ["final"] },
    ], [file("a"), file("b"), ...completeParent ? [] : [file("final")]]);
    await f.wait(() => ["closed", "halted"].includes(f.view(id).loop.phase));
    const view = f.view(id), parent = view.criteria[0], children = view.criteria.slice(1);
    assert.equal(splitCalls, 1);
    assert.equal(f.fake.prompts.length, 4);
    assert.deepEqual(children.map((c) => [c.splitFrom, c.status]), [[parent.id, "passed"], [parent.id, "passed"]]);
    assert.deepEqual(parent.dependsOn, children.map((c) => c.id));
    assert.equal(parent.status, completeParent ? "passed" : "blocked");
    assert.equal(view.loop.report?.outcome, completeParent ? "completed" : "halted");
    if (!completeParent) assert.match(parent.blockedReason!, /原条目的检查仍失败/);
    await f.hub.request({ op: "loop.revise", id, revision: view.loop.contractRevision,
      changes: [{ action: "waive", id: parent.id }] });
    const revised = f.view(id).criteria;
    assert.deepEqual(revised.map((c) => c.status), ["waived", "waived", "waived"]);
    assert.deepEqual(revised[0].dependsOn, []);
  });
}

test("只有已配置的顾问会另行诊断，用量单列并保存实际模型", async (t) => {
  const f = await fixture(t, { retries: 0, executorRuns: 3 });
  await f.hub.request({ op: "settings", value: { ...f.hub.settings(), advisorModel: "fixture-advisor", memberEffort: "high" } });
  f.hub.verification.available = async () => true;
  f.hub.verification.review = async () => ({ action: "program", detail: "测试程序证据" });
  let advised = 0;
  f.hub.brain.complete = async (settings, _payload, system) => {
    const advisor = String(system).includes("中的顾问");
    if (advisor) {
      assert.equal(settings.model, "fixture-advisor");
      assert.equal(settings.reasoningEffort, "high");
      advised++;
    } else assert.equal(settings.model, defaults.codexModel);
    return { model: advisor ? "actual-advisor" : "fixture", usage: { total_tokens: advisor ? 70 : 13 }, text: JSON.stringify({
      causes: ["当前交付还没有通过检查"],
      approaches: advisor ? [
        { title: "顾问建议", plan: "重建指定文件并保留原规则" },
        { title: "另一种做法", plan: "按授权提取验收内容" },
      ] : [
        { title: "普通诊断", plan: "核对交付文件名" },
        { title: "备用诊断", plan: "核对真实检查" },
      ],
    }) };
  };
  f.fake.scripts.push(async () => "completed", async () => "completed", async (run, prompt) => {
    assert.equal(f.hub.loop.writerOptions(f.task(run.taskId), run).fresh, true);
    assert.match(prompt, /顾问建议/);
    await writeFile(join(f.root, "answer.txt"), "ok\n");
    return "completed";
  });
  const { id } = await f.create([criterion("answer")], [file("answer")]);
  await f.wait(() => f.task(id).state === "done");
  const { loop, criteria } = f.view(id);
  const escalation = criteria[0].escalation!;
  const invocation = f.hub.store.get("invocation", escalation.advisor!.invocationId);
  assert.equal(advised, 1);
  assert.equal(invocation.role, "advisor");
  assert.equal(invocation.actualModel, "actual-advisor");
  assert.equal(escalation.advisor?.actualModel, "actual-advisor");
  assert.equal(escalation.stage, "advisor-attempted");
  assert.deepEqual(loop.report?.roleUsage?.find((r) => r.role === "advisor"), { role: "advisor", calls: 1, tokensKnown: 70, unknown: 0 });
});

test("预算停止可追加继续；修订只使受影响条目失效", async (t) => {
  const f = await fixture(t, { executorRuns: 1 });
  await writeFile(join(f.root, "a.txt"), "ok");
  f.fake.scripts.push(
    async () => "completed",
    async () => {
      await writeFile(join(f.root, "b.txt"), "different");
      return "completed";
    },
  );
  const { id } = await f.create(
    [criterion("a"), criterion("b")],
    [file("a"), file("b", "different")],
  );
  await f.wait(() => f.view(id).loop.halt?.reason === "budget");
  const [{ id: a }, { id: b }] = f.view(id).criteria;
  await f.hub.request({
    op: "loop.revise",
    id,
    revision: 1,
    changes: [{ action: "reopen", id: b }],
  });
  assert.equal(f.view(id).loop.contractRevision, 2);
  assert.equal(f.view(id).criteria.find((c) => c.id === a)?.status, "passed");
  await assert.rejects(
    f.hub.request({
      op: "loop.revise",
      id,
      revision: 1,
      changes: [{ action: "reopen", id: b }],
    }),
    /清单已更新/,
  );
  await f.wait(() => f.view(id).loop.halt?.reason === "budget");
  await f.hub.request({ op: "loop.budget", id, add: { executorRuns: 1 } });
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.view(id).loop.report?.usage.executorRuns, 2);
});

test("暂停基线检查终止进程，恢复后重新检查，无重复派发", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "probe.cjs"),
    "setTimeout(()=>console.log('passed'),1000);",
  );
  const { id } = await f.create(
    [],
    [{ kind: "command", name: "probe", program: "node", args: ["probe.cjs"] }],
  );
  await f.wait(() =>
    f.view(id).checkRuns.some((r) => r.state === "running" && !!r.pid),
  );
  await f.control(id, "pause");
  await f.wait(() => f.task(id).control === "confirmed");
  assert.equal(f.task(id).state, "paused");
  assert.equal(f.fake.prompts.length, 0);
  await f.control(id, "resume");
  await f.wait(() => f.task(id).state === "done");
  assert.ok(
    f
      .view(id)
      .checkRuns.some(
        (r) => r.purpose === "baseline" && r.outcome === "passed",
      ),
  );
  assert.equal(f.fake.prompts.length, 0);
});

test("完整退出保存仅运行检查的循环的暂停意图，重开不自动继续", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "probe.cjs"),
    "setTimeout(()=>console.log('passed'),30000);",
  );
  const { id } = await f.create(
    [{ title: "本地检查", checks: ["probe"] }],
    [{ kind: "command", name: "probe", program: "node", args: ["probe.cjs"] }],
  );
  await f.wait(() =>
    f.view(id).checkRuns.some((r) => r.state === "running" && !!r.pid),
  );
  await f.hub.shutdown();
  assert.equal(f.task(id).state, "paused");
  assert.equal(f.task(id).control, "confirmed");
  const before = f.view(id).checkRuns.length;
  await f.restart();
  await f.hub.tick();
  assert.equal(f.task(id).state, "paused");
  assert.equal(f.view(id).checkRuns.length, before);
  assert.equal(f.fake.prompts.length, 0);
});

test("重启重新验证检查；已派发而未结束的执行保持未知、不重派", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "ready.txt"), "ok");
  const a = await f.create([criterion("ready")], [file("ready")]);
  await f.hub.loop.shutdown();
  const checked = f.view(a.id);
  if (checked.loop.phase === "closed") {
    await f.hub.request({
      op: "loop.revise",
      id: a.id,
      revision: checked.loop.contractRevision,
      changes: [{ action: "reopen", id: checked.criteria[0].id }],
    });
  }
  const phase = f.view(a.id);
  const stored = {
    ...phase.loop,
    phase: "baseline",
    step: { ...entity(), kind: "baseline", attempt: 0, state: "running" },
  };
  f.hub.store.put("loop", stored);
  f.hub.store.put("check-run", {
    ...entity(),
    loopId: phase.loop.id,
    checkId: phase.checks[0].id,
    state: "running",
    stepId: stored.step.id,
  });
  await f.restart();
  await f.wait(() => f.task(a.id).state === "done");
  assert.ok(
    f.view(a.id).checkRuns.some((r: CheckRun) => r.state === "unknown"),
  );
  const b = await f.create(
    [criterion("not-done")],
    [file("not-done")],
    {},
    "b",
  );
  await f.wait(() => f.fake.prompts.length === 1);
  await f.restart();
  await f.wait(() => f.view(b.id).loop.halt?.reason === "unknown_run");
  assert.equal(f.fake.prompts.length, 0);
  assert.equal(
    f.hub.store.get("run-reconcile", f.task(b.id).runId!)?.attempts,
    3,
  );
});

test("DSH 未知回合延迟取得匹配回执后沿用同一回合验收，不重新派发", async (t) => {
  const f = await fixture(t);
  const { id } = await f.create([criterion("result")], [file("result")]);
  await f.wait(() => {
    const runId = f.task(id).runId;
    return !!runId && f.hub.store.get<Run>("run", runId)?.state === "running";
  });
  const runId = f.task(id).runId!;
  let attempts = 0;
  f.hub.dsh.reconcile = async (run) => {
    assert.equal(run?.id, runId);
    if (++attempts === 1) throw new MissingDshReceipt("暂缺回执");
    await writeFile(join(f.root, "result.txt"), "ok");
    await f.hub.finishRun(run!, {
      status: "completed",
      nativeEndReason: "completed",
    });
  };
  f.hub.markUnknown("dsh", runId);
  await f.wait(() => attempts === 1);
  assert.ok(f.hub.store.all("run").some((r) => r.state === "unknown"));
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(attempts, 2);
  assert.equal(f.hub.store.get("run-reconcile", runId)?.matched, true);
});

test("修改执行中的目标会隔离旧回合；新清单不用手工恢复", async (t) => {
  const f = await fixture(t);
  let endOld!: () => void;
  const release = new Promise<void>((done) => {
    endOld = done;
  });
  f.fake.scripts.push(
    async () => {
      await release;
      return "completed";
    },
    async (_run, prompt) => {
      assert.match(prompt, /新目标/);
      await writeFile(join(f.root, "result.txt"), "ok");
      return "completed";
    },
  );
  const { id } = await f.create([criterion("result")], [file("result")]);
  await f.wait(() => {
    const runId = f.task(id).runId;
    return !!runId && f.hub.store.get<Run>("run", runId)?.state === "running";
  });
  await f.hub.request({
    op: "task.revise",
    id,
    revision: 1,
    goal: "新目标",
    constraints: "",
    acceptance: "",
    checks: [],
  });
  assert.equal(f.view(id).loop.contractRevision, 2);
  assert.equal(f.task(id).control, "pause_requested");
  assert.equal(f.fake.prompts.length, 1);
  endOld();
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 2);
  assert.equal(f.view(id).criteria[0].attempts, 1);
});

async function authorFixture(t: TestContext) {
  const f = await fixture(t);
  await mkdir(join(f.root, "tests"));
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await writeFile(join(f.root, "lib.mjs"), "export const number = 1;\n");
  await writeFile(
    join(f.root, "tests", "existing.test.mjs"),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('existing', () => assert.equal(typeof 1, 'number'));",
    ].join("\n"),
  );
  const proposed = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { number } from '../lib.mjs';",
    "test('验收前返回 2', () => assert.equal(number, 2));",
  ].join("\n");
  return {
    ...f,
    proposed,
    createCheck: () =>
      f.create(
        [
          {
            title: "返回项目契约要求的新值",
            method: "command",
            checks: ["test"],
            needsAuthoredCheck: true,
          },
        ],
        [],
      ),
  };
}

test("编写者只新建隔离测试；旧套件先绿，新断言先红，再受保护交给实现者", async (t) => {
  const f = await authorFixture(t);
  f.hub.checkAuthor.write = async (_dir, work, file) => {
    assert.notEqual(work, f.root);
    assert.equal((await readdir(join(f.root, "tests"))).length, 1);
    const tools = workspaceMcp(work, {
      write: true,
      paths: { protect: [], allowOnly: [file], lockPackageScripts: true },
    });
    const invoke = async (name: string, args: object) => {
      const reply = await tools({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      assert.ok("result" in reply && "isError" in reply.result);
      return reply.result;
    };
    assert.equal(
      (
        await invoke("edit_file", {
          path: "lib.mjs",
          old_text: "1",
          new_text: "2",
        })
      ).isError,
      true,
    );
    assert.equal(
      (await invoke("write_file", { path: file, text: f.proposed })).isError,
      false,
    );
    return { accepted: true, reason: "end_turn", error: "" };
  };
  f.fake.scripts.push(async (_run, context) => {
    assert.match(context, /新增检查在实现前失败/);
    assert.match(context, /"authoredTest": "tests\/alcor-/);
    const { protectedPaths } = f.hub.loop.forTask(
      f.hub.store.all<Task>("task")[0],
    )!;
    assert.ok(protectedPaths.some((x) => x.startsWith("tests/alcor-")));
    await writeFile(join(f.root, "lib.mjs"), "export const number = 2;\n");
    return "completed";
  });
  const { id } = await f.createCheck();
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.criteria[0].author?.attempts, 1);
  assert.equal(view.criteria[0].status, "passed");
  assert.ok(
    view.checkRuns.some(
      (r) => r.purpose === "author-before" && r.outcome === "passed",
    ),
  );
  assert.ok(
    view.checkRuns.some(
      (r) => r.purpose === "author-after" && r.outcome === "failed",
    ),
  );
  assert.equal(view.loop.budget.spent.executorRuns, 2);
});

test("实现已存在且基线及独立证据均通过，跳过原拟编写的新检查", async (t) => {
  const f = await authorFixture(t);
  const proof = "export const number = 2;";
  await writeFile(join(f.root, "lib.mjs"), proof + "\n");
  f.hub.verification.available = async () => true;
  f.hub.checkAuthor.write = async () =>
    assert.fail("不能给已完成的条目派检查编写者");
  f.hub.brain.complete = async (_cfg, messages, system) => {
    assert.match(system, /逐项核对/);
    const input = JSON.parse(messages);
    assert.equal(input.baselineOnly, true);
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: input.points.map((point: string) => ({
          point,
          met: true,
          evidence: { path: "lib.mjs", quote: proof },
          note: "",
        })),
      }),
      model: "fake",
      usage: null,
    };
  };
  const { id } = await f.createCheck();
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.criteria[0].passed?.grade, "program");
  assert.ok(view.criteria[0].passed?.invocationId);
  assert.deepEqual(await readdir(join(f.root, "tests")), ["existing.test.mjs"]);
  assert.equal(view.loop.budget.spent.executorRuns, 0);
  assert.equal(f.fake.prompts.length, 0);
});

test("已经通过的约定检查可引用真实基线回执，无须派执行者重跑", async (t) => {
  const f = await fixture(t);
  const output = "fixture success marker from actual check";
  await writeFile(
    join(f.root, "run.cjs"),
    "console.log(" + JSON.stringify(output) + ")",
  );
  f.hub.verification.available = async () => true;
  f.hub.brain.complete = async (_cfg, messages, system) => {
    assert.match(system, /检查输出已直接证明要点/);
    const input = JSON.parse(messages);
    const check = input.materials.find((m: any) => m.kind === "check-output");
    assert.match(check.content, /fixture success marker/);
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: input.points[0],
            met: true,
            evidence: {
              checkRun: check.id.slice("check:".length),
              excerpt: output,
            },
            note: "",
          },
        ],
      }),
      model: "fake",
      usage: null,
    };
  };
  const { id } = await f.create(
    [{ title: "约定的检查通过", checks: ["proof"] }],
    [{ kind: "command", name: "proof", program: "node", args: ["run.cjs"] }],
  );
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(view.criteria[0].passed?.grade, "program");
  assert.ok(view.criteria[0].passed?.invocationId);
  assert.equal(f.fake.prompts.length, 0);
});

test("始终通过及语法错误的测试不采纳；改写一次后降为评审", async (t) => {
  const f = await authorFixture(t);
  let calls = 0;
  f.hub.checkAuthor.write = async (
    _dir,
    work,
    file,
    _cfg,
    _loop,
    _task,
    _criterion,
    reason,
  ) => {
    if (calls++) assert.match(reason!, /未触发断言失败/);
    await writeFile(
      join(work, file),
      calls === 1 ? "import 'node:test';\n" : "not valid const",
    );
    return { accepted: true, reason: "end_turn", error: "" };
  };
  const { id } = await f.createCheck();
  await f.wait(() => f.view(id).loop.phase === "halted");
  const view = f.view(id);
  assert.equal(calls, 2);
  assert.equal(view.criteria[0].verify.method, "judge");
  assert.equal(view.criteria[0].author?.path, undefined);
  assert.equal(
    await readFile(join(f.root, "lib.mjs"), "utf8"),
    "export const number = 1;\n",
  );
  assert.deepEqual(await readdir(join(f.root, "tests")), ["existing.test.mjs"]);
  assert.equal(f.fake.prompts.length, 0);
});

test("程序检查变绿后，带真实引用的有效性存疑会触发重试", async (t) => {
  const f = await fixture(t);
  f.hub.verification.available = async () => true;
  let reviews = 0;
  const partial = "expected but unfinished implementation";
  f.hub.brain.complete = async (_cfg, messages, system) => {
    assert.match(system, /sound\|suspect/);
    assert.doesNotMatch(messages, /已完成。/);
    const value =
      ++reviews === 1
        ? {
            verdict: "suspect",
            reasons: ["内容仍是占位"],
            evidence: [{ path: "result.txt", quote: partial }],
            concerns: [],
          }
        : { verdict: "sound", reasons: [], evidence: [], concerns: [] };
    return { text: JSON.stringify(value), model: "fake", usage: null };
  };
  f.fake.scripts.push(
    async () => {
      await writeFile(join(f.root, "result.txt"), partial);
      return "completed";
    },
    async (_run, context) => {
      assert.match(context, /独立验证存疑/);
      await writeFile(join(f.root, "result.txt"), "expected verified result");
      return "completed";
    },
  );
  const { id } = await f.create(
    [criterion("result")],
    [file("result", "expected")],
  );
  await f.wait(() => f.task(id).state === "done");
  const c = f.view(id).criteria[0];
  assert.equal(c.attempts, 2);
  assert.equal(reviews, 2);
  assert.ok(c.passed?.invocationId);
  assert.equal(c.passed.grade, "program");
});

test("独立评审逐项核对：捏造引用不通过，真实引用形成独立证据", async (t) => {
  const f = await fixture(t);
  const one = "title appears in the written artifact";
  const two = "footer includes the exact approval label";
  f.hub.verification.available = async () => true;
  let reviews = 0;
  f.hub.brain.complete = async (_cfg, messages) => {
    assert.doesNotMatch(messages, /已完成。/);
    reviews++;
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: "标题可见",
            met: true,
            evidence: { path: "result.txt", quote: one },
            note: "",
          },
          {
            point: "尾注可见",
            met: true,
            evidence: {
              path: "result.txt",
              quote: reviews === 1 ? "a quotation that was invented" : two,
            },
            note: "",
          },
        ],
      }),
      model: "fake",
      usage: null,
    };
  };
  await writeFile(join(f.root, "result.txt"), one);
  f.fake.scripts.push(async (_run, context) => {
    assert.match(context, /尾注可见/);
    await writeFile(join(f.root, "result.txt"), one + "\n" + two);
    return "completed";
  });
  const { id } = await f.create(
    [{ title: "准备两条材料", method: "judge", points: "标题可见\n尾注可见" }],
    [],
  );
  await f.wait(() => f.task(id).state === "done");
  assert.equal(f.fake.prompts.length, 1);
  const view = f.view(id);
  assert.equal(view.criteria[0].passed?.grade, "judged");
  assert.deepEqual(view.loop.report?.judgedOnly, ["准备两条材料"]);
  assert.equal(reviews, 2);
});

test("有文件证据的检查异议只修订同一份已采纳测试，不改原有套件", async (t) => {
  const f = await authorFixture(t);
  f.hub.verification.available = async () => true;
  let authorCalls = 0;
  f.hub.checkAuthor.write = async (
    _dir,
    work,
    file,
    _cfg,
    _loop,
    _task,
    _criterion,
    prior,
  ) => {
    if (++authorCalls === 2) {
      assert.match(prior!, /不应要求 3/);
      assert.match(
        await readFile(join(f.root, file), "utf8"),
        /assert.equal\(number, 3\)/,
      );
    }
    await writeFile(
      join(work, file),
      authorCalls === 1
        ? f.proposed.replace("number, 2", "number, 3")
        : f.proposed,
    );
    return { accepted: true, reason: "end_turn", error: "" };
  };
  f.hub.brain.complete = async (_cfg, messages, system) => {
    const m = JSON.parse(messages);
    if (system.includes("只裁决")) {
      assert.match(m.objection, /不应要求 3/);
      assert.doesNotMatch(messages, /不要泄漏的普通最终自述/);
      const tracked = m.materials.find(
        (c: any) => c.kind === "file" && c.title.includes("alcor-"),
      ).title;
      return {
        text: JSON.stringify({
          fault: "check",
          reason: "不应要求 3",
          evidence: [{ path: tracked, quote: "assert.equal(number, 3)" }],
        }),
        model: "fake",
        usage: null,
      };
    }
    return {
      text: '{"verdict":"sound","reasons":[],"evidence":[],"concerns":[]}',
      model: "fake",
      usage: null,
    };
  };
  f.fake.answers.push("检查异议：目标不应要求 3。\n不要泄漏的普通最终自述");
  f.fake.scripts.push(
    async () => "completed",
    async () => {
      await writeFile(join(f.root, "lib.mjs"), "export const number = 2;\n");
      return "completed";
    },
  );
  const oldTest = await readFile(
    join(f.root, "tests", "existing.test.mjs"),
    "utf8",
  );
  const { id } = await f.createCheck();
  await f.wait(() => f.task(id).state === "done", 32000);
  const c = f.view(id).criteria[0];
  assert.equal(authorCalls, 2);
  assert.equal(c.author?.rewrites, 1);
  assert.match(
    await readFile(join(f.root, c.author!.path!), "utf8"),
    /assert.equal\(number, 2\)/,
  );
  assert.equal(
    await readFile(join(f.root, "tests", "existing.test.mjs"), "utf8"),
    oldTest,
  );
});

test("被策略拒绝的项目脚本从不运行，条目可用独立证据继续", async (t) => {
  const f = await fixture(t);
  const proof = "independent evidence is already present";
  await writeFile(join(f.root, "result.txt"), proof);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { start: "node start.cjs" } }),
  );
  await writeFile(
    join(f.root, "start.cjs"),
    "require('node:fs').writeFileSync('should-not-exist.txt', 'ran');",
  );
  f.hub.verification.available = async () => true;
  f.hub.brain.complete = async (_cfg, _messages, system) => {
    assert.match(system, /逐项核对/);
    return {
      model: "fake",
      usage: null,
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: "已有可核对的结果",
            met: true,
            evidence: { path: "result.txt", quote: proof },
            note: "",
          },
        ],
      }),
    };
  };
  const { id } = await f.create(
    [
      {
        title: "核对结果",
        method: "command",
        points: "已有可核对的结果",
        checks: ["start"],
      },
      criterion("result"),
    ],
    [file("result", proof)],
  );
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  const rejected = view.checks.find((check) => check.input.name === "start")!;
  assert.equal(rejected.status, "rejected");
  assert.equal(view.criteria[0].passed?.grade, "judged");
  assert.equal(view.criteria[1].passed?.grade, "program");
  assert.ok(!view.checkRuns.some((row) => row.checkId === rejected.id));
  await assert.rejects(readFile(join(f.root, "should-not-exist.txt")), {
    code: "ENOENT",
  });
  assert.equal(f.fake.prompts.length, 0);
});

test("执行后程序检查全部不可用时，只用可核对的独立评审证据收口", async (t) => {
  const f = await fixture(t);
  const proof = "the actual result remains available";
  await writeFile(
    join(f.root, "check.cjs"),
    "if (require('node:fs').existsSync('dependency-down.flag')) { console.error('Cannot find module fixture-tool'); process.exit(1); }\nprocess.exit(1);",
  );
  f.hub.verification.available = async () => true;
  f.hub.brain.complete = async (_cfg, messages, system) => {
    assert.match(system, /逐项核对/);
    assert.match(messages, /Cannot find module fixture-tool/);
    assert.doesNotMatch(messages, /已完成。/);
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: "结果包含实际标识",
            met: true,
            evidence: { path: "result.txt", quote: proof },
            note: "",
          },
        ],
      }),
      model: "fake",
      usage: null,
    };
  };
  f.fake.scripts.push(async () => {
    await writeFile(join(f.root, "result.txt"), proof);
    await writeFile(
      join(f.root, "dependency-down.flag"),
      "simulated missing runner",
    );
    return "completed";
  });
  const { id } = await f.create(
    [
      {
        title: "结果可核对",
        method: "command",
        points: "结果包含实际标识",
        checks: ["proof"],
      },
    ],
    [{ kind: "command", name: "proof", program: "node", args: ["check.cjs"] }],
  );
  await f.wait(() => f.task(id).state === "done", 20000);
  const view = f.view(id);
  assert.equal(view.criteria[0].passed?.grade, "judged");
  assert.deepEqual(view.loop.report?.unavailableChecks, ["proof"]);
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(
    view.checkRuns.filter(
      (r) => r.purpose === "criterion" && r.outcome === "environment",
    ).length,
    2,
  );
});

test("检查编写降级后仍要通过用户明确指定的程序检查", async (t) => {
  const f = await authorFixture(t);
  await f.hub.request({
    op: "settings",
    value: {
      ...f.hub.settings(),
      loopBudget: { ...f.hub.settings().loopBudget, retries: 1 },
    },
  });
  await writeFile(
    join(f.root, "tests", "existing.test.mjs"),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { number } from '../lib.mjs';",
      "test('原值至少为正数', () => assert.ok(number > 0));",
    ].join("\n"),
  );
  f.hub.checkAuthor.write = async (_dir, work, file) => {
    await writeFile(join(work, file), "import 'node:test';");
    return { accepted: true, reason: "end_turn", error: "" };
  };
  f.hub.verification.available = async () => true;
  let reviews = 0;
  f.hub.brain.complete = async () => ({
    text: JSON.stringify({
      verdict: "pass",
      points: [
        {
          point: "返回项目契约要求的新值",
          met: true,
          evidence: {
            path: "lib.mjs",
            quote:
              ++reviews === 1
                ? "export const number = -3;"
                : "export const number = 2;",
          },
          note: "",
        },
      ],
    }),
    model: "fake",
    usage: null,
  });
  f.fake.scripts.push(
    async () => {
      await writeFile(join(f.root, "lib.mjs"), "export const number = -3;\n");
      return "completed";
    },
    async (_run, context) => {
      assert.match(context, /检查未通过：test/);
      await writeFile(join(f.root, "lib.mjs"), "export const number = 2;\n");
      return "completed";
    },
  );
  const { id } = await f.createCheck();
  await f.wait(() => f.task(id).state === "done", 30000);
  const view = f.view(id);
  assert.equal(view.criteria[0].verify.method, "judge");
  assert.ok(view.criteria[0].verify.checkIds.length > 0);
  assert.equal(view.criteria[0].passed?.grade, "judged");
  assert.ok(view.criteria[0].passed?.checkRunIds.length);
  assert.deepEqual(view.loop.report?.judgedOnly, []);
  assert.equal(f.fake.prompts.length, 2);
});

test("只有独立评审退出后才确认暂停，继续时不应用已取消的结论", async (t) => {
  const f = await fixture(t);
  const facts = "the isolated file contains the required text";
  await writeFile(join(f.root, "result.txt"), facts);
  let exitFirst!: () => void;
  const untilExit = new Promise<void>((done) => {
    exitFirst = done;
  });
  let calls = 0;
  f.hub.verification.available = async () => true;
  f.hub.brain.complete = async () => {
    if (++calls === 1) await untilExit;
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: "结果文件有验收文字",
            met: true,
            evidence: { path: "result.txt", quote: facts },
            note: "",
          },
        ],
      }),
      model: "fixture",
      usage: null,
    };
  };
  const { id } = await f.create(
    [{ title: "核查结果", method: "judge", points: "结果文件有验收文字" }],
    [],
  );
  try {
    await f.wait(() => calls === 1);
    await f.control(id, "pause");
    assert.equal(f.task(id).control, "pause_requested");
    await assert.rejects(f.control(id, "resume"), /尚未结束/);
  } finally {
    exitFirst();
  }
  await f.wait(() => f.task(id).control === "confirmed");
  assert.equal(f.task(id).state, "paused");
  assert.equal(f.view(id).criteria[0].passed, undefined);
  await f.control(id, "resume");
  await f.wait(() => f.task(id).state === "done");
  assert.equal(calls, 2);
  assert.equal(f.fake.prompts.length, 0);
});

test("从单句目标规划、审查并只修订一次，过滤虚构检查及越界条目", async (t) => {
  const f = await fixture(t);
  const goal = "完成结果文件并保留说明";
  const resultMarker = "this durable result can be verified";
  const notes = "this project guide has important constraints";
  await writeFile(join(f.root, "README.md"), notes);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { test: "node check.cjs" } }),
  );
  await writeFile(
    join(f.root, "check.cjs"),
    "const fs=require('node:fs'); process.exit(fs.existsSync('result.txt')?0:1);",
  );
  await f.hub.request({
    op: "memory.save",
    text: "只修改项目文件，不发布",
    projectId: "",
    enabled: true,
  });
  f.hub.brain.configured = async () => true;
  const sequence: string[] = [];
  const base = {
    title: "完成结果文件",
    detail: "项目内生成结果",
    necessity: "required",
    assumption: false,
    sourceQuote: "完成结果文件",
    method: "command",
    checks: ["test", "invented-command"],
    needsAuthoredCheck: false,
    checkIntent: "",
    points: "",
    dependsOn: [2, 99],
  };
  const outside = {
    ...base,
    title: "发布到外部",
    sourceQuote: "非用户要求的伪造引用",
    dependsOn: [],
  };
  const draft = {
    understanding: "生成项目结果并保留说明",
    outOfScope: ["发布"],
    assumptions: [],
    criteria: [base, outside],
  };
  f.hub.brain.complete = async (_cfg, prompt, system) => {
    const m = JSON.parse(prompt);
    let response;
    if (system.includes("清单审查者")) {
      sequence.push("critic");
      assert.equal(m.goal, goal);
      response = {
        missing: [
          { sourceQuote: "保留说明", suggestion: "保留项目入口" },
          { sourceQuote: "不在原话", suggestion: "丢弃" },
        ],
        unverifiable: [{ index: 20, reason: "不存在", suggestion: "丢弃" }],
        beyondGoal: [{ index: 1, reason: "没有授权发布" }],
      };
    } else if (system.includes("清单规划者")) {
      if (m.revision) {
        sequence.push("revision");
        assert.equal(m.revision.issues.missing.length, 1);
        assert.equal(m.revision.issues.unverifiable.length, 0);
        response = {
          ...draft,
          criteria: [
            base,
            outside,
            {
              ...base,
              title: "保留说明",
              detail: "说明仍存在",
              sourceQuote: "保留说明",
              method: "judge",
              checks: [],
              points: "项目入口说明保留",
              dependsOn: [0, 3],
            },
          ],
        };
      } else {
        sequence.push("plan");
        assert.ok(
          m.materials.some(
            (x: any) => x.title === "README.md" && x.content === notes,
          ),
        );
        assert.ok(
          m.materials.some(
            (x: any) => x.kind === "rule" && x.content.includes("不发布"),
          ),
        );
        assert.deepEqual(
          m.availableChecks.map((x: any) => x.name),
          ["test"],
        );
        response = draft;
      }
    } else if (system.includes("逐项核对")) {
      sequence.push("judge");
      response = {
        verdict: "pass",
        points: [
          {
            point: "项目入口说明保留",
            met: true,
            evidence: { path: "README.md", quote: notes },
            note: "",
          },
        ],
      };
    } else {
      sequence.push("verify");
      response = { verdict: "sound", reasons: [], evidence: [], concerns: [] };
    }
    return { text: JSON.stringify(response), model: "fixture", usage: null };
  };
  f.fake.scripts.push(async (_run, context) => {
    assert.doesNotMatch(context, /invented-command/);
    await writeFile(join(f.root, "result.txt"), resultMarker);
    return "completed";
  });
  const { id } = await f.create([], [], { goal });
  await f.wait(() => f.task(id).state === "done", 30000);
  const v = f.view(id);
  assert.deepEqual(sequence.slice(0, 3), ["plan", "critic", "revision"]);
  assert.equal(sequence.filter((s) => s === "revision").length, 1);
  assert.equal(v.criteria[0].sourceQuote, "完成结果文件");
  assert.deepEqual(
    v.criteria[0].verify.checkIds.map(
      (id) => v.checks.find((c) => c.id === id)?.input.name,
    ),
    ["test"],
  );
  assert.equal(v.criteria[1].status, "blocked");
  assert.equal(v.criteria[1].input.necessity, "optional");
  assert.equal(v.criteria[1].assumption, true);
  assert.deepEqual(v.criteria[2].dependsOn, [v.criteria[0].id]);
  assert.ok(v.loop.contract?.plannedBy && v.loop.contract.reviewedBy);
  assert.equal(f.fake.prompts.length, 1);
  assert.equal(f.hub.launches.pending().length, 0);
  assert.equal(f.hub.store.all("approval").length, 0);
});

test("无效规划输出退化为单一评审条目，不等待额外确认", async (t) => {
  const f = await fixture(t);
  const goal = "检查现有结果完整性";
  const proof = "the complete result is already present";
  await writeFile(join(f.root, "result.txt"), proof);
  f.hub.brain.configured = async () => true;
  let drafts = 0;
  f.hub.brain.complete = async (_cfg, _prompt, system) => {
    if (system.includes("清单规划者")) {
      drafts++;
      return { text: "not JSON", model: "fixture", usage: null };
    }
    return {
      text: JSON.stringify({
        verdict: "pass",
        points: [
          {
            point: goal,
            met: true,
            evidence: { path: "result.txt", quote: proof },
            note: "",
          },
        ],
      }),
      model: "fixture",
      usage: null,
    };
  };
  const { id } = await f.create([], [], { goal });
  await f.wait(() => f.task(id).state === "done");
  const view = f.view(id);
  assert.equal(drafts, 2);
  assert.equal(view.criteria.length, 1);
  assert.equal(view.criteria[0].passed?.grade, "judged");
  assert.ok(view.loop.contract?.fallback);
  assert.equal(f.fake.prompts.length, 0);
});

test("验收失败后自动回退工具写入，外部改动留存，时间线与备份包含镜像证据", async (t) => {
  const f = await fixture(t, { retries: 0 });
  await writeFile(join(f.root, "notes.txt"), "original notes\n");
  f.fake.scripts.push(async (run) => {
    const task = f.task(run.taskId);
    const tools = workspaceMcp(run.workPath, {
      write: true,
      ...f.hub.loop.writerOptions(task, run),
    });
    const call = async (name: string, args: object) => {
      const response = await tools({
        jsonrpc: "2.0",
        id: "fixture",
        method: "tools/call",
        params: { name, arguments: args },
      });
      assert.ok("result" in response && "isError" in response.result);
      assert.equal(
        response.result.isError,
        false,
        response.result.content[0].text,
      );
    };
    await call("edit_file", {
      path: "notes.txt",
      old_text: "original notes",
      new_text: "executor notes",
    });
    await call("write_file", { path: "result.txt", text: "not accepted" });
    await writeFile(join(f.root, "notes.txt"), "external notes\n");
    return "completed";
  });
  const { id } = await f.create(
    [criterion("result")],
    [file("result", "expected")],
  );
  await f.wait(() => f.view(id).loop.phase === "halted");
  const v = f.view(id);
  assert.equal(v.loop.halt?.reason, "all_blocked");
  assert.deepEqual(v.loop.report?.unrestoredFiles, ["notes.txt"]);
  await assert.rejects(readFile(join(f.root, "result.txt")), /ENOENT/);
  assert.equal(
    await readFile(join(f.root, "notes.txt"), "utf8"),
    "external notes\n",
  );
  const rows = f.hub.store.all("file-journal");
  assert.equal(rows.find((row) => row.path === "result.txt").restored, "done");
  assert.equal(
    rows.find((row) => row.path === "notes.txt").restored,
    "skipped_external_change",
  );
  const run = f.hub.store.get<Run>("run", f.task(id).runId!)!;
  assert.match(run.diff, /-original notes\n\+executor notes/);
  assert.doesNotMatch(run.diff, /external notes/);
  const activity = f.hub.store.all("agent-line");
  const entry = activity.find((line) => line.id === "verified:" + run.id);
  assert.equal(
    entry?.work.files.find((item: any) => item.path === "notes.txt").added,
    1,
  );
  assert.ok(activity.some((item) => item.work?.title === "回退在途改动"));
  const backup = await f.hub.request({ op: "backup" });
  const manifest = JSON.parse(
    await readFile(join(backup.path, "manifest.json"), "utf8"),
  );
  const names = manifest.files.map((item: any) => item.name);
  for (const row of rows) {
    if (row.preRef) assert.ok(names.includes(row.preRef));
    assert.ok(names.includes(row.postRef));
  }
});

test("回合预算耗尽时恢复未承诺的文件，不回退早先检查点", async (t) => {
  const f = await fixture(t, { executorRuns: 2 });
  const capture = async (run: Run, path: string, text: string) => {
    const mcp = workspaceMcp(run.workPath, {
      write: true,
      ...f.hub.loop.writerOptions(f.task(run.taskId), run),
    });
    const response = await mcp({
      id: 1,
      method: "tools/call",
      params: { name: "write_file", arguments: { path, text } },
    });
    assert.ok(
      "result" in response &&
        "isError" in response.result &&
        !response.result.isError,
    );
  };
  f.fake.scripts.push(
    async (run) => {
      await capture(run, "one.txt", "first accepted");
      return "completed";
    },
    async (run) => {
      await capture(run, "two.txt", "second incomplete");
      return "completed";
    },
  );
  const { id } = await f.create(
    [criterion("one"), criterion("two")],
    [file("one", "first accepted"), file("two", "second accepted")],
  );
  await f.wait(() => f.view(id).loop.halt?.reason === "budget");
  assert.equal(
    await readFile(join(f.root, "one.txt"), "utf8"),
    "first accepted",
  );
  await assert.rejects(readFile(join(f.root, "two.txt")), /ENOENT/);
  assert.deepEqual(f.view(id).loop.report?.unrestoredFiles, []);
  assert.equal(f.hub.store.all("checkpoint").length, 1);
});

test("DSH 回合保留多个 API 请求中的已知用量和未知用量，不重复记账", async (t) => {
  const f = await fixture(t);
  const { id } = await f.create([criterion("result")], [file("result")]);
  await f.wait(() => {
    const runId = f.task(id).runId;
    return !!runId && f.hub.store.get<Run>("run", runId)?.state === "running";
  });
  const run = f.hub.store.get<Run>("run", f.task(id).runId!)!;
  await writeFile(join(f.root, "result.txt"), "ok");
  const usage = { requests: 3, knownRequests: 1, tokensKnown: 17 };
  const event = {
    method: "turn/completed",
    params: {
      threadId: run.threadId,
      turnId: run.turnId,
      turn: { id: run.turnId, status: "completed", dshUsage: usage },
    },
  };
  await f.hub.handleEvent(event, "dsh");
  await f.hub.handleEvent(event, "dsh");
  await f.wait(() => f.task(id).state === "done");
  assert.deepEqual(f.hub.store.get<Run>("run", run.id)?.usage, usage);
  assert.equal(f.view(id).loop.report?.usage.tokensKnown, 17);
  assert.equal(f.view(id).loop.report?.usage.unknownUsageCalls, 2);
});
