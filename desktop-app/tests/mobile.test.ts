import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Hub } from "../src/hub/service";
import { OwnerClient } from "../src/adapter/owner";
import { MobileDesk } from "../src/hub/mobile";
import { entity, stamp } from "../src/hub/store";
import { line } from "../src/hub/agent-ledger";
import { hash } from "../src/hub/security";
import type { Artifact, Run, Task } from "../src/shared/contracts";
import { call, mobileInvite, until, upload } from "./mobile-client";

function fileInfo(command: { id: string; projectId: string; version: string; expiresAt: number },
    name: string, mode: "original" | "excerpt" = "original", slot = 0, count = 1) {
  return { requestId: command.id, projectId: command.projectId, version: command.version,
    expiresAt: command.expiresAt, name, slot, count, mode };
}

test("桌面成果只由选中的手机补取，重新授权不会恢复旧分享", async () => {
  const fixtures = resolve(".test-data");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "mobile-delivery-"));
  const folder = join(root, "project"), state = join(root, "state");
  await mkdir(folder);
  const hub = new Hub(state);
  hub.tick = async () => {};
  let desk = new MobileDesk(hub, 0, true);
  try {
    const project = await hub.request({ op: "project.add", path: folder, name: "成果样本" });
    const otherFolder = join(root, "other");
    await mkdir(otherFolder);
    const otherProject = await hub.request({ op: "project.add", path: otherFolder, name: "其他项目" });
    const pair = async (projectId: string) => {
      const invite = await mobileInvite(desk, projectId);
      return { ...invite, token: (await call(invite, "pair", {})).pair.token };
    };
    const a = await pair(project.id), b = await pair(project.id), outside = await pair(otherProject.id);
    const proposal = await hub.request({ op: "task.create", requestId: "made-on-desktop", value: {
      projectId: project.id, title: "桌面交付标题", goal: "本地成果夹具", mode: "read",
    } });
    const created = await hub.request({ op: "agent.launch.confirm", id: proposal.launchId, profile: { model: "fixture", effort: "default" } });
    const task = hub.getTask(created.id);
    const run: Run = { ...entity(), taskId: task.id, revision: task.revision, commandId: randomUUID(), state: "ended", outcome: "completed",
      response: "第一版交付正文", diff: "", startedAt: stamp(), workPath: folder };
    hub.store.put("run", run);
    hub.store.put("task", { ...task, runId: run.id, state: "verifying" });
    const makeFile = async (name: string, text: string, runId = run.id) => {
      const path = join(folder, name);
      await writeFile(path, text);
      const art: Artifact = { ...entity(), taskId: task.id, runId, path, name, kind: "text", origin: "result",
        size: Buffer.byteLength(text), hash: hash(text), status: "ready" };
      return hub.store.put("artifact", art);
    };
    const file = await makeFile("一.txt", "选中的原文"), unused = await makeFile("二.txt", "未选文本");
    const history = await makeFile("旧.txt", "其他回合", randomUUID());
    const choices = () => desk.local({ action: "delivery-devices", taskId: task.id, runId: run.id }) as Promise<{
      evidenceHash: string; devices: { id: string; grantVersion: string }[]; artifacts: { id: string }[];
    }>;
    const ready = await choices(), person = ready.devices.find(d => d.id === hash(a.token))!;
    assert.deepEqual(ready.devices.map(d => d.id).sort(), [hash(a.token), hash(b.token)].sort());
    assert.deepEqual(ready.artifacts.map(f => f.id).sort(), [file.id, unused.id].sort());
    const id = randomUUID(), send = { action: "delivery-send", id, deviceId: person.id, taskId: task.id, runId: run.id,
      grantVersion: person.grantVersion, evidenceHash: ready.evidenceHash, artifacts: [file.id] };
    await assert.rejects(desk.local({ ...send, artifacts: [history.id] }), /本回合/);
    await assert.rejects(desk.local({ ...send, deviceId: hash(outside.token) }), /共享范围/);
    await assert.rejects(desk.local({ ...send, evidenceHash: "0".repeat(64) }), /交付内容已变化/);
    const saved = await desk.local(send);
    assert.deepEqual(await desk.local(send), saved);
    const replacement: Run = { ...run, id: randomUUID(), response: "第二版交付正文" };
    hub.store.put("run", replacement);
    hub.store.put("task", { ...task, runId: replacement.id, state: "verifying" });
    await assert.rejects(desk.local({ ...send, id: randomUUID() }), /交付版本已变化/);
    await desk.close();
    desk = new MobileDesk(hub, new URL(a.url).port ? Number(new URL(a.url).port) : 443, true);
    await desk.startSaved();
    const catalog = async (phone: typeof a) => (await call(phone, "catalog", {})).value.deliveries;
    assert.deepEqual((await catalog(a)).map((x: { id: string }) => x.id), [id]);
    assert.deepEqual(await catalog(b), []);
    assert.match((await call(b, "delivery", { id })).error, /共享范围/);
    assert.equal((await call(a, "delivery", { id })).value.text, run.response);
    assert.deepEqual((await call(a, "delivery", { id, artifact: file.id })).value, { name: file.name, text: "选中的原文", textTruncated: false });
    assert.match((await call(a, "delivery", { id, artifact: unused.id })).error, /未被选入/);
    await writeFile(file.path, "文件已变动");
    assert.match((await call(a, "delivery", { id, artifact: file.id })).error, /记录版本不同/);
    assert.deepEqual((await call(a, "pull", { after: 0 })).value, []);
    assert.equal(hub.store.all("task").length, 1);
    await desk.local({ action: "revoke", id: person.id });
    assert.equal((await call(a, "delivery", { id })).code, 401);
    const fresh = await pair(project.id);
    assert.deepEqual(await catalog(fresh), []);
    assert.match((await call(fresh, "delivery", { id })).error, /共享范围/);
  } finally { await desk.close(); hub.store.close(); }
});

