import { submitAgentForm } from "../src/shared/agent-form";
import { resultArtifacts, resultEvidence } from "../src/shared/result-evidence";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { Hub } from "../src/hub/service";
import { hash, within, redact, childEnv, Vault } from "../src/hub/security";
import { transition, overlaps, endpointUrl } from "../src/core/policy";
import {
  Request,
  defaults,
  type Task,
  type Run,
  type Artifact,
} from "../src/shared/contracts";
import { RpcError } from "../src/adapter/codex";

class FakeCodex extends EventEmitter {
  constructor(private readCwd?: string) {
    super();
  }
  initialized = true;
  version = "test-only";
  calls: any[] = [];
  counter = 0;
  turnCounter = 0;
  failStart = false;
  turns: any[] = [];
  onInterrupt?: () => Promise<void>;
  async connect() {
    this.initialized = true;
  }
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume")
      return {
        thread: { id: params.threadId || `thread-${++this.counter}` },
        model: params.model,
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
        sandbox: {
          type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite",
          networkAccess: false,
          writableRoots: [],
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      };
    if (method === "turn/start") {
      if (this.failStart) throw new RpcError("fixture timeout", true);
      return {
        turn: { id: `turn-${++this.turnCounter}`, status: "inProgress" },
      };
    }
    if (method === "thread/read")
      return {
        thread: { id: params.threadId, cwd: this.readCwd, turns: this.turns },
      };
    if (method === "turn/interrupt" && this.onInterrupt)
      await this.onInterrupt();
    if (method === "account/read") return { account: { type: "fixture" } };
    return {};
  }
  reply(id: any, result: any) {
    this.calls.push({ method: "reply", id, result });
  }
  async stop() {}
}
async function fixture() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "case-"));
  const project = join(dir, "project");
  await mkdir(project);
  const codex = new FakeCodex(project);
  const hub = new Hub(join(dir, "data"), codex as any);
  hub.store.put("settings", {
    id: "global",
    value: {
      ...defaults,
      executorBackend: "codex",
      toolApproval: "on-request",
      codexPath: "fixture.exe",
    },
  });
  const p = await hub.request({
    op: "project.add",
    path: project,
    name: "同名项目",
  });
  return { hub, codex, dir, project, p };
}
async function created(
  f: Awaited<ReturnType<typeof fixture>>,
  goal = "只读调查",
  requestId = "request-1",
) {
  const t = await submitAgentForm(f.hub.request.bind(f.hub), {
    op: "task.create",
    profile: { model: "fixture", effort: "max" },
    requestId,
    value: { projectId: f.p.id, goal, mode: "read" },
  });
  for (let i = 0; i < 100 && f.hub.scheduling; i++)
    await new Promise((r) => setTimeout(r, 5));
  return f.hub.getTask(t.id);
}
function end(f: Awaited<ReturnType<typeof fixture>>) {
  f.hub.shuttingDown = true;
  f.hub.store.close();
}
async function completed(hub: Hub, t: Task, text = "实际调查结果") {
  const run = hub.store.get<Run>("run", t.runId!)!;
  await hub.handleEvent({
    method: "item/completed",
    params: {
      threadId: run.threadId,
      turnId: run.turnId,
      item: { id: "message-1", type: "agentMessage", text },
    },
  });
  await hub.handleEvent({
    method: "turn/completed",
    params: {
      threadId: run.threadId,
      turn: { id: run.turnId, status: "completed" },
    },
  });
  return hub.store.get<Run>("run", run.id)!;
}
function review(hub: Hub, run: Run) {
  return { op: "task.control", action: "accept", id: run.taskId, revision: run.revision, runId: run.id,
    evidenceHash: hash(resultEvidence(run, resultArtifacts(hub.store.all<Artifact>("artifact"), run))) };
}

test("cross-project reuse pins selected accepted text, records explicit use, and preserves withdrawal through restore", async () => {
  const f = await fixture();
  try {
    const add = async (name: string) => {
      const path = join(f.dir, name); await mkdir(path);
      return f.hub.request({ op: "project.add", name, path });
    };
    const b = await add("允许使用的 B"), c = await add("不共享的 C");
    const aTask = await created(f, "来源工作标题不应跨项目");
    const source = await completed(f.hub, aTask, "没有选择的私有段。\n首次：将结果与验收条件放在一起。\n新版：检查附件完整。\n" + f.project);
    await f.hub.request(review(f.hub, source));
    const publish = { op: "reuse.publish", title: "交付写法", condition: "仅交接文字结果时", excerpt: "首次：将结果与验收条件放在一起。",
      taskId: aTask.id, runId: source.id, projectIds: [b.id], requestId: "reuse-v1" };
    await assert.rejects(f.hub.request({ ...publish, excerpt: f.project, requestId: "raw-path" }), /原项目目录/);
    const first = await f.hub.request(publish);
    const ref = ({ id, version, versionId }: typeof first) => ({ id, version, versionId });
    const prepare = (projectId: string, requestId: string) => f.hub.request({ op: "task.create", requestId,
      value: { projectId, goal: "写本项目交付说明", mode: "read", advance: "single", reuse: [ref(first)] } });
    const allowed = await f.hub.request({ op: "reuse.project", projectId: b.id });
    assert.deepEqual(allowed, [{ ...ref(first), title: publish.title, condition: publish.condition }]);
    assert.deepEqual(await f.hub.request({ op: "reuse.project", projectId: c.id }), []);
    await assert.rejects(prepare(c.id, "forbidden"), /授权已变化/);
    const tick = f.hub.tick.bind(f.hub);
    f.hub.tick = async () => {};
    const launch = await prepare(b.id, "reuse-consumer");
    const task = await f.hub.request({ op: "agent.launch.confirm", id: launch.launchId, profile: { model: "fixture", effort: "max" } });
    assert.equal(f.hub.reuse.uses().length, 0);
    const second = await f.hub.request({ ...publish, id: first.id, revision: first.revision, excerpt: "新版：检查附件完整。", requestId: "reuse-v2" });
    assert.equal(second.version, 2);
    await assert.rejects(prepare(b.id, "obsolete-new-selection"), /留用版本或项目授权已变化/);
    await tick();
    for (let i = 0; i < 100 && f.hub.scheduling; i++) await new Promise(r => setTimeout(r, 5));
    const prompt = f.codex.calls.filter(x => x.method === "turn/start").at(-1)?.params.input[0].text;
    assert.match(prompt, /首次：将结果与验收条件放在一起/);
    assert.doesNotMatch(prompt, /来源工作标题|没有选择的私有段|新版：检查附件完整/);
    assert.ok(!prompt.includes(JSON.stringify(f.project).slice(1, -1)));
    const storedTask = f.hub.getTask(task.id);
    const run = await completed(f.hub, storedTask, "按约定写了交付说明");
    await f.hub.request(review(f.hub, run));
    const record = { op: "reuse.record", taskId: storedTask.id, runId: run.id, ref: ref(first), outcome: "used", note: "输出结构与所选内容相符" };
    await assert.rejects(f.hub.request({ ...record, ref: ref(second) }), /没有发送所选留用版本/);
    const adopted = await f.hub.request(record);
    assert.deepEqual(await f.hub.request(record), adopted);
    assert.deepEqual(adopted.ref, ref(first));
    const backup = await f.hub.backup();
    await f.hub.request({ op: "reuse.scope", id: second.id, revision: second.revision, projectIds: [], active: true });
    assert.deepEqual(await f.hub.request({ op: "reuse.project", projectId: b.id }), []);
    await f.hub.restore(backup.path);
    assert.deepEqual(await f.hub.request({ op: "reuse.project", projectId: b.id }), []);
    assert.throws(() => f.hub.reuse.materials(b.id, storedTask.reuse!), /已撤回或停用/);
    assert.deepEqual(f.hub.reuse.uses(), [adopted]);

    await f.hub.request({ op: "reuse.scope", id: second.id, revision: second.revision, projectIds: [b.id], active: true });
    assert.throws(() => f.hub.reuse.materials(b.id, storedTask.reuse!), /已撤回或停用/);
    const latest = await f.hub.request({ op: "task.create", requestId: "reuse-counterexample", value: {
      projectId: b.id, goal: "核对新版", mode: "write", advance: "single", reuse: [ref(second)],
    } });
    assert.equal(f.hub.launches.pending().find(card => card.id === latest.launchId)?.scope, "project");
    const target = await f.hub.request({ op: "agent.launch.confirm", id: latest.launchId, profile: { model: "fixture", effort: "max" } });
    assert.equal(f.hub.getTask(target.id).access, "project");
    await tick();
    for (let i = 0; i < 100 && f.hub.scheduling; i++) await new Promise(r => setTimeout(r, 5));
    const checked = await completed(f.hub, f.hub.getTask(target.id), "没有附件，不适用");
    await f.hub.request(review(f.hub, checked));
    const negative = { ...record, taskId: target.id, runId: checked.id, ref: ref(second), outcome: "counterexample" };
    await assert.rejects(f.hub.request({ ...negative, note: "" }), /不适用的原因/);
    await f.hub.request({ ...negative, note: "这份交付没有附件" });
    assert.deepEqual(await f.hub.request({ op: "reuse.project", projectId: b.id }), []);
    assert.equal(f.hub.reuse.uses().length, 2);
  } finally { end(f); }
});

