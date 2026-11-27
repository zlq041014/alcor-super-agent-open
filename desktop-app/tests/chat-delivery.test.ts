import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { ModelRequestError } from "../src/hub/brain";
import { RpcError } from "../src/adapter/codex";
import { CHIEF, type Message, type AgentLine } from "../src/shared/contracts";
import { outgoing, withEchoes } from "../src/ui/outgoing";
import { assigned, line } from "../src/hub/agent-ledger";
import { entity } from "../src/hub/store";
import { submitAgentForm } from "../src/shared/agent-form";
async function fixture() {
  const base = resolve(".test-data");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "delivery-")),
    h = new Hub(join(dir, "state"));
  const p = await h.request({ op: "project.add", path: dir, name: "样例项目" });
  h.store.put("catalog", {
    id: "codex",
    status: "ready",
    count: 1,
    checkedAt: new Date().toISOString(),
  });
  return { h, p };
}
test("总管修正无效回复一次，分别保留用量；拒绝无效建议和网络重发", async () => {
  const { h } = await fixture();
  let calls = 0;
  const send = (text: string) => h.request({ op: "chat", requestId: crypto.randomUUID(), text });
  try {
    h.brain.request = async (_settings, _route, body) => {
      calls++;
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.reasoning_effort, h.settings().reasoningEffort);
      const repaired = calls === 2;
      if (repaired) assert.match(body.messages[0].content, /上一份输出未通过格式校验/);
      return {
        model: "fixture",
        usage: { total_tokens: calls * 10 },
        choices: [{ message: { content: repaired
          ? JSON.stringify({ reply: "在新建工作选择循环推进，再点创建并推进。", proposal: null })
          : "这段纯文本不符合协议。",
        } }],
      };
    };
    await send("是的，我怎么开启循环推动完成一个项目呢");
    assert.equal(calls, 2);
    assert.match(h.store.all<Message>("message").at(-1)!.text, /创建并推进/);
    const used = h.store.all("invocation");
    assert.deepEqual(used.map(i => [i.status, i.usage.total_tokens]), [["failed", 10], ["completed", 20]]);

    h.brain.request = async () => {
      calls++;
      return { model: "fixture", choices: [{ message: { content: '{"proposal":"start"}' } }] };
    };
    const failed = await send("再解释一下怎么使用");
    assert.match(failed.error, /格式无效/);
    assert.equal(calls, 4);

    h.brain.request = async () => {
      calls++;
      throw new ModelRequestError("连接错误夹具", 503);
    };
    const unavailable = await send("请告诉我入口在哪");
    assert.match(unavailable.error, /连接错误夹具/);
    assert.equal(calls, 5);
    assert.equal(h.store.all("task").length, 0);
    assert.equal(h.store.all("run").length, 0);
  } finally {
    h.store.close();
  }
});
test("root persists receipt before a delayed reply, keeps even an identical new draft, and does not double-submit a request", async () => {
  const { h } = await fixture();
  let begin!: () => void,
    finish!: () => void,
    calls = 0;
  const started = new Promise<void>((r) => (begin = r)),
    hold = new Promise<void>((r) => (finish = r));
  h.brain.advise = async () => {
    calls++;
    begin();
    await hold;
    return {
      text: "好",
      usage: null,
      model: "fixture",
      advice: { reply: "好", proposal: null },
    };
  };
  try {
    await h.request({ op: "draft", text: "同一句话" });
    const req = { op: "chat", text: "同一句话", requestId: "root-1" };
    const send = h.request(req);
    assert.equal(h.store.get<Message>("message", "root-1")?.status, "pending");
    assert.equal(h.store.get("draft", "main").text, "");
    await started;
    await h.request({ op: "draft", text: "同一句话" });
    await h.request(req);
    await assert.rejects(h.request({ ...req, text: "另一个请求" }));
    finish();
    await send;
    assert.equal(calls, 1);
    assert.equal(h.store.get("draft", "main").text, "同一句话");
    assert.equal(
      h.store.all<Message>("message").filter((m) => m.role === "user").length,
      1,
    );
  } finally {
    finish();
    h.store.close();
  }
});