test("手机 Agent 结构仅投影共享项目的账本节点和本设备回执", async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "mobile-agents-"));
  const sharedPath = join(dir, "shared"), hiddenPath = join(dir, "hidden");
  await Promise.all([mkdir(sharedPath), mkdir(hiddenPath)]);
  const h = new Hub(join(dir, "state")), desk = new MobileDesk(h, 0, true);
  try {
    const shared = await h.request({ op: "project.add", path: sharedPath, name: "共享项目" });
    const hidden = await h.request({ op: "project.add", path: hiddenPath, name: "未共享项目" });
    const parent = h.desk.open(shared, "上级讨论");
    const foreign = h.desk.open(hidden, "不可泄露名称");
    const task = { ...entity(), projectId: shared.id, model: "sample-model", state: "active", revision: 1, backend: "dsh" };
    const run = { ...entity(), taskId: task.id, revision: 1, state: "waiting_input", backend: "dsh", response: "不可泄露正文" };
    h.store.put("task", { ...task, runId: run.id });
    h.store.put("run", run);
    const child = h.store.put("agent", { ...entity(), projectId: shared.id, kind: "executor", parentAgentId: parent.id,
      taskId: task.id, title: "执行节点" });
    const orphan = h.store.put("agent", { ...entity(), projectId: shared.id, kind: "discussion", parentAgentId: foreign.id, title: "本项目独立节点" });
    h.store.put("agent-source", { id: parent.id, projectId: shared.id, threadId: "fixture-thread", nativeSource: "fixture-source" });
    h.store.put("agent-source", { id: orphan.id, projectId: hidden.id, threadId: "不可泄露线程" });
    const pair = async () => {
      const invite = await mobileInvite(desk, shared.id);
      const { pair: paired } = await call(invite, "pair", {});
      return { ...invite, token: paired.token };
    };
    const own = await pair(), other = await pair();
    const ledger = (desk as unknown as { ledger(): import("../src/hub/store").Store }).ledger();
    const workId = randomUUID();
    ledger.put("mobile-work", { id: "mobile:" + workId, device: hash(own.token), data: { id: workId, projectId: shared.id },
      taskId: task.id, phase: "sent", last: { stage: "done" } });
    const read = (phone: typeof own, projectId: string) => call(phone, "agents", { projectId });
    assert.deepEqual((await read(own, hidden.id)).value, { allowed: false });
    const result = (await read(own, shared.id)).value;
    assert.equal(result.allowed, true);
    const lookup = (id: string) => result.nodes.find((n: any) => n.id === id);
    assert.equal(lookup(child.id).parentId, parent.id);
    assert.equal(lookup(child.id).state, "waiting_input");
    assert.equal(lookup(child.id).model, task.model);
    assert.equal(lookup(child.id).workId, workId);
    assert.deepEqual(lookup(parent.id).session, { backend: "dsh", threadId: "fixture-thread", source: "fixture-source" });
    assert.equal(lookup(orphan.id).parentId, undefined);
    assert.equal(lookup(orphan.id).session, undefined);
    assert.doesNotMatch(JSON.stringify(result), /不可泄露|sharedPath/);
    assert.equal((await read(other, shared.id)).value.nodes.find((n: any) => n.id === child.id).workId, undefined);
    h.store.put("project", { ...shared, available: false });
    assert.deepEqual((await read(own, shared.id)).value, { allowed: false });
  } finally {
    await desk.close();
    h.store.close();
  }
});

