import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import test from "node:test";
import { dshBridgeVault } from "../src/adapter/dsh-desktop";
import { Vault } from "../src/hub/security";
import { Hub } from "../src/hub/service";
import { MobileDesk } from "../src/hub/mobile";
import { call, mobileInvite, until } from "./mobile-client";

const { WebSocketServer } = createRequire(import.meta.url)("ws");
const secret = "ISOLATED-DSH-BRIDGE-FIXTURE";
const thread = "session-dsh-desktop-fixture";

test("DSH 原桌面只读、续聊、去重与退出后的占用均绑定原项目", async (t) => {
  const base = resolve(".test-data");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "dsh-desktop-")),
    state = join(dir, "state");
  const path = join(dir, "project"),
    other = join(dir, "other");
  await Promise.all([mkdir(path), mkdir(other)]);
  let cwd = await realpath(path),
    nativeTitle: string | null = "隔离原桌面讨论",
    offline = false,
    wrongIdentity = false,
    drop = false,
    emptyAck = false,
    badToken = false;
  let sends = 0,
    reads = 0,
    last: any;
  const event = (seq: number, type: string, data: object) => ({
    type: "event",
    event: { seq, type, data },
  });
  let records = [
    event(1, "turn/start", { turn: 1 }),
    event(2, "user/message", {
      source: { kind: "runtime-context" },
      content: [{ type: "text", text: "内部运行条件" }],
    }),
    event(3, "assistant/message", {
      message: {
        content: [
          { type: "reasoning", text: "内部推理记录" },
          { type: "text", text: "历史中的公开回复" },
        ],
      },
    }),
    event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + secret || badToken)
      return void res.writeHead(401).end();
    if (offline) return void res.writeHead(503).end();
    let text = "";
    for await (const part of req) text += part;
    const request = JSON.parse(text);
    let value: object;
    if (req.url === "/ui/api/session/list")
      value = {
        items: [
          {
            sessionId: thread,
            cwd,
            projections: { values: { title: nativeTitle } },
          },
          {
            sessionId: "foreign",
            cwd: other,
            projections: { values: { title: "其它项目" } },
          },
        ],
      };
    else if (req.url === "/ui/api/session/prompt") {
      sends++;
      last = request.payload.args.request;
      if (drop) return res.destroy();
      if (emptyAck) return void res.writeHead(204).end();
      value = { accepted: true };
    } else return void res.writeHead(404).end();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        type: "server-response",
        rpcId: request.rpcId,
        result: { ok: true, value },
      }),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.headers.authorization !== "Bearer " + secret ||
      req.url !== "/ui/api/remote.mux"
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (peer: any) =>
      peer.on("message", (bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8"));
        if (request.type !== "open") return;
        reads++;
        peer.send(
          JSON.stringify({
            streamId: request.streamId,
            type: "item",
            value: {
              type: "snapshot",
              header: {
                id: wrongIdentity
                  ? "wrong"
                  : request.payload.args.request.address.sessionId,
                cwd,
                version: 4,
              },
              hasMore: false,
              records,
              projections: { values: { title: nativeTitle } },
            },
          }),
        );
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/ui`;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  let h = new Hub(state);
  t.after(() => h.store.close());
  await h.request({
    op: "settings",
    value: { ...h.settings(), dshDesktopUrl: endpoint },
  });
  const vault = new Vault(state, dshBridgeVault);
  await vault.save(endpoint, secret);
  const p = await h.request({ op: "project.add", path, name: "授权样例" }),
    projectId = p.id;
  const q = await h.request({
    op: "project.add",
    path: other,
    name: "其它项目",
  });
  const list = await h.request({ op: "sessions", projectId, backend: "dsh" });
  assert.deepEqual(
    list.items.map((row: any) => row.id),
    [thread],
  );
  const ref = { projectId, threadId: thread, source: list.source };
  const read = () => h.request({ op: "session.read", ...ref });
  const routed = await h.request({ op: "chat", text: "继续授权样例的「隔离原桌面讨论」讨论", requestId: "find-native-dsh" });
  assert.deepEqual(routed.native, ref);
  assert.equal(sends, 0);
  await assert.rejects(
    h.request({ op: "session.read", ...ref, projectId: q.id }),
    /未确认.*属于/,
  );
  assert.equal(reads, 0);
  const open = await read();
  assert.equal(open.ownerAvailable, true);
  assert.equal(open.activeTurnId, null);
  const serialized = JSON.stringify(open);
  assert.match(serialized, /历史中的公开回复/);
  assert.doesNotMatch(serialized, /内部运行条件|内部推理记录/);
  const proposed = await h.request({ op: "discussion.fromNative", ...ref, requestId: "cite-dsh" });
  const confirmed = await h.request({ op: "agent.launch.confirm", id: proposed.launchId,
    profile: { model: "fixture", effort: "max" } });
  assert.ok(h.desk.view(confirmed.openAgentId).lines.some((line) => line.text === "历史中的公开回复"));
  wrongIdentity = true;
  await assert.rejects(read(), /会话或协议版本/);
  wrongIdentity = false;

  const send = {
    op: "session.send",
    ...ref,
    requestId: "first-send",
    text: "公开续聊验证",
  };
  const ack = await h.request(send);
  assert.equal(ack.state, "accepted");
  assert.equal(last.sessionId, thread);
  assert.equal(last.requestId, "first-send");
  assert.equal(last.mode, "queue");
  assert.equal(sends, 1);
  assert.ok(h.workspaceHolds().includes(p.path));
  await assert.rejects(
    h.request({ ...send, requestId: "too-early" }),
    /待核对/,
  );
  assert.equal((await h.request(send)).state, "accepted");
  assert.equal(sends, 1);
  const proof = (
    seq: number,
    turn: number,
    text: string,
    requestId: string,
  ) => [
    event(seq, "turn/start", { turn }),
    event(seq + 1, "user/message", {
      source: { kind: "user", rpcId: requestId },
      content: [{ type: "text", text }],
    }),
    event(seq + 2, "turn/end", { turn, reason: { kind: "completed" } }),
  ];
  records.push(...proof(5, 2, "原文不符", send.requestId));
  assert.equal((await read()).workspacePending, true);
  records.splice(4, 3, ...proof(5, 2, send.text, send.requestId));
  const terminal = records.pop()!;
  assert.equal((await read()).workspacePending, true);
  records.unshift(terminal);
  const settled = await read();
  assert.equal(settled.actions[0].end, "completed");
  assert.equal(settled.workspacePending, false);
  assert.equal(
    (await h.request({ op: "search", text: send.text, projectId })).messages
      .length,
    1,
  );

  drop = true;
  const uncertain = {
    ...send,
    requestId: "lost-receipt",
    text: "第二条原生输入",
  };
  await assert.rejects(h.request(uncertain), /送达未确认/);
  assert.equal(sends, 2);
  h.store.close();
  h = new Hub(state);
  assert.equal((await h.request(uncertain)).state, "unknown");
  assert.equal(sends, 2);
  assert.ok(h.workspaceHolds().includes(p.path));
  badToken = true;
  await assert.rejects(read(), /拒绝了凭据/);
  badToken = false;
  offline = true;
  assert.equal((await read()).offline, true);
  assert.equal((await read()).workspacePending, true);
  assert.equal(
    (await h.request({ op: "sessions", projectId, backend: "dsh" })).offline,
    true,
  );
  offline = false;
  await vault.save(endpoint, secret);
  const rotated = await h.request({
    op: "sessions",
    projectId,
    backend: "dsh",
  });
  assert.notEqual(rotated.source, ref.source);
  await assert.rejects(read(), /桥或令牌已更换/);
  records.push(...proof(8, 3, uncertain.text, uncertain.requestId));
  h.dshDesktop.tick();
  await h.dshDesktop.settle();
  assert.deepEqual(h.workspaceHolds(), []);
  const recovered = await h.request({
    op: "session.read",
    ...ref,
    source: rotated.source,
  });
  assert.equal(recovered.workspacePending, false);
  assert.equal(
    recovered.actions.find((a: any) => a.id === uncertain.requestId).turnId,
    "DSH #3",
  );
  drop = false;
  emptyAck = true;
  const missingAck = { ...send, source: rotated.source, requestId: "empty-ack" };
  await assert.rejects(h.request(missingAck), /送达未确认/);
  assert.ok(h.workspaceHolds().includes(p.path));
  assert.equal((await h.request(missingAck)).state, "unknown");
  await assert.rejects(h.request({ ...missingAck, requestId: "never-send" }), /待核对/);
  assert.equal(sends, 3);
  const readRotated = () => h.request({
    op: "session.read", ...ref, source: rotated.source,
  });
  const knownTurn = proof(11, 4, missingAck.text, missingAck.requestId);
  const earlier = records.length;
  records.push(...knownTurn.slice(0, 2));
  const active = await readRotated();
  assert.equal(active.actions.at(-1).turnId, "DSH #4");
  assert.equal(active.workspacePending, true);
  // A later snapshot may omit the previously matched turn; never rebind its action.
  records.splice(earlier, 2, ...proof(14, 5, missingAck.text, missingAck.requestId));
  const mismatched = await readRotated();
  assert.equal(mismatched.actions.at(-1).turnId, "DSH #4");
  assert.equal(mismatched.workspacePending, true);
  records.splice(earlier, 3, ...knownTurn);
  assert.equal((await readRotated()).workspacePending, false);
  cwd = other;
  await assert.rejects(
    h.request({ op: "session.read", ...ref, source: rotated.source }),
    /未确认.*属于/,
  );

  await t.test("手机经 DSH 原桥丢回执后重启，凭据轮换仍能找回原结果", async () => {
    cwd = path;
    nativeTitle = null; // The actual Host returns null for a new session with no derived title.
    emptyAck = false;
    drop = true;
    h.ensureCodex = async () => { throw Error("此测试只接 DSH"); };
    let desk = new MobileDesk(h, 0, true);
    try {
      const challenge = await mobileInvite(desk, p.id);
      const initial = (await call(challenge, "pair", {})).pair;
      const phone = { ...challenge, token: initial.token };
      const catalog = (await call(phone, "catalog", { native: true })).value;
      const listed = catalog.groups.find((g: any) => g.backend === "dsh").items[0];
      assert.equal(listed.title, "DSH 原生会话");
      const target = listed.session;
      assert.deepEqual(target, { backend: "dsh", threadId: thread, source: rotated.source });
      const discussion = h.desk.open(p, "手机原讨论");
      const decision = { id: randomUUID(), version: randomUUID(), parents: [], text: "继续", quote: "就用继续" };
      assert.equal((await call(phone, "push", { projectId, discussion: discussion.id,
        title: discussion.title, messages: [], decisions: [decision] })).value, true);
      const command = { id: randomUUID(), projectId, discussion: discussion.id, version: catalog.projects[0].version,
        target, goal: "更新夹具文案", acceptance: "在原会话回报", decision: { id: decision.id, version: decision.version },
        expiresAt: Date.now() + 60000 };
      const enqueue = () => call(phone, "command", { value: command });
      const events = async (after = 0) => (await call(phone, "pull", { after })).value as any[];
      const find = (stage: string) => until(async () => (await events()).find((e) => e.id === command.id && e.receipt.stage === stage));
      assert.equal((await enqueue()).value.stage, "queued");
      const uncertain = await find("verify");
      const sent = last;
      assert.equal(sent.sessionId, thread);
      assert.equal(sent.requestId, "mobile:" + command.id);
      assert.match(sent.content[0].text, /采用原讨论的决定：继续/);
      assert.equal(sends, 4);
      await desk.close();
      h.store.close();
      h = new Hub(state);
      desk = new MobileDesk(h, Number(new URL(challenge.url).port), true);
      await desk.startSaved();
      assert.equal((await enqueue()).value.stage, "verify");
      assert.equal(sends, 4);
      await desk.close();
      await vault.save(endpoint, secret);
      const next = await h.request({ op: "sessions", projectId, backend: "dsh" });
      assert.notEqual(next.source, target.source);
      const resolved = proof(30, 6, sent.content[0].text, sent.requestId);
      records.push(...resolved.slice(0, 2));
      records.push(event(32, "assistant/message", { message: { content: [{ type: "text", text: "原会话已更新按钮文案" }] } }));
      records.push(event(33, "turn/end", { turn: 6, reason: { kind: "completed" } }));
      h.dshDesktop.tick();
      await h.dshDesktop.settle();
      const native = h.store.get("dsh-native-action", "mobile:" + command.id);
      assert.equal(native.source, next.source);
      assert.equal(native.originalSource, target.source);
      assert.equal(native.end, "completed");
      // The terminal receipt is already durable, but the mobile entry has not fetched its text.
      await vault.save(endpoint, secret);
      desk = new MobileDesk(h, Number(new URL(challenge.url).port), true);
      await desk.startSaved();
      const review = await until(async () => (await events(uncertain.seq)).find((e) =>
        e.id === command.id && e.receipt.stage === "review" && e.receipt.evidenceHash));
      assert.equal(review.receipt.turnId, "DSH #6");
      assert.equal(review.receipt.text, "原会话已更新按钮文案");
      assert.equal((await call(phone, "accept", { id: command.id, evidenceHash: review.receipt.evidenceHash })).value, true);
      await find("done");
      assert.equal(sends, 4);
      assert.equal(h.store.all("task").length, 0);
    } finally {
      await desk.close();
    }
  });
});
