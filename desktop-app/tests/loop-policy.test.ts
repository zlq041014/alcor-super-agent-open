import test from "node:test";
import assert from "node:assert/strict";
import { decide, evidenceFor, nextFailure } from "../src/core/loop-policy";
import { LoopBudgetSchema } from "../src/shared/loop-contracts";
import type {
  Loop,
  Criterion,
  Check,
  CheckRun,
} from "../src/shared/loop-contracts";
import type { Task, Run } from "../src/shared/contracts";

const at = Date.UTC(2026, 10, 19);
const task = { state: "ready" } as Task;
const loop: Loop = {
  id: "l",
  createdAt: new Date(at).toISOString(),
  updatedAt: new Date(at).toISOString(),
  startedAt: new Date(at).toISOString(),
  taskId: "t",
  projectId: "p",
  mode: "loop",
  phase: "advancing",
  contractRevision: 1,
  roster: { executor: { model: "test", effort: "default" } },
  closeMode: "auto",
  budget: {
    limits: LoopBudgetSchema.parse({ executorRuns: 1, wallMinutes: 10 }),
    spent: {
      executorRuns: 0,
      roleCalls: 0,
      tokensKnown: 0,
      unknownUsageCalls: 0,
    },
  },
  blockedStreak: 0,
  rejectedWrites: 0,
  protectedPaths: [],
  assumptions: [],
};
const c: Criterion = {
  id: "first",
  loopId: loop.id,
  order: 0,
  input: {
    title: "第一项",
    detail: "",
    necessity: "required",
    method: "command",
    checks: [],
    points: "",
  },
  definitionHash: "criterion",
  createdAt: loop.createdAt,
  updatedAt: loop.updatedAt,
  verify: { method: "command", checkIds: ["a"] },
  status: "pending",
  dependsOn: [],
  attempts: 0,
  noProgress: 0,
};
const checks = [
  { id: "a", status: "authorized", input: { name: "test" } },
] as Check[];
test("按阶段、回执、回归优先级与预算决定下一步", () => {
  const one = (
    l: Loop,
    t: Task = task,
    run?: Run,
    list = [c],
    checking = false,
    now = at,
  ) => decide(l, t, list, checks, run, checking, now);
  assert.equal(one({ ...loop, phase: "baseline" }).kind, "run-checks");
  assert.equal(one({ ...loop, phase: "closing" }).kind, "run-checks");
  assert.equal(one(loop, { ...task, state: "paused" }).kind, "wait");
  assert.equal(one(loop, task, { state: "running" } as Run).kind, "wait");
  assert.equal(one(loop, task, { state: "unknown" } as Run).kind, "halt");
  assert.equal(
    one(loop, task, undefined, [c], false, at + 600000).kind,
    "halt",
  );
  const writing: Loop = {
    ...loop,
    step: {
      id: "s",
      kind: "execute",
      attempt: 0,
      state: "running",
      runId: "r",
    },
  };
  assert.equal(
    one(writing, task, { state: "ended", outcome: "completed" } as Run).kind,
    "check-work",
  );
  assert.equal(
    one(writing, task, { state: "ended", outcome: "failed" } as Run).kind,
    "failed-work",
  );
  assert.equal(
    one({ ...loop, step: { ...writing.step!, kind: "check" } }).kind,
    "run-checks",
  );
  assert.equal(one(loop).kind, "writer");
  const stale = { ...c, id: "stale", status: "stale" } as const;
  assert.deepEqual(one(loop, task, undefined, [c, stale]), {
    kind: "writer",
    criterion: stale,
  });
  assert.equal(
    one(loop, task, undefined, [{ ...c, dependsOn: ["not-passed"] }]).kind,
    "close",
  );
  assert.equal(
    one(loop, task, undefined, [
      { ...c, verify: { method: "judge", checkIds: [] } },
    ]).kind,
    "judge",
  );
  assert.equal(one({ ...loop, blockedStreak: 3 }).kind, "halt");
  assert.equal(
    one({
      ...loop,
      budget: {
        ...loop.budget,
        spent: { ...loop.budget.spent, executorRuns: 1 },
      },
    }).kind,
    "halt",
  );
  assert.equal(one(loop, task, undefined, [c], true).kind, "wait");
});

test("失败签名与无改动都会限制重试，缺失证据不会通过", () => {
  const failure = { signature: "same", detail: "failed" };
  const first = nextFailure(c, { failure, changed: false }, 3);
  assert.equal(first.status, "failed");
  assert.equal(
    nextFailure(first, { failure, changed: true }, 3).status,
    "blocked",
  );
  assert.equal(nextFailure(c, { failure, changed: true }, 0).status, "blocked");
  assert.equal(evidenceFor(c, checks, new Map()).passed, false);
  assert.equal(
    evidenceFor(
      c,
      checks,
      new Map([["a", { id: "result", outcome: "passed" } as CheckRun]]),
    ).passed,
    true,
  );
});
