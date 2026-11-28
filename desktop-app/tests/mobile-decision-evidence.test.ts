import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MobileDesk } from "../src/hub/mobile";
import { Hub } from "../src/hub/service";
import { line } from "../src/hub/agent-ledger";
import { call, mobileInvite } from "./mobile-client";

test("shared decision shows the exact cited user message and distinguishes original time from first receipt", async () => {
  const fixtures = resolve(".test-data");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "decision-evidence-"));
  const hub = new Hub(join(root, "state")), desk = new MobileDesk(hub, 0, true);
  hub.tick = async () => {};
  try {
    const project = async (name: string) => {
      const path = join(root, name); await mkdir(path);
      return hub.request({ op: "project.add", path, name });
    };
    const a = await project("共享 A"), b = await project("私有 B");
    const discussion = hub.desk.open(a, "原共享讨论"), hidden = hub.desk.open(b, "不可见讨论");
    const wire = await mobileInvite(desk, a.id), phone = { ...wire, token: (await call(wire, "pair", {})).pair.token };
    const { projects, capabilities } = (await call(phone, "catalog", {})).value;
    assert.equal(capabilities.decisionEvidence, true);
    const scope = projects[0].version;
    const cited = randomUUID(), notCited = randomUUID(), privateId = randomUUID(), esp = randomUUID();
    const raw = "🧪 决定：选 B，不替换原验收";
    const quote = "选 B，不替换原验收", start = raw.indexOf(quote);
    const olderTime = "2026-11-22T08:30:00.000Z", sourceTime = "2026-11-25T08:30:00.000Z";
    line(hub.store, hidden.id, "user", "你", raw, { id: privateId, createdAt: olderTime });
    line(hub.store, discussion.id, "assistant", "助手", raw, { id: esp, createdAt: olderTime });
    const decisionId = randomUUID(), version = randomUUID();
    const value = { id: decisionId, version, parents: [], text: "选择 B", quote, source: { messageId: cited, start, end: start + quote.length } };
    const push = (decisions: object[], messages: object[] = []) => call(phone, "push",
      { title: "原共享讨论", projectId: a.id, discussion: discussion.id, messages, decisions });
    const evidence = (r: object = {}) => call(phone, "decision-evidence",
      { projectId: a.id, scope, discussion: discussion.id, decisionId, version, ...r });
    assert.match((await push([{ ...value, source: { ...value.source, messageId: privateId } }])).error, /无法核对/);
    assert.match((await push([{ ...value, source: { ...value.source, messageId: esp } }])).error, /无法核对/);
    assert.match((await push([{ ...value, source: { ...value.source, start: start + 1 } }])).error, /无法核对/);
    const messages = [{ id: notCited, role: "user", text: raw, at: olderTime }, { id: cited, role: "user", text: raw, at: sourceTime }];
    assert.equal((await push([value], messages)).value, true);
    const first = (await evidence()).value;
    assert.equal(first.state, "verified");
    assert.equal(first.messageId, cited);
    assert.equal(first.quote, quote);
    assert.equal(first.sourceAt, sourceTime);
    assert.ok(Date.parse(first.receivedAt) > Date.parse(first.sourceAt));
    assert.equal(Object.hasOwn(first, "effectiveAt"), false);
    assert.equal((await push([value], messages)).value, true);
    assert.deepEqual((await evidence()).value, first);
    assert.match((await push([{ ...value, source: { ...value.source, messageId: notCited } }])).error, /版本编号冲突/);
    assert.deepEqual((await evidence({ projectId: b.id, discussion: hidden.id })).value, { state: "missing" });
    assert.deepEqual((await evidence({ scope: "old" })).value, { state: "stale" });

    const oldId = randomUUID(), oldVersion = randomUUID();
    assert.equal((await push([{ id: oldId, version: oldVersion, parents: [], text: "旧决定", quote }])).value, true);
    const old = (await evidence({ decisionId: oldId, version: oldVersion })).value;
    assert.equal(old.state, "unverified");
    assert.equal(old.quote, undefined);
    const original = await call(phone, "resume", { projectId: a.id, version: scope });
    assert.ok(original.value.decisions.every((r: { target: { kind: string } }) => r.target.kind === "discussion"));
    const withEvidence = await call(phone, "resume", { projectId: a.id, version: scope, evidence: true });
    assert.ok(withEvidence.value.decisions.some((r: { target: { kind: string; version: string } }) => r.target.kind === "decision" && r.target.version === version));
    assert.equal((await push([{ ...value, version: randomUUID() }])).value, true);
    assert.deepEqual((await evidence()).value, { state: "conflict" });
    assert.equal(hub.store.all("task").length, 0);
    assert.equal(hub.store.all("command").length, 0);
  } finally { await desk.close(); hub.store.close(); }
});