test("reuse withdrawal after native setup prevents sending the prompt", async () => {
  const f = await fixture();
  try {
    const firstTask = await created(f);
    const run = await completed(f.hub, firstTask);
    await f.hub.request(review(f.hub, run));
    const value = await f.hub.request({ op: "reuse.publish", title: "参考", condition: "文字", excerpt: run.response,
      taskId: firstTask.id, runId: run.id, projectIds: [f.p.id], requestId: "publish-for-fence" });
    const { id, version, versionId } = value;
    const original = f.codex.call.bind(f.codex);
    f.codex.calls.length = 0;
    f.codex.call = async (method, body) => {
      const result = await original(method, body);
      if (method === "thread/start") await f.hub.request({ op: "reuse.scope", id, revision: value.revision, projectIds: [], active: false });
      return result;
    };
    const prepared = await f.hub.request({ op: "task.create", requestId: "reuse-fence", value: {
      projectId: f.p.id, goal: "复核参考", advance: "single", mode: "read", reuse: [{ id, version, versionId }],
    } });
    const task = await f.hub.request({ op: "agent.launch.confirm", id: prepared.launchId, profile: { model: "fixture", effort: "max" } });
    for (let i = 0; i < 100 && f.hub.scheduling; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(f.codex.calls.some(call => call.method === "thread/start"));
    assert.ok(!f.codex.calls.some(call => call.method === "turn/start"));
    assert.match(f.hub.getTask(task.id).reason ?? "", /留用内容已撤回/);
  } finally { end(f); }
});
test("runtime schemas reject unknown operations and dangerous implicit modes", () => {
  assert.throws(() => Request.parse({ op: "shell", command: "anything" }));
  assert.throws(() =>
    Request.parse({
      op: "task.create",
      requestId: "1",
      value: { projectId: "x", goal: "x", mode: "danger-full-access" },
    }),
  );
  assert.throws(() =>
    endpointUrl("https://example.com/v1?key=placeholder", "models"),
  );
  assert.throws(() => endpointUrl("http://example.com/v1", "models"));
  assert.equal(
    endpointUrl("http://127.0.0.1:5555/v1", "models"),
    "http://127.0.0.1:5555/v1/models",
  );
});
test("state transitions and nested Windows workspace conflicts", () => {
  assert.throws(() => transition({ state: "cancelled" } as Task, "ready"));
  assert.equal(overlaps("D:\\WORK\\app", "d:/work/app/sub"), true);
  assert.equal(overlaps("D:/work/app", "D:/work/apple"), false);
});
test("same request survives duplicate delivery without duplicate native dispatch", async () => {
  const f = await fixture();
  try {
    const a = await created(f);
    const b = await created(f);
    assert.equal(a.id, b.id);
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    await assert.rejects(created(f, "different"));
  } finally {
    end(f);
  }
});
test("ledger failure rolls back acceptance before any native side effect", async () => {
  const f = await fixture();
  try {
    const original = f.hub.store.put.bind(f.hub.store);
    f.hub.store.put = (kind: string, data: any) => {
      if (kind === "message") throw new Error("simulated disk full");
      return original(kind, data);
    };
    await assert.rejects(
      submitAgentForm(f.hub.request.bind(f.hub), {
        op: "task.create",
        profile: { model: "fixture", effort: "max" },
        requestId: "disk-full",
        value: { projectId: f.p.id, goal: "must not execute", mode: "write" },
      }),
    );
    assert.equal(f.hub.store.all("task").length, 0);
    assert.equal(f.codex.calls.length, 0);
    f.hub.store.put = original;
  } finally {
    end(f);
  }
});
test("SQLite capacity exhaustion keeps its real error and accepts work only after space is available", async () => {
  const f = await fixture();
  try {
    const db = f.hub.store.db;
    const pages = db.prepare("PRAGMA page_count").get()!.page_count;
    const previous = db.prepare("PRAGMA max_page_count").get()!.max_page_count;
    db.exec("PRAGMA max_page_count=" + pages);
    assert.throws(() => f.hub.store.tx(() => {
      f.hub.store.event("fixture.capacity", "fixture");
      f.hub.store.put("fixture", { id: "oversized", text: "容量".repeat(64_000) });
    }), /database or disk is full/i);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT 1 FROM events WHERE kind='fixture.capacity'").get(), undefined);
    const submit = () =>
      submitAgentForm(f.hub.request.bind(f.hub), {
        op: "task.create",
        profile: { model: "fixture", effort: "max" },
        requestId: "capacity",
        value: {
          projectId: f.p.id,
          goal: "合成容量。".repeat(4400),
          mode: "read",
        },
      });
    await assert.rejects(submit, /database or disk is full/i);
    assert.equal(f.hub.store.all("task").length, 0);
    assert.equal(f.hub.launches.pending().length, 0);
    assert.equal(f.codex.calls.length, 0);
    db.exec("PRAGMA max_page_count=" + previous);
    const task = await submit();
    while (f.hub.scheduling) await new Promise((done) => setTimeout(done, 5));
    assert.equal(f.hub.getTask(task.id).state, "active");
    assert.equal(
      f.codex.calls.filter((r) => r.method === "turn/start").length,
      1,
    );
  } finally {
    end(f);
  }
});
test("workspace serialization keeps second writer queued; separate projects can run", async () => {
  const f = await fixture();
  try {
    await created(f);
    const b = await created(f, "second", "request-2");
    assert.equal(b.state, "ready");
    const path = join(f.dir, "other");
    await mkdir(path);
    const p = await f.hub.request({
      op: "project.add",
      path,
      name: "同名项目",
    });
    assert.notEqual(p.id, f.p.id);
    f.hub.createTask(
      {
        projectId: p.id,
        goal: "parallel",
        mode: "read",
        constraints: "",
        acceptance: "",
        model: "",
        attachments: [],
        dependencies: [],
      },
      "request-3",
    );
    for (let i = 0; i < 100 && f.hub.scheduling; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      2,
    );
  } finally {
    end(f);
  }
});
test("unknown start holds workspace and restart never retries it", async () => {
  const f = await fixture();
  f.codex.failStart = true;
  const t = await created(f);
  assert.equal(t.state, "blocked");
  assert.equal(f.hub.store.get<Run>("run", t.runId!)!.state, "unknown");
  await assert.rejects(f.hub.control(t.id, "resume", t.revision));
  end(f);
  const other = new FakeCodex();
  const reopened = new Hub(join(f.dir, "data"), other as any);
  try {
    await reopened.tick();
    assert.equal(other.calls.length, 0);
    assert.equal(reopened.getTask(t.id).state, "blocked");
  } finally {
    reopened.store.close();
  }
});

test("unknown runs retain their workspace without consuming another project's execution slot", async () => {
  const f = await fixture();
  try {
    await f.hub.request({
      op: "settings",
      value: { ...f.hub.settings(), concurrency: 1 },
    });
    f.codex.failStart = true;
    const unknown = await created(f, "unknown", "unknown-project");
    assert.equal(unknown.state, "blocked");
    f.codex.failStart = false;
    const queued = await created(f, "same root", "same-project");
    assert.equal(queued.state, "ready");
    const otherPath = join(f.dir, "independent");
    await mkdir(otherPath);
    const other = await f.hub.request({
      op: "project.add",
      name: "独立项目",
      path: otherPath,
    });
    const separate = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      requestId: "independent-project",
      value: { projectId: other.id, goal: "independent", mode: "read" },
      profile: { model: "fixture", effort: "max" },
    });
    while (f.hub.scheduling) await new Promise((done) => setTimeout(done, 5));
    assert.equal(f.hub.getTask(separate.id).state, "active");
    assert.equal(f.hub.getTask(queued.id).state, "ready");
    assert.equal(f.hub.store.get<Run>("run", unknown.runId!)?.state, "unknown");
    assert.equal(
      f.codex.calls.filter((call) => call.method === "turn/start").length,
      2,
    );
  } finally {
    end(f);
  }
});
test("pause request waits for native ending and late success cannot undo pause", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    await f.hub.control(t.id, "pause", t.revision);
    let current = f.hub.getTask(t.id);
    assert.equal(current.control, "pause_requested");
    assert.equal(current.state, "paused");
    await completed(f.hub, t);
    current = f.hub.getTask(t.id);
    assert.equal(current.state, "paused");
    assert.equal(current.control, "confirmed");
    await f.hub.tick();
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
  } finally {
    end(f);
  }
});
test("一次性预约在重启后原子领取，失败不推进，成功只交给调度一次", async () => {
  const f = await fixture();
  let hub = f.hub;
  try {
    const task = await created(f);
    await completed(hub, task);
    await hub.control(task.id, "pause", task.revision);
    const paused = hub.getTask(task.id);
    const due = Date.now() + 120000;
    const schedule = { op: "task.wake.schedule", id: task.id, revision: paused.revision,
      stateVersion: paused.stateVersion, at: new Date(due).toISOString() };
    await assert.rejects(hub.request(schedule), /后台保留已关闭/);
    await hub.request({ op: "settings", value: { ...hub.settings(), background: true } });
    await hub.request(schedule);
    const { wakeId } = hub.wakes.list()[0];
    hub.store.close();
    hub = new Hub(join(f.dir, "data"), f.codex as any);
    assert.equal(hub.getTask(task.id).state, "paused");
    await hub.wakes.tick(due - 1);
    assert.equal(hub.wakes.list()[0].state, "scheduled");
    hub.store.db.exec(`CREATE TEMP TRIGGER reject_wake BEFORE INSERT ON events
      WHEN NEW.kind='task.wake.released' BEGIN SELECT RAISE(ABORT,'预约写入失败'); END;`);
    await assert.rejects(hub.wakes.tick(due), /预约写入失败/);
    assert.equal(hub.getTask(task.id).state, "paused");
    assert.equal(hub.wakes.list()[0].state, "scheduled");
    hub.store.db.exec("DROP TRIGGER reject_wake");
    await hub.wakes.tick(due);
    await hub.wakes.tick(due);
    assert.equal(hub.getTask(task.id).state, "ready");
    assert.equal(hub.wakes.list()[0].wakeId, wakeId);
    assert.equal(hub.wakes.list()[0].state, "released");
    await hub.tick();
    await hub.tick();
    assert.equal(hub.getTask(task.id).state, "active");
    assert.equal(f.codex.calls.filter((c) => c.method === "turn/start").length, 2);
    assert.equal(hub.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='task.wake.released'").get()?.n, 1);
  } finally {
    hub.shuttingDown = true;
    hub.store.close();
  }
});

test("取消、授权变化和恢复旧备份都不允许预约触发", async () => {
  const f = await fixture();
  try {
    const { hub } = f;
    const task = await created(f);
    await completed(hub, task);
    await hub.control(task.id, "pause", task.revision);
    await hub.request({ op: "settings", value: { ...hub.settings(), background: true } });
    const paused = hub.getTask(task.id);
    const due = Date.now() + 120000;
    const request = { op: "task.wake.schedule", id: task.id, revision: paused.revision,
      stateVersion: paused.stateVersion, at: new Date(due).toISOString() };
    await hub.request(request);
    const old = hub.wakes.list()[0].wakeId;
    await hub.request({ op: "task.wake.cancel", id: task.id, wakeId: old });
    await hub.request(request);
    await assert.rejects(hub.request({ op: "task.wake.cancel", id: task.id, wakeId: old }), /预约已变化/);
    const backup = await hub.backup();
    await hub.wakes.tick(due + 16 * 60000);
    assert.match(hub.wakes.list()[0].reason!, /预约已过期/);
    await hub.request(request);
    await hub.request({ op: "memory.save", text: "要求变化", projectId: f.p.id, enabled: true });
    await hub.wakes.tick(due);
    assert.match(hub.wakes.list()[0].reason!, /规则.*已变化/);
    await hub.restore(backup.path);
    await hub.wakes.tick(due);
    assert.match(hub.wakes.list()[0].reason!, /从备份恢复/);
    assert.equal(hub.getTask(task.id).state, "paused");
    assert.equal(f.codex.calls.filter((c) => c.method === "turn/start").length, 1);
  } finally {
    end(f);
  }
});
test("a late interrupt error cannot undo a confirmed native stop", async () => {
  const f = await fixture();
  try {
    const task = await created(f);
    const run = f.hub.store.get<Run>("run", task.runId!)!;
    let refused!: (e: Error) => void;
    f.codex.onInterrupt = () =>
      new Promise<void>((_, reject) => {
        refused = reject;
      });
    const stopping = f.hub.control(task.id, "pause", task.revision);
    assert.ok(refused);
    await f.hub.handleEvent({
      method: "turn/completed",
      params: {
        threadId: run.threadId,
        turn: { id: run.turnId, status: "interrupted" },
      },
    });
    refused(new RpcError("transport end", true));
    await stopping;
    assert.equal(f.hub.getTask(task.id).state, "paused");
    assert.equal(f.hub.getTask(task.id).control, "confirmed");
    assert.equal(
      f.hub.store.all("command").find((x) => x.kind === "stop")?.state,
      "resolved",
    );
  } finally {
    end(f);
  }
});
test("native success requires current evidence and user acceptance", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    const r = await completed(f.hub, t);
    assert.equal(f.hub.getTask(t.id).state, "verifying");
    const request = review(f.hub, r);
    await assert.rejects(f.hub.request({ ...request, runId: undefined }), /结果版本已变化/);
    await assert.rejects(f.hub.request({ ...request, evidenceHash: "wrong" }), /结果版本已变化/);
    await f.hub.request(request);
    assert.equal(f.hub.getTask(t.id).state, "done");
  } finally {
    end(f);
  }
});
test("review rejects identical results from a different run before and during file verification", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    await writeFile(join(f.project, "result.md"), "fixture");
    const old = await completed(f.hub, t);
    const task = f.hub.getTask(t.id), open = review(f.hub, old);
    assert.equal(resultArtifacts(f.hub.store.all<Artifact>("artifact"), old).length, 1);
    const next = { ...old, id: "same-text-new-run", turnId: "next-turn" };
    f.hub.store.put("run", next);
    f.hub.store.put("task", { ...task, runId: next.id });
    await assert.rejects(f.hub.request(open), /结果版本已变化/);
    f.hub.store.put("task", task);
    const inFlight = f.hub.request(open);
    f.hub.store.put("task", { ...task, runId: next.id });
    await assert.rejects(inFlight, /验收期间结果已变化/);
    assert.equal(f.hub.store.all("acceptance").length, 0);
    await f.hub.request(review(f.hub, next));
    assert.equal(f.hub.store.all("acceptance")[0].runId, next.id);
  } finally { end(f); }
});
test("terminal receipt fills missing result events once without late regressions", async () => {
  const f = await fixture();
  let notice: Parameters<Hub["claimResultNotice"]>[0] | undefined;
  try {
    const task = await created(f);
    const run = f.hub.store.get<Run>("run", task.runId!)!;
    const turn = {
      id: run.turnId,
      status: "completed",
      items: [
        {
          id: "cmd",
          type: "commandExecution",
          command: "inspect fixture",
          exitCode: 0,
          aggregatedOutput: "actual output",
        },
        { id: "answer", type: "agentMessage", text: "actual recovered answer" },
      ],
    };
    const params = { threadId: run.threadId, turnId: run.turnId };
    f.hub.on("result", (event) => { notice = event; });
    assert.equal(f.hub.claimResultNotice({ taskId: task.id, runId: run.id }), undefined);
    await f.hub.handleEvent({
      method: "turn/completed",
      params: { ...params, turn },
    });
    const nextRun = { ...run, id: run.id + ":next", turnId: undefined };
    f.hub.store.put("run", nextRun);
    for (const method of ["turn/started", "turn/completed"])
      await f.hub.handleEvent({ method, params: { ...params, turn } });
    await f.hub.handleEvent({
      method: "item/completed",
      params: { ...params, item: turn.items[0] },
    });
    assert.equal(f.hub.getTask(task.id).state, "verifying");
    const result = f.hub.store.get<Run>("run", run.id)!;
    assert.equal(result.state, "ended");
    assert.equal(result.response, "actual recovered answer");
    assert.equal(f.hub.store.get<Run>("run", nextRun.id)?.turnId, undefined);
    assert.deepEqual(notice, { taskId: task.id, runId: run.id });
    assert.equal(f.hub.claimResultNotice(notice!), undefined);
    await f.hub.request({ op: "settings", value: { ...f.hub.settings(), notifications: true } });
    assert.deepEqual(f.hub.claimResultNotice(notice!), { title: task.title });
    assert.equal(f.hub.claimResultNotice(notice!), undefined);
    assert.equal(f.hub.getTask(task.id).unread, true);
    assert.equal(
      f.hub.store
        .all("evidence")
        .filter((row) => row.runId === run.id && row.kind === "command").length,
      1,
    );
    assert.equal(
      f.hub.store.db
        .prepare(
          "SELECT count(*) AS total FROM events WHERE kind='run.ended' AND object_id=?",
        )
        .get(run.id)?.total,
      1,
    );
  } finally {
    end(f);
  }
  const reopened = new Hub(join(f.dir, "data"));
  try {
    assert.equal(reopened.claimResultNotice(notice!), undefined);
  } finally {
    reopened.store.close();
  }
});
test("a failed audit write keeps work unresolved until restart and native reconciliation", async () => {
  const f = await fixture();
  const task = await created(f);
  const run = f.hub.store.get<Run>("run", task.runId!)!;
  const turn = {
    id: run.turnId,
    status: "completed",
    items: [{ id: "actual-reply", type: "agentMessage", text: "保留真实回执" }],
  };
  try {
    f.hub.store.db.exec(`CREATE TEMP TRIGGER abort_receipt_audit
      BEFORE INSERT ON events WHEN NEW.kind='run.ended'
      BEGIN SELECT RAISE(ABORT, 'fixture audit unavailable'); END;`);
    let results = 0;
    f.hub.on("result", () => results++);
    f.codex.emit("event", {
      method: "turn/completed",
      params: { threadId: run.threadId, turn },
    });
    await f.hub.eventQueue;
    assert.match((await f.hub.snapshot()).hub.error!, /原生事件保存失败/);
    assert.equal(f.hub.getTask(task.id).state, "active");
    assert.equal(f.hub.store.get<Run>("run", run.id)?.state, "running");
    assert.equal(results, 0);
    await assert.rejects(f.hub.request({
      op: "session.send", projectId: task.projectId, threadId: run.threadId,
      text: "新增外部回合", requestId: "during-fault",
    }), /原生事件保存失败/);
  } finally {
    end(f);
  }
  const native = new FakeCodex(f.project);
  native.turns = [turn];
  const reopened = new Hub(join(f.dir, "data"), native as any);
  try {
    assert.equal((await reopened.snapshot()).hub.error, undefined);
    assert.equal(reopened.store.get<Run>("run", run.id)?.state, "unknown");
    await reopened.control(task.id, "reconcile", task.revision);
    assert.equal(reopened.getTask(task.id).state, "verifying");
    assert.equal(reopened.store.get<Run>("run", run.id)?.response, "保留真实回执");
    assert.deepEqual(native.calls.map((x) => x.method), ["thread/read"]);
    assert.equal(reopened.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='run.ended'").get()?.n, 1);
  } finally {
    reopened.store.close();
  }
});
test("a live completion and history reconciliation finalize the same turn only once", async () => {
  const f = await fixture();
  try {
    const task = await created(f);
    const run = f.hub.store.get<Run>("run", task.runId!)!;
    const turn = {
      id: run.turnId,
      status: "completed",
      items: [
        { id: "reply", type: "agentMessage", text: "final fixture response" },
      ],
    };
    f.codex.turns = [turn];
    await Promise.all([
      f.hub.handleEvent({
        method: "turn/completed",
        params: { threadId: run.threadId, turn },
      }),
      f.hub.control(task.id, "reconcile", task.revision),
    ]);
    assert.equal(
      f.hub.store.db
        .prepare(
          "SELECT count(*) AS total FROM events WHERE kind='run.ended' AND object_id=?",
        )
        .get(run.id)?.total,
      1,
    );
    assert.equal(f.hub.getTask(task.id).state, "verifying");
    assert.equal(
      f.hub.store.get<Run>("run", run.id)?.response,
      "final fixture response",
    );
  } finally {
    end(f);
  }
});
test("revision expires approval and old result does not complete new goal", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    const r = f.hub.store.get<Run>("run", t.runId!)!;
    f.hub.handleApproval({
      id: 90,
      method: "item/tool/requestUserInput",
      params: {
        threadId: r.threadId,
        turnId: r.turnId,
        questions: [{ id: "q", question: "clarify" }],
      },
    });
    const a = f.hub.store.all("approval")[0];
    await f.hub.request({
      op: "task.revise",
      id: t.id,
      revision: 1,
      goal: "new requirement",
      constraints: "",
      acceptance: "",
      model: "",
    });
    await assert.rejects(f.hub.answerApproval(a.id, 1, true));
    assert.equal(f.hub.store.get("approval", a.id).state, "expired");
    await completed(f.hub, t);
    assert.equal(f.hub.getTask(t.id).revision, 2);
    assert.equal(f.hub.getTask(t.id).state, "paused");
  } finally {
    end(f);
  }
});
test("deleting explicit memory survives restoring an old backup", async () => {
  const f = await fixture();
  try {
    const m = await f.hub.request({
      op: "memory.save",
      text: "only chinese",
      projectId: "",
      enabled: true,
    });
    const b = await f.hub.backup();
    await f.hub.request({ op: "memory.delete", id: m.id });
    await f.hub.restore(b.path);
    assert.equal(f.hub.rules(f.p.id).length, 0);
    assert.equal(f.hub.store.get("memory", m.id).text, "");
  } finally {
    end(f);
  }
});
test("restoring the ledger recovers native audit evidence and never reclaims a delivered notice", async () => {
  const f = await fixture();
  const imported = new Hub(join(f.dir, "imported"));
  try {
    await f.hub.request({ op: "settings", value: { ...f.hub.settings(), notifications: true } });
    const task = await created(f);
    const run = await completed(f.hub, task);
    const notice = { taskId: task.id, runId: run.id };
    const recorded = (hub: Hub) => hub.store.db.prepare(
      "SELECT seq,kind,object_id,at,metadata FROM events WHERE kind='run.ended' AND object_id=?",
    ).get(run.id);
    const receipt = recorded(f.hub);
    assert.ok(receipt);
    const beforeNotice = await f.hub.backup();
    assert.deepEqual(f.hub.claimResultNotice(notice), { title: task.title });
    const withNotice = await f.hub.backup();
    f.hub.store.event("fixture.later-event", task.id);
    const later = () => f.hub.store.db.prepare(
      "SELECT 1 FROM events WHERE kind='fixture.later-event'",
    ).get();
    f.hub.store.db.exec(`CREATE TEMP TRIGGER reject_restore_event BEFORE INSERT ON events
      WHEN NEW.kind='backup.restored' BEGIN SELECT RAISE(ABORT,'fixture restore aborted'); END;`);
    await assert.rejects(f.hub.restore(beforeNotice.path), /fixture restore aborted/);
    assert.ok(later());
    assert.deepEqual(recorded(f.hub), receipt);
    assert.equal(f.hub.getTask(task.id).unread, true);
    assert.equal(f.hub.claimResultNotice(notice), undefined);
    f.hub.store.db.exec("DROP TRIGGER reject_restore_event");
    await f.hub.restore(beforeNotice.path);
    assert.deepEqual(recorded(f.hub), receipt);
    assert.equal(f.hub.claimResultNotice(notice), undefined);
    assert.equal(later(), undefined);
    await imported.restore(withNotice.path);
    assert.deepEqual(recorded(imported), receipt);
    assert.equal(imported.getTask(task.id).unread, true);
    assert.equal(imported.claimResultNotice(notice), undefined);
  } finally {
    imported.store.close();
    end(f);
  }
});
test("attachment snapshot detects changes and prevents path escape", async () => {
  const f = await fixture();
  try {
    const path = join(f.project, "note.md");
    await writeFile(path, "safe fixture");
    const a = await f.hub.addAttachment(path);
    assert.equal((await f.hub.readArtifact(a.id)).content, "safe fixture");
    await writeFile(a.path, "changed fixture");
    await assert.rejects(f.hub.readArtifact(a.id));
    await assert.rejects(
      within(f.project, join(f.dir, "data", "state.sqlite")),
    );
  } finally {
    end(f);
  }
});
test("答复偏好从独立反馈提炼，跨项目不注入；停用和删除不回灌旧答复", async () => {
  const f = await fixture();
  const { hub } = f;
  try {
    const inputs: { recent: { text: string }[]; replyPresentation?: string }[] = [];
    hub.brain.advise = async (_settings, prompt) => {
      const context = JSON.parse(prompt);
      inputs.push(context);
      return { text: "", model: "fixture", usage: {}, advice: {
        reply: "答复：" + context.input, proposal: null,
      } };
    };
    const ask = async (id: string, scope?: string) => {
      await hub.chat(id, id, undefined, scope);
      return hub.store.all("message").find((msg) => msg.role === "assistant" && msg.workRequestId === id)!;
    };
    const feedback = (id: string, style = "concise") => hub.request({ op: "preference.feedback", id, style });
    const manage = (item: any, action: string) => hub.request({
      op: "preference.manage", id: item.id, revision: item.revision, generation: item.generation, action,
    });
    const [a, b] = [await ask("通用问题一"), await ask("通用问题二")];
    await assert.rejects(feedback(a.id), /先打开答复偏好学习/);
    await hub.request({ op: "preference.learning", enabled: true });
    const one = await feedback(a.id);
    assert.equal(one.state, "insufficient");
    assert.deepEqual(await feedback(a.id), one);
    await assert.rejects(manage(one, "enable"), /证据不足/);
    const two = await feedback(b.id);
    assert.equal(two.state, "candidate");
    assert.equal(hub.preferences.hint(""), undefined);
    const conflicting = await feedback(b.id, "detailed");
    assert.equal(conflicting.state, "conflicted");
    assert.equal(conflicting.evidence.length, 2);
    const corrected = await feedback(b.id);
    await assert.rejects(manage(two, "enable"), /已变化/);
    await manage(corrected, "enable");
    assert.equal(hub.preferences.list()[0].state, "active");
    const affected = await ask("使用偏好的通用答复");
    assert.equal(inputs.at(-1)?.replyPresentation, "concise");
    assert.ok(affected.preferenceInput);
    assert.ok(hub.preferences.list()[0].lastUsedAt);
    await ask("项目内问题", f.p.id);
    assert.equal(inputs.at(-1)?.replyPresentation, undefined);
    assert.ok(!inputs.at(-1)?.recent.some((line) => line.text === affected.text));
    assert.equal(hub.preferences.list(Date.now() + 61 * 86400000)[0].state, "expired");
    const before = await hub.backup();
    const current = hub.preferences.list()[0];
    const source = await hub.request({ op: "preference.source", id: current.id, messageId: a.id });
    assert.equal(source.text, a.text);
    const exported = await manage(current, "export");
    assert.doesNotMatch(await readFile(exported.path, "utf8"), /答复：/);
    await manage(current, "pause");
    await ask("停用后的问题");
    assert.equal(inputs.at(-1)?.replyPresentation, undefined);
    assert.ok(!inputs.at(-1)?.recent.some((line) => line.text === affected.text));
    assert.equal(hub.store.get("message", affected.id).text, affected.text);
    await manage(hub.preferences.list()[0], "delete");
    await assert.rejects(feedback(a.id), /证据已删除/);
    await hub.restore(before.path);
    assert.equal(hub.preferences.list().length, 0);
    assert.equal((await hub.snapshot()).preferenceLearning, false);
    assert.ok(hub.store.get("message", a.id));
  } finally {
    end(f);
  }
});

