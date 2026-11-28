import { submitAgentForm } from "../src/shared/agent-form";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { startIntent } from "../src/hub/agents";
import { RpcError } from "../src/adapter/codex";
import { entity } from "../src/hub/store";
import { line } from "../src/hub/agent-ledger";
import type { Memory, Run, Task } from "../src/shared/contracts";
class Native extends EventEmitter {
  initialized = true;
  calls: { method: string; params: any }[] = [];
  ids = 0;
  uncertain = false;
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "project/list") return { data: [], nextCursor: null };
    if (method === "thread/start" || method === "thread/resume")
      return {
        thread: { id: params.threadId || "th-" + ++this.ids },
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
        sandbox: {
          type: params.sandbox === "read-only" ? "readOnly" : "workspaceWrite",
          networkAccess: false,
          writableRoots: [],
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      };
    if (method === "turn/start") return { turn: { id: "turn-" + ++this.ids } };
    if (method === "turn/steer") {
      if (this.uncertain) throw new RpcError("fixture disconnect", true);
      return { turnId: params.expectedTurnId };
    }
    return {};
  }
  async stop() {}
}
async function fixture() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "agents-")),
    native = new Native(),
    h = new Hub(join(dir, "state"), native as any);
  h.store.put("settings", {
    id: "global",
    value: { ...h.settings(), executorBackend: "codex" },
  });
  const projects = [];
  for (const name of ["样本甲", "样本乙"]) {
    const path = join(dir, name);
    await mkdir(path);
    projects.push(await h.request({ op: "project.add", name, path }));
  }
  h.brain.complete = async (_s, p) => ({
    model: "fixture",
    usage: null,
    summary: "公开摘要",
    text: "已讨论该项目要求：" + JSON.parse(p).input,
  });
  h.brain.handoff = async () => ({
    goal: "查验入口文档",
    constraints: "暂缓界面改动",
    acceptance: "列出标题",
    mode: "read",
    ready: true,
    question: "",
  });
  return { h, native, dir, projects };
}
async function scheduled(h: Hub) {
  for (let i = 0; h.scheduling && i < 200; i++)
    await new Promise((r) => setTimeout(r, 5));
}
async function end(h: Hub) {
  await scheduled(h);
  h.shuttingDown = true;
  h.store.close();
}
async function open(h: Hub, text: string, requestId: string) {
  return (await confirmed(h, await h.request({ op: "chat", text, requestId })))
    .openAgentId as string;
}
async function confirmed(h: Hub, result: any) {
  if (!result.launchId) return result;
  return h.request({
    op: "agent.launch.confirm",
    id: result.launchId,
    profile: { model: "gpt-6.2-sol", effort: "max" },
  });
}
async function talk(h: Hub, agentId: string, text: string, requestId: string) {
  return confirmed(
    h,
    await h.request({ op: "agent.send", agentId, text, requestId }),
  );
}
async function chatWorker(
  h: Hub,
  task: Task,
  run: Run,
  text: string,
  id: string,
  mode = "now",
) {
  return h.request({
    op: "agent.send",
    agentId: "exec:" + task.id,
    text,
    requestId: id,
    mode,
    runId: run.id,
    turnId: run.turnId,
    revision: task.revision,
  });
}
async function finish(h: Hub, r: Run) {
  await h.handleEvent({
    method: "item/completed",
    params: {
      threadId: r.threadId,
      turnId: r.turnId,
      item: { id: "answer", type: "agentMessage", text: "已核对入口。" },
    },
  });
  await h.handleEvent({
    method: "turn/completed",
    params: {
      threadId: r.threadId,
      turn: { id: r.turnId, status: "completed" },
    },
  });
}
test("discussion, decision, scoped delegation, cross-project continuity and report survive restart", async () => {
  const { h, dir, native } = await fixture();
  let reopened: Hub | undefined;
  try {
    const a = await open(h, "为样本甲新开「桌面交互」需求讨论", "open-a");
    assert.ok(a);
    const b = await open(h, "为样本乙新开「安装方式」需求讨论", "open-b");
    assert.ok(b);
    await talk(h, b, "乙项目限定内容：独立包装", "b1");
    await talk(h, a, "确定：本次只读核对入口文档", "a1");
    assert.equal(h.store.all("task").length, 0);
    assert.equal(await open(h, "继续昨天样本甲的桌面交互讨论", "resume"), a);
    await h.request({ op: "agent.draft", agentId: b, text: "乙草稿" });
    const auth = "按刚才讨论的方案做；界面暂缓。";
    const result = await talk(h, a, auth, "go");
    await scheduled(h);
    assert.ok(result.worker);
    const t = h.store.all<Task>("task")[0],
      r = h.store.get<Run>("run", t.runId!)!;
    assert.equal(h.desk.agent(result.worker).parentAgentId, a);
    const prompt = native.calls.find((x) => x.method === "turn/start")!.params
      .input[0].text;
    assert.ok(prompt.includes(auth));
    assert.ok(!prompt.includes("独立包装"));
    assert.equal(t.mode, "read");
    assert.equal((await talk(h, a, auth, "go")).worker, result.worker);
    await talk(h, a, auth, "go-again");
    assert.equal(h.store.all("task").length, 1);
    await finish(h, r);
    assert.equal(h.getTask(t.id).state, "verifying");
    const snap = await h.snapshot();
    assert.ok(
      snap.messages.some(
        (m) => m.id === "result:" + r.id && m.linkAgentId === result.worker,
      ),
    );
    assert.ok(h.desk.view(a).lines.some((l) => l.label === "执行回报"));
    assert.ok(!h.desk.view(b).lines.some((l) => l.label === "执行回报"));
    await end(h);
    reopened = new Hub(join(dir, "state"), new Native() as any);
    assert.equal(reopened.desk.view(b).draft, "乙草稿");
    assert.equal(reopened.desk.agent(result.worker).parentAgentId, a);
  } finally {
    if (reopened) await end(reopened);
    else if (!h.shuttingDown) await end(h);
  }
});