test("project history searches actual conversations even when their work titles do not match", async () => {
  const { h, p } = await fixture();
  try {
    const otherPath = join(p.path, "other");
    await mkdir(otherPath);
    const other = await h.request({
      op: "project.add",
      path: otherPath,
      name: p.name,
    });
    const discussion = h.desk.open(p, "旧讨论");
    const otherAgent = h.desk.open(other, "同名项目的讨论");
    const task = {
      ...entity(),
      projectId: p.id,
      title: "仅核对版本",
      goal: "核对",
      constraints: "",
    };
    h.store.put("task", task);
    const worker = assigned(h.store, task as any);
    line(h.store, discussion.id, "assistant", "讨论 Agent", "NeEdLe 讨论回复", {
      id: "discussion-match",
    });
    line(h.store, worker.id, "assistant", "执行 Agent", "needle 工作结果", {
      id: "worker-match",
      runId: "already-rendered-run",
    });
    h.store.put("run", {
      ...entity(),
      id: "old-run",
      taskId: task.id,
      response: "needle 旧回合原始回复",
    });
    h.store.put("run", {
      ...entity(),
      id: "already-rendered-run",
      taskId: task.id,
      response: "needle 已有对话副本",
    });
    line(h.store, otherAgent.id, "user", "你", "needle 另一项目", {
      id: "other-match",
    });
    line(h.store, worker.id, "tool", "工具", "needle 原始工具输出", {
      id: "tool-match",
    });
    h.store.put("message", {
      ...entity(),
      id: "project-message",
      role: "assistant",
      text: "needle 项目答复",
      projectId: p.id,
    });
    h.message(
      "user",
      "needle 本任务的总管消息",
      task.id,
      undefined,
      "task-message",
    );
    h.message(
      "user",
      "needle 全局消息",
      undefined,
      undefined,
      "global-message",
    );
    h.store.put("message", {
      ...entity(),
      id: "duplicate-intent",
      role: "user",
      audience: "executor",
      text: "needle 已在执行分支显示的意图",
      taskId: task.id,
    });
    h.store.put("message", {
      ...entity(),
      id: "native-message",
      role: "user",
      status: "native-owner",
      text: "needle 本地记录的原生发送",
      projectId: p.id,
    });
    h.store.put("native-action", {
      id: "native-message",
      threadId: "external",
    });
    h.ensureCodex = async () =>
      assert.fail("历史搜索必须可在原生后端离线时运行");

    const scoped = await h.request({
      op: "search",
      text: "  NEEDLE ",
      projectId: p.id,
    });
    assert.deepEqual(scoped.tasks, []);
    assert.deepEqual(
      new Set(scoped.messages.map((m: any) => m.id)),
      new Set([
        "discussion-match",
        "worker-match",
        "project-message",
        "task-message",
        "native-message",
        "history-reply:old-run",
      ]),
    );
    const results = new Map(scoped.messages.map((m: any) => [m.id, m]));
    const literal = h.message("assistant", "保存了 ÉCLAIR_100% 标记");
    h.message("assistant", "相似但不同的 éclair-100x 标记");
    const accented = await h.request({ op: "search", text: "éclair_100%" });
    assert.deepEqual(accented.messages.map((m: any) => m.id), [literal.id]);
    assert.deepEqual(
      [...results.values()].map((m: any) => m.projectId),
      Array(6).fill(p.id),
    );
    assert.equal(
      (results.get("discussion-match") as any)?.agentId,
      discussion.id,
    );
    assert.equal((results.get("task-message") as any)?.agentId, CHIEF);
    assert.equal(
      (results.get("native-message") as any)?.nativeThreadId,
      "external",
    );
    assert.equal((results.get("history-reply:old-run") as any)?.legacy, true);

    for (let i = 0; i < 61; i++) h.message("assistant", "共同检索标记 " + i);
    const limited = await h.request({ op: "search", text: "共同检索标记" });
    assert.equal(limited.messages.length, 60);
    assert.equal(limited.moreMessages, true);
  } finally {
    h.store.close();
  }
});
test("a rejected executor message is retained once in its own conversation, with no native dispatch or silent retry", async () => {
  const { h, p } = await fixture();
  try {
    const a = {
      ...h.desk.open(p, "讨论"),
      id: "fixture-worker",
      kind: "executor",
      taskId: "fixture-task",
    };
    h.store.put("agent", a);
    h.store.put("task", {
      id: a.taskId,
      projectId: p.id,
      state: "active",
      revision: 3,
    });
    h.store.put("draft", { id: "agent:" + a.id, text: "过期回合补充" });
    const r = {
      op: "agent.send",
      agentId: a.id,
      text: "过期回合补充",
      requestId: "stale-turn",
      revision: 1,
      runId: "before",
      turnId: "old",
    };
    await assert.rejects(h.request(r), /轮次已变化/);
    const l = h.store.get<AgentLine>("agent-line", "user:stale-turn");
    assert.equal(l?.agentId, a.id);
    assert.equal(l?.text, r.text);
    assert.equal(l?.status, "failed");
    assert.equal(h.store.get("draft", "agent:" + a.id).text, "");
    await h.request(r);
    assert.equal(
      h.desk.view(a.id).lines.filter((x) => x.id === "user:stale-turn").length,
      1,
    );
    assert.equal(h.store.all("run").length, 0);
  } finally {
    h.store.close();
  }
});
test("choice replies and repeated handoff instructions keep one public user row each without duplicating work", async () => {
  const { h, p } = await fixture();
  try {
    const a = h.desk.open(p, "甲"),
      b = h.desk.open(p, "乙");
    await h.request({
      op: "chat",
      text: "继续样例项目上次的讨论",
      requestId: "ambiguous",
    });
    const m = h.store.all<Message>("message").find((x) => x.choices?.length)!;
    const idx = m.choices!.findIndex((x) => x.agentId === b.id);
    const picked = await h.request({
      op: "chat",
      text: String(idx + 1),
      requestId: "choice-text",
    });
    assert.equal(picked.openAgentId, b.id);
    assert.equal(h.store.get<Message>("message", "choice-text")?.role, "user");
    h.brain.complete = async () => ({
      text: "先核对标题",
      usage: null,
      model: "fixture",
    });
    h.brain.handoff = async () => ({
      ready: true,
      goal: "核对标题",
      constraints: "只读",
      acceptance: "标题",
      mode: "read",
      question: "",
    });
    await h.request({
      op: "agent.send",
      agentId: a.id,
      text: "先讨论入口标题",
      requestId: "talk",
    });
    const draft = "下一条正在写";
    h.store.put("draft", { id: "agent:" + a.id, text: draft });
    const send = (id: string) =>
      h.request({
        op: "agent.send",
        agentId: a.id,
        text: "按这个方案做",
        requestId: id,
        preserveDraft: true,
      });
    const first = await send("go"),
      twice = await send("again");
    assert.equal(first.launchId, twice.launchId);
    assert.equal(h.store.get("draft", "agent:" + a.id).text, draft);
    assert.deepEqual(
      h.desk
        .view(a.id)
        .lines.filter((l) => l.kind === "user" && l.text === "按这个方案做")
        .map((l) => l.id),
      ["user:go", "user:again"],
    );
    assert.equal(h.store.all("task").length, 0);
  } finally {
    h.store.close();
  }
});
test("local echoes reconcile by ID and recipient, never by text; uncertain receipts are not reported as sent", () => {
  const s = CHIEF + ":fixture",
    b = "agent:fixture";
  const m = outgoing.begin(s, "同一句话", "你"),
    n = outgoing.begin(b, "同一句话", "你");
  const make = (e: typeof m) => ({ id: e.id, createdAt: e.at, text: e.text });
  try {
    const durable = { id: "older", createdAt: "2000-01-01", text: m.text };
    assert.equal(withEchoes([durable], outgoing.list(s), make).length, 2);
    assert.equal(
      withEchoes([durable, make(m)], outgoing.list(s), make).length,
      2,
    );
    outgoing.reconcile(s, [m.id]);
    assert.equal(outgoing.list(s).length, 0);
    assert.ok(outgoing.busy(s));
    assert.equal(outgoing.list(b).length, 1);
    outgoing.reject(b, n.id, new Error("操作响应超时"));
    assert.equal(outgoing.list(b)[0].state, "unknown");
  } finally {
    outgoing.forget(b, n.id);
    outgoing.finish(s, m.id);
    outgoing.finish(b, n.id);
  }
});
test("the receipt belongs to the native owner conversation, stays unknown after a lost acknowledgment, and is never re-sent", async () => {
  const { h, p } = await fixture();
  let calls = 0;
  const turns: object[] = [];
  try {
    h.ensureCodex = async () => {};
    h.codex.call = async (_method, params) => ({
      thread: { id: params.threadId, cwd: p.path, turns },
    });
    h.owner.owner = async () => "fixture-owner";
    h.owner.send = async () => {
      calls++;
      throw new RpcError("fixture transport", true);
    };
    const r = {
      op: "session.send",
      threadId: "external",
      projectId: p.id,
      requestId: "native-request",
      text: "外部会话的文字",
    };
    await assert.rejects(h.request(r), /结果未知/);
    assert.equal((await h.request(r)).state, "unknown");
    assert.equal(calls, 1);
    const read = () =>
      h.request({
        op: "session.read",
        threadId: "external",
        projectId: p.id,
      });
    const view = await read();
    assert.equal(view.actions[0].text, r.text);
    assert.equal(view.actions[0].state, "unknown");
    assert.ok(!(await h.snapshot()).messages.some((m) => m.id === r.requestId));
    const message = (clientId: string, text: string) => ({
      id: "generated-item",
      type: "userMessage",
      clientId,
      content: [{ type: "text", text }],
    });
    turns.push(
      {
        id: "different-turn",
        status: "completed",
        items: [message("different-request", r.text)],
      },
      {
        id: "mismatch-turn",
        status: "completed",
        items: [message(r.requestId, "原文不符")],
      },
    );
    assert.equal((await read()).actions[0].state, "unknown");
    await assert.rejects(
      h.request({ ...r, requestId: "cannot-dispatch-yet" }),
      /未确认/,
    );
    turns.push({
      id: "matched-turn",
      status: "completed",
      items: [message(r.requestId, r.text)],
    });
    const verified = await read();
    assert.equal(verified.actions[0].state, "accepted");
    assert.equal(verified.actions[0].turnId, "matched-turn");
    assert.equal(verified.turns[2].items[0].clientId, r.requestId);
    const hits = await h.request({ op: "search", projectId: p.id, text: r.text });
    assert.equal(hits.messages.length, 2);
    assert.equal(hits.messages.filter((x: any) => x.id === r.requestId).length, 1);
    assert.match(hits.messages.find((x: any) => x.nativeCachedAt).id, /different-turn/);
    assert.equal(calls, 1);
    h.ensureCodex = async () =>
      assert.fail("重复请求应复用原回执，不能重新联系原生端");
    assert.equal((await h.request(r)).turnId, "matched-turn");
  } finally {
    h.store.close();
  }
});