test("用户关闭偏好学习时在途答复不得提交，重开也不会复活授权", async () => {
  const f = await fixture();
  const { hub } = f;
  try {
    await hub.request({ op: "preference.learning", enabled: true });
    for (const n of [1, 2]) {
      hub.message("user", "本地设置", undefined, "answered", "seed-pref-" + n);
      const reply = hub.message("assistant", "本地答案", undefined, undefined, "seed-pref-reply-" + n);
      hub.store.put("message", { ...reply, workRequestId: "seed-pref-" + n });
      await hub.request({ op: "preference.feedback", id: reply.id, style: "detailed" });
    }
    const pref = hub.preferences.list()[0];
    await hub.request({ op: "preference.manage", id: pref.id, revision: pref.revision, generation: pref.generation, action: "enable" });
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    hub.brain.advise = async (_cfg, context) => {
      assert.equal(JSON.parse(context).replyPresentation, "detailed");
      ready();
      await blocked;
      return { text: "", model: "fixture", usage: {}, advice: { reply: "不能提交的旧答复", proposal: null } };
    };
    const asking = hub.chat("尝试在途答复", "pref-pending");
    await started;
    await hub.request({ op: "preference.learning", enabled: false });
    await hub.request({ op: "preference.learning", enabled: true });
    release();
    assert.match((await asking).error!, /偏好已变化/);
    assert.equal(hub.preferences.hint(""), undefined);
    assert.equal(hub.store.all("message").some((msg) => msg.text === "不能提交的旧答复"), false);
  } finally {
    end(f);
  }
});