test("explicit project decisions are manageable and stale discussion content cannot enter a new handoff", async () => {
  const { h, projects } = await fixture();
  try {
    const a = h.desk.open(projects[0], "入口交接");
    const phrase = "合成决定：仅核对入口固定标识";
    const replies: any[] = [],
      handoffs: any[] = [];
    h.brain.complete = async (_cfg, input) => {
      const context = JSON.parse(input);
      replies.push(context);
      return {
        model: "fixture",
        usage: null,
        text: context.rules.join("\n") || "给出普通建议",
      };
    };
    const out = h.brain.handoff.bind(h.brain);
    h.brain.handoff = async (cfg, input, report) => {
      handoffs.push(JSON.parse(input));
      return out(cfg, input, report);
    };
    await talk(h, a.id, "请整理入口交接目标", "goal");
    await talk(h, a.id, "可以", "generic-approval");
    await talk(h, a.id, "项目规则太复杂了", "comment");
    assert.equal((await h.snapshot()).memories.length, 0);

    await talk(h, a.id, "项目决定：" + phrase, "decision");
    const rule = (await h.snapshot()).memories[0];
    assert.equal(rule.projectId, projects[0].id);
    assert.equal(rule.enabled, true);
    assert.deepEqual(rule.decision, {
      agentId: a.id,
      lineIds: ["user:decision"],
    });
    assert.match(JSON.stringify(replies.at(-1).rules), /入口固定标识/);
    assert.deepEqual(h.rules(projects[1].id), []);
    const send = (requestId: string) =>
      h.request({
        op: "agent.send",
        agentId: a.id,
        text: "开始执行，只核对入口",
        requestId,
      });
    const stale = await send("first-handoff");
    assert.ok(stale.launchId);
    assert.ok(JSON.stringify(handoffs[0].decisions).includes(phrase));
    await h.request({
      op: "memory.save",
      id: rule.id,
      revision: rule.revision,
      text: rule.text,
      projectId: rule.projectId,
      enabled: false,
    });
    assert.equal((await h.snapshot()).launches.length, 0);
    await assert.rejects(confirmed(h, stale), /不能重复创建|已处理/);
    await talk(h, a.id, "现在有哪些已启用规则？", "query");
    assert.ok(!JSON.stringify(replies.at(-1)).includes(phrase));
    const fresh = await send("fresh-handoff");
    assert.ok(fresh.launchId && fresh.launchId !== stale.launchId);
    assert.ok(!JSON.stringify(handoffs.at(-1)).includes(phrase));
    assert.ok(h.desk.view(a.id).lines.some((l) => l.text.includes(phrase)));
    assert.equal(h.store.all("task").length, 0);
  } finally {
    await end(h);
  }
});