test("手机经 Codex 原窗口派发：离线明确失败，错收据重启后只按原回合核对", async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "mobile-owner-"));
  const workspace = join(dir, "project"), state = join(dir, "state");
  await mkdir(workspace);
  const address = "\\\\.\\pipe\\alcor-mobile-owner-" + randomUUID();
  const thread = randomUUID(), turnId = "owner-confirmed-turn", owner = "isolated-original-owner";
  const posts: { threadId: string; requestId: string; text: string }[] = [];
  const sockets = new Set<net.Socket>();
  let reachable = false, ended = false, transcript: any[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const send = (value: object) => {
      const payload = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = 4 + buffer.readUInt32LE();
        if (buffer.length < size) break;
        const m = JSON.parse(buffer.subarray(4, size).toString());
        buffer = buffer.subarray(size);
        if (m.type === "broadcast" && m.params.following) {
          send({ type: "broadcast", method: "thread-stream-state-changed", version: 13,
            sourceClientId: owner, targetClientIds: [m.sourceClientId], params: { hostId: "local", conversationId: thread,
              change: { type: "snapshot", conversationState: { id: thread, cwd: workspace,
                threadRuntimeStatus: { type: ended ? "idle" : "active" },
                turns: [{ turnId, status: ended ? "completed" : "inProgress" }],
              } },
            } });
        }
        if (m.type !== "request") continue;
        const reply = { type: "response", method: m.method, requestId: m.requestId };
        if (m.method === "initialize") send({ ...reply, resultType: "success", result: { clientId: "alcor-fixture" } });
        else if (m.method === "thread-owner-discovery") {
          assert.equal(m.params.conversationId, thread);
          if (reachable) send({ ...reply, resultType: "success", handledByClientId: owner, result: {} });
          else send({ ...reply, resultType: "error", error: { code: "no-client-found" } });
        } else if (m.method === "thread-follower-start-turn") {
          const native = m.params.turnStart.request;
          assert.equal(m.targetClientId, owner);
          assert.equal(native.threadId, thread);
          posts.push({ threadId: native.threadId, requestId: native.clientUserMessageId, text: native.input[0].text });
          send({ ...reply, resultType: "success", handledByClientId: "foreign-window", result: { result: { turnId: "untrusted-turn" } } });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  function openHub() {
    const h = new Hub(state);
    h.owner = new OwnerClient(address);
    h.ensureCodex = async () => {};
    h.codex.call = async (method, params) => {
      if (method === "thread/list") return { data: [{ id: thread, cwd: workspace, name: "原 Codex 会话" }] };
      assert.equal(method, "thread/read");
      return { thread: { id: params.threadId, cwd: workspace, turns: transcript } };
    };
    return h;
  }
  let hub = openHub();
  let desk = new MobileDesk(hub, 0, true);
  try {
    const project = await hub.request({ op: "project.add", path: workspace, name: "Codex 手机夹具" });
    const challenge = await mobileInvite(desk, project.id);
    const phone = { ...challenge, token: (await call(challenge, "pair", {})).pair.token };
    const catalog = (await call(phone, "catalog", { native: true })).value;
    const target = catalog.groups.find((g: any) => g.backend === "codex").items[0].session;
    const discussion = hub.desk.open(project, "原讨论");
    const command = () => ({ id: randomUUID(), projectId: project.id, version: catalog.projects[0].version,
      target, discussion: discussion.id, goal: "给原项目核对标题", acceptance: "返回核对结果", expiresAt: Date.now() + 60000 });
    const pull = async () => (await call(phone, "pull", { after: 0 })).value as any[];
    const find = (id: string, stage: string) => until(async () => (await pull()).find((e) => e.id === id && e.receipt.stage === stage));
    const read = () => call(phone, "history", { projectId: project.id, session: target });
    assert.equal((await read()).value.gap, true);
    const offline = command();
    assert.equal((await call(phone, "command", { value: offline })).value.stage, "queued");
    assert.match((await find(offline.id, "failed")).receipt.detail, /没有可用的原 owner/);
    assert.equal(posts.length, 0);
    assert.equal((await call(phone, "history", { projectId: project.id, discussion: discussion.id })).value.gap, false);
    reachable = true;
    const pending = command();
    const enqueue = () => call(phone, "command", { value: pending });
    assert.equal((await enqueue()).value.stage, "queued");
    await find(pending.id, "verify");
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post.requestId, "mobile:" + pending.id);
    assert.match(post.text, /给原项目核对标题/);
    await desk.close();
    hub.owner.close();
    hub.store.close();
    hub = openHub();
    desk = new MobileDesk(hub, Number(new URL(challenge.url).port), true);
    await desk.startSaved();
    assert.equal((await enqueue()).value.stage, "verify");
    const item = { id: "owner-user", type: "userMessage", clientId: post.requestId };
    transcript = [{ id: "untrusted-turn", status: "completed",
      items: [{ ...item, content: [{ type: "text", text: "不同的派工内容" }] }] }];
    await read();
    assert.equal((await enqueue()).value.stage, "verify");
    const accepted = { ...item, content: [{ type: "text", text: post.text }] };
    transcript = [{ id: turnId, status: "inProgress", items: [accepted] }];
    await read();
    assert.equal((await find(pending.id, "running")).receipt.turnId, turnId);
    ended = true;
    transcript = [{ id: turnId, status: "completed", items: [accepted,
      { id: "owner-result", type: "agentMessage", text: "已在原工作区完成核对" }] }];
    await read();
    const result = await find(pending.id, "review");
    assert.equal(result.receipt.text, "已在原工作区完成核对");
    assert.equal((await call(phone, "accept", { id: pending.id, evidenceHash: result.receipt.evidenceHash })).value, true);
    await find(pending.id, "done");
    assert.equal(posts.length, 1);
    assert.equal(hub.store.all("task").length, 0);
  } finally {
    await desk.close();
    hub.owner.close();
    hub.store.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("手机入口限定项目、合并讨论与两端决定，重新连接后同一原生授权只派发一次", async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "mobile-"));
  const visible = join(dir, "shared"), privateDir = join(dir, "private");
  await Promise.all([mkdir(visible), mkdir(privateDir)]);
  const h = new Hub(join(dir, "state"));
  let desk = new MobileDesk(h, 0, true);
  const project = await h.request({ op: "project.add", path: visible, name: "同名项目" });
  const hidden = await h.request({ op: "project.add", path: privateDir, name: "同名项目" });
  const discussion = h.desk.open(project, "登录页讨论");
  line(h.store, discussion.id, "assistant", "桌面讨论", "桌面原有讨论");
  const regular = h.request.bind(h);
  const sends: Record<string, number> = {};
  const output: Record<string, string> = {};
  const original = { codex: "fixture-codex", dsh: "fixture-dsh" };
  h.dshDesktop.resultSource = async () => "dsh-fixture-instance";
  h.request = async (raw) => {
    const r = raw as any;
    if (r.op === "sessions") return {
      items: [{ id: original[r.backend as keyof typeof original], title: "设计讨论" }],
      source: r.backend === "dsh" ? "dsh-fixture-instance" : undefined,
    };
    if (r.op === "session.send") {
      assert.equal(r.projectId, project.id);
      assert.equal(r.threadId, r.source ? original.dsh : original.codex);
      assert.match(r.text, /采用原讨论的决定：继续/);
      assert.match(r.text, /【手机材料摘录：核对\.txt】\n来源段落，仅用于隔离验证/);
      sends[r.threadId] = (sends[r.threadId] ?? 0) + 1;
      h.store.put(r.source ? "dsh-native-action" : "native-action", {
        id: r.requestId, state: r.source ? "accepted" : "unknown",
        projectId: r.projectId, threadId: r.threadId, source: r.source,
      });
      if (!r.source) throw Error("夹具：接收回执丢失");
      return { state: "accepted" };
    }
    if (r.op === "session.read") {
      const turns = output[r.threadId] ? [{ id: "turn-" + r.threadId,
        items: [{ id: "assistant-" + r.threadId, type: "agentMessage", text: output[r.threadId] }] }] : [];
      const key = r.source ? [r.projectId, r.threadId, r.source] : [r.projectId, r.threadId];
      h.store.put(r.source ? "dsh-native-history" : "native-history", { id: JSON.stringify(key), value: { turns } });
      return { turns, cachedAt: stamp() };
    }
    return regular(raw);
  };
  try {
    const challenge = await mobileInvite(desk, project.id);
    await assert.rejects(call({ ...challenge, pin: "invalid" }, "pair", {}), /pin mismatch/);
    const pairResponse = await call(challenge, "pair", {});
    assert.equal(pairResponse.deviceId, challenge.id);
    assert.equal((await call(challenge, "pair", {})).code, 401);
    const p = { ...challenge, token: pairResponse.pair.token };
    const catalog = (await call(p, "catalog", { native: true })).value;
    assert.deepEqual(catalog.projects.map((x: any) => x.id), [project.id]);
    assert.equal(catalog.groups.length, 2);
    assert.match((await call(p, "history", { projectId: hidden.id, discussion: discussion.id })).error, /共享范围/);
    const decisionId = randomUUID(), base = randomUUID();
    const phoneMessage = { id: randomUUID(), role: "user", text: "讨论里的手机消息", at: stamp() };
    const push = (decisions: object[]) => call(p, "push", {
      projectId: project.id, discussion: discussion.id, title: discussion.title, messages: [phoneMessage], decisions,
    });
    const first = { id: decisionId, version: base, parents: [], text: "原始按钮", quote: "原话" };
    assert.equal((await push([first])).value, true);
    assert.equal((await push([first])).value, true);
    const edited = randomUUID(), mobileEdit = randomUUID();
    await desk.local({ action: "decision", discussion: discussion.id, value: { ...first, version: edited, parents: [base], text: "下一步" } });
    await push([{ ...first, version: mobileEdit, parents: [base], text: "继续" }]);
    const history = (await call(p, "history", { projectId: project.id, discussion: discussion.id })).value;
    assert.deepEqual(history.messages.map((m: any) => m.text), ["桌面原有讨论", phoneMessage.text]);
    assert.deepEqual(history.decisions[0].heads, [edited, mobileEdit]);
    const version = catalog.projects[0].version, accepted = randomUUID();
    const resolved = { ...first, version: accepted, parents: [edited, mobileEdit], text: "继续" };
    const command = (backend: "codex" | "dsh") => ({
      id: randomUUID(), projectId: project.id, version, discussion: discussion.id, goal: "修改夹具的按钮",
      acceptance: "在原会话回复结果", target: { backend, threadId: original[backend], ...(backend === "dsh" ? { source: "dsh-fixture-instance" } : {}) },
      decision: { id: decisionId, version: accepted }, expiresAt: Date.now() + 3600000,
    });
    assert.match((await call(p, "command", { value: command("codex") })).error, /决定/);
    assert.equal((await push([resolved])).value, true);
    const excerpt = Buffer.from("来源段落，仅用于隔离验证");
    const include = async (value: ReturnType<typeof command>) => {
      const info = fileInfo(value, "核对.txt", "excerpt");
      assert.match((await upload(p, info, Buffer.from("文".repeat(2501)))).error, /超过长度/);
      const received = await upload(p, info, excerpt);
      assert.deepEqual(received.value, { slot: 0, version: hash(excerpt) });
      return { ...value, materials: [received.value] };
    };
    const codex = await include(command("codex")), dsh = await include(command("dsh"));
    assert.equal((await call(p, "command", { value: codex })).value.stage, "queued");
    assert.equal((await call(p, "command", { value: codex })).value.stage, "queued");
    const pull = async (after = 0) => (await call(p, "pull", { after })).value as any[];
    const uncertain = await until(async () => (await pull()).find((e) => e.id === codex.id && e.receipt.stage === "verify"));
    assert.equal(uncertain.receipt.materialCount, 1);
    assert.equal(uncertain.receipt.materialInputs, undefined);
    assert.equal(sends[original.codex], 1);

    await desk.close();
    desk = new MobileDesk(h, Number(new URL(challenge.url).port), true);
    await desk.startSaved();
    assert.deepEqual(await pull(uncertain.seq), []);
    assert.equal((await call(p, "command", { value: codex })).value.stage, "verify");
    assert.equal((await call(p, "command", { value: dsh })).value.stage, "queued");
    await until(async () => sends[original.dsh]);
    const beforeNative = await pull();
    assert.equal(beforeNative.some((e) => e.id === dsh.id && e.receipt.stage === "running"), false);
    const completion = (id: string, isDsh: boolean) => {
      const key = "mobile:" + id, kind = isDsh ? "dsh-native-action" : "native-action";
      const a = h.store.get(kind, key);
      output[a.threadId] = "同一回合的实际结果";
      h.store.put(kind, { ...a, state: "accepted", turnId: "turn-" + a.threadId,
        ...(isDsh ? { end: "completed" } : { sendResult: { status: "completed" } }) });
    };
    completion(codex.id, false);
    h.store.put("dsh-native-action", {
      ...h.store.get("dsh-native-action", "mobile:" + dsh.id), turnId: "turn-" + original.dsh,
    });
    await until(async () => (await pull()).find((e) => e.id === dsh.id && e.receipt.stage === "running"));
    completion(dsh.id, true);
    const done = await until(async () => (await pull()).find((e) => e.id === dsh.id && e.receipt.stage === "review" && e.receipt.text));
    assert.equal(done.receipt.text, output[original.dsh]);
    assert.deepEqual(done.receipt.materialInputs, [{ kind: "excerpt", count: 1 }]);
    assert.match((await call(p, "accept", { id: dsh.id, evidenceHash: "0".repeat(64) })).error, /回执已变化/);
    assert.equal((await call(p, "accept", { id: dsh.id, evidenceHash: done.receipt.evidenceHash })).value, true);
    await until(async () => (await pull()).find((e) => e.id === dsh.id && e.receipt.stage === "done"));
    assert.deepEqual(sends, { [original.codex]: 1, [original.dsh]: 1 });
    // Revoke during the real Codex send path's asynchronous owner lookup.
    h.request = regular;
    h.ensureCodex = async () => {};
    h.codex.call = async (_method, params) => ({ thread: { id: params.threadId, cwd: project.path } });
    let releaseOwner!: () => void;
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerLookedUp = false, ownerWrites = 0;
    h.owner.owner = async () => {
      ownerLookedUp = true;
      await release;
      return "fixture-owner";
    };
    h.owner.request = async () => { ownerWrites++; throw new Error("unexpected owner write"); };
    const revoked = command("codex");
    assert.equal((await call(p, "command", { value: revoked })).value.stage, "queued");
    const device = (await desk.local({ action: "status" }) as any).devices[0];
    try {
      await until(async () => ownerLookedUp || undefined);
      await desk.local({ action: "revoke", id: device.id });
    } finally { releaseOwner(); }
    await until(async () => h.store.get("native-action", "mobile:" + revoked.id)?.state === "rejected" || undefined);
    assert.equal((await call(p, "pull", {})).code, 401);
    assert.equal(ownerWrites, 0);
  } finally {
    await desk.close();
    h.store.close();
  }
});