test("owner absence is a known refusal; continuation and stop bind to the actual turn", async () => {
  const { h, p } = await fixture();
  const threadId = "00000000-0000-4000-8000-000000000001";
  let connected = false;
  let matchingStop = false;
  let stopCalls = 0;
  const turns = [
    // An independent reader may report this before the owning window stops.
    { id: "active-turn", status: "interrupted", items: [] },
    { id: "other-active-turn", status: "inProgress", items: [] },
  ];
  let observed: Awaited<ReturnType<typeof h.owner.observe>> = {
    cwd: p.path, runtime: "active", turn: { id: "active-turn", status: "inProgress" },
  };
  try {
    h.ensureCodex = async () => {};
    h.codex.call = async () => ({
      thread: { id: threadId, cwd: p.path, turns },
    });
    h.owner.connect = async () => {};
    h.owner.observe = async () => observed;
    h.owner.request = async (method, params, recipient) => {
      if (method === "thread-owner-discovery") {
        if (!connected)
          throw new RpcError("原生 owner 拒绝请求：no-client-found");
        return { handledByClientId: "owner" };
      }
      assert.equal(recipient, "owner");
      assert.equal(params.conversationId, threadId);
      if (method === "thread-follower-start-turn")
        return { result: { result: { turn: { id: "active-turn" } } } };
      assert.equal(method, "thread-follower-interrupt-turn");
      stopCalls++;
      return {
        result: {
          ok: true,
          interruptedTurnId: matchingStop
            ? params.expectedTurnId
            : "older-turn",
        },
      };
    };
    const send = {
      op: "session.send",
      threadId,
      projectId: p.id,
      text: "无副作用的验收文本",
    };
    await assert.rejects(
      h.request({ ...send, requestId: "no-owner" }),
      /没有可用的原 owner/,
    );
    assert.equal(h.store.get("native-action", "no-owner").state, "rejected");
    connected = true;
    const receipt = await h.request({ ...send, requestId: "owner-online" });
    assert.equal(receipt.turnId, "active-turn");
    const stop = {
      op: "session.stop",
      projectId: p.id,
      threadId,
      turnId: receipt.turnId,
    };
    await assert.rejects(h.request(stop), /目标回合/);
    matchingStop = true;
    await assert.rejects(h.request(stop), /不要重复发送/);
    const read = () => h.request({ op: "session.read", projectId: p.id, threadId });
    const whileRunning = await read();
    assert.equal(whileRunning.activeTurnId, "active-turn");
    assert.ok(!whileRunning.actions.find((x: any) => x.kind === "owner-stop").stopResult);
    observed = { cwd: p.path, runtime: "idle", turn: { id: "active-turn", status: "interrupted" } };
    assert.equal((await read()).actions.find((x: any) => x.kind === "owner-stop").stopResult.status, "interrupted");
    assert.deepEqual(await h.request(stop), {
      requested: false,
      terminalStatus: "interrupted",
    });
    const next = { ...stop, turnId: turns[1].id };
    await assert.rejects(h.request(next), /未核对到原窗口的目标回合/);
    observed = { cwd: p.path, runtime: "active", turn: { id: next.turnId, status: "inProgress" } };
    assert.equal((await h.request(next)).requested, true);
    assert.equal((await h.request(next)).requested, true);
    observed = { cwd: p.path, runtime: "idle", turn: { id: next.turnId, status: "completed" } };
    assert.equal((await read()).actions.findLast((x: any) => x.kind === "owner-stop").stopResult.status, "completed");
    assert.deepEqual(await h.request(next), { requested: false, terminalStatus: "completed" });
    assert.equal(stopCalls, 2);
    assert.deepEqual(
      h.store
        .all("native-action")
        .filter((a) => a.kind === "owner-stop")
        .map((a) => a.state),
      ["unknown", "accepted"],
    );
  } finally {
    h.store.close();
  }
});