test("discussion preview survives restart, binds the actual material and only dispatches on confirmation", async () => {
  const { h, native, dir, projects } = await fixture();
  let current = h;
  try {
    const a = h.desk.open(projects[0], "修复入口"), b = h.desk.open(projects[1], "其他讨论");
    line(h.store, a.id, "user", "你", "保留返回入口", { id: "preview-source" });
    line(h.store, b.id, "user", "你", "另一个项目的材料", { id: "outside-preview" });
    h.store.put("settings", { id: "global", value: { ...h.settings(), defaultAdvance: "loop-native" } });
    const text = "修复当前项目入口；返回按钮仍能回首页。";
    await h.request({ op: "agent.draft", agentId: a.id, text });
    const calls: unknown[] = [];
    h.brain.handoff = async (_settings, input, _report, preview) => {
      assert.equal(preview, true);
      calls.push(JSON.parse(input));
      return { ready: true, goal: "修复当前项目入口", mode: "write", constraints: "保留返回入口", acceptance: "返回按钮回首页", question: "" };
    };
    const request = { op: "discussion.prepareHandoff", agentId: a.id, text, requestId: "preview-one" };
    const result = await h.request(request);
    assert.deepEqual(await h.request(request), result);
    assert.equal(calls.length, 1);
    assert.equal(h.store.all("task").length, 0);
    assert.equal(h.store.all("run").length, 0);
    assert.equal(native.calls.length, 0);
    assert.equal(h.desk.view(a.id).draft, text);
    assert.ok(!h.store.get("agent-line", "user:preview-one"));
    const card = h.launches.pending().find(c => c.id === result.launchId)!;
    assert.equal(card.scope, "project");
    assert.equal(card.backend, "codex");
    assert.equal(card.handoff?.request, text);
    assert.equal(card.handoff?.acceptance, "返回按钮回首页");
    assert.match(card.handoff?.constraints ?? "", /保留返回入口/);
    assert.deepEqual(card.handoff?.discussion.map(row => row.id), ["preview-source"]);
    assert.doesNotMatch(JSON.stringify(calls), /另一个项目/);
    await end(h);
    current = new Hub(join(dir, "state"), native as any);
    assert.deepEqual(current.launches.pending().find(c => c.id === result.launchId), card);
    const created = await confirmed(current, result);
    assert.deepEqual(await confirmed(current, result), created);
    assert.equal(current.store.all("task").length, 1);
    const task = current.getTask(created.id);
    assert.equal(task.loopId, undefined);
    assert.equal(task.acceptance, card.handoff?.acceptance);
    const basis = current.store.get("agent-bridge", task.id);
    assert.deepEqual(basis?.discussion.map((row: { id: string }) => row.id), ["preview-source"]);
  } finally { await end(current); }
});

test("unclear, cancelled and stale discussion previews cannot create work or arm a later handoff", async () => {
  const { h, native, projects } = await fixture();
  try {
    const a = h.desk.open(projects[0], "询问交付"), text = "修复入口";
    const prepare = (requestId: string) => h.request({ op: "discussion.prepareHandoff", agentId: a.id, text, requestId });
    h.brain.handoff = async () => ({ ready: true, goal: "修复入口", mode: "write", constraints: "", acceptance: "", question: "" });
    const unclear = await prepare("unclear");
    assert.equal(unclear.question, "怎样算这项工作完成？");
    assert.equal(h.store.get("agent-pending-handoff", a.id), undefined);
    await talk(h, a.id, "返回按钮回首页", "ordinary-reply");
    assert.equal(h.launches.pending().length, 0);
    h.brain.handoff = async () => ({ ready: true, goal: "修复入口", mode: "write", constraints: "", acceptance: "返回按钮回首页", question: "" });
    const cancelled = await prepare("cancelled");
    await h.request({ op: "agent.launch.cancel", id: cancelled.launchId });
    await assert.rejects(confirmed(h, cancelled), /已处理/);
    const stale = await prepare("stale-preview");
    line(h.store, a.id, "user", "你", "范围还要重新核对", { id: "changed-source" });
    await assert.rejects(confirmed(h, stale), /讨论内容已更新/);
    const ruleStale = await prepare("stale-rule-preview");
    await h.request({ op: "memory.save", projectId: a.projectId, text: "必须保留全部原文", enabled: true });
    await assert.rejects(confirmed(h, ruleStale), /已处理/);
    assert.equal(h.store.all("task").length, 0);
    assert.equal(h.store.all("run").length, 0);
    assert.equal(native.calls.length, 0);
  } finally { await end(h); }
});

