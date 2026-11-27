import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Hub } from "../src/hub/service";
import { ModelRequestError } from "../src/hub/brain";
import { entity } from "../src/hub/store";
import { defaults, type Task } from "../src/shared/contracts";
import type { Loop } from "../src/shared/loop-contracts";

async function fixture(t: TestContext, roleCalls = 8) {
  const base = resolve(".test-data/roles");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "case-"));
  let hub = new Hub(dir);
  t.after(async () => {
    hub.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const task: Task = {
    ...entity(),
    projectId: "fixture-project",
    title: "测试",
    goal: "验证测试",
    constraints: "",
    acceptance: "",
    state: "ready",
    stateVersion: 1,
    revision: 1,
    mode: "write",
    model: "",
    archived: false,
    unread: false,
    attempt: 0,
    attachments: [],
    dependencies: [],
  };
  const loop: Loop = {
    ...entity(),
    taskId: task.id,
    projectId: task.projectId,
    mode: "loop",
    phase: "advancing",
    contractRevision: 1,
    roster: {
      executor: { model: "executor", effort: "low" },
      verifier: { model: "fixture-judge", effort: "high" },
    },
    closeMode: "auto",
    budget: {
      limits: { ...defaults.loopBudget, roleConcurrency: 1, roleCalls },
      spent: {
        executorRuns: 0,
        roleCalls: 0,
        tokensKnown: 0,
        unknownUsageCalls: 0,
      },
    },
    startedAt: new Date().toISOString(),
    blockedStreak: 0,
    rejectedWrites: 0,
    protectedPaths: [],
    assumptions: [],
  };
  hub.store.put("task", task);
  hub.store.put("loop", loop);
  const spec = {
    loopId: loop.id,
    revision: 1,
    stepId: "test-step",
    role: "verifier" as const,
    purpose: "validity" as const,
    promptVersion: 1,
    instructions: "按证据返回 verdict",
    input: { goal: "查证 fixture" },
    materials: [
      {
        id: "check-1",
        kind: "note" as const,
        title: "test",
        content: "已脱敏材料",
        sourceVersion: "v1",
      },
    ],
    schema: z.object({ verdict: z.enum(["sound", "suspect"]) }).strict(),
    timeoutMs: 700,
    maxOutputTokens: 1500,
    signal: new AbortController().signal,
  };
  return {
    get hub() {
      return hub;
    },
    spec,
    spent: () => hub.store.get<Loop>("loop", loop.id)!.budget.spent,
    restart: () => {
      hub.store.close();
      hub = new Hub(dir);
    },
  };
}
const good = {
  text: '{"verdict":"sound"}',
  model: "fixture-judge",
  usage: { total_tokens: 7 },
};

test("角色按快照使用模型、超时和材料；JSON 格式错一次后修复，复用持久结果", async (t) => {
  const f = await fixture(t);
  let n = 0;
  f.hub.brain.complete = async (cfg, prompt, system, _report, options) => {
    assert.equal(cfg.model, "fixture-judge");
    assert.equal(cfg.reasoningEffort, "high");
    assert.equal(cfg.maxOutputTokens, 1500);
    assert.equal(options?.timeoutMs, 700);
    assert.deepEqual(
      JSON.parse(prompt).materials.map((x: { id: string }) => x.id),
      ["check-1"],
    );
    if (++n === 1) return { ...good, text: '{"bad":true}' };
    assert.match(system, /上一次输出不符合格式/);
    return good;
  };
  const out = await f.hub.roles.call(f.spec);
  assert.equal(out.status, "completed");
  assert.deepEqual(await f.hub.roles.call(f.spec), out);
  assert.equal(n, 2);
  assert.equal(f.spent().roleCalls, 2);
  assert.equal(f.spent().tokensKnown, 14);
  const rows = f.hub.store.all("invocation");
  assert.deepEqual(
    rows.map((r) => r.status),
    ["invalid", "completed"],
  );
  assert.ok(
    rows.every(
      (r) =>
        r.materials[0].contentHash && r.materials[0].sourceVersion === "v1",
    ),
  );
  assert.ok(rows.every((r) => !Object.hasOwn(r.materials[0], "content")));
});

test("429 退避每次都计入预算，预算用尽不会再次调用", async (t) => {
  const f = await fixture(t, 2);
  let calls = 0;
  f.hub.brain.complete = async () => {
    if (++calls === 1) throw new ModelRequestError("模拟限流", 429, 0);
    return { ...good, usage: null };
  };
  assert.equal((await f.hub.roles.call(f.spec)).status, "completed");
  assert.equal(
    (await f.hub.roles.call({ ...f.spec, stepId: "another" })).status,
    "budget",
  );
  assert.equal(calls, 2);
  assert.equal(f.spent().unknownUsageCalls, 2);
});

test("两次无效输出不会变成通过证据", async (t) => {
  const f = await fixture(t);
  f.hub.brain.complete = async () => ({ ...good, text: "我觉得可以算通过" });
  assert.equal((await f.hub.roles.call(f.spec)).status, "invalid");
  assert.equal(f.spent().roleCalls, 2);
  assert.ok(
    f.hub.store
      .all("invocation")
      .every((row) => row.outputValid === false && !row.result),
  );
});

test("JSON 回执触及输出上限时保留真实用量，并用同模型和强度修复一次", async (t) => {
  const f = await fixture(t);
  const loop = f.hub.store.get<Loop>("loop", f.spec.loopId)!;
  loop.roster.verifier = { model: "deepseek-flash", effort: "max" };
  f.hub.store.put("loop", loop);
  const caps: number[] = [];
  f.hub.brain.request = async (_cfg, route, body) => {
    assert.equal(route, "chat/completions");
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.response_format, { type: "json_object" });
    caps.push(body.max_tokens);
    return {
      model: body.model,
      choices:
        caps.length === 1
          ? [
              {
                finish_reason: "length",
                message: { content: "", reasoning_content: "不记录的推理" },
              },
            ]
          : [{ finish_reason: "stop", message: { content: good.text } }],
      usage: { total_tokens: caps.length === 1 ? 12100 : 2000 },
    };
  };
  const result = await f.hub.roles.call({ ...f.spec, maxOutputTokens: 12000 });
  assert.equal(result.status, "completed");
  assert.deepEqual(caps, [12000, 16000]);
  assert.equal(f.spent().tokensKnown, 14100);
  assert.equal(f.spent().unknownUsageCalls, 0);
  const recorded = f.hub.store.all("invocation");
  assert.deepEqual(
    recorded.map((r) => [r.status, r.outputError]),
    [
      ["invalid", "length"],
      ["completed", undefined],
    ],
  );
  assert.ok(!JSON.stringify(recorded).includes("不记录的推理"));
});

test("角色并发受限，重启中断调用可重新核对，失效结果不会写为成功", async (t) => {
  const f = await fixture(t);
  f.hub.store.put("invocation", {
    ...entity(),
    status: "calling",
    loopId: f.spec.loopId,
  });
  f.restart();
  assert.equal(f.hub.store.all("invocation")[0].status, "unknown");
  const active = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  let n = 0;
  f.hub.brain.complete = async () => {
    if (++n === 1) await pending;
    return good;
  };
  const first = f.hub.roles.call({ ...f.spec, signal: active.signal });
  const second = f.hub.roles.call({ ...f.spec, stepId: "second" });
  await delay(50);
  assert.equal(n, 1);
  active.abort();
  release();
  assert.equal((await first).status, "cancelled");
  assert.equal((await second).status, "completed");
  assert.equal(n, 2);
  assert.deepEqual(
    f.hub.store.all("invocation").map((r) => r.status),
    ["unknown", "cancelled", "completed"],
  );
});
