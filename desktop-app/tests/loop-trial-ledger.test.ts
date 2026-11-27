import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runSlot,
  saveJson,
  saveRoundSummary,
  withRound,
  type Attempt,
} from "../scripts/loop-trial-ledger";

const slot = { group: "A" as const, task: "example", run: 1 };
function sample(n: number): Attempt {
  return {
    ...slot,
    systemCompleted: true,
    visiblePassed: true,
    hiddenPassed: true,
    passed: true,
    mechanicalFalseCompletion: 0,
    protectedFilesChanged: 0,
    executorRuns: 1,
    rejectedWrites: 0,
    wallMs: 100,
    tokensKnown: null,
    infrastructureRetry: n === 2,
    timedOut: false,
    infrastructure: false,
    confirmationRequests: 0,
    version: "fixture",
    runs: [],
  };
}
test("实验续跑优先复用结果，遗留的运行只补跑一次", async (t) => {
  const base = resolve(".test-data/experiment-resume");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "round-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recovered = join(dir, "recovered");
  await mkdir(join(recovered, "attempt-1"), { recursive: true });
  await saveJson(join(recovered, "attempt-1", "result.json"), sample(1));
  const skipped = async () => {
    throw new Error("不应重复执行");
  };
  assert.equal((await runSlot(recovered, slot, skipped)).passed, true);
  assert.equal((await runSlot(recovered, slot, skipped)).executorRuns, 1);
  await assert.rejects(
    runSlot(recovered, { ...slot, run: 2 }, skipped),
    /不一致/,
  );

  const incomplete = join(dir, "interrupted");
  await mkdir(join(incomplete, "attempt-1"), { recursive: true });
  const restarted = await runSlot(incomplete, slot, async (_dir, n) => {
    assert.equal(n, 2);
    return sample(n);
  });
  assert.equal(restarted.infrastructureRetry, true);
  const earlier = JSON.parse(
    await readFile(join(incomplete, "attempt-1", "result.json"), "utf8"),
  );
  assert.equal(earlier.interrupted, true);
  assert.equal(earlier.passed, false);

  const twice = join(dir, "twice");
  await mkdir(join(twice, "attempt-1"), { recursive: true });
  await mkdir(join(twice, "attempt-2"), { recursive: true });
  assert.equal((await runSlot(twice, slot, skipped)).passed, false);
});

test("实验轮次的并发运行器被操作系统拒绝，退出后可接手", async () => {
  const dir = resolve(".test-data", "lease-" + crypto.randomUUID());
  await withRound(dir, async () => {
    await assert.rejects(
      withRound(dir, async () => false),
      /独占权/,
    );
  });
  assert.equal(await withRound(dir, async () => true), true);
});

test("评分中断后沿用已完成的执行回执，不创建补跑", async (t) => {
  const base = resolve(".test-data/experiment-resume");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "score-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ended = join(dir, "attempt-1");
  await mkdir(ended);
  await saveJson(join(ended, "execution.json"), { done: true });
  const score = await runSlot(dir, slot, async (path, attempt) => {
    assert.equal(path, ended);
    assert.equal(attempt, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(path, "execution.json"), "utf8")),
      { done: true },
    );
    return sample(attempt);
  });
  assert.ok(score.passed && !score.infrastructureRetry);
});

test("恢复 A 组时保留已发布的 B 组摘要", async (t) => {
  const base = resolve(".test-data/experiment-resume");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "summary.json");
  const stats = (B: number, C: number) => ({
    mode: "--live",
    manifestHash: "a".repeat(64),
    groups: { A: { total: 45 }, B: { total: B }, C: { total: C } },
  });
  assert.equal(await saveRoundSummary(path, stats(45, 0)), true);
  const complete = await readFile(path, "utf8");
  assert.equal(await saveRoundSummary(path, stats(0, 0)), false);
  assert.equal(await readFile(path, "utf8"), complete);
  assert.equal(await saveRoundSummary(path, stats(45, 45)), true);
  await assert.rejects(
    saveRoundSummary(path, { ...stats(45, 45), mode: "--fake" }),
    /不一致/,
  );
});