test("deleting a migrated project decision keeps it out of an older restored handoff", async () => {
  const { h, projects, dir } = await fixture();
  let reopened: Hub | undefined;
  try {
    const project = projects[0],
      a = h.desk.open(project, "旧版决定");
    const phrase = "项目决定：旧版合成记录标记";
    const source = line(h.store, a.id, "user", "你", phrase);
    const old = {
      ...entity(),
      text: phrase,
      projectId: project.id,
      agentId: a.id,
      sourceLineId: source.id,
    };
    const briefApproval = line(h.store, a.id, "user", "你", "同意");
    h.store.put("agent-decision", old);
    h.store.put("agent-decision", {
      ...entity(),
      text: "候选文字\n用户确认：可以",
      projectId: project.id,
      agentId: a.id,
      sourceLineId: briefApproval.id,
    });
    h.desk.note("讨论决定 · " + phrase, a, old.id);
    const task = {
      ...entity(),
      projectId: project.id,
      goal: "核对入口",
      title: "合成工作",
      mode: "read",
      state: "paused",
      revision: 1,
      attempt: 0,
      dependencies: [],
      attachments: [],
    } as unknown as Task;
    h.store.put("agent-bridge", {
      id: task.id,
      agentId: a.id,
      projectId: project.id,
      decisions: [phrase],
      authorization: "核对入口",
      discussion: [{ id: source.id, role: "user", text: phrase }],
    });
    const backup = await h.backup();
    await end(h);
    reopened = new Hub(join(dir, "state"), new Native() as any);
    const decision = reopened.store.get<Memory>("memory", old.id)!;
    assert.equal(decision.enabled, true);
    const migrated = reopened.store.all<Memory>("memory");
    assert.equal(migrated.filter((m) => m.enabled).length, 1);
    assert.equal(reopened.store.all("agent-decision").length, 0);
    assert.ok(!reopened.store.get("message", old.id).text.includes(phrase));
    await reopened.request({ op: "memory.delete", id: old.id });
    await reopened.restore(backup.path);
    assert.equal(reopened.store.get<Memory>("memory", old.id)?.deleted, true);
    assert.equal(reopened.store.get<Memory>("memory", old.id)?.text, "");
    assert.deepEqual(reopened.rules(project.id), []);
    const context = await reopened.context(task, project, []);
    assert.ok(!context.prompt.includes(phrase));
    assert.ok(
      reopened.desk.view(a.id).lines.some((entry) => entry.id === source.id),
    );
  } finally {
    if (reopened) await end(reopened);
    else if (!h.shuttingDown) await end(h);
  }
});
test("ambiguous discussions ask before opening and never create a worker", async () => {
  const { h, projects } = await fixture();
  try {
    const a = h.desk.open(projects[0], "交互一"),
      b = h.desk.open(projects[0], "交互二");
    const out = await h.request({
      op: "chat",
      text: "继续样本甲上次的需求讨论",
      requestId: "ask",
    });
    assert.ok(out.choices);
    const msg = h.store.all("message").find((m) => m.choices?.length === 2)!;
    const i = msg.choices.findIndex((c: any) => c.agentId === b.id);
    const result = await h.request({
      op: "agent.choose",
      messageId: msg.id,
      index: i,
      requestId: "chosen",
    });
    assert.equal(result.openAgentId, b.id);
    assert.notEqual(b.id, a.id);
    await assert.rejects(
      h.request({
        op: "agent.choose",
        messageId: msg.id,
        index: 0,
        requestId: "replay",
      }),
    );
    assert.equal(h.store.all("task").length, 0);
  } finally {
    await end(h);
  }
});
test("steering is addressed to one exact native turn; queue waits, starts once, and resumes the original thread", async () => {
  const { h, native, projects } = await fixture();
  try {
    const task = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: { model: "fixture", effort: "max" },
      value: { projectId: projects[0].id, goal: "读取文档" },
      requestId: "task",
    });
    await scheduled(h);
    const t = h.getTask(task.id),
      r = h.store.get<Run>("run", t.runId!)!;
    await chatWorker(h, t, r, "只核对标题", "s");
    await chatWorker(h, t, r, "只核对标题", "s");
    const calls = native.calls.filter((c) => c.method === "turn/steer");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.expectedTurnId, r.turnId);
    await assert.rejects(
      chatWorker(h, t, { ...r, turnId: "other" }, "旧轮次", "stale"),
    );
    for (const delta of ["甲", "甲"])
      await h.handleEvent({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: r.threadId,
          turnId: r.turnId,
          itemId: "x",
          summaryIndex: 0,
          delta,
        },
      });
    await h.handleEvent({
      method: "item/reasoning/textDelta",
      params: {
        threadId: r.threadId,
        turnId: r.turnId,
        itemId: "x",
        delta: "不可展示材料",
      },
    });
    const before = h.desk.view("exec:" + t.id).lines;
    assert.ok(before.some((l) => l.text === "甲甲"));
    assert.ok(!JSON.stringify(before).includes("不可展示材料"));
    await chatWorker(h, t, r, "下一轮再复核", "q", "queue");
    assert.equal(h.store.get("agent-line", "user:q").status, "queued");
    await finish(h, r);
    await scheduled(h);
    const turns = native.calls.filter((c) => c.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.ok(turns[1].params.input[0].text.includes("下一轮再复核"));
    assert.equal(turns[1].params.threadId, r.threadId);
    assert.equal(h.store.get("agent-line", "user:q").status, "sent");
    const next = h.getTask(t.id);
    await assert.rejects(chatWorker(h, t, r, "过期", "late"));
    const rr = h.store.get<Run>("run", next.runId!)!;
    native.uncertain = true;
    const u = await chatWorker(h, next, rr, "回执丢失的补充", "u");
    assert.ok(u.error);
    assert.equal(h.store.get("agent-line", "user:u").status, "unknown");
    await assert.rejects(chatWorker(h, next, rr, "回执丢失的补充", "u2"));
    assert.equal(
      native.calls.filter((c) => c.method === "turn/steer").length,
      2,
    );
  } finally {
    await end(h);
  }
});
test("approval, questions, quoted and deferred instructions do not authorize implementation", () => {
  for (const x of [
    "这个设计可以",
    "先讨论，别开工",
    "我没说按这个做",
    "如果按这个方案做，会怎样",
    "我们讨论一下按这个做的风险",
    "等我说‘开始执行’再开工",
    "暂时先不做",
    "是否按这个做？",
    "请不要执行",
    "按这个做之前先聊聊",
  ])
    assert.equal(startIntent(x), false, x);
  for (const x of [
    "按这个方案做",
    "先把树做出来，插话先不做",
    "样本甲按昨天讨论的方案做",
    "开始执行",
  ])
    assert.equal(startIntent(x), true, x);
});
test("one chief request delegates only project A and answers project B separately; a quoted exclusion stays in the handoff", async () => {
  const { h, native, projects } = await fixture();
  try {
    const a = h.desk.open(projects[0], "入口验收");
    await talk(h, a.id, "要求是只读核对入口，不修改文件。", "scope");
    const b = projects[1];
    let other = false;
    const chat = h.chat.bind(h);
    h.chat = async (text, id, ...rest) => {
      if (id.startsWith("also:")) {
        other = text.includes(b.name);
        return { saved: true, proposal: null };
      }
      return chat(text, id, ...rest);
    };
    const cmd = "样本甲按昨天讨论的方案做；界面暂缓";
    await confirmed(
      h,
      await h.request({
        op: "chat",
        text: cmd + "。另外看看样本乙项目的进度",
        requestId: "multi",
      }),
    );
    await scheduled(h);
    assert.equal(other, true);
    const t = h.store.all<Task>("task")[0];
    assert.equal(t.projectId, projects[0].id);
    assert.equal(t.mode, "read");
    assert.equal(h.store.get("agent-bridge", t.id).authorization, cmd);
    const out = await talk(h, a.id, "补充给执行者：只核对第一行。", "relay");
    assert.ok(out.saved);
    assert.equal(
      native.calls.filter((x) => x.method === "turn/steer").length,
      1,
    );
    assert.ok(
      h.desk.view(a.id).lines.some((l) => l.label === "已补充给执行 Agent"),
    );
    const child = await submitAgentForm(h.request.bind(h), {
      op: "agent.delegate",
      profile: { model: "fixture", effort: "high" },
      agentId: "exec:" + t.id,
      goal: "核对入口命名",
      requestId: "delegate",
    });
    assert.equal(h.desk.agent(child.worker).parentAgentId, "exec:" + t.id);
    assert.equal(h.getTask(h.desk.agent(child.worker).taskId!).mode, "read");
    assert.equal(
      native.calls.filter((x) => x.method === "turn/start").length,
      1,
    );
  } finally {
    await end(h);
  }
});
test("direct work with no project discussion, unresolved plan and native history are distinct paths", async () => {
  const { h, projects, native } = await fixture();
  try {
    h.brain.handoff = async () => ({
      ready: false,
      goal: "",
      constraints: "",
      acceptance: "",
      mode: "read",
      question: "要核对哪个文件？",
    });
    await h.request({
      op: "chat",
      text: "样本甲按这个方案做",
      requestId: "empty-plan",
    });
    assert.equal(h.store.all("task").length, 0);
    h.brain.handoff = async () => ({
      ready: true,
      goal: "核对入口",
      constraints: "只读",
      acceptance: "标题",
      mode: "read",
      question: "",
    });
    const direct = await confirmed(
      h,
      await h.request({
        op: "chat",
        text: "样本甲开始执行只读核对入口",
        requestId: "direct",
      }),
    );
    await scheduled(h);
    assert.equal(h.desk.agent(direct.worker).parentAgentId, "chief");
    assert.equal(h.desk.discussions().length, 0);
    const p = projects[1],
      original = native.call.bind(native);
    native.call = async (method: string, params: any) =>
      method === "thread/list"
        ? ({
            data: [{ id: "fixture-native", name: "旧议题", cwd: p.path }],
          } as any)
        : method === "thread/read"
          ? ({
              thread: {
                id: "fixture-native",
                name: "旧议题",
                cwd: p.path,
                turns: [
                  {
                    id: "native-t",
                    status: "completed",
                    items: [
                      {
                        id: "native-message",
                        type: "userMessage",
                        content: [{ type: "text", text: "原生公开消息" }],
                      },
                      { type: "reasoning", content: "私有字段" },
                    ],
                  },
                ],
              },
            } as any)
          : original(method, params);
    h.owner.owner = async () => null;
    const external = await h.request({
      op: "chat",
      text: "继续样本乙的「旧议题」讨论",
      requestId: "external",
    });
    assert.equal(external.native.threadId, "fixture-native");
    assert.equal(h.desk.discussions().length, 0);
    const imported = await confirmed(
      h,
      await h.request({
        op: "discussion.fromNative",
        ...external.native,
        requestId: "import",
      }),
    );
    const v = h.desk.view(imported.openAgentId);
    assert.ok(v.lines.some((x) => x.text === "原生公开消息"));
    assert.ok(!JSON.stringify(v).includes("私有字段"));
    assert.equal(h.store.all("task").length, 1);
  } finally {
    await end(h);
  }
});