test("Codex 原窗口续聊取得跨端目录占用，重启不重发，只凭原窗口终态释放", async () => {
  const { h, p } = await fixture();
  const state = h.dir;
  const threadId = "00000000-0000-4000-8000-000000000019";
  const turnId = "original-turn";
  const send = { op: "session.send", projectId: p.id, threadId, requestId: "owner-hold-fixture", text: "继续本项目" };
  const read = { op: "session.read", projectId: p.id, threadId };
  const anotherPath = await mkdtemp(join(resolve(".test-data"), "separate-"));
  let sends = 0;
  let observed: Awaited<ReturnType<typeof h.owner.observe>> = {
    cwd: p.path, runtime: "active", turn: { id: turnId, status: "inProgress" },
  };
  const dispatched: string[] = [];
  const stub = (hub: Hub) => {
    hub.ensureCodex = async () => {};
    hub.codex.call = async (_method, params) => ({ thread: { id: params.threadId, cwd: p.path, turns: [
      { id: turnId, status: "interrupted", items: [] }, // The independent reader alone is insufficient.
    ] } });
    hub.owner.owner = async () => "fixture-owner";
    hub.owner.observe = async () => observed;
    hub.owner.send = async () => ({ threadId, turnId, accepted: ++sends === 1 });
    hub.dispatch = async (task) => {
      dispatched.push(task.id);
      hub.saveTask(task, "blocked");
    };
  };
  stub(h);
  try {
    assert.equal((await h.request(send)).state, "accepted");
    assert.deepEqual(h.workspaceHolds(), [p.path]);
    assert.equal((await h.request(read)).workspacePending, true);
    await assert.rejects(h.request({ ...send, requestId: "other-turn" }), /待核对/);
    await assert.rejects(h.request({ op: "backup" }), /发送和结束回执/);
  } finally {
    h.store.close();
  }
  const resumed = new Hub(state);
  stub(resumed);
  try {
    assert.deepEqual(resumed.workspaceHolds(), [p.path]);
    assert.equal((await resumed.request(send)).turnId, turnId);
    const other = await resumed.request({ op: "project.add", path: anotherPath, name: "独立样例" });
    const create = (projectId: string) => submitAgentForm(resumed.request.bind(resumed), {
      op: "task.create", requestId: "write-" + projectId, profile: { model: "fixture", effort: "max" },
      value: { projectId, mode: "write", goal: "写入单独的样例文件" },
    });
    const same = await create(p.id);
    const separate = await create(other.id);
    await resumed.tick();
    assert.equal(resumed.getTask(same.id).state, "ready");
    assert.deepEqual(dispatched, [separate.id]);
    observed = { cwd: p.path, runtime: "idle", turn: { id: "another-turn", status: "completed" } };
    assert.equal((await resumed.request(read)).workspacePending, true);
    observed.terminalTurns = new Map([[turnId, "completed"]]);
    const settled = await resumed.request(read);
    assert.equal(settled.actions[0].sendResult.status, "completed");
    assert.equal(settled.workspacePending, false);
    await resumed.tick();
    assert.deepEqual(dispatched, [separate.id, same.id]);
    assert.equal(sends, 1);
  } finally {
    await resumed.shutdown();
    resumed.store.close();
  }
});

