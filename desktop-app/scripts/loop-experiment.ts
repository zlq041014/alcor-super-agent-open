import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { Codex, RpcError } from "../src/adapter/codex";
import { Vault, hash, redact } from "../src/hub/security";
import { z } from "zod";
import {
  runSlot,
  optionalJson,
  saveJson,
  saveRoundSummary,
  withRound,
} from "./loop-trial-ledger";
import { DatabaseSync } from "node:sqlite";
import { endpointUrl } from "../src/core/policy";
import {
  APP_VERSION,
  defaults,
  ProfileSchema,
  readSettings,
  type Command,
  type Run,
  type Settings,
  type Task,
} from "../src/shared/contracts";
import { LoopRelativePath } from "../src/shared/loop-contracts";
import {
  checkWorkspace,
  compare,
  copyTree,
  taskSet,
  tree,
  type ExperimentTask,
  type Group,
  type TrialScore,
} from "./loop-score";

const evidenceRoot = resolve("../.dev/advance-loop/L0");
const source = resolve("experiments/advance-loop");
const infra =
  /模型服务返回 HTTP |连接中断|模型请求中断|容量|限流|无法启动 DSH|网关|未配置|连接器仅验证|尚未登录|发生断开|状态未知/i;
const usages = (run: Run) => {
  const usage = run.usage as
    | { total?: { totalTokens?: number }; total_tokens?: number }
    | undefined;
  return usage?.total?.totalTokens ?? usage?.total_tokens ?? null;
};
type Live = {
  dshPath: string;
  codexPath: string;
  codexModel: string;
  codexEndpoint: string;
  codexEffort: Settings["memberEffort"];
};
const meta = (run: Run) => ({
  model: run.model || null,
  effort: run.actualEffort || run.profile?.effort || null,
  outcome: run.outcome || null,
  tokens: usages(run),
  sandbox: run.actualSandbox ?? null,
  network: run.actualSandboxNetwork ?? null,
});
const Executed = z
  .object({
    group: z.enum(["A", "B", "C", "D"]),
    task: z.string(),
    repetition: z.number().int(),
    retry: z.boolean(),
    completed: z.boolean(),
    timedOut: z.boolean(),
    infrastructure: z.boolean(),
    executorRuns: z.number().int().nonnegative(),
    rejectedWrites: z.number().int().nonnegative(),
    wallMs: z.number().int().nonnegative(),
    tokensKnown: z.number().int().nonnegative().nullable(),
    confirmationRequests: z.number().int().nonnegative(),
    authored: z
      .array(
        z.object({
          path: LoopRelativePath,
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .optional(),
    roleCalls: z.number().int().nonnegative().optional(),
    version: z.string().optional(),
    runs: z.array(
      z.object({
        model: z.string().nullable(),
        effort: z.string().nullable(),
        outcome: z.string().nullable(),
        tokens: z.number().int().nonnegative().nullable(),
        sandbox: z.string().nullable(),
        network: z.boolean().nullable(),
      }),
    ),
  })
  .strict();

async function fixtureAnswer(
  hub: Hub,
  run: Run,
  text: string,
  apply: boolean,
  task: ExperimentTask,
  backend: "codex" | "dsh",
) {
  assert.ok(text.includes(task.prompt));
  const files = await tree(run.workPath);
  assert.equal(
    files.some((name) => /^(hidden|reference)\//.test(name)),
    false,
  );
  assert.doesNotMatch(text, /hidden[/\\]|review\.mjs|reference[/\\]/);
  if (apply) await copyTree(join(task.dir, "reference"), run.workPath);
  const params = { threadId: run.threadId, turnId: run.turnId };
  await hub.handleEvent({ method: "turn/started", params }, backend);
  await hub.handleEvent(
    {
      method: "item/completed",
      params: {
        ...params,
        item: {
          type: "agentMessage",
          id: run.id + ":fixture",
          text: "合成运行回执",
        },
      },
    },
    backend,
  );
  await hub.handleEvent(
    {
      method: "turn/completed",
      params: {
        ...params,
        turn: { id: run.turnId, status: "completed" },
      },
    },
    backend,
  );
}

async function configure(
  hub: Hub,
  dir: string,
  group: Group,
  live?: Live,
  outputCap = defaults.maxOutputTokens,
) {
  const cfg: Settings = {
    ...defaults,
    maxOutputTokens: outputCap,
    checkPath: [dirname(process.execPath)],
    executorBackend: group === "C" ? "codex" : "dsh",
    concurrency: 1,
    maxRuns: 1,
    maxMinutes: group === "B" || group === "D" ? 60 : 20,
    loopBudget: {
      ...defaults.loopBudget,
      executorRuns: 6,
      retries: 4,
      wallMinutes: 60,
      checkTimeoutSec: 300,
    },
  };
  if (live) {
    cfg.dshPath = live.dshPath;
    if (group === "C") {
      cfg.codexPath = live.codexPath;
      cfg.codexModel = live.codexModel;
      cfg.memberEffort = live.codexEffort;
      const key = process.env.ALCOR_NATIVE_API_KEY;
      if (!key) throw new Error("未配置 Codex 组的隔离环境凭据");
      endpointUrl(live.codexEndpoint, "models");
      const home = join(dir, "codex");
      await mkdir(home, { recursive: true });
      cfg.codexCredentialEnv = "ALCOR_NATIVE_API_KEY";
      await writeFile(
        join(home, "config.toml"),
        [
          'model_provider = "alcor_trial"',
          "[model_providers.alcor_trial]",
          'name = "Alcor isolation trial"',
          "base_url = " + JSON.stringify(live.codexEndpoint),
          'env_key = "ALCOR_NATIVE_API_KEY"',
          'wire_api = "responses"',
          "[windows]",
          'sandbox = "unelevated"',
          "[shell_environment_policy]",
          'exclude = ["ALCOR_NATIVE_API_KEY"]',
        ].join("\n"),
      );
      await new Vault(dir, "codex-native.dpapi").save(
        "codex:" + cfg.codexCredentialEnv,
        key,
      );
    } else {
      const key = process.env.ALCOR_DEEPSEEK_API_KEY;
      if (!key) throw new Error("真实 DSH 试验缺少指定环境凭据");
      await hub.brain.vaultFor(cfg).save(cfg.endpoint, key);
    }
  }
  await hub.request({ op: "settings", value: cfg });
  return cfg;
}

async function executeTrial(
  task: ExperimentTask,
  group: Group,
  index: number,
  repetition: number,
  dir: string,
  live?: Live,
  retry = false,
  outputCap = defaults.maxOutputTokens,
  fullContract = false,
) {
  const workspace = join(dir, "workspace"),
    data = join(dir, "state");
  await copyTree(join(task.dir, "workspace"), workspace);
  const hub = new Hub(data, new Codex(join(data, "codex")));
  let error: unknown;
  hub.on("fault", (event) => {
    error = new Error(event);
  });
  if (!live) {
    if (group === "C") {
      hub.codex.initialized = true;
      hub.codex.version = "fake";
      hub.codex.call = async (method, params) => {
        if (method === "thread/start")
          return {
            thread: { id: "fixture" },
            model: params.model,
            runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
            sandbox: {
              type: "workspaceWrite",
              networkAccess: false,
              writableRoots: [],
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
          };
        if (method === "turn/start") {
          const taskId = hub.store.all<Task>("task")[0].id;
          const run = hub.store.get<Run>("run", hub.getTask(taskId).runId!)!;
          run.turnId = "fake-turn";
          hub.store.put("run", run);
          setImmediate(
            () =>
              void fixtureAnswer(
                hub,
                run,
                params.input[0].text,
                true,
                task,
                "codex",
              ).catch((e) => {
                error = e;
              }),
          );
          return { turn: { id: run.turnId } };
        }
        throw new Error("未预期的伪 Codex 请求");
      };
    } else {
      let applied = false;
      if (fullContract) {
        hub.brain.configured = async () => true;
        hub.brain.complete = async (_cfg, prompt, system) => {
          const input = JSON.parse(prompt);
          const value = system.includes("清单规划者")
            ? {
                understanding: task.prompt,
                outOfScope: [],
                assumptions: [],
                criteria: [
                  {
                    title: task.title,
                    detail: task.prompt,
                    necessity: "required",
                    assumption: false,
                    sourceQuote: task.prompt,
                    method: "judge",
                    checks: [],
                    needsAuthoredCheck: false,
                    checkIntent: "",
                    points: task.title,
                    dependsOn: [],
                  },
                ],
              }
            : system.includes("清单审查者")
              ? { missing: [], unverifiable: [], beyondGoal: [] }
              : {
                  verdict: applied ? "pass" : "fail",
                  points: input.points.map((point: string) => ({
                    point,
                    met: applied,
                    evidence: applied
                      ? {
                          path: input.materials[0].title,
                          quote: input.materials[0].content
                            .trim()
                            .slice(0, 100),
                        }
                      : null,
                    note: "",
                  })),
                };
          return { text: JSON.stringify(value), model: "fake", usage: null };
        };
      }
      hub.dsh.probe = async () => ({ status: "ACP 就绪", version: "fake" });
      hub.dsh.start = async (
        _t: Task,
        run: Run,
        command: Command,
        _cfg: Settings,
        text: string,
      ) => {
        run.threadId = "fake:" + run.id;
        run.turnId = command.id;
        hub.store.put("run", run);
        hub.store.put("command", { ...command, state: "accepted" });
        const apply =
          group === "A"
            ? (index + repetition) % 2 === 0
            : fullContract || hub.getTask(run.taskId).attempt > 1;
        applied ||= apply;
        setImmediate(
          () =>
            void fixtureAnswer(hub, run, text, apply, task, "dsh").catch(
              (e) => {
                error = e;
              },
            ),
        );
      };
    }
  }
  let state: {
    completed: boolean;
    timedOut: boolean;
    infrastructure: boolean;
    executorRuns: number;
    rejectedWrites: number;
    wallMs: number;
    tokensKnown: number | null;
    confirmationRequests: number;
    authored?: { path: string; hash: string }[];
    roleCalls?: number;
    version?: string;
    runs: ReturnType<typeof meta>[];
  };
  const start = Date.now();
  try {
    const cfg = await configure(hub, data, group, live, outputCap);
    const p = await hub.request({
      op: "project.add",
      path: workspace,
      name: "冻结任务 " + task.id,
    });
    const looping = group === "B" || group === "D";
    const allowed =
      Date.now() +
      (live ? (looping ? 60 : task.timeLimitMinutes) * 60_000 : 60_000);
    const pending = await hub.request({
      op: "task.create",
      requestId: "trial",
      value: {
        advance: looping ? "loop" : "single",
        projectId: p.id,
        mode: "write",
        access: "project",
        goal: task.prompt,
        ...(looping && !fullContract
          ? {
              criteria: [
                {
                  title: task.prompt,
                  checks: task.visibleChecks.map((v) => v.name),
                },
              ],
              selectedChecks: task.visibleChecks.map((v) => v.name),
            }
          : {}),
      },
    });
    const receipt = looping
      ? pending
      : await hub.request({
          op: "agent.launch.confirm",
          id: pending.launchId,
          profile: { model: cfg.codexModel, effort: cfg.memberEffort },
        });
    if (looping) assert.equal(pending.launchId, undefined);
    if (fullContract) assert.equal(pending.state, "draft");
    while (Date.now() < allowed) {
      if (error) throw error;
      await hub.tick();
      const t = hub.getTask(receipt.id),
        r = t.runId ? hub.store.get<Run>("run", t.runId) : undefined;
      const l = hub.loop.forTask(t);
      if (
        looping
          ? l?.phase === "closed" || l?.phase === "halted"
          : r?.state === "ended" || r?.state === "unknown"
      )
        break;
      await delay(live ? 250 : 8);
    }
    const t = hub.getTask(receipt.id);
    const runs = hub.store.all<Run>("run");
    const l = hub.loop.forTask(t);
    const last = runs.at(-1);
    const decided = looping
      ? l?.phase === "closed" || l?.phase === "halted"
      : last?.state === "unknown" || last?.state === "ended";
    const timedOut =
      !decided ||
      (l?.halt?.reason === "budget" &&
        Date.now() - start >= task.timeLimitMinutes * 60_000 &&
        Date.now() >= allowed);
    const usage = runs.map(usages);
    state = {
      completed:
        !timedOut &&
        (looping
          ? l?.report?.outcome === "completed"
          : last?.outcome === "completed"),
      timedOut,
      infrastructure:
        !timedOut &&
        ((live &&
          group === "C" &&
          !!last &&
          (last.actualSandbox !== "workspaceWrite" ||
            last.actualSandboxNetwork !== false)) ||
          last?.state === "unknown" ||
          (!decided
            ? false
            : last?.outcome === "failed" &&
              (infra.test(t.reason || "") ||
                l?.report?.blockedRequired.some((x) =>
                  infra.test(x.reason),
                )) === true)),
      executorRuns: l?.budget.spent.executorRuns ?? runs.length,
      roleCalls: l?.budget.spent.roleCalls ?? 0,
      authored: hub.store
        .all("check-adoption")
        .filter((item) => item.state === "adopted")
        .map((item) => ({
          path: String(item.file),
          hash: String(item.contentHash),
        })),
      rejectedWrites: l?.rejectedWrites || 0,
      wallMs: Date.now() - start,
      tokensKnown:
        usage.length && usage.every((x) => x !== null)
          ? usage.reduce((n, x) => n! + x!, 0)
          : null,
      confirmationRequests:
        hub.launches.pending().length + hub.store.all("approval").length,
      version: group === "C" ? hub.codex.version : hub.dsh.status.version,
      runs: runs.map(meta),
    };
  } catch (e) {
    if (!live || !infra.test((e as Error).message)) throw e;
    state = {
      completed: false,
      timedOut: false,
      infrastructure: true,
      executorRuns: 0,
      rejectedWrites: 0,
      wallMs: Date.now() - start,
      tokensKnown: null,
      confirmationRequests: 0,
      runs: [],
    };
  } finally {
    if (live) await hub.shutdown();
    else {
      hub.shuttingDown = true;
      await hub.loop.shutdown();
      await hub.eventQueue;
    }
    hub.store.close();
    const vaultName =
      group === "C"
        ? "codex-native.dpapi"
        : hub.brain.vaultFor(defaults).filename;
    await rm(join(data, vaultName), { force: true });
  }
  return Executed.parse({ group, task: task.id, repetition, retry, ...state });
}

async function trial(
  task: ExperimentTask,
  group: Group,
  index: number,
  repetition: number,
  dir: string,
  live?: Live,
  retry = false,
  outputCap = defaults.maxOutputTokens,
  fullContract = false,
) {
  const checkpoint = join(dir, "execution.json");
  let state = await optionalJson(checkpoint, Executed);
  if (!state) {
    state = await executeTrial(
      task,
      group,
      index,
      repetition,
      dir,
      live,
      retry,
      outputCap,
      fullContract,
    );
    await copyTree(join(dir, "workspace"), join(dir, "submitted"));
    await saveJson(checkpoint, state);
  } else if (
    state.group !== group ||
    state.task !== task.id ||
    state.repetition !== repetition ||
    state.retry !== retry
  ) {
    throw new Error("已完成执行的回执与评分样本不一致");
  }
  const scoring = await mkdtemp(join(dir, "scoring-"));
  const checked = await checkWorkspace(
    task,
    join(dir, "submitted"),
    scoring,
    state.authored,
    { auditOnly: state.timedOut },
  );
  const score = state.timedOut
    ? { ...checked, visiblePassed: false, hiddenPassed: false }
    : checked;
  const result: TrialScore = {
    group,
    task: task.id,
    run: repetition,
    systemCompleted: state.completed,
    ...score,
    passed: !state.infrastructure && score.visiblePassed && score.hiddenPassed,
    mechanicalFalseCompletion:
      group === "B" || group === "D"
        ? Number(state.completed && !score.visiblePassed) +
          Number(score.protectedFilesChanged > 0)
        : 0,
    executorRuns: state.executorRuns,
    rejectedWrites: state.rejectedWrites,
    wallMs: state.wallMs,
    tokensKnown: state.tokensKnown,
    infrastructureRetry: retry,
    timedOut: state.timedOut || checked.scoringTimedOut === true,
  };
  const record = {
    ...result,
    infrastructure: state.infrastructure,
    confirmationRequests: state.confirmationRequests,
    version: state.version || null,
    runs: state.runs,
    roleCalls: state.roleCalls,
  };
  return record;
}

async function parallel<T>(jobs: (() => Promise<T>)[]) {
  const results: T[] = [];
  for (let i = 0; i < jobs.length; i += 2) {
    const batch = await Promise.allSettled(
      jobs.slice(i, i + 2).map((job) => job()),
    );
    for (const value of batch) {
      if (value.status === "rejected") throw value.reason;
      results.push(value.value);
    }
  }
  return results;
}
async function verify(tasks: ExperimentTask[], out: string) {
  const results = await parallel(
    tasks.map((task) => async () => {
      const workspace = join(task.dir, "workspace");
      const files = await tree(join(workspace, "src"));
      assert.ok(files.length >= 5 && files.length <= 30, task.id);
      assert.equal(
        (await tree(workspace)).some((name) =>
          /^(hidden|reference)\//.test(name),
        ),
        false,
        task.id,
      );
      let referenceLines = 0;
      for (const path of await tree(join(task.dir, "reference")))
        referenceLines += (
          await readFile(join(task.dir, "reference", path), "utf8")
        ).split(/\r?\n/).length;
      assert.ok(referenceLines <= 150, task.id);
      const initial = await checkWorkspace(
        task,
        workspace,
        join(out, task.id, "initial-scored"),
      );
      const reference = join(out, task.id, "reference-workspace");
      await copyTree(workspace, reference);
      await copyTree(join(task.dir, "reference"), reference);
      const final = await checkWorkspace(
        task,
        reference,
        join(out, task.id, "reference-scored"),
      );
      const valid =
        initial.visiblePassed === (task.category === "refactor") &&
        !initial.hiddenPassed &&
        final.visiblePassed &&
        final.hiddenPassed &&
        !initial.protectedFilesChanged &&
        !final.protectedFilesChanged;
      return {
        id: task.id,
        category: task.category,
        files: files.length,
        referenceLines,
        initial,
        final,
        valid,
      };
    }),
  );
  await writeFile(
    join(out, "fixture-validation.json"),
    JSON.stringify(results, null, 2),
  );
  assert.deepEqual(
    results.filter((r) => !r.valid).map((r) => r.id),
    [],
    "任务集不能冻结",
  );
}
async function checkCodexSandbox(codex: Codex, root: string) {
  const marker = "ALCOR_CODEX_SCOPE_PROBE";
  const outsideDir = join(dirname(root), "outside-scope");
  await mkdir(outsideDir);
  const test = async (target: string, type: "readOnly" | "workspaceWrite") => {
    let exitCode: number | null = null;
    let rpcCode: number | null = null;
    try {
      const result = await codex.call(
        "command/exec",
        {
          command: [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
            target,
            marker,
          ],
          cwd: root,
          env: { ALCOR_NATIVE_API_KEY: null },
          sandboxPolicy:
            type === "readOnly"
              ? { type, networkAccess: false }
              : {
                  type,
                  networkAccess: false,
                  writableRoots: [root],
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
          timeoutMs: 12_000,
        },
        true,
        16_000,
      );
      exitCode = result.exitCode;
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      rpcCode = e.code ?? null;
    }
    const actual = await readFile(target, "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    return {
      exitCode,
      rpcCode,
      exists: actual !== null,
      markerMatches: actual === marker,
    };
  };
  const written = await test(join(root, "scope-write.txt"), "workspaceWrite");
  const readOnly = await test(join(root, "scope-read.txt"), "readOnly");
  const outside = await test(
    join(outsideDir, "scope-outside.txt"),
    "workspaceWrite",
  );
  const denied = (sample: typeof readOnly) =>
    !sample.exists &&
    (sample.rpcCode === -32603 ||
      (sample.exitCode !== null && sample.exitCode !== 0));
  return {
    written,
    readOnly,
    outside,
    passed:
      written.exitCode === 0 &&
      written.markerMatches &&
      denied(readOnly) &&
      denied(outside),
  };
}

async function preflightCodex(live: Live, out: string) {
  if (
    !live.codexPath ||
    !live.codexModel ||
    !live.codexEndpoint ||
    !process.env.ALCOR_NATIVE_API_KEY
  )
    return { codex: undefined, codexAvailable: false };
  const candidate = await mkdtemp(join(out, "preflight-codex-")),
    other = new Hub(candidate, new Codex(join(candidate, "codex")));
  let codex: string | undefined;
  let codexAvailable = false;
  try {
    await configure(other, candidate, "C", live);
    codex = (await other.request({ op: "codex.probe" })).version;
    const models = await other.modelCatalog("codex");
    const entry = models.find((m) => m.id === live.codexModel);
    if (
      live.codexEffort === "default" ||
      !entry?.efforts.length ||
      entry.efforts.includes(live.codexEffort)
    ) {
      const project = join(candidate, "workspace");
      await mkdir(project);
      const scope = await checkCodexSandbox(other.codex, project);
      await saveJson(join(candidate, "scope-probe.json"), scope);
      if (!scope.passed) return { codex, codexAvailable: false };
      const p = await other.request({
        op: "project.add",
        path: project,
        name: "Codex 隔离写入探针",
      });
      const cfg = other.settings();
      const card = await other.request({
        op: "task.create",
        requestId: "native-model-probe",
        value: {
          projectId: p.id,
          mode: "write",
          access: "project",
          advance: "single",
          goal: '请直接用执行工具运行 Node，在当前项目根目录创建 proof.txt。命令：node -e \'require("node:fs").writeFileSync("proof.txt", "ALCOR_NATIVE_WORKSPACE_WRITE_OK")\'。只核对这个文件，不修改其它内容，不访问网络；写入后结束。',
        },
      });
      const t = await other.request({
        op: "agent.launch.confirm",
        id: card.launchId,
        profile: { model: cfg.codexModel, effort: cfg.memberEffort },
      });
      const until = Date.now() + 180_000;
      let run: Run | undefined;
      while (Date.now() < until) {
        await other.tick();
        run = other.store.all<Run>("run").find((r) => r.taskId === t.id);
        if (run?.state === "ended" || run?.state === "unknown") break;
        await delay(250);
      }
      const fsProof = await readFile(join(project, "proof.txt"), "utf8").then(
        (s) => s.trim() === "ALCOR_NATIVE_WORKSPACE_WRITE_OK",
        (e) => {
          if (e.code !== "ENOENT") throw e;
          return false;
        },
      );
      codexAvailable =
        !!run &&
        run.model === live.codexModel &&
        run.state === "ended" &&
        run.outcome === "completed" &&
        run.actualSandbox === "workspaceWrite" &&
        run.actualSandboxNetwork === false &&
        fsProof;
      await saveJson(join(candidate, "result.json"), {
        model: run?.model ?? null,
        requestedModel: live.codexModel,
        confirmed: codexAvailable,
        state: run?.state ?? null,
        outcome: run?.outcome ?? null,
        sandbox: run?.actualSandbox ?? null,
        network: run?.actualSandboxNetwork ?? null,
        fileVerified: fsProof,
        observedAt: new Date().toISOString(),
        codex,
      });
    }
  } catch (e) {
    if (
      !infra.test((e as Error).message) &&
      !/请选择 Codex/.test((e as Error).message)
    )
      throw e;
  } finally {
    await other.shutdown();
    other.store.close();
    await rm(join(candidate, "codex-native.dpapi"), { force: true });
  }
  return { codex, codexAvailable };
}
async function preflight(live: Live, out: string) {
  const state = join(out, "preflight"),
    hub = new Hub(state);
  let dsh: string | undefined, flash: string;
  try {
    await configure(hub, state, "A", live);
    dsh = (await hub.dsh.probe()).version;
    if (!(await hub.brain.models(hub.settings())).includes("deepseek-flash"))
      throw new Error("所配置服务目录不含 deepseek-flash");
    flash = (await hub.request({ op: "model.test" })).model;
  } finally {
    hub.store.close();
    await rm(join(state, hub.brain.vaultFor(defaults).filename), {
      force: true,
    });
  }
  return { dsh, flash, ...(await preflightCodex(live, out)) };
}
const environmentSchema = z.object({
  mode: z.enum(["--fake", "--live"]),
  app: z.string(),
  dsh: z.string().optional(),
  flash: z.string(),
  codex: z.string().optional(),
  codexAvailable: z.boolean(),
  observedAt: z.string(),
  requestedCodexModel: z.string().nullable(),
  configuration: z.string().optional(),
});
async function matchRecordedPreflight(dir: string, live?: Live) {
  if (!live) return true;
  function settings(dir: string) {
    const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
    try {
      const saved = db
        .prepare(
          "SELECT data FROM records WHERE kind='settings' AND id='global'",
        )
        .get();
      return readSettings(saved ? JSON.parse(String(saved.data)).value : {});
    } finally {
      db.close();
    }
  }
  const dsh = settings(join(dir, "preflight"));
  if (
    dsh.dshPath !== live.dshPath ||
    dsh.codexModel !== defaults.codexModel ||
    dsh.memberEffort !== defaults.memberEffort
  )
    return false;
  if (!live.codexModel) return true;
  const folder = join(dir, "preflight-codex");
  const codex = settings(folder);
  const config = await readFile(join(folder, "codex", "config.toml"), "utf8");
  return (
    codex.codexPath === live.codexPath &&
    codex.codexModel === live.codexModel &&
    codex.memberEffort === live.codexEffort &&
    config
      .split(/\r?\n/)
      .includes("base_url = " + JSON.stringify(live.codexEndpoint))
  );
}
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (!["--freeze", "--verify", "--fake", "--live"].includes(mode))
    throw new Error("选择 --freeze、--verify、--fake 或已授权后的 --live");
  const get = (flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const setName = get("--task-set") ?? "original";
  if (
    setName !== "original" &&
    setName !== "retest-v2" &&
    setName !== "retest-v3" &&
    setName !== "l1-followup"
  )
    throw new Error("没有对应的冻结任务集");
  const setRoot = setName === "original" ? source : join(source, setName);
  const outputCap = setName === "original" ? defaults.maxOutputTokens : 8000;
  const codexPath = get("--codex-path") || "";
  const model = get("--codex-model") || "";
  const live =
    mode === "--live"
      ? {
          codexPath,
          dshPath: get("--dsh-path") || "",
          codexModel: model ? ProfileSchema.shape.model.parse(model) : "",
          codexEndpoint: get("--codex-endpoint") || "",
          codexEffort: ProfileSchema.shape.effort.parse(
            get("--codex-effort") || "default",
          ),
        }
      : undefined;
  if (live && !args.includes("--authorized"))
    throw new Error("真实实验需要明确的开工指令");
  const resume = get("--resume");
  if (
    args.includes("--resume") &&
    (!resume ||
      !/^(?:live|fake)-[a-z0-9]+$/i.test(resume) ||
      (mode !== "--fake" && mode !== "--live"))
  )
    throw new Error("续跑需指定已有实验轮次目录名");
  const fullContract = setName === "l1-followup";
  const base = fullContract
    ? resolve("../.dev/advance-loop/L1-ready/experiment")
    : join(evidenceRoot, "experiment");
  await mkdir(base, { recursive: true });
  const out = resume
    ? join(base, resume)
    : await mkdtemp(join(base, mode.slice(2) + "-"));
  if (resume && (await realpath(out)).toLowerCase() !== out.toLowerCase())
    throw new Error("轮次目录不能重定向");
  if (args.includes("--codex-write-probe")) {
    if (!live || resume) throw new Error("写入探针必须使用独立的真实试验目录");
    const result = await preflightCodex(live, out);
    console.log(JSON.stringify({ out, ...result }));
    if (!result.codexAvailable) process.exitCode = 1;
    return;
  }
  const { tasks, manifestHash } = await taskSet(
    setRoot,
    mode === "--freeze" ? "preview" : "read",
  );
  if (mode === "--freeze" || mode === "--verify") {
    await verify(tasks, out);
    if (mode === "--freeze")
      assert.equal(
        (await taskSet(setRoot, "freeze")).manifestHash,
        manifestHash,
      );
    await writeFile(join(out, "tasks.manifest.sha256"), manifestHash + "\n");
    console.log(
      JSON.stringify({ mode, out, tasks: tasks.length, manifestHash }),
    );
    return;
  }
  await withRound(out, async () => {
    const environment = join(out, "environment.json");
    const manifest = join(out, "tasks.manifest.sha256");
    const configuration = hash(
      JSON.stringify(
        setName === "original"
          ? (live ?? null)
          : [live ?? null, setName, outputCap],
      ),
    );
    const capacity = resume
      ? environmentSchema.parse(JSON.parse(await readFile(environment, "utf8")))
      : {
          mode,
          app: APP_VERSION,
          ...(live
            ? await preflight(live, out)
            : {
                dsh: "fake",
                codex: "fake",
                flash: "fake",
                codexAvailable: true,
              }),
          observedAt: new Date().toISOString(),
          requestedCodexModel: live?.codexModel || null,
          configuration,
          taskSet: setName,
          outputCap,
        };
    if (resume) {
      if (
        capacity.mode !== mode ||
        capacity.app !== APP_VERSION ||
        capacity.requestedCodexModel !== (live?.codexModel || null) ||
        (capacity.configuration
          ? capacity.configuration !== configuration
          : !(await matchRecordedPreflight(out, live))) ||
        (await readFile(manifest, "utf8")).trim() !== manifestHash
      )
        throw new Error("原轮次与当前配置或冻结任务集不匹配");
    } else {
      await writeFile(manifest, manifestHash + "\n", { flag: "wx" });
      await saveJson(environment, capacity);
    }
    const totals: Awaited<ReturnType<typeof runSlot>>[] = [];
    let codexEvidence: string | undefined;
    for (const group of ["A", "B", "C"] as const) {
      if (group !== "A" && !compare(totals).gates.valid) break;
      let groupDir = join(out, "runs", group);
      if (group === "C" && !capacity.codexAvailable) {
        if (
          !resume ||
          !live ||
          !(await preflightCodex(live, out)).codexAvailable
        ) {
          console.log(
            JSON.stringify({ group, skipped: "codex-unavailable", mode }),
          );
          break;
        }
        codexEvidence = "reruns/codex-workspace-write";
        groupDir = join(out, codexEvidence);
      }
      const items = await parallel(
        tasks.flatMap((task, index) =>
          [1, 2, 3].map(
            (run) => () =>
              runSlot(
                join(groupDir, task.id, String(run)),
                { group, task: task.id, run },
                (dir, attempt) =>
                  trial(
                    task,
                    group,
                    index,
                    run,
                    dir,
                    live,
                    attempt === 2,
                    outputCap,
                    fullContract && group === "B",
                  ),
              ),
          ),
        ),
      );
      if (group === "B" && items.some((t) => t.confirmationRequests !== 0))
        throw new Error("循环组出现了运行期间的用户操作请求");
      totals.push(...items);
      await saveRoundSummary(join(out, "summary.json"), {
        mode,
        manifestHash,
        ...compare(totals),
        verifiedByRealRuns: !!live,
        ...(fullContract
          ? {
              loopUserRequests: totals
                .filter((sample) => sample.group === "B")
                .reduce(
                  (total, sample) => total + sample.confirmationRequests,
                  0,
                ),
            }
          : {}),
        ...(codexEvidence ? { codexEvidence } : {}),
      });
      console.log(
        JSON.stringify({
          group,
          completed: items.length,
          passed: items.filter((x) => x.passed).length,
          mode,
        }),
      );
    }
    console.log(JSON.stringify({ mode, out, manifestHash }));
  });
}
main().catch((e) => {
  console.error("实验未完成：" + redact((e as Error).message).slice(0, 500));
  process.exitCode = 1;
});