test("总管一句循环指令覆盖单次默认，跳过已有讨论和模型定约，重复请求不重派", async () => {
  const { h, projects } = await fixture();
  h.dsh.probe = async () => ({ status: "fixture", version: "test-only" });
  h.brain.configured = async () => false;
  h.brain.handoff = async () => { throw new Error("清楚的交办不需要模型定约"); };
  try {
    h.desk.open(projects[0], "方案甲");
    h.desk.open(projects[0], "方案乙");
    assert.equal(h.settings().defaultAdvance, "single");
    const goal = "制作可交互的技术美术样例，可用 Blender，不要写项目外文件";
    const command = { op: "chat", text: "总管，帮我循环推进 样本甲：" + goal, requestId: "direct-loop" };
    const result = await h.request(command);
    assert.equal(result.launchId, undefined);
    const task = h.getTask(result.id);
    assert.equal(task.advance, "loop-native");
    assert.equal(task.projectId, projects[0].id);
    assert.equal(task.goal, goal);
    assert.equal(task.backend, "dsh");
    assert.equal(h.desk.agent(result.worker).parentAgentId, "chief");
    assert.equal(h.store.get("agent-bridge", task.id)?.authorization, command.text);
    assert.deepEqual(await h.request(command), result);
    assert.equal(h.store.all("task").length, 1);
    assert.equal(h.settings().defaultAdvance, "single");
  } finally {
    h.shuttingDown = true;
    await h.loop.shutdown();
    await end(h);
  }
});

