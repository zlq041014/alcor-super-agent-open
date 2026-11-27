import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readPreviewReceipt, requestPreviewStop, startGuardedPreview } from "../src/hub/preview-job-process";
import type { PreviewJobDefinition } from "../src/shared/preview-job";
import { PreviewJobLedger } from "../src/hub/preview-job-ledger";
import { entity, Store } from "../src/hub/store";
import type { Run, Task } from "../src/shared/contracts";

const root = resolve(".test-data/preview-job");
const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

test("S6 独立 Windows 监护器：请求停止后，确认主进程和子进程都已退出才写终态", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "tree-"));
  const worker = join(dir, "writer.cjs");
  await writeFile(worker, [
    'const fs=require("node:fs");',
    'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},10000)"],{windowsHide:true,stdio:"ignore"});',
    'fs.writeFileSync("pids.json",JSON.stringify([process.pid,child.pid]));',
    'setInterval(()=>{},10000);',
  ].join("\n"));
  const guard = startGuardedPreview(process.execPath, [worker], dir, Date.now() + 14_000);
  t.after(async () => { guard.stop(); await guard.done; await rm(dir, { recursive: true, force: true }); });
  let pids: number[] | undefined;
  for (let i = 0; i < 100 && !pids; i++) {
    try { pids = JSON.parse(await readFile(join(dir, "pids.json"), "utf8")) as number[]; }
    catch (error) {
      if (!["ENOENT", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") && !(error instanceof SyntaxError)) throw error;
      await delay(50);
    }
  }
  assert.ok(guard.started);
  assert.ok(pids?.every(pidAlive));
  guard.stop();
  const final = await guard.done;
  assert.equal(final.released, true);
  assert.equal(final.exitCode, 164);
  assert.ok(pids?.every((pid) => !pidAlive(pid)));
});

test("S6 独立 Windows 监护器硬截止不依赖 Hub 请求", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "hard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hardAt = Date.now() + 2800;
  const guard = startGuardedPreview(process.execPath, ["-e", "setInterval(()=>{},5000)"], dir, hardAt);
  try {
    const final = await guard.done;
    assert.equal(final.released, true);
    assert.equal(final.exitCode, 164);
    assert.ok(final.endedAt! >= hardAt && final.endedAt! - hardAt < 1800);
  } finally { guard.stop(); }
});

test("S6 缺失、错绑和未验满的作业回执均不能用于释放；停止请求可重复提交", async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "binding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const definition: PreviewJobDefinition = {
    id: randomUUID(), receiptKey: randomUUID(), sourceHash: "0".repeat(64),
    ffmpeg: "D:/fixture/ffmpeg.exe", frames: 2, hardAt: Date.now() + 1000,
  };
  assert.equal(await readPreviewReceipt(dir, definition), undefined);
  const snapshot = { id: definition.id, receiptKey: String(randomUUID()), phase: "completed",
    sequence: 2, frames: 2, at: Date.now() };
  await writeFile(join(dir, "receipt.json"), JSON.stringify(snapshot));
  assert.equal(await readPreviewReceipt(dir, definition), undefined);
  snapshot.receiptKey = definition.receiptKey;
  await writeFile(join(dir, "receipt.json"), JSON.stringify({ ...snapshot, frames: 1 }));
  assert.equal(await readPreviewReceipt(dir, definition), undefined);
  await requestPreviewStop(dir, definition, "user");
  await requestPreviewStop(dir, definition, "hard");
  assert.equal(JSON.parse(await readFile(join(dir, "stop.json"), "utf8")).reason, "user");
  await writeFile(join(dir, "receipt.json"), JSON.stringify(snapshot));
  assert.equal((await readPreviewReceipt(dir, definition))?.phase, "completed");
});

test("S6 Hub 重启保留独立作业占用，停止请求和丢失回执不会释放设备", async (t) => {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "ledger-"));
  let store = new Store(dir), jobs = new PreviewJobLedger(store);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.now();
  function queue(resources: string[]) {
    const task: Task = {
      ...entity(), graph: true, loopId: randomUUID(), projectId: "fixture", title: "预览",
      goal: "生成实际预览帧", acceptance: "帧数达标", constraints: "", revision: 1,
      stateVersion: 1, mode: "write", state: "active", model: "", archived: false, unread: false,
      attempt: 1, dependencies: [], attachments: [],
    };
    const run: Run = {
      ...entity(), taskId: task.id, revision: task.revision, commandId: randomUUID(),
      workPath: join(dir, "agent", task.id), startedAt: task.createdAt,
      state: "running", response: "", diff: "",
      graphAttempt: { nodeId: randomUUID(), nodeRevision: 1, role: "execute", inputs: [], resources: [] },
    };
    store.put("task", task);
    store.put("run", run);
    const definition: PreviewJobDefinition = {
      id: randomUUID(), receiptKey: randomUUID(), sourceHash: "a".repeat(64), frames: 2,
      hardAt: now + 3000, ffmpeg: "D:/fixture/ffmpeg.exe",
    };
    return jobs.queue(task, run, definition, join(dir, "jobs", definition.id), resources);
  }
  const first = queue(["render:device"]), second = queue(["render:device"]);
  assert.equal(jobs.claim(first.id, now), undefined);
  for (const job of [first, second]) {
    store.put("run", { ...store.get<Run>("run", job.runId)!, state: "ended", outcome: "completed" });
    jobs.confirmHandoff(job.id);
  }
  assert.equal(jobs.claim(first.id, now)?.state, "dispatching");
  const receipt = { id: first.id, receiptKey: first.definition.receiptKey,
    sequence: 1, at: now, phase: "running" as const, frames: 1 };
  assert.equal(jobs.observe(first.id, receipt)?.state, "running");
  assert.equal(jobs.claim(second.id, now + 100), undefined);
  store.close();
  store = new Store(dir);
  jobs = new PreviewJobLedger(store);
  store.tx(() => jobs.recover());
  assert.equal(jobs.get(first.id)?.state, "unknown");
  assert.equal(jobs.claim(first.id, now + 200), undefined);
  assert.equal(jobs.request(first.id, "user")?.state, "unknown");
  assert.equal(jobs.claim(second.id, now + 500), undefined);
  assert.equal(jobs.observe(first.id, { ...receipt, phase: "stopped", sequence: 2, receiptKey: randomUUID() }), undefined);
  assert.equal(jobs.observe(first.id, { ...receipt, phase: "stopped" }), undefined);
  assert.equal(jobs.claim(second.id, now + 700), undefined);
  assert.equal(jobs.observe(first.id, { ...receipt, phase: "stopped", sequence: 2 })?.state, "stopped");
  assert.equal(jobs.claim(second.id, now + 800)?.state, "dispatching");
  assert.deepEqual(jobs.held().map((job) => job.id), [second.id]);
  const expired = queue(["other:device"]);
  assert.equal(jobs.claim(expired.id, now + 3000), undefined);
  assert.equal(jobs.get(expired.id)?.state, "stopped");
});
