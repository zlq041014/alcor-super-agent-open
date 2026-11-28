import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MobileDesk } from "../src/hub/mobile";
import { Hub } from "../src/hub/service";
import { hash } from "../src/hub/security";
import { entity, stamp, Store } from "../src/hub/store";
import { call, mobileInvite } from "./mobile-client";

test("project resume is read-only, grants scoped, and exposes only device-owned waiting receipts", async () => {
  const fixtures = resolve(".test-data");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "project-resume-"));
  const state = join(root, "state"), hub = new Hub(state), desk = new MobileDesk(hub, 0, true);
  hub.tick = async () => {};
  let ledger: Store | undefined;
  try {
    const project = async (name: string) => {
      const path = join(root, name); await mkdir(path);
      return hub.request({ op: "project.add", path, name });
    };
    const a = await project("接续项目 A"), b = await project("不能读取的 B"), empty = await project("空的共享项目");
    const pair = async () => {
      const invite = await mobileInvite(desk, a.id, empty.id);
      return { ...invite, token: (await call(invite, "pair", {})).pair.token };
    };
    const phone = await pair(), other = await pair();
    const discussion = hub.desk.open(a, "可回到的共享讨论"), privateDiscussion = hub.desk.open(b, "私有项目的讨论");
    const chosen = randomUUID(), conflicted = randomUUID();
    for (const [id, source, texts] of [[chosen, discussion.id, ["对外共享的当前决定"]],
      [conflicted, discussion.id, ["冲突原文左", "冲突原文右"]],
      [randomUUID(), privateDiscussion.id, ["另一个项目的决定"]]] as const) {
      const versions = texts.map(text => ({ version: randomUUID(), text, at: stamp() }));
      hub.store.put("mobile-decision", { id, discussion: source, versions, heads: versions.map(v => v.version) });
    }
    await hub.request({ op: "memory.save", projectId: a.id, text: "这里是桌面私有规则", enabled: true });
    ledger = new Store(join(state, "mobile"));
    const own = randomUUID();
    for (const [id, device, goal, stage, question] of [[own, phone, "只显示自己的回执", "waiting", { expiresAt: new Date(Date.now() + 60000).toISOString() }],
      [randomUUID(), other, "另一台手机的回执", "waiting", { expiresAt: new Date(Date.now() + 60000).toISOString() }],
      [randomUUID(), phone, "过期待答不能继续打开", "waiting", { expiresAt: new Date(0).toISOString() }],
      [randomUUID(), phone, "尚无验收凭据的结果", "review", undefined]] as const)
      ledger.put("mobile-work", { id: "mobile:" + id, device: hash(device.token), data: { id, projectId: a.id, goal }, last: { stage, question } });
    const catalog = async () => (await call(phone, "catalog", {})).value;
    const initial = await catalog();
    assert.equal(initial.capabilities.projectResume, true);
    const version = initial.projects.find((p: { id: string }) => p.id === a.id).version;
    const get = async (projectId = a.id, v = version) => (await call(phone, "resume", { projectId, version: v })).value;
    const first = await get();
    assert.deepEqual(first.decisions.map((r: { text: string }) => r.text), ["对外共享的当前决定"]);
    assert.deepEqual(first.decisions[0].target, { kind: "discussion", id: discussion.id });
    assert.deepEqual(first.pending[0].target, { kind: "work", id: own });
    assert.equal(first.pending.length, 1);
    assert.equal(first.gaps.length, 3);
    assert.ok(first.gaps.some((row: { text: string }) => row.text.includes("原验收回执有变化")));
    assert.doesNotMatch(JSON.stringify(first), /冲突原文|另一台手机|私有规则|私有项目/);
    assert.deepEqual(await get(b.id), { allowed: false });
    assert.deepEqual(await get(randomUUID()), { allowed: false });
    assert.deepEqual(await get(a.id, "expired"), { allowed: true, stale: true });
    const blank = await get(empty.id, initial.projects.find((p: { id: string }) => p.id === empty.id).version);
    assert.deepEqual({ changes: blank.changes, pending: blank.pending, decisions: blank.decisions, gaps: blank.gaps },
      { changes: [], pending: [], decisions: [], gaps: [] });
    const last = await get();
    assert.deepEqual(last.decisions, first.decisions);
    assert.equal(hub.store.all("task").length, 0);
    assert.equal(hub.store.all("command").length, 0);
    assert.equal(hub.store.all("invocation").length, 0);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM events").get()?.n, 0);
    await desk.local({ action: "revoke", id: hash(phone.token) });
    assert.equal((await call(phone, "resume", { projectId: a.id, version })).code, 401);
  } finally { ledger?.close(); await desk.close(); hub.store.close(); }
});