test("总管只询问未确定的项目；咨询、延期、只读和空目标不会启动原生循环", async () => {
  const { h, projects } = await fixture();
  h.chat = async () => ({ saved: true });
  h.dsh.probe = async () => ({ status: "fixture", version: "test-only" });
  h.brain.configured = async () => false;
  try {
    for (const [index, text] of [
      "循环推进是什么",
      "循环推进 样本甲：怎么用？",
      "示例是「循环推进 样本甲：修好布局」",
      "循环推进 样本甲：暂不执行，等我确认",
      "循环推进 样本甲：只读检查布局",
      "循环推进 样本甲：",
      "循环推进 样本甲",
      "循环推进 不存在的项目：修好布局",
    ].entries()) {
      await h.request({ op: "chat", text, requestId: "no-loop-" + index });
      assert.equal(h.store.all("task").length, 0, text);
    }
    const goal = "修好首页在手机上的布局";
    const first = await h.request({ op: "chat", text: "循环推进：" + goal, requestId: "ambiguous-loop" });
    assert.equal(first.choices, true);
    assert.equal(h.store.all("task").length, 0);
    const choice = h.store.all("message").findLast((m) => m.choices?.length);
    const index = choice.choices.findIndex((p: { projectId: string }) => p.projectId === projects[1].id);
    const result = await h.request({ op: "agent.choose", messageId: choice.id, index, requestId: "choose-loop" });
    assert.equal(h.getTask(result.id).advance, "loop-native");
    assert.equal(h.getTask(result.id).projectId, projects[1].id);
    assert.equal(h.getTask(result.id).goal, goal);
  } finally {
    h.shuttingDown = true;
    await h.loop.shutdown();
    await end(h);
  }
});