test("手机文本产物只来自这次授权的回合，核对后的验收不接收旧版本", async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "mobile-artifact-"));
  const workspace = join(dir, "project");
  await mkdir(workspace);
  const h = new Hub(join(dir, "state"));
  h.tick = async () => {};
  const desk = new MobileDesk(h, 0, true);
  try {
    const project = await h.request({ op: "project.add", path: workspace, name: "产物测试" });
    const challenge = await mobileInvite(desk, project.id);
    const p = { ...challenge, token: (await call(challenge, "pair", {})).pair.token };
    const version = (await call(p, "catalog", {})).value.projects[0].version;
    const id = randomUUID();
    const { value } = await call(p, "command", { value: { id, projectId: project.id, version,
      target: { backend: "dsh", mode: "write" }, goal: "写一个文本文件", acceptance: "核对文字", expiresAt: Date.now() + 3600000 } });
    assert.equal(value.stage, "queued");
    const task = await until(async () => h.store.all<Task>("task")[0]);
    const result: Run = { ...entity(), taskId: task.id, revision: task.revision, commandId: randomUUID(),
      threadId: "sandbox-thread", turnId: "sandbox-turn", state: "ended", outcome: "completed",
      response: "已交付", diff: "", workPath: workspace, startedAt: stamp() };
    const path = join(workspace, "产物.txt");
    await writeFile(path, "当前回合产物");
    const artifact = { ...entity(), taskId: task.id, runId: result.id, name: "产物.txt", path,
      hash: hash("当前回合产物"), size: Buffer.byteLength("当前回合产物"), kind: "text", origin: "result", status: "ready" };
    const unrelated = { ...artifact, id: randomUUID(), runId: randomUUID(), name: "旧回合" };
    h.store.put("artifact", artifact);
    h.store.put("artifact", unrelated);
    h.store.put("run", result);
    h.store.put("task", { ...task, state: "verifying", runId: result.id });
    const events = async () => (await call(p, "pull", { after: 0 })).value as any[];
    const review = await until(async () => (await events()).find((e) => e.id === id && e.receipt.stage === "review"));
    const evidenceHash = review.receipt.evidenceHash;
    assert.equal(review.receipt.runId, result.id);
    assert.deepEqual(review.receipt.artifacts, [{ id: artifact.id, name: artifact.name }]);
    const read = (artifact: string) => call(p, "artifact", { id, artifact, evidenceHash });
    assert.match((await read(unrelated.id)).error, /不属于当前回执/);
    assert.deepEqual((await read(artifact.id)).value, { name: "产物.txt", text: "当前回合产物" });
    await writeFile(path, "事后被修改");
    assert.match((await read(artifact.id)).error, /文件内容与记录版本不同/);
    assert.match((await call(p, "accept", { id, evidenceHash })).error, /产物已在外部修改/);
    await writeFile(path, "当前回合产物");
    const newRun = { ...result, id: randomUUID() };
    h.store.put("run", newRun);
    h.store.put("task", { ...task, state: "verifying", runId: newRun.id });
    // Same reply and diff in a different run cannot reuse the displayed receipt.
    assert.match((await call(p, "accept", { id, evidenceHash })).error, /回执已变化/);
    h.store.put("task", { ...task, state: "verifying", runId: result.id });
    assert.equal((await call(p, "accept", { id, evidenceHash })).value, true);
    assert.equal(h.getTask(task.id).state, "done");
    assert.equal(h.store.all("acceptance")[0].runId, result.id);
    assert.equal((await call(p, "accept", { id, evidenceHash })).value, true);
    assert.match((await call(p, "accept", { id, evidenceHash: "0".repeat(64) })).error, /回执已变化/);
  } finally {
    await desk.close();
    h.store.close();
  }
});

