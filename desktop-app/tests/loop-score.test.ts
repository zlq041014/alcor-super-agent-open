import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkWorkspace, copyTree, taskSet } from "../scripts/loop-score";
import { hash } from "../src/hub/security";

test("冻结评分不掺入本轮生成的测试，但仍检查其是否被改写", async (t) => {
  const base = resolve(".test-data/experiment-score");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { tasks } = await taskSet(resolve("experiments/advance-loop"));
  const task = tasks.find((t) => t.id === "csv-quotes")!;
  const work = join(dir, "submitted");
  await copyTree(join(task.dir, "workspace"), work);
  await copyTree(join(task.dir, "reference"), work);
  const created = "alcor-fixture.test.mjs";
  const authored =
    "import test from 'node:test'; test('循环新增测试', () => { throw Error('candidate only'); });";
  await writeFile(join(work, created), authored);
  const spec = [{ path: created, hash: hash(authored) }];
  assert.deepEqual(await checkWorkspace(task, work, join(dir, "score"), spec), {
    visiblePassed: true,
    hiddenPassed: true,
    protectedFilesChanged: 0,
  });
  await writeFile(join(work, created), "modified");
  const tampered = await checkWorkspace(
    task,
    work,
    join(dir, "tampered-score"),
    spec,
  );
  assert.equal(tampered.protectedFilesChanged, 1);
  assert.deepEqual(
    await checkWorkspace(task, work, join(dir, "audit-only"), spec, {
      auditOnly: true,
    }),
    {
      visiblePassed: false,
      hiddenPassed: false,
      protectedFilesChanged: 1,
    },
  );
  const slow = await checkWorkspace(
    task,
    work,
    join(dir, "scoring-timeout"),
    spec,
    { timeoutMs: 20 },
  );
  assert.equal(slow.scoringTimedOut, true);
  assert.equal(slow.visiblePassed, false);
  assert.equal(slow.protectedFilesChanged, 1);
});