test("明确交办循环工作直接启动原生编排，单次与只读工作保留确认", async () => {
  const { h, projects } = await fixture();
  const settings = h.settings();
  await h.request({
    op: "settings",
    value: { ...settings, defaultAdvance: "loop" },
  });
  h.dsh.probe = async () => ({ status: "fixture", version: "test-only" });
  h.brain.handoff = async () => ({
    ready: true,
    goal: "已整理项目实现范围",
    constraints: "仅在项目内",
    acceptance: "",
    mode: "write",
    question: "",
  });
  h.brain.configured = async () => false;
  try {
    const instruction = "样本甲开始执行，修改标签格式";
    const first = await h.request({
      op: "chat",
      text: instruction,
      requestId: "loop-chief",
    });
    assert.ok(first.worker && first.id);
    assert.equal(first.state, "ready");
    assert.equal(first.launchId, undefined);
    assert.equal(h.getTask(first.id).backend, "dsh");
    assert.equal(h.getTask(first.id).advance, "loop-native");
    assert.equal(
      h.store.get("agent-bridge", first.id)?.authorization,
      instruction,
    );
    assert.deepEqual(
      await h.request({
        op: "chat",
        text: instruction,
        requestId: "loop-chief",
      }),
      first,
    );
    const discussion = h.desk.open(projects[1], "循环交付");
    await talk(
      h,
      discussion.id,
      "修改标签格式，保留原有用法。",
      "input-loop-document",
    );
    const handoff = await h.request({
      op: "agent.send",
      agentId: discussion.id,
      text: "按这个方案做，开始执行",
      requestId: "loop-discussion",
    });
    assert.equal(handoff.launchId, undefined);
    assert.equal(handoff.state, "ready");
    assert.equal(h.desk.agent(handoff.worker).parentAgentId, discussion.id);
    assert.ok(h.store.get("agent-bridge", handoff.id)?.discussion.length);
    assert.equal(h.launches.pending().length, 0);
    const read = await h.request({
      op: "chat",
      text: "样本甲开始执行只读核对入口",
      requestId: "loop-default-read",
    });
    assert.ok(read.launchId);
    await h.request({ op: "settings", value: settings });
    const single = await h.request({
      op: "chat",
      text: "样本甲开始执行，修改结果文档",
      requestId: "single-default-write",
    });
    assert.ok(single.launchId);
    assert.equal(h.store.all("task").length, 2);
  } finally {
    h.shuttingDown = true;
    await h.loop.shutdown();
    await end(h);
  }
});