test("verified public history survives a restart and stays read-only while Codex is unavailable", async () => {
  const { h, p } = await fixture();
  const threadId = "00000000-0000-4000-8000-000000000002",
    read = { op: "session.read", projectId: p.id, threadId },
    list = { op: "sessions", projectId: p.id },
    candidate = { op: "discussion.fromNative", projectId: p.id, threadId, requestId: "quote" };
  const otherPath = join(p.path, "other");
  await mkdir(otherPath);
  const other = await h.request({ op: "project.add", path: otherPath, name: "另一个项目" });
  const secret = "fixture-private-reasoning";
  let proposal: any, saved: any;
  const turns = Array.from({ length: 21 }, (_, i) => ({
    id: `turn-${i}`,
    status: "completed",
    items: [
      { id: `reasoning-${i}`, type: "reasoning", text: secret },
      { id: `answer-${i}`, type: "agentMessage", text: "回".repeat(60001) },
    ],
  }));
  const thread = { id: threadId, name: "已核对讨论", cwd: p.path, turns };
  try {
    h.ensureCodex = async () => {};
    h.owner.owner = async () => "fixture-owner";
    h.codex.call = async (method) =>
      method === "thread/list"
        ? { data: [thread, { ...thread, id: "foreign", cwd: other.path }], nextCursor: "more" }
        : { thread };
    const sessions = await h.request(list);
    assert.equal(sessions.offline, false);
    assert.equal(sessions.incomplete, true);
    assert.deepEqual(sessions.items.map((x: any) => x.id), [threadId]);
    const native = h.codex.call;
    h.codex.call = async (method, ...args) => method === "thread/list"
      ? { data: [], nextCursor: "still-collecting" }
      : native(method, ...args);
    assert.equal((await h.request(list)).incomplete, true);
    saved = await h.request(read);
    assert.equal(saved.ownerAvailable, true);
    assert.equal(saved.turns.length, 20);
    assert.equal(saved.turns[0].id, "turn-1");
    assert.equal(saved.turns.at(-1).id, "turn-20");
    assert.equal(saved.turns.flatMap((t: any) => t.items).reduce((n: number, i: any) => n + i.text.length, 0), 80000);
    assert.ok(!JSON.stringify(h.store.all("native-history")).includes(secret));
    proposal = await h.request(candidate);
    h.codex.call = async () => ({ thread: { ...thread, id: "wrong-id" } });
    await assert.rejects(h.request(read), /回执与请求不匹配/);
    h.codex.call = async () => ({ thread: { ...thread, cwd: other.path } });
    await assert.rejects(h.request(read), /目录与授权项目不匹配/);
    h.codex.call = async () => { throw new RpcError("原生端拒绝读取", false, -32600); };
    await assert.rejects(h.request(read), /原生端拒绝读取/);
    h.store.put("native-action", {
      ...entity(), kind: "owner-stop", state: "unknown", projectId: p.id,
      threadId, turnId: "turn-20",
    });
  } finally {
    h.store.close();
  }

  const restarted = new Hub(h.dir);
  try {
    restarted.ensureCodex = async () => { throw new Error("native offline"); };
    restarted.owner.owner = async () => assert.fail("离线不能向原窗口派发");
    const sessions = await restarted.request(list);
    assert.equal(sessions.offline, true);
    assert.ok(sessions.cachedAt);
    assert.equal(sessions.items[0].title, "已核对讨论");
    const offline = await restarted.request(read);
    assert.equal(offline.offline, true);
    assert.equal(offline.ownerAvailable, false);
    assert.equal(offline.cachedAt, saved.cachedAt);
    assert.deepEqual(offline.turns, saved.turns);
    assert.equal(offline.actions[0].state, "unknown");
    const search = { op: "search", projectId: p.id, text: "回回" };
    const found = (await restarted.request(search)).messages;
    assert.equal(found.length, 2);
    assert.ok(found.every((m: any) => m.nativeThreadId === threadId && m.nativeCachedAt === saved.cachedAt && m.text.length < 490));
    assert.deepEqual((await restarted.request({ ...search, projectId: other.id })).messages, []);
    assert.deepEqual((await restarted.request({ ...search, text: secret })).messages, []);
    assert.deepEqual((await restarted.request({ ...list, projectId: other.id })).items, []);
    await assert.rejects(restarted.request({ ...read, projectId: other.id }), /没有历史缓存/);
    await assert.rejects(restarted.request({ ...read, threadId: "not-saved" }), /没有历史缓存/);
    await assert.rejects(restarted.request({ ...read, op: "session.send", text: "线下不发送", requestId: "offline-send" }), /暂时无法读取/);
    await assert.rejects(restarted.request({ ...read, op: "session.stop", turnId: "turn-20" }), /暂时无法读取/);
    await assert.rejects(restarted.request({
      op: "agent.launch.confirm", id: proposal.launchId, profile: { model: "fixture", effort: "high" },
    }), /原生历史当前离线/);
    assert.equal(restarted.desk.discussions().length, 0);
    assert.deepEqual(restarted.store.all("native-action").map((a) => a.state), ["unknown"]);
    restarted.store.put("project", { ...p, path: other.path });
    assert.equal((await restarted.request(list)).cachedAt, undefined);
    await assert.rejects(restarted.request(read), /没有历史缓存/);
    assert.deepEqual((await restarted.request(search)).messages, []);
  } finally {
    restarted.store.close();
  }
});
