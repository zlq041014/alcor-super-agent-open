import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Hub } from "../src/hub/service";
import type { Memory, Message, Project } from "../src/shared/contracts";

test("明确替换保留独立条件、旧验收和并列修订", async () => {
  const fixtures = resolve(".test-data");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "manager-decisions-"));
  const folder = join(root, "project");
  await mkdir(folder);
  const hub = new Hub(join(root, "state"));
  try {
    const project = await hub.request({ op: "project.add", name: "合成版本项目", path: folder }) as Project;
    const agent = hub.desk.open(project, "确认样本");
    const requests: { input: string; rules: string[]; recent: { text: string }[] }[] = [];
    hub.brain.complete = async (_cfg, wire) => {
      requests.push(JSON.parse(wire));
      return { text: "合成讨论结果", model: "fixture-only", usage: null };
    };
    const send = async (value: string, id: string) => {
      const result = await hub.desk.discuss(agent, value, id);
      assert.equal("error" in result ? result.error : undefined, undefined);
    };
    await send("只用 A 稿", "a");
    const [first] = hub.rules(project.id);
    assert.equal(first.text, "只用 A 稿");
    hub.store.put("run", { id: "accepted-a", revision: 1, decisionInputs: [{ id: first.id, revision: first.revision }] });
    hub.store.put("task", { id: "old-task", projectId: project.id, title: "旧验收", state: "done", revision: 1, runId: "accepted-a" });
    hub.store.put("agent", { id: "old-executor", parentAgentId: agent.id, projectId: project.id, taskId: "old-task" });

    await send("只用 B 稿，取代 A 稿", "b");
    await send("截止周五", "friday");
    assert.equal(hub.rules(project.id).length, 2);
    assert.deepEqual(new Set(hub.rules(project.id).map((rule) => rule.text)), new Set(["只用 B 稿", "截止周五"]));
    const updated = hub.store.get<Memory>("memory", first.id)!;
    assert.deepEqual(updated.decision?.versions?.map((v) => [v.text, v.parents]), [["只用 A 稿", []], ["只用 B 稿", [1]]]);
    const calls = requests.length;
    await send("之前验了什么？", "historical");
    assert.equal(requests.length, calls);
    assert.match(hub.desk.lines(agent.id).at(-1)!.text, /只用 A 稿/);
    await hub.chat("上次验收用哪一稿？", "historical-chief", "old-task", project.id);
    assert.match(hub.store.all<Message>("message").find(m => m.workRequestId === "historical-chief")!.text, /只用 A 稿/);
    await send("现在用哪一稿？", "current");
    assert.deepEqual(new Set(requests.at(-1)!.rules), new Set(["只用 B 稿", "截止周五"]));
    assert.ok(!JSON.stringify(requests.at(-1)).includes("A 稿"));

    await send("只用 C 稿，取代 A 稿", "concurrent-c");
    const conflict = hub.store.get<Memory>("memory", first.id)!;
    assert.deepEqual(conflict.decision?.heads, [2, 3]);
    assert.deepEqual(conflict.decision?.versions?.at(-1)?.parents, [1]);
    assert.deepEqual(hub.rules(project.id).map(rule => rule.text), ["截止周五"]);
    const beforeChoice = requests.length;
    await send("现在用哪一稿？", "conflicted");
    assert.match(hub.desk.lines(agent.id).at(-1)!.text, /只用 B 稿.*只用 C 稿/);
    assert.equal(requests.length, beforeChoice);
    await send("有哪些无关的准备事项？", "unrelated");
    assert.equal(requests.length, beforeChoice + 1);
    assert.deepEqual(requests.at(-1)!.rules, ["截止周五"]);
    await send("D 稿取代不存在的稿", "missing");
    assert.deepEqual(hub.store.get<Memory>("memory", first.id)!.decision?.heads, [2, 3]);
    assert.equal(hub.rules(project.id).length, 1);

    const folderB = join(root, "other");
    await mkdir(folderB);
    const other = await hub.request({ op: "project.add", name: "另一项目", path: folderB }) as Project;
    const resolve = { op: "decision.resolve", id: first.id, projectId: project.id, revision: 3, heads: [2, 3], selectedRevision: 3 };
    const ledger = () => hub.store.get<Memory>("memory", first.id)!;
    const count = () => hub.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='decision.resolved'").get()!.n;
    await assert.rejects(hub.request({ ...resolve, projectId: other.id }), /找不到此项目/);
    await assert.rejects(hub.request({ ...resolve, heads: [2, 2] }), /已变化/);
    await assert.rejects(hub.request({ ...resolve, selectedRevision: 1 }), /无法核对/);
    await assert.rejects(hub.request({ op: "memory.save", id: first.id, projectId: project.id, revision: 3, text: "强行合并", enabled: false }), /并列决定/);
    assert.deepEqual(ledger(), conflict);
    assert.equal(count(), 0);
    await send("只用 D 稿，取代 A 稿", "concurrent-d");
    await assert.rejects(hub.request(resolve), /已变化/);
    assert.deepEqual(ledger().decision?.heads, [2, 3, 4]);
    const confirmed = await hub.request({ ...resolve, revision: 4, heads: [4, 3, 2] }) as Memory;
    assert.deepEqual(confirmed.decision?.heads, [5]);
    assert.deepEqual(confirmed.decision?.versions?.at(-1), {
      revision: 5, text: "只用 C 稿", parents: [2, 3, 4], selectedRevision: 3,
    });
    assert.equal(count(), 1);
    await assert.rejects(hub.request({ ...resolve, revision: 4, heads: [4, 3, 2] }), /已变化/);
    await assert.rejects(hub.request({ op: "memory.save", id: first.id, projectId: project.id, revision: 3, text: "旧草稿", enabled: false }), /修订已变化/);
    await assert.rejects(hub.request({ op: "memory.save", id: first.id, projectId: other.id, revision: 5, text: "错误项目", enabled: true }), /项目决定/);
    await send("现在用哪一稿？", "after-confirm");
    assert.deepEqual(new Set(requests.at(-1)!.rules), new Set(["只用 C 稿", "截止周五"]));
    await send("之前验了什么？", "after-confirm-history");
    assert.match(hub.desk.lines(agent.id).at(-1)!.text, /只用 A 稿/);
    assert.equal(ledger().decision?.versions?.[0].text, "只用 A 稿");
    await send("只用 E 稿，取代 C 稿", "replace-confirmed");
    assert.deepEqual(ledger().decision?.versions?.at(-1)?.parents, [5]);
    assert.deepEqual(new Set(hub.rules(project.id).map(rule => rule.text)), new Set(["只用 E 稿", "截止周五"]));
  } finally { hub.store.close(); }
});
