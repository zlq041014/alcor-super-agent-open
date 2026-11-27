import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  readdir,
  writeFile,
  readFile,
  cp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { LEDGER_VERSION, Store, entity } from "../src/hub/store";
import { hash } from "../src/hub/security";
import { defaults } from "../src/shared/contracts";
import type { Loop } from "../src/shared/loop-contracts";
import type { MissSample } from "../src/hub/misses";

async function fixture(t: TestContext, cleanup = true) {
  const base = resolve(".test-data/loop-ledger");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "fixture-"));
  if (cleanup) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("v2 升级前保留原版账本和引用的文件副本", async (t) => {
  const dir = await fixture(t);
  const first = new Store(dir);
  const source = Buffer.from("备份夹具");
  const digest = hash(source);
  await mkdir(join(dir, "blobs"));
  const path = join(dir, "blobs", digest + ".txt");
  await writeFile(path, source);
  first.put("artifact", {
    ...entity(),
    origin: "attachment",
    path,
    hash: digest,
  });
  first.db.exec("PRAGMA user_version=2");
  first.close();
  const upgraded = new Store(dir);
  try {
    assert.equal(LEDGER_VERSION, 8);
    assert.equal(
      upgraded.db.prepare("PRAGMA user_version").get()?.user_version,
      LEDGER_VERSION,
    );
    const [name] = await readdir(join(dir, "backups"));
    const snapshot = join(dir, "backups", name);
    assert.match(name, /^pre-loop-/);
    const manifest = JSON.parse(
      await readFile(join(snapshot, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.files, [{ name: digest + ".txt", hash: digest }]);
    assert.deepEqual(
      await readFile(join(snapshot, "blobs", digest + ".txt")),
      source,
    );
    const backup = new DatabaseSync(join(snapshot, "state.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        2,
      );
    } finally {
      backup.close();
    }
  } finally {
    upgraded.close();
  }
});

test("检查输出有一致性备份；恢复后中途循环保留为已暂停，诊断没有正文", async (t) => {
  const dir = await fixture(t, false),
    root = join(dir, "project"),
    data = join(dir, "data");
  await mkdir(root);
  await writeFile(join(root, "fixture.txt"), "public fixture");
  const hub = new Hub(data);
  t.after(async () => {
    hub.shuttingDown = true;
    await hub.loop.shutdown();
    hub.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  hub.dsh.probe = async () => ({ status: "ACP 就绪", version: "fixture" });
  const p = await hub.request({
    op: "project.add",
    path: root,
    name: "隔离夹具",
  });
  const { id } = await hub.request({
    op: "task.create",
    requestId: "saved-loop",
    value: {
      projectId: p.id,
      goal: "PRIVATE TASK FIXTURE",
      advance: "loop",
      mode: "write",
      loopChecks: [
        { kind: "file", name: "private-check-name", path: "fixture.txt" },
      ],
    },
  });
  const until = Date.now() + 5000;
  while (hub.getTask(id).state !== "done" && Date.now() < until) {
    await hub.tick();
    await delay(20);
  }
  assert.equal(hub.getTask(id).state, "done");
  const view = hub.loop.view(hub.getTask(id));
  const output = view.checkRuns.find((r) => r.outputRef);
  assert.ok(output?.outputRef);
  const checkpoint = {
    ...view.loop,
    phase: "advancing",
    step: undefined,
    report: undefined,
  } satisfies Loop;
  hub.store.put("loop", checkpoint);
  hub.store.put("task", { ...hub.getTask(id), state: "ready" });
  const { path } = await hub.backup();
  const manifest = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, LEDGER_VERSION);
  assert.ok(
    manifest.files.find((f: { name: string }) => f.name === output.outputRef),
  );
  assert.equal(
    hash(await readFile(join(path, "blobs", output.outputRef))),
    output.outputRef,
  );
  assert.equal(await hub.restore(path), true);
  assert.equal(hub.getTask(id).state, "paused");
  assert.equal(hub.loop.view(hub.getTask(id)).loop.halt?.reason, "restored");
  assert.match(await hub.loop.output(output.id), /已确认文件存在/);
  const diagnostics = await hub.diagnostics();
  const raw = await readFile(diagnostics.path, "utf8");
  assert.ok(JSON.parse(raw).counts.loop === 1);
  assert.ok(
    !raw.includes("PRIVATE TASK FIXTURE") &&
      !raw.includes("private-check-name") &&
      !raw.includes("fixture.txt"),
  );
  assert.equal(hub.settings().defaultAdvance, defaults.defaultAdvance);
});

test("损坏或缺漏的备份在写入现用文件前拒绝，有效备份才能恢复", async (t) => {
  const dir = await fixture(t, false);
  const archived = new Hub(join(dir, "archived"));
  const current = new Hub(join(dir, "current"));
  t.after(async () => {
    archived.store.close();
    current.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const attachment = async (hub: Hub, label: string) => {
    const input = join(dir, label + ".txt");
    await writeFile(input, label);
    return hub.addAttachment(input);
  };
  const expected = await attachment(archived, "archive first fixture");
  await attachment(archived, "archive second fixture");
  const ours = await attachment(current, "live fixture");
  const memory = await current.request({
    op: "memory.save",
    text: "live rule",
    enabled: true,
    projectId: "",
  });
  const { path } = await archived.backup();
  const manifest = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  const blobNames = await readdir(join(current.dir, "blobs"));
  const backups = join(current.dir, "backups");

  const missing = join(dir, "missing-list-entry");
  await cp(path, missing, { recursive: true });
  await writeFile(
    join(missing, "manifest.json"),
    JSON.stringify({
      ...manifest,
      files: manifest.files.slice(0, 1),
    }),
  );
  await assert.rejects(current.restore(missing), /全部副本/);

  const corrupt = join(dir, "broken-second-copy");
  await cp(path, corrupt, { recursive: true });
  await writeFile(
    join(corrupt, "blobs", manifest.files[1].name),
    "incomplete copy",
  );
  await assert.rejects(current.restore(corrupt), /副本校验失败/);
  assert.deepEqual(await readdir(join(current.dir, "blobs")), blobNames);
  assert.equal((await current.readArtifact(ours.id)).content, "live fixture");
  assert.equal(current.store.get("memory", memory.id).text, "live rule");
  await assert.rejects(readdir(backups), { code: "ENOENT" });

  const restoring = current.restore(path);
  await assert.rejects(
    current.request({
      op: "memory.save",
      text: "must wait",
      enabled: true,
      projectId: "",
    }),
    /恢复进行中/,
  );
  assert.equal(await restoring, true);
  assert.equal(
    (await current.readArtifact(expected.id)).content,
    "archive first fixture",
  );
  assert.equal(current.store.get("memory", memory.id), undefined);
  assert.equal((await readdir(backups)).length, 1);
});

test("漏检登记冻结原交付，变更后的目录不冒充旧证据，样本可随备份恢复", async (t) => {
  const dir = await fixture(t, false);
  const root = join(dir, "project");
  await mkdir(root);
  const file = join(root, "result.txt");
  await writeFile(file, "登记时核对的已交付原文");
  const hub = new Hub(join(dir, "original"));
  const imported = new Hub(join(dir, "imported"));
  t.after(async () => {
    hub.shuttingDown = true;
    await hub.loop.shutdown();
    hub.store.close();
    imported.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  hub.dsh.probe = async () => ({ status: "ACP 就绪", version: "fixture" });
  const project = await hub.request({ op: "project.add", path: root, name: "漏检夹具" });
  const { id } = await hub.request({
    op: "task.create", requestId: "miss-fixture", value: {
      projectId: project.id, goal: "核对已存在的交付", advance: "loop", mode: "write",
      loopChecks: [{ kind: "file", name: "交付文件", path: "result.txt" }],
    },
  });
  const deadline = Date.now() + 5000;
  while (hub.getTask(id).state !== "done" && Date.now() < deadline) {
    await hub.tick();
    await delay(20);
  }
  const task = hub.getTask(id);
  assert.equal(task.state, "done");
  const view = hub.loop.view(task);
  const request = {
    op: "miss.record", id, requestId: randomUUID(), taskRevision: task.revision,
    revision: view.loop.contractRevision, text: "报告没有核对缺失的交付说明",
  };
  await assert.rejects(hub.request({ ...request, revision: request.revision + 1 }), /交付修订已变化/);
  const [saved, duplicate] = await Promise.all([hub.request(request), hub.request(request)]);
  assert.deepEqual(saved, duplicate);
  assert.equal(saved.materialStatus, "frozen");
  const sample = hub.store.get<MissSample>("miss", saved.id)!;
  assert.deepEqual(sample.report, view.loop.report);
  assert.deepEqual(sample.criteria, view.criteria);
  assert.deepEqual(sample.findings, view.findings);
  assert.ok(sample.checkOutputRefs.length);
  assert.equal(sample.delivery?.evidence.workspace.version, view.loop.report?.workspaceVersion);
  assert.equal(sample.delivery?.evidence.materials.find((item) => item.title === "result.txt")?.content, "登记时核对的已交付原文");
  await assert.rejects(hub.request({ ...request, text: "编号冲突" }), /请求编号冲突/);
  await writeFile(file, "另一次修改的内容");
  const fromArchive = await hub.request({ ...request, requestId: randomUUID(), text: "仍能用旧交付的封存材料" });
  assert.equal(fromArchive.materialStatus, "frozen");
  assert.ok(sample.delivery);
  hub.store.remove("miss-delivery", sample.delivery.id); // Model a pre-L4 delivery with no automatic archive.
  const changed = await hub.request({ ...request, requestId: randomUUID(), text: "旧材料已失联时仍可登记" });
  assert.equal(changed.materialStatus, "unavailable");
  const stale = hub.store.get<MissSample>("miss", changed.id)!;
  assert.equal(stale.delivery, undefined);
  assert.deepEqual(stale.checkOutputRefs, sample.checkOutputRefs);
  const backup = await hub.backup();
  await imported.restore(backup.path);
  const paused = imported.store.get<MissSample>("miss", saved.id)!;
  assert.deepEqual(paused.delivery, sample.delivery);
  assert.deepEqual(paused.report, sample.report);
  assert.equal(paused.attribution?.state, "paused");
  const listing = await imported.request({ op: "miss.list", id });
  assert.equal(listing.length, 3);
  assert.equal(listing.find((item: { id: string }) => item.id === saved.id).text, saved.text);
  assert.equal(listing.find((item: { id: string }) => item.id === saved.id).attribution.state, "paused");
  assert.doesNotMatch(JSON.stringify(listing), /登记时核对的已交付原文|另一次修改的内容/);
  assert.equal(hub.store.all("invocation").length, 0);

  imported.brain.configured = async () => true;
  const used: string[] = [];
  imported.brain.complete = async (settings, prompt) => {
    const input = JSON.parse(prompt);
    assert.equal(input.fixedCategory, "review");
    assert.equal(input.reminder, saved.text);
    assert.deepEqual(input.authorizedChecks, []);
    used.push(settings.model);
    return {
      model: "fixture-actual",
      usage: { total_tokens: used.length * 5 },
      text: JSON.stringify({
        category: "review", reason: "缺少异常分支核对",
        derived: used.length === 1
          ? { kind: "command-check", checkId: "non-authorized" }
          : { kind: "review-item", lens: "正确性与边界", text: "核对异常分支是否给出可执行的反馈" },
      }),
    };
  };
  await imported.request({ op: "miss.attribute", id: saved.id, revision: 1, category: "review" });
  await assert.rejects(imported.request({ op: "miss.attribute", id: saved.id, revision: 1, category: "check" }), /归因版本已变化/);
  imported.misses.tick();
  for (let i = 0; i < 100 && imported.misses.busy(); i++) await delay(10);
  const attributed = imported.store.get<MissSample>("miss", saved.id)!;
  assert.equal(attributed.attribution?.state, "derived");
  assert.equal(attributed.attribution?.category, "review");
  assert.equal(attributed.derived?.kind, "review-item");
  assert.deepEqual(used, [sample.profile.model, sample.profile.model]);
  assert.deepEqual(imported.store.all("invocation").map((r) => [r.status, r.actualModel, r.tokens]),
    [["invalid", "fixture-actual", 5], ["completed", "fixture-actual", 10]]);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const gate = new Promise<void>((done) => { release = done; });
  imported.brain.complete = async () => {
    entered();
    await gate;
    return {
      model: "fixture-stale",
      usage: {},
      text: JSON.stringify({ category: "review", reason: "过期回答", derived: { kind: "none" } }),
    };
  };
  await imported.request({ op: "miss.attribute", id: saved.id, revision: 2, category: "review" });
  imported.misses.tick();
  await waiting;
  await imported.request({ op: "miss.attribute", id: saved.id, revision: 3, category: "check" });
  release();
  for (let i = 0; i < 100 && imported.misses.busy(); i++) await delay(10);
  assert.deepEqual(imported.store.get<MissSample>("miss", saved.id)?.attribution,
    { revision: 4, category: "check", state: "pending" });
  assert.equal(imported.store.all("invocation").at(-1).status, "cancelled");
  assert.equal(imported.getTask(id).state, "done");
  assert.equal(imported.store.all("run").length, 0);
});
