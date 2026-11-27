import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { APP_VERSION, defaults, type Run } from "../src/shared/contracts";
import { copyTree, taskSet } from "./loop-score";
import { redact } from "../src/hub/security";
import { runContractLive } from "./loop-contract-live";

async function makeRetryDiagnostic(workspace: string) {
  await mkdir(join(workspace, "tests"), { recursive: true });
  const ticket = "ALCOR-TRIAL-" + randomUUID();
  await writeFile(join(workspace, ".acceptance-ticket"), ticket);
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { test: "node --test tests/receipt.test.cjs" },
    }),
  );
  await writeFile(
    join(workspace, "tests", "receipt.test.cjs"),
    [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "test('交付文件包含运行期回执工单号', () => {",
      "  assert.ok(fs.existsSync('result.txt'), '先写入 result.txt，检查随后提供工单号');",
      "  const ticket = fs.readFileSync('.acceptance-ticket', 'utf8').trim();",
      "  const result = fs.readFileSync('result.txt', 'utf8').trim();",
      "  assert.equal(result, ticket, '本次运行的工单号是 ' + ticket + '，请原样写入 result.txt');",
      "});",
    ].join("\n"),
  );
  return async () =>
    (await readFile(join(workspace, "result.txt"), "utf8")).trim() === ticket;
}
async function makeAuthorDiagnostic(workspace: string) {
  await mkdir(join(workspace, "tests"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node --test" } }),
  );
  await writeFile(
    join(workspace, "caption.mjs"),
    "export function caption(text, options = {}) { return text.trim(); }\n",
  );
  await writeFile(
    join(workspace, "tests", "caption.test.mjs"),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { caption } from '../caption.mjs';",
      "test('默认去除两边的空格', () => assert.equal(caption('  Mixed Case  '), 'Mixed Case'));",
    ].join("\n"),
  );
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--authorized"))
    throw new Error("真实 DSH 验证需要单独的开工指令");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw new Error("缺少指定的 DeepSeek 网关环境凭据");
  if (args.includes("--contract-probe")) {
    const index = args.indexOf("--dsh-path");
    if (index >= 0 && !args[index + 1]) throw new Error("缺少 DSH 安装路径");
    await runContractLive(key, index >= 0 ? args[index + 1] : "");
    return;
  }
  const authorProbe = args.includes("--author-probe");
  const escalationProbe = args.includes("--escalation-probe");
  const base = resolve(
    escalationProbe ? "../.dev/advance-loop/L3" : authorProbe ? "../.dev/advance-loop/L1-recheck" : "../.dev/advance-loop/L0",
  );
  await mkdir(base, { recursive: true });
  const out = await mkdtemp(join(base, "live-"));
  const { tasks, manifestHash } = await taskSet(
    resolve("experiments/advance-loop"),
  );
  const diagnostic = escalationProbe || args.includes("--diagnose");
  const samples = authorProbe
    ? [
        {
          id: "author-caption",
          title: "显式大写标题",
          prompt:
            "在 caption.mjs 的 caption(text, options) 增加 options.uppercase === true 时将去除首尾空格后的标题转为大写。没有设置或设为 false 时保留原行为。请通过项目的实际测试交付。",
          checks: ["test"],
          setup: makeAuthorDiagnostic,
        },
      ]
    : diagnostic
      ? [
          {
            id: "runtime-receipt",
            title: "按实际回执提交工单号",
            prompt:
              "请在项目根目录创建普通文本文件 result.txt，文件最终只包含检查返回的工单号。这个诊断的工单号仅在 result.txt 已存在时由检查返回；尚未收到回执时先写一行「待核对」。得到实际工单号后把文件内容换成它。不要更改任何检查文件。",
            checks: ["test"],
            setup: makeRetryDiagnostic,
          },
        ]
      : ["csv-quotes", "bill-totals", "text-preview"].map((id) => {
          const sample = tasks.find((task) => task.id === id)!;
          return {
            id,
            title: sample.title,
            prompt: sample.prompt,
            checks: sample.visibleChecks.map((c) => c.name),
            setup: async (workspace: string) => {
              await copyTree(join(sample.dir, "workspace"), workspace);
              return undefined;
            },
          };
        });
  const dshPath = args.includes("--dsh-path")
    ? args[args.indexOf("--dsh-path") + 1]
    : "";
  if (dshPath === undefined) throw new Error("缺少 DSH 安装路径");
  const results = [];
  for (const sample of samples) {
    const dir = join(out, sample.id),
      data = join(dir, "state"),
      workspace = join(dir, "workspace");
    const validate = await sample.setup(workspace);
    const hub = new Hub(data);
    try {
      const cfg = {
        ...defaults,
        dshPath,
        maxMinutes: 10,
        ...(authorProbe || escalationProbe ? { maxOutputTokens: 8000 } : {}),
        checkPath: [dirname(process.execPath)],
        loopBudget: {
          ...defaults.loopBudget,
          executorRuns: escalationProbe ? 2 : 4,
          retries: escalationProbe ? 0 : 3,
          wallMinutes: 10,
          checkTimeoutSec: 60,
        },
      };
      await hub.brain.vaultFor(cfg).save(cfg.endpoint, key);
      await hub.request({ op: "settings", value: cfg });
      const project = await hub.request({
        op: "project.add",
        path: workspace,
        name: "推进循环隔离验证",
      });
      const t = await hub.request({
        op: "task.create",
        requestId: sample.id,
        value: {
          projectId: project.id,
          goal: sample.prompt,
          mode: "write",
          advance: "loop",
          criteria: [
            {
              title: sample.title,
              checks: sample.checks,
              ...(authorProbe
                ? {
                    needsAuthoredCheck: true,
                    checkIntent:
                      "显式 true 时大写，false 和未指定均应保留大小写",
                  }
                : {}),
            },
          ],
          selectedChecks: sample.checks,
        },
      });
      assert.equal(t.launchId, undefined);
      const until = Date.now() + 610_000;
      while (Date.now() < until) {
        await hub.tick();
        const result = hub.loop.view(hub.getTask(t.id));
        if (result.loop.phase === "closed" || result.loop.phase === "halted")
          break;
        await delay(250);
      }
      const result = hub.loop.view(hub.getTask(t.id));
      const runs = hub.store.all<Run>("run");
      const retry =
        result.checkRuns.some(
          (r) => r.purpose === "criterion" && r.outcome === "failed",
        ) && runs.length >= 2;
      const autoClosed = result.loop.report?.outcome === "completed";
      const adopted = result.criteria[0].author;
      const authorProof =
        !!adopted?.path &&
        result.loop.protectedPaths.includes(adopted.path.toLowerCase()) &&
        result.checkRuns.some(
          (r) => r.id === adopted.beforeFail && r.outcome === "failed",
        ) &&
        result.checkRuns.some(
          (r) => r.purpose === "author-before" && r.outcome === "passed",
        );
      const verificationId = result.criteria[0].passed?.invocationId;
      const verification =
        verificationId && hub.store.get("invocation", verificationId);
      const verifierCompleted =
        verification?.status === "completed" &&
        verification?.purpose === "validity";
      const escalation = result.criteria[0].escalation;
      const diagnoser = escalation?.invocationId && hub.store.get("invocation", escalation.invocationId);
      const escalationChecked = runs.length === 2 && runs.every((r) => !!r.threadId) &&
        runs[0].threadId !== runs[1].threadId && escalation?.stage === "attempted" &&
        diagnoser?.status === "completed" && diagnoser.role === "diagnoser" &&
        escalation.diagnosis!.approaches.length >= 2;
      const dataSummary = {
        application: APP_VERSION,
        dsh: hub.dsh.status.version,
        model: runs.at(-1)?.model,
        when: new Date().toISOString(),
        sample: sample.id,
        manifestHash: diagnostic || authorProbe ? null : manifestHash,
        diagnostic,
        escalationProbe,
        escalationChecked,
        retry,
        autoClosed,
        runtimeReceiptMatched: validate && autoClosed ? await validate() : null,
        executorRuns: result.loop.budget.spent.executorRuns,
        authoredAcceptance: authorProof,
        verifierCompleted: !!verifierCompleted,
        numberOfChecks: result.checkRuns.length,
        halted: result.loop.halt?.reason || null,
        approvalRequests: hub.store.all("approval").length,
        pendingConfirmations: hub.launches.pending().length,
      };
      results.push(dataSummary);
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify(dataSummary, null, 2),
      );
      if (
        dataSummary.autoClosed &&
        dataSummary.runtimeReceiptMatched !== false &&
        (escalationProbe ? escalationChecked : authorProbe ? authorProof && verifierCompleted : retry) &&
        dataSummary.approvalRequests === 0 &&
        dataSummary.pendingConfirmations === 0
      )
        break;
    } finally {
      await hub.shutdown();
      hub.store.close();
      await rm(join(data, hub.brain.vaultFor(defaults).filename), {
        force: true,
      });
    }
  }
  await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({
      out,
      samples: results.length,
      completed: results.filter((r) => r.autoClosed).length,
      retriedAndClosed: results.some(
        (r) =>
          r.autoClosed &&
          r.runtimeReceiptMatched !== false &&
          (escalationProbe ? r.escalationChecked : authorProbe
            ? r.authoredAcceptance && r.verifierCompleted
            : r.retry) &&
          !r.approvalRequests &&
          !r.pendingConfirmations,
      ),
    }),
  );
  assert.ok(
    results.some(
      (r) =>
        r.autoClosed &&
        r.runtimeReceiptMatched !== false &&
        (escalationProbe ? r.escalationChecked : authorProbe ? r.authoredAcceptance && r.verifierCompleted : r.retry) &&
        !r.approvalRequests &&
        !r.pendingConfirmations,
    ),
    authorProbe
      ? "没有真实样本同时证明新增验收、独立有效性复核及自动收口"
      : "没有真实样本同时证明带失败证据重试和自动收口",
  );
}
main().catch((e) => {
  console.error(
    "真实循环验证未通过：" + redact((e as Error).message).slice(0, 500),
  );
  process.exitCode = 1;
});
