import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Hub } from "../src/hub/service";
import { runCheck } from "../src/hub/checks";
import { defaults, APP_VERSION, type Run } from "../src/shared/contracts";
import { hash } from "../src/hub/security";
import { copyTree, tree } from "./loop-score";

const taskInput = z.object({
  goal: z.string().min(1),
  constraints: z.string(),
});
const protectedEntries = ["package.json", "tests/label.test.mjs"];
const sourceFile = "src/label.mjs";

export async function runContractLive(key: string, dshPath: string) {
  const root = resolve("../.dev/advance-loop/L1-ready/onboarding");
  const spec = taskInput.parse(
    JSON.parse(await readFile(join(root, "task.json"), "utf8")),
  );
  const original = join(root, "workspace"),
    reference = join(root, "reference");
  const expected = await Promise.all(
    protectedEntries.map(async (file) =>
      hash(await readFile(join(original, file))),
    ),
  );
  const base = join(dirname(root), "live-validation");
  await mkdir(base, { recursive: true });
  const out = await mkdtemp(join(base, "real-"));
  const samples = await Promise.allSettled(
    [false, true].map(async (alreadyDone) => {
      const mode = alreadyDone ? "already-complete" : "new-work";
      const sample = join(out, mode),
        work = join(sample, "workspace"),
        state = join(sample, "state");
      await copyTree(original, work);
      if (alreadyDone) await copyTree(reference, work);
      const initialFiles = await tree(work);
      const initialSource = hash(await readFile(join(work, sourceFile)));
      const hub = new Hub(state);
      try {
        const cfg = {
          ...defaults,
          dshPath,
          maxOutputTokens: 8000,
          checkPath: [dirname(process.execPath)],
          loopBudget: {
            ...defaults.loopBudget,
            executorRuns: 6,
            roleCalls: 12,
            wallMinutes: 15,
            checkTimeoutSec: 60,
          },
        };
        await hub.brain.vaultFor(cfg).save(cfg.endpoint, key);
        await hub.request({ op: "settings", value: cfg });
        const project = await hub.request({
          op: "project.add",
          path: work,
          name: "完整 L1 隔离验收",
        });
        const t = await hub.request({
          op: "task.create",
          requestId: mode,
          value: {
            projectId: project.id,
            mode: "write",
            advance: "loop",
            ...spec,
          },
        });
        const until = Date.now() + 16 * 60_000;
        while (Date.now() < until) {
          await hub.tick();
          const view = hub.loop.view(hub.getTask(t.id));
          if (view.loop.phase === "closed" || view.loop.phase === "halted")
            break;
          await delay(250);
        }
        const view = hub.loop.view(hub.getTask(t.id));
        const runs = hub.store.all<Run>("run");
        const check = await runCheck(
          {
            kind: "command",
            name: "独立验证原套件",
            program: "node",
            args: ["--test"],
            cwd: ".",
          },
          {
            root: work,
            checkPath: [dirname(process.execPath)],
            timeoutMs: 10000,
          },
        );
        const unchanged = await Promise.all(
          protectedEntries.map(
            async (file, index) =>
              hash(await readFile(join(work, file))) === expected[index],
          ),
        );
        const invocations = hub.store.all("invocation");
        const reviewedProgram = view.criteria.some(
          (row) =>
            row.passed?.grade === "program" &&
            row.passed.checkRunIds.length > 0 &&
            invocations.some(
              (call) =>
                call.id === row.passed?.invocationId &&
                call.role === "verifier" &&
                call.status === "completed",
            ),
        );
        const result = {
          application: APP_VERSION,
          mode,
          startingState: t.state,
          phase: view.loop.phase,
          dsh: hub.dsh.status.version,
          model: runs.at(-1)?.model ?? cfg.model,
          planner: invocations.some(
            (row) => row.role === "planner" && row.status === "completed",
          ),
          critic: invocations.some(
            (row) => row.role === "critic" && row.status === "completed",
          ),
          verifier: invocations.some(
            (row) => row.role === "verifier" && row.status === "completed",
          ),
          citation: view.criteria.some(
            (row) => row.sourceQuote && spec.goal.includes(row.sourceQuote),
          ),
          programmed: reviewedProgram,
          completed: view.loop.report?.outcome === "completed",
          programSuitePassed: check.outcome === "passed",
          protectedFilesUnchanged: unchanged.every(Boolean),
          noFilesAddedOrRemoved:
            JSON.stringify(await tree(work)) === JSON.stringify(initialFiles),
          sourceChanged:
            hash(await readFile(join(work, sourceFile))) !== initialSource,
          executorRuns: runs.length,
          checkAuthorCalls: invocations.filter(
            (row) => row.role === "check-author",
          ).length,
          roleCalls: view.loop.budget.spent.roleCalls,
          unrequestedInteractions:
            hub.launches.pending().length + hub.store.all("approval").length,
          retainedDraftBeforePlan: t.state === "draft",
        };
        await writeFile(
          join(sample, "result.json"),
          JSON.stringify(result, null, 2),
        );
        return result;
      } finally {
        await hub.shutdown();
        hub.store.close();
        await rm(join(state, hub.brain.vaultFor(defaults).filename), {
          force: true,
        });
      }
    }),
  );
  const results = samples.map((sample) => {
    if (sample.status === "rejected") throw sample.reason;
    return sample.value;
  });
  await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2));
  const passed = results.every(
    (row) =>
      row.retainedDraftBeforePlan &&
      row.planner &&
      row.critic &&
      row.verifier &&
      row.citation &&
      row.programmed &&
      row.completed &&
      row.programSuitePassed &&
      row.protectedFilesUnchanged &&
      row.noFilesAddedOrRemoved &&
      row.sourceChanged === (row.mode === "new-work") &&
      row.unrequestedInteractions === 0 &&
      (row.mode === "already-complete"
        ? row.executorRuns === 0 && row.checkAuthorCalls === 0
        : row.executorRuns > 0),
  );
  console.log(JSON.stringify({ out, samples: results.length, passed }));
  assert.ok(passed, "完整 L1 的真实定约/完成路径未全部通过");
}
