import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GraphProgress } from "../src/hub/graph-progress";
import { Store } from "../src/hub/store";
import { GraphTiming } from "../src/shared/graph-progress";

test("S6：帧计数递增才续时，重复回执和重复文件不算第二次进展", async (t) => {
  const root = resolve(".test-data/graph-progress");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "window-"));
  let store = new Store(dir), progress = new GraphProgress(store);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(GraphTiming.safeParse({ observeMinutes: 3, hardMinutes: 3 }).success, false);
  progress.start("frames", 0, 100, 400);
  progress.frames("frames", 2, 90);
  assert.equal(progress.check("frames", 100), undefined);
  assert.equal(progress.get("frames")?.observeAt, 200);
  assert.equal(progress.get("frames")?.lastObserved, 2);

  store.close();
  store = new Store(dir);
  progress = new GraphProgress(store);
  progress.frames("frames", 2, 175);
  progress.frames("frames", 1, 190);
  assert.equal(progress.check("frames", 200), "stalled");
  assert.equal(progress.get("frames")?.hardAt, 400);

  progress.start("files", 0, 100, 400);
  progress.file("files", "deliver.txt", Buffer.from("确实写出的文件"), 50);
  progress.file("files", "again.txt", Buffer.from("确实写出的文件"), 90);
  progress.file("files", "DELIVER.txt", Buffer.from("改同一份文件"), 90);
  assert.equal(progress.get("files")?.outputs.length, 1);
  progress.check("files", 100);
  assert.equal(progress.check("files", 200), "stalled");
});

test("S6：即使一直有新产物，硬截止也不延后；迟到证据不能撤销请求", async (t) => {
  const root = resolve(".test-data/graph-progress");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "hard-"));
  const store = new Store(dir), progress = new GraphProgress(store);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  progress.start("run", 0, 100, 240);
  progress.frames("run", 1, 70);
  progress.check("run", 100);
  progress.frames("run", 2, 150);
  progress.check("run", 200);
  assert.equal(progress.get("run")?.observeAt, 240);
  progress.frames("run", 3, 230);
  assert.equal(progress.check("run", 240), "hard");
  progress.frames("run", 4, 241);
  assert.equal(progress.get("run")?.frames, 3);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='graph.observation-stop'").get()?.n, 1);
  assert.equal(progress.check("run", 300), "hard");
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='graph.observation-stop'").get()?.n, 1);
});
