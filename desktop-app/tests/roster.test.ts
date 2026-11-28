import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MobileDesk } from "../src/hub/mobile";
import { Hub } from "../src/hub/service";
import { call, mobileInvite } from "./mobile-client";

test("registered identities survive restart and project-scoped mobile views never expose the directory", async () => {
  const fixtures = resolve(".test-data");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "roster-"));
  let hub = new Hub(join(root, "state"));
  hub.tick = async () => {};
  let mobile: MobileDesk | undefined;
  try {
    const project = async (name: string) => {
      const path = join(root, name);
      await mkdir(path);
      return hub.request({ op: "project.add", name, path });
    };
    const a = await project("样本 A"), b = await project("样本 B");
    const saved = (name: string, source: string, mode: string, requestId: string) =>
      hub.request({ op: "roster.add", name, source, mode, requestId, note: "仅电脑可见的能力备注" });
    const member = await saved("同名 Agent", "dsh", "managed", "roster-first");
    const independent = await saved("同名 Agent", "manual", "record", "roster-second");
    const free = await saved("未分配 Agent", "codex", "record", "roster-third");
    assert.deepEqual(await saved("同名 Agent", "dsh", "managed", "roster-first"), member);
    assert.notEqual(member.id, independent.id);
    const prepare = (p: { id: string }, chosen: string, requestId: string) => hub.request({ op: "task.create", requestId,
      value: { projectId: p.id, goal: requestId, advance: "single", mode: "read", ...(chosen ? { rosterId: chosen } : {}) } });
    const confirm = (launchId: string) => hub.request({ op: "agent.launch.confirm", id: launchId, profile: { model: "fixture", effort: "default" } });
    await assert.rejects(prepare(a, independent.id, "read-only-denied"), /不能接新工作/);
    await assert.rejects(prepare(a, member.id, "offline-denied"), /执行端还未就绪/);
    hub.dsh.status = { status: "ACP 就绪", version: "fixture" };

    const preview = await prepare(a, member.id, "stale-roster");
    assert.equal(hub.store.all("task").length, 0);
    const card = hub.launches.pending().find(r => r.id === preview.launchId)!;
    assert.equal(card.backend, "dsh");
    assert.deepEqual(card.roster, { id: member.id, name: member.name, revision: 1 });
    const patch = (revision: number, state: string) => hub.request({ op: "roster.update", id: member.id,
      revision, name: member.name, note: member.note, state });
    const paused = await patch(1, "paused");
    await assert.rejects(confirm(preview.launchId), /名册已变化/);
    await assert.rejects(prepare(a, member.id, "paused-denied"), /不能接新工作/);
    await assert.rejects(patch(1, "active"), /名册已变化/);
    const resumed = await patch(paused.revision, "active");

    const ids = [];
    for (const [p, title] of [[a, "项目 A 关联"], [b, "项目 B 私有工作"]] as const) {
      const proposal = await prepare(p, member.id, title);
      const result = await confirm(proposal.launchId);
      assert.deepEqual(await confirm(proposal.launchId), result);
      const task = hub.getTask(result.id);
      assert.equal(task.rosterId, member.id);
      assert.equal(task.backend, "dsh");
      assert.equal(task.projectId, p.id);
      ids.push(task.id);
    }
    const independentWork = await confirm((await prepare(a, "", "独立工作")).launchId);
    const association = { op: "roster.link", id: independent.id, taskId: independentWork.id, revision: 1 };
    const before = hub.getTask(independentWork.id);
    await hub.request(association);
    assert.deepEqual(hub.getTask(independentWork.id), before);
    await assert.rejects(hub.request({ ...association, id: free.id }), /已有登记身份/);
    await patch(resumed.revision, "retired");
    assert.equal(hub.store.all("run").length, 0);
    hub.store.close();
    hub = new Hub(join(root, "state"));
    hub.tick = async () => {};
    const snap = await hub.snapshot();
    assert.deepEqual(snap.roster.map(m => m.id).sort(), [member.id, independent.id, free.id].sort());
    assert.equal(snap.roster.find(m => m.id === member.id)?.state, "retired");
    assert.deepEqual(snap.tasks.filter(t => t.rosterId === member.id).map(t => t.id).sort(), ids.sort());
    assert.equal(snap.tasks.find(t => t.id === independentWork.id)?.rosterRecorded, true);
    assert.equal(snap.tasks.some(t => t.rosterId === free.id), false);

    mobile = new MobileDesk(hub, 0, true);
    const invite = await mobileInvite(mobile, a.id);
    const phone = { ...invite, token: (await call(invite, "pair", {})).pair.token };
    const onlyA = (await call(phone, "agents", { projectId: a.id })).value;
    assert.deepEqual(onlyA.nodes.map((n: { roster?: { id: string } }) => n.roster?.id).sort(), [member.id, independent.id].sort());
    assert.equal(onlyA.nodes.every((n: { parentId?: string }) => !n.parentId), true);
    assert.doesNotMatch(JSON.stringify(onlyA), /项目 B 私有工作|仅电脑可见|未分配 Agent/);
    assert.deepEqual((await call(phone, "agents", { projectId: b.id })).value, { allowed: false });
  } finally { await mobile?.close(); hub.store.close(); }
});
