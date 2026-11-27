import test from "node:test";
import assert from "node:assert/strict";
import {
  readSettings,
  Request,
  TaskInput,
  taskAdvance,
} from "../src/shared/contracts";
import { CheckInput } from "../src/shared/loop-contracts";

test("旧设置保留，推进默认为单次；运行中的追加预算不能被减小", () => {
  const settings = readSettings({ profileVersion: 2, theme: "dark" });
  assert.equal(settings.defaultAdvance, "single");
  assert.equal(settings.loopBudget.executorRuns, 30);
  assert.equal(settings.theme, "dark");
  assert.ok(
    Request.safeParse({ op: "loop.budget", id: "t", add: { executorRuns: 2 } })
      .success,
  );
  for (const add of [{}, { executorRuns: -1 }, { extra: 1 }])
    assert.equal(
      Request.safeParse({ op: "loop.budget", id: "t", add }).success,
      false,
    );
});

test("循环写入需要原项目；相对路径和清单修订在入口校验", () => {
  const settings = readSettings({ defaultAdvance: "loop" });
  const task = TaskInput.parse({ projectId: "p", goal: "目标" });
  assert.throws(() => taskAdvance(task, settings), /只读/);
  assert.throws(
    () => taskAdvance({ ...task, mode: "write", isolate: true }, settings),
    /原目录/,
  );
  assert.equal(taskAdvance({ ...task, mode: "write" }, settings), "loop-native");
  assert.equal(taskAdvance({ ...task, advance: "single" }, settings), "single");
  for (const path of [
    "../file",
    "test\\.. \\file",
    "C:relative",
    "/root",
    "test:a",
  ])
    assert.equal(
      CheckInput.safeParse({ kind: "file", name: "内容", path }).success,
      false,
    );
  assert.ok(
    Request.safeParse({
      op: "loop.revise",
      id: "t",
      revision: 1,
      changes: [{ action: "add", value: { title: "新增条目" } }],
    }).success,
  );
});