test("手机新建托管工作按所选 Codex 或 DSH 入账，排队不冒充已运行", async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "mobile-hosted-"));
  const workspace = join(dir, "project"), secondWorkspace = join(dir, "second");
  await Promise.all([mkdir(workspace), mkdir(secondWorkspace)]);
  const hub = new Hub(join(dir, "state"));
  hub.tick = async () => {};
  const desk = new MobileDesk(hub, 0, true);
  try {
    const project = await hub.request({ op: "project.add", path: workspace, name: "手机新建工作验证" });
    const secondProject = await hub.request({ op: "project.add", path: secondWorkspace, name: "独立项目" });
    const challenge = await mobileInvite(desk, project.id, secondProject.id);
    const phone = { ...challenge, token: (await call(challenge, "pair", {})).pair.token };
    const otherCode = await mobileInvite(desk, project.id);
    const other = { ...otherCode, token: (await call(otherCode, "pair", {})).pair.token };
    const versions = (await call(phone, "catalog", {})).value.projects;
    const version = versions.find((p: any) => p.id === project.id).version;
    const targets = [{ backend: "codex", mode: "read" }, { backend: "dsh", mode: "write" }] as const;
    for (const target of targets) {
      const value = { id: randomUUID(), projectId: project.id, version, target,
        goal: "核对隔离工作区：" + target.backend, acceptance: "返回结果", expiresAt: Date.now() + 60000 };
      const first = Buffer.from("首份同名材料"), second = Buffer.from(target.backend === "dsh" ? "第二份同名材料" + "字".repeat(30001) : "第二份同名材料");
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xg84AAAAASUVORK5CYII=", "base64");
      const count = target.backend === "codex" ? 3 : 2;
      const info = fileInfo(value, "同名.txt", "original", 0, count);
      const submit = (p: typeof phone, update: object) => call(p, "command", { value: { ...value, ...update } });
      const ref = { slot: 0, version: hash(first) };
      assert.match((await submit(phone, { materials: [ref] })).error, /未收齐/);
      assert.match((await upload(phone, { ...info, expiresAt: 1 }, first)).error, /过期/);
      assert.match((await upload(phone, { ...info, name: "CON.txt" }, first)).error, /不符合/);
      if (target.backend === "codex") {
        await assert.rejects(upload(phone, info, first, true), /upload interrupted/);
        assert.match((await submit(phone, { materials: [ref] })).error, /未收齐/);
      }
      assert.match((await upload(phone, info, Buffer.from([0, 0x80]))).error, /UTF-8/);
      assert.deepEqual((await upload(phone, info, first)).value, ref);
      assert.deepEqual((await upload(phone, info, first)).value, ref);
      assert.match((await upload(phone, info, second)).error, /版本不一致/);
      assert.match((await submit(phone, {})).error, /未引用/);
      assert.match((await submit(phone, { materials: [ref] })).error, /未收齐/);
      assert.match((await submit(other, { materials: [ref] })).error, /不属于/);
      assert.match((await submit(phone, { materials: [ref], projectId: secondProject.id,
        version: versions.find((p: any) => p.id === secondProject.id).version })).error, /不属于/);
      const refs = [ref, (await upload(phone, fileInfo(value, "同名.txt", "original", 1, count), second)).value];
      if (target.backend === "codex") {
        refs.push((await upload(phone, fileInfo(value, "样图.png", "original", 2, count), image)).value);
        assert.match((await submit(phone, { target: { backend: "dsh", mode: "read" }, materials: refs })).error, /不能读取/);
      }
      const accepted = await submit(phone, { materials: refs });
      assert.equal(accepted.value.stage, "queued");
      assert.equal(accepted.value.materialCount, count);
      assert.equal(accepted.value.materialInputs, undefined);
      const task = await until(async () => hub.store.all<Task>("task").find((t) => t.goal === value.goal));
      assert.equal((await submit(phone, { materials: refs })).value.stage, "queued");
      const attachments = task.attachments.map((id) => hub.store.get<Artifact>("artifact", id)!);
      assert.deepEqual(attachments.map((a) => [a.name, a.kind]), [
        ["同名.txt", "text"], ["同名.txt", "text"], ...(count === 3 ? [["样图.png", "image"]] : []),
      ]);
      assert.deepEqual(await Promise.all(attachments.map((a) => readFile(a.path))), count === 3 ? [first, second, image] : [first, second]);
    }
    assert.deepEqual(hub.store.all<Task>("task").map(({ backend, mode }) => ({ backend, mode })), targets);
    assert.equal(hub.store.all("run").length, 0);
    const events = (await call(phone, "pull", { after: 0 })).value as any[];
    assert.ok(events.length >= 2);
    assert.ok(events.every((event) => event.receipt.stage === "queued"));
    const hosted = hub.store.all<Task>("task");
    for (const task of hosted) {
      const run: Run = { ...entity(), taskId: task.id, revision: task.revision, commandId: randomUUID(), workPath: workspace,
        threadId: "fixture-thread", turnId: "fixture-turn-" + task.backend, state: "running", response: "", diff: "", startedAt: stamp(),
        attachmentInputs: task.attachments.map((id, slot) => ({
          id, kind: hub.store.get<Artifact>("artifact", id)!.kind, ...(task.backend === "dsh" && slot === 1 ? { truncated: true } : {}),
        })) };
      hub.store.put("run", { ...run, inputsAcceptedAt: stamp() });
      hub.store.put("task", { ...task, runId: run.id, state: "running" });
    }
    for (const target of targets) {
      const applied = await until(async () => ((await call(phone, "pull", { after: 0 })).value as any[])
        .find((event) => event.receipt.turnId === "fixture-turn-" + target.backend && event.receipt.stage === "running"));
      assert.deepEqual(applied.receipt.materialInputs, target.backend === "codex"
        ? [{ kind: "text", count: 2 }, { kind: "image", count: 1 }]
        : [{ kind: "text", count: 2, truncated: 1 }]);
    }
  } finally {
    await desk.close();
    hub.store.close();
  }
});
