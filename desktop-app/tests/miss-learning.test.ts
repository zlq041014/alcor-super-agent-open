import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import type { MissSample } from "../src/hub/misses";
import { reviewFindings } from "../src/hub/review";

test("漏检用同一冻结材料做盲回放，通过留出才启用；停用和删除穿透旧备份", async (t) => {
  const root = resolve(".test-data/miss-learning");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "learning-"));
  const workspace = join(dir, "project");
  await mkdir(workspace);
  const hub = new Hub(join(dir, "state"));
  t.after(async () => {
    hub.shuttingDown = true;
    await hub.misses.shutdown();
    await hub.loop.shutdown();
    hub.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  hub.dsh.probe = async () => ({ status: "ACP 就绪", version: "fixture" });
  const { id: projectId } = await hub.request({
    op: "project.add",
    name: "独立交付",
    path: workspace,
  });
  const step = async () => {
    hub.misses.tick();
    for (let i = 0; i < 100 && hub.misses.busy(); i++) await delay(10);
    assert.equal(hub.misses.busy(), false);
  };
  const old = "历史原件显示超时没有告知用户";
  const healthy = "另一份交付中超时明确显示，界面可重试";
  const marker = "用户单独说明：旧结果在超时后没有提示";
  const candidate = "检查失败路径是否显示清楚的恢复提示";
  const close = async (goal: string, content: string) => {
    await writeFile(join(workspace, "result.txt"), content);
    const { id } = await hub.request({
      op: "task.create",
      requestId: randomUUID(),
      value: {
        projectId,
        goal,
        mode: "write",
        advance: "loop",
        loopChecks: [{ kind: "file", name: "确认文件", path: "result.txt" }],
      },
    });
    for (let i = 0; i < 250 && hub.getTask(id).state !== "done"; i++) {
      await hub.tick();
      await delay(20);
    }
    const task = hub.getTask(id);
    assert.equal(task.state, "done");
    return task;
  };
  const original = await close("交付含有明确错误提示的报告", old);
  const entry = async (text: string) =>
    hub.request({
      op: "miss.record",
      id: original.id,
      taskRevision: original.revision,
      revision: hub.loop.view(original).loop.contractRevision,
      requestId: randomUUID(),
      text,
    });
  let scenario: "pass" | "hallucinate" = "pass";
  const calls: { purpose: string; body: any }[] = [];
  hub.brain.configured = async () => true;
  hub.brain.complete = async (_cfg, prompt, instructions) => {
    const body = JSON.parse(prompt);
    if (instructions.includes("漏检归因者")) {
      return {
        model: "fixture-attribution",
        usage: { total_tokens: 15 },
        text: JSON.stringify({
          category: "review",
          reason: "漏检涉及失败分支",
          derived: {
            kind: "review-item",
            lens: "正确性与边界",
            text: candidate,
          },
        }),
      };
    }
    const scoring = instructions.includes("逐项核对两组");
    const purpose = scoring ? "score" : "inspect";
    calls.push({ purpose, body });
    const source = body.goal === original.goal;
    assert.ok(
      body.materials.some(
        (item: any) => item.content === (source ? old : healthy),
      ),
    );
    assert.doesNotMatch(prompt, /这个当前版本/);
    if (!scoring || !source) assert.doesNotMatch(prompt, /用户单独说明/);
    if (scoring) {
      return {
        model: "fixture-score",
        usage: {},
        text: JSON.stringify({
          firstTarget: null,
          secondTarget: source ? 0 : null,
          unsupportedSecond: [],
        }),
      };
    }
    const findings =
      body.projectCheckHints && (source || scenario === "hallucinate")
        ? [
            {
              title: "失败提示",
              claim: "错误分支没有说明",
              impact: "用户不能判断怎么继续",
              severity: "major",
              evidence: [
                {
                  path: "result.txt",
                  quote: source
                    ? old
                    : "这一段引用完全不存在于留出交付的原始文件",
                },
              ],
            },
          ]
        : [];
    return {
      model: "fixture-review",
      usage: {},
      text: JSON.stringify({ findings }),
    };
  };
  const saved = await entry(marker);
  await step();
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), []);
  await step();
  assert.equal(
    hub.store.get<MissSample>("miss", saved.id)?.replay?.state,
    "waiting",
  );
  assert.equal(calls.length, 0);
  hub.brain.configured = async () => false;
  const holdout = await close("核对另外一份交付的超时提示", healthy);
  hub.brain.configured = async () => true;
  await writeFile(
    join(workspace, "result.txt"),
    "这个当前版本在回放时不会读取",
  );
  await step();
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((c) => c.purpose),
    ["inspect", "inspect", "score", "inspect", "inspect", "score"],
  );
  for (const [base, enriched] of [
    [0, 1],
    [3, 4],
  ]) {
    const { projectCheckHints, ...withSameInputs } = calls[enriched].body;
    assert.deepEqual(projectCheckHints, [candidate]);
    assert.deepEqual(withSameInputs, calls[base].body);
  }
  const learned = (await hub.snapshot()).learnedChecks[0];
  assert.equal(learned.id, saved.id);
  assert.equal(learned.replay.state, "passed");
  assert.equal(learned.replay.holdoutTaskId, holdout.id);
  assert.deepEqual(hub.rules(projectId), []);
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), [
    candidate,
  ]);
  assert.deepEqual(hub.misses.hints(projectId, [], "一致性"), []);
  assert.deepEqual(hub.misses.hints("other", [], "正确性与边界"), []);
  const liveReview = hub.roles.call;
  const received = new Map<string, unknown>();
  hub.roles.call = async (spec) => {
    received.set(spec.stepId.split(":").at(-1)!, spec.input.projectCheckHints);
    return { status: "invalid", reason: "fixture-only" };
  };
  try {
    const view = hub.loop.view(original);
    const sample = hub.store.get<MissSample>("miss", saved.id)!;
    await reviewFindings(
      hub,
      view.loop,
      { id: "fixture", kind: "review", attempt: 1, state: "running" },
      1,
      original,
      view.criteria,
      sample.delivery!.evidence,
      AbortSignal.timeout(1000),
    );
    assert.deepEqual(received.get("正确性与边界"), [candidate]);
    assert.equal(received.get("一致性"), undefined);
  } finally {
    hub.roles.call = liveReview;
  }
  assert.equal(hub.getTask(original.id).state, "done");
  assert.equal(hub.store.all("run").length, 0);

  scenario = "hallucinate";
  const unsafe = await entry(marker + "，作为误报对照");
  await step();
  await step();
  assert.equal(
    hub.store.get<MissSample>("miss", unsafe.id)?.replay?.state,
    "rejected",
  );
  await assert.rejects(
    hub.request({
      op: "miss.manage",
      id: unsafe.id,
      revision: 1,
      action: "enable",
    }),
    /尚未通过/,
  );
  const { path } = await hub.backup();
  await hub.request({
    op: "miss.manage",
    id: saved.id,
    revision: 1,
    action: "disable",
  });
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), []);
  await hub.restore(path);
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), []);
  await hub.request({
    op: "miss.manage",
    id: saved.id,
    revision: 1,
    action: "enable",
  });
  await hub.request({
    op: "miss.manage",
    id: saved.id,
    revision: 2,
    action: "edit",
    text: "新提示需要重验",
  });
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), []);
  await hub.restore(path);
  assert.equal(
    hub.store.get<MissSample>("miss", saved.id)?.replay?.state,
    "paused",
  );
  await hub.request({
    op: "miss.manage",
    id: saved.id,
    revision: 1,
    action: "delete",
  });
  await hub.restore(path);
  assert.equal(hub.store.get("miss", saved.id), undefined);
  assert.deepEqual(hub.misses.hints(projectId, [], "正确性与边界"), []);
});