test("attachment receipts belong to one run; an unknown Codex turn is matched without resubmission", async () => {
  const f = await fixture();
  try {
    const textPath = join(f.dir, "input.txt"),
      binaryPath = join(f.dir, "record.bin");
    await writeFile(textPath, "文字输入".repeat(7600));
    await writeFile(binaryPath, "binary-fixture");
    const text = await f.hub.addAttachment(textPath),
      binary = await f.hub.addAttachment(binaryPath);
    const launch = (requestId: string) =>
      submitAgentForm(f.hub.request.bind(f.hub), {
        op: "task.create",
        requestId,
        profile: { model: "fixture", effort: "max" },
        value: {
          projectId: f.p.id,
          goal: "核对附件",
          mode: "read",
          attachments: [text.id, binary.id],
        },
      });
    f.codex.failStart = true;
    const first = await launch("attachments-ack-lost");
    while (f.hub.scheduling)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const run = f.hub.store.get<Run>("run", f.hub.getTask(first.id).runId!)!;
    assert.equal(run.state, "unknown");
    assert.equal(run.turnId, undefined);
    assert.equal(run.inputsAcceptedAt, undefined);
    assert.deepEqual(run.attachmentInputs, [
      { id: text.id, kind: "text", truncated: true },
      { id: binary.id, kind: "binary" },
    ]);
    const start = f.codex.calls.find((c) => c.method === "turn/start")!;
    const sent = start.params.input[0].text;
    assert.match(sent, /只提供文件名和 SHA-256/);
    assert.doesNotMatch(sent, /binary-fixture/);
    f.codex.turns = [
      {
        id: "history-turn",
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            clientId: "same-text-other-request",
            content: [{ type: "text", text: sent }],
          },
        ],
      },
    ];
    await assert.rejects(
      f.hub.control(first.id, "reconcile", first.revision),
      /不重派/,
    );
    assert.equal(f.hub.store.get<Run>("run", run.id)?.turnId, undefined);
    f.codex.turns[0].items[0].clientId = start.params.clientUserMessageId;
    await assert.rejects(
      f.hub.control(first.id, "reconcile", first.revision),
      /没有结束回执/,
    );
    const active = f.hub.store.get<Run>("run", run.id)!;
    assert.equal(active.turnId, "history-turn");
    assert.equal(active.state, "unknown");
    assert.ok(active.inputsAcceptedAt);
    f.codex.turns[0].status = "completed";
    f.codex.turns[0].items.push({
      type: "agentMessage",
      id: "answer",
      text: "已核对",
    });
    await f.hub.control(first.id, "reconcile", first.revision);
    assert.equal(f.hub.getTask(first.id).state, "verifying");
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    assert.equal(f.hub.store.get("artifact", text.id).status, text.status);
    assert.equal(f.hub.store.get("artifact", binary.id).status, binary.status);
    const second = await launch("reuse-same-attachments");
    while (f.hub.scheduling)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const secondRun = f.hub.store.get<Run>(
      "run",
      f.hub.getTask(second.id).runId!,
    )!;
    assert.equal(secondRun.state, "unknown");
    assert.equal(secondRun.inputsAcceptedAt, undefined);
  } finally {
    end(f);
  }
});
test("diagnostics exclude goals, secrets, paths and raw outputs", async () => {
  const f = await fixture();
  try {
    f.hub.message("user", "PRIVATE_TASK_FIXTURE");
    const result = await f.hub.diagnostics();
    const text = await readFile(result.path, "utf8");
    assert.ok(!text.includes("PRIVATE_TASK_FIXTURE"));
    assert.ok(!text.includes(f.project));
    assert.equal(redact("Bearer test-placeholder"), "Bearer [已隐藏]");
    assert.ok(!Object.keys(childEnv()).some((k) => /API_KEY|TOKEN/.test(k)));
  } finally {
    end(f);
  }
});
test("lost model call retains original input and marks unknown on recovery", async () => {
  const f = await fixture();
  f.hub.message(
    "user",
    "persisted original",
    undefined,
    "pending",
    "test-input",
  );
  f.hub.store.put("invocation", { id: "test-call", status: "calling" });
  end(f);
  const hub = new Hub(join(f.dir, "data"), new FakeCodex() as any);
  try {
    assert.equal(
      hub.store.get("message", "test-input").text,
      "persisted original",
    );
    assert.equal(hub.store.get("invocation", "test-call").status, "unknown");
  } finally {
    hub.store.close();
  }
});
test(
  "Windows credential storage decrypts exact original and binds to endpoint",
  { skip: process.platform !== "win32" },
  async () => {
    const f = await fixture();
    try {
      const v = new Vault(f.dir, "fixture.dpapi");
      await v.save("https://example.invalid/v1", "nonsecret-test-fixture");
      assert.equal(
        await v.get("https://example.invalid/v1"),
        "nonsecret-test-fixture",
      );
      assert.ok(
        !(await readFile(join(f.dir, "fixture.dpapi"), "utf8")).includes(
          "nonsecret-test-fixture",
        ),
      );
      await assert.rejects(v.get("https://other.invalid/v1"));
    } finally {
      end(f);
    }
  },
);
test("non Git isolated output keeps original untouched until explicit integration", async () => {
  const f = await fixture();
  try {
    const t = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      profile: { model: "fixture", effort: "max" },
      requestId: "isolated",
      value: {
        projectId: f.p.id,
        goal: "produce artifact",
        mode: "write",
        isolate: true,
      },
    });
    for (let i = 0; i < 100 && f.hub.scheduling; i++)
      await new Promise((r) => setTimeout(r, 5));
    const r = f.hub.store.get<Run>("run", f.hub.getTask(t.id).runId!)!;
    assert.equal(r.isolation, "output");
    assert.notEqual(r.workPath, f.project);
    const file = join(r.workPath, "result.md");
    await writeFile(file, "isolated fixture");
    await completed(f.hub, f.hub.getTask(t.id));
    const target = join(f.project, "result.md");
    const integrate = () =>
      f.hub.request({ op: "task.integrate", id: t.id, revision: 1 });
    await assert.rejects(readFile(target));
    await writeFile(file, "changed after the run");
    await assert.rejects(integrate(), /回合结束后有变化/);
    assert.equal(f.hub.store.all("integration")[0].state, "rejected");
    await assert.rejects(readFile(target));
    await writeFile(file, "isolated fixture");
    await integrate();
    assert.equal(
      await readFile(join(f.project, "result.md"), "utf8"),
      "isolated fixture",
    );
    await assert.rejects(
      f.hub.request({ op: "task.integrate", id: t.id, revision: 1 }),
    );
    const settled = f.hub.store
      .all("integration")
      .findLast((x) => x.runId === r.id);
    f.hub.store.put("integration", { ...settled, state: "unknown" });
    f.hub.store.put("run", {
      ...f.hub.store.get<Run>("run", r.id)!,
      integratedAt: undefined,
    });
    const reconcile = () =>
      f.hub.request({
        op: "task.integration.reconcile",
        id: t.id,
        runId: r.id,
        revision: 1,
      });
    await writeFile(target, "user-edited output");
    await assert.rejects(reconcile(), /证据不足/);
    assert.equal(f.hub.store.get("integration", settled.id).state, "unknown");
    assert.equal(await readFile(target, "utf8"), "user-edited output");
    await writeFile(target, "isolated fixture");
    assert.deepEqual(await reconcile(), { outcome: "observed" });
    assert.equal(f.hub.store.get("integration", settled.id).state, "completed");
    assert.ok(f.hub.store.get<Run>("run", r.id)?.integratedAt);
  } finally {
    end(f);
  }
});
test("command-created output is captured and altered output blocks acceptance", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    await writeFile(join(f.project, "result.md"), "first");
    const r = await completed(f.hub, t);
    const outputs = f.hub.store.all("artifact");
    assert.equal(outputs.length, 1);
    await writeFile(join(f.project, "result.md"), "changed after completion");
    assert.equal((await f.hub.readArtifact(outputs[0].id)).content, "first");
    await assert.rejects(
      f.hub.request(review(f.hub, r)), /产物已在外部修改/,
    );
  } finally {
    end(f);
  }
});
test("changing accepted upstream goal invalidates an accepted downstream result", async () => {
  const f = await fixture();
  try {
    const a = await created(f);
    const ar = await completed(f.hub, a);
    await f.hub.request(review(f.hub, ar));
    const b = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      profile: { model: "fixture", effort: "max" },
      requestId: "dependent",
      value: {
        projectId: f.p.id,
        goal: "use upstream result",
        mode: "read",
        dependencies: [a.id],
      },
    });
    for (let i = 0; i < 100 && f.hub.scheduling; i++)
      await new Promise((r) => setTimeout(r, 5));
    const br = await completed(f.hub, f.hub.getTask(b.id));
    await f.hub.request(review(f.hub, br));
    await f.hub.request({
      op: "task.revise",
      id: a.id,
      revision: 1,
      goal: "changed source",
      constraints: "",
      acceptance: "",
      model: "",
    });
    assert.equal(f.hub.getTask(b.id).state, "blocked");
    assert.equal(f.hub.getTask(b.id).revision, 2);
    for (let i = 0; i < 100 && f.hub.scheduling; i++)
      await new Promise((r) => setTimeout(r, 5));
  } finally {
    end(f);
  }
});
test("declared file checks complete tasks only from actual current content", async () => {
  const f = await fixture();
  try {
    const t = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      profile: { model: "fixture", effort: "max" },
      requestId: "checked",
      value: {
        projectId: f.p.id,
        goal: "file output",
        mode: "write",
        checks: [{ path: "result.txt", contains: "expected" }],
      },
    });
    for (let i = 0; i < 100 && f.hub.scheduling; i++)
      await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(f.project, "result.txt"), "expected");
    await completed(f.hub, f.hub.getTask(t.id));
    assert.equal(f.hub.getTask(t.id).state, "done");
    assert.equal(
      f.hub.store.all("acceptance")[0].method,
      "declared-file-checks",
    );
  } finally {
    end(f);
  }
});
test("Hub resumes declared file verification after the native ending was committed before a crash", async () => {
  const f = await fixture();
  let reopened: Hub | undefined;
  try {
    const t = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      requestId: "recover-file-check",
      profile: { model: "fixture", effort: "max" },
      value: {
        projectId: f.p.id,
        goal: "check recovered result",
        mode: "write",
        checks: [{ path: "deliverable.txt", contains: "actual content" }],
      },
    });
    while (f.hub.scheduling) await new Promise((done) => setTimeout(done, 5));
    const task = f.hub.getTask(t.id);
    const run = f.hub.store.get<Run>("run", task.runId!)!;
    await writeFile(join(f.project, "deliverable.txt"), "actual content");
    f.hub.store.tx(() => {
      f.hub.store.put("run", {
        ...run,
        state: "ended",
        outcome: "completed",
        response: "fixture result",
      });
      f.hub.saveTask(task, "verifying");
    });
    end(f);
    const adapter = new FakeCodex();
    reopened = new Hub(join(f.dir, "data"), adapter as any);
    await reopened.tick();
    assert.equal(reopened.getTask(t.id).state, "done");
    assert.equal(reopened.store.all("verification").length, 1);
    assert.equal(
      reopened.store.all("acceptance")[0].method,
      "declared-file-checks",
    );
    assert.equal(
      adapter.calls.filter((c) => c.method === "turn/start").length,
      0,
    );
    await reopened.tick();
    assert.equal(reopened.store.all("verification").length, 1);
  } finally {
    if (reopened) {
      reopened.shuttingDown = true;
      reopened.store.close();
    } else if (!f.hub.shuttingDown) end(f);
  }
});
test("failed file acceptance persists a cap of two automatic corrections", async () => {
  const f = await fixture();
  try {
    const t = await submitAgentForm(f.hub.request.bind(f.hub), {
      op: "task.create",
      profile: { model: "fixture", effort: "max" },
      requestId: "missing-check",
      value: {
        projectId: f.p.id,
        goal: "missing output",
        mode: "write",
        checks: [{ path: "missing.txt", contains: "expected" }],
      },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < 100 && f.hub.scheduling; i++)
        await new Promise((r) => setTimeout(r, 5));
      await completed(f.hub, f.hub.getTask(t.id));
      if (attempt < 2) {
        assert.equal(f.hub.getTask(t.id).state, "ready");
        await f.hub.tick();
      }
    }
    assert.equal(f.hub.getTask(t.id).state, "blocked");
    assert.equal(f.hub.getTask(t.id).autoCorrections, 2);
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      3,
    );
  } finally {
    end(f);
  }
});
test("工作方法要有同条件的独立复验，反例撤销且旧备份不复活", async () => {
  const f = await fixture();
  const { hub } = f;
  try {
    const deliver = async (id: string, failureCount: number, pass = true, model = "fixture") => {
      await writeFile(join(f.project, "method.txt"), "wrong");
      const task = await submitAgentForm(hub.request.bind(hub), {
        op: "task.create", requestId: id, profile: { model, effort: "max" },
        value: { projectId: f.p.id, goal: "完成 " + id, mode: "write", access: "project",
          checks: [{ path: "method.txt", contains: "expected" }] },
      });
      for (let i = 0; i <= failureCount; i++) {
        for (let n = 0; n < 100 && hub.scheduling; n++)
          await new Promise((done) => setTimeout(done, 5));
        const current = hub.getTask(task.id);
        assert.equal(current.state, "active");
        if (pass && i === failureCount) await writeFile(join(f.project, "method.txt"), "expected");
        await completed(hub, current);
        if (i < failureCount) await hub.tick();
      }
      return hub.getTask(task.id);
    };
    const a = await deliver("method-provenance", 2);
    assert.equal(a.state, "done");
    const issue = hub.methods.issues()[0];
    assert.equal(issue.failed.length, 2);
    assert.ok(issue.recovery?.verificationId);
    assert.equal(issue.taskId, a.id);
    const candidate = hub.methods.list()[0];
    assert.equal(candidate.state, "candidate");
    const manage = (entry: typeof candidate, action: string) =>
      hub.request({ op: "method.manage", id: entry.id, revision: entry.revision, action });
    await assert.rejects(manage(candidate, "enable"), /不允许/);
    await deliver("method-different-model", 1, true, "other-fixture");
    assert.equal(hub.methods.list()[0].state, "candidate");
    const b = await deliver("method-holdout", 1);
    const verified = hub.methods.list()[0];
    assert.equal(verified.state, "verified");
    assert.deepEqual(verified.proofs.map((p) => p.taskId), [a.id, b.id]);
    for (const proof of verified.proofs) {
      const run = hub.store.get<Run>("run", proof.runId)!;
      assert.ok(run.correctionInput);
      assert.equal(hub.store.get("verification", proof.verificationId!).passed, true);
    }
    await manage(verified, "enable");
    const before = await hub.backup();
    const c = await deliver("method-counterexample", 0, false);
    const last = f.codex.calls.filter((call) => call.method === "turn/start").at(-1);
    assert.match(last.params.input[0].text, /同项目同条件下验证过的做法/);
    assert.equal(last.params.sandboxPolicy.type, "workspaceWrite");
    const invalidated = hub.methods.list()[0];
    assert.equal(invalidated.state, "needs-review");
    assert.equal(invalidated.counterexample?.taskId, c.id);
    assert.equal(c.state, "ready"); // Original correction policy, not a method-granted attempt.
    await hub.restore(before.path);
    assert.equal(hub.methods.list()[0].state, "needs-review");
    await manage(hub.methods.list()[0], "delete");
    await hub.restore(before.path);
    assert.deepEqual(hub.methods.list(), []);
    assert.ok(hub.methods.issues().some((item) => item.taskId === a.id));
  } finally {
    end(f);
  }
});
test("native approval only answers the exact current request and never grants a session rule", async () => {
  const f = await fixture();
  try {
    const t = await created(f);
    const r = f.hub.store.get<Run>("run", t.runId!)!;
    f.hub.handleApproval({
      id: 101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: r.threadId,
        turnId: r.turnId,
        command: "echo safe-fixture",
        cwd: f.project,
        availableDecisions: ["accept", "decline"],
      },
    });
    const a = f.hub.store.all("approval")[0];
    await f.hub.answerApproval(a.id, 1, true);
    assert.deepEqual(f.codex.calls.at(-1).result, { decision: "accept" });
    assert.equal(f.hub.store.all("grant")[0].scope, "single-native-request");
    f.hub.handleApproval({
      id: 101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: r.threadId,
        turnId: r.turnId,
        command: "echo safe-fixture",
        cwd: f.project,
        availableDecisions: ["accept", "decline"],
      },
    });
    assert.equal(f.hub.store.all("approval").length, 1);
    assert.equal(f.hub.store.get("approval", a.id).state, "answered");
    await assert.rejects(f.hub.answerApproval(a.id, 1, true));
  } finally {
    end(f);
  }
});
test("an uncertain native approval response cannot be sent again or re-created after disconnect", async () => {
  const f = await fixture();
  try {
    const task = await created(f);
    const run = f.hub.store.get<Run>("run", task.runId!)!;
    const approvalRequest = {
      id: 201,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: run.threadId,
        turnId: run.turnId,
        command: "echo synthetic",
      },
    };
    f.hub.handleApproval(approvalRequest);
    const approval = f.hub.store.all("approval")[0];
    const reply = f.codex.reply.bind(f.codex);
    let attempted = 0;
    f.codex.reply = () => {
      attempted++;
      throw new RpcError("fixture lost receipt", true);
    };
    await assert.rejects(
      f.hub.answerApproval(approval.id, task.revision, true),
      /结果未知/,
    );
    assert.equal(f.hub.store.get("approval", approval.id).state, "unknown");
    await assert.rejects(
      f.hub.answerApproval(approval.id, task.revision, true),
      /已失效/,
    );
    assert.equal(attempted, 1);
    assert.equal(f.hub.store.all("grant").length, 0);
    f.codex.reply = reply;
    f.codex.emit("disconnect");
    f.hub.handleApproval(approvalRequest);
    assert.equal(f.hub.store.all("approval").length, 1);
    assert.deepEqual(f.codex.calls.at(-1).result, { decision: "decline" });
  } finally {
    end(f);
  }
});
