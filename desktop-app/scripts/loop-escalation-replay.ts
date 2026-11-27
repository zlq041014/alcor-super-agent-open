import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { childEnv, hash, redact, within, Vault } from "../src/hub/security";
import { defaults, TaskInput, type Run, type Settings, type Task } from "../src/shared/contracts";
import type { Check, Criterion, Loop, LoopView } from "../src/shared/loop-contracts";
import { checkWorkspace, copyTree, taskSet, tree } from "./loop-score";
import { optionalJson, saveJson, withRound } from "./loop-trial-ledger";

const experiment = resolve("../.dev/advance-loop/L1-ready/experiment/live-Ol7SqI");
const stage = resolve("../.dev/advance-loop/L3");
const inventoryPath = join(stage, "replay-preflight-live-Ol7SqI", "blocked-inventory.json");
const ordinaryRetries = defaults.loopBudget.retries;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const inventorySchema = z.object({ l1FixtureManifest: digest, candidates: z.array(z.object({
  taskId: z.string().regex(/^[a-z0-9-]+$/), repeat: z.number().int().min(1), scoredPass: z.boolean(),
  ledger: z.string(), ledgerHash: digest, submitted: z.string(), treeHash: digest,
  fileCount: z.number().int().positive(), blocked: z.array(z.object({ criterionId: z.string(), definitionHash: digest })).min(1),
})).length(19) });
type Arm = "ordinary" | "escalation";
type Outcome = { arm: Arm; task: string; ordinal: number; resolved: boolean; hiddenPassed: boolean; protectedChanged: number;
  userRequests: number; executorRuns: number; grader?: string; intervention?: string; earlierPassed: boolean; valid: boolean; error?: string; directory?: string };
const outcomeSchema: z.ZodType<Outcome> = z.object({
  arm: z.enum(["ordinary", "escalation"]), task: z.string(), ordinal: z.number().int().positive(),
  resolved: z.boolean(), hiddenPassed: z.boolean(), protectedChanged: z.number().int().nonnegative(),
  userRequests: z.number().int().nonnegative(), executorRuns: z.number().int().nonnegative(),
  grader: z.string().optional(), intervention: z.string().optional(), earlierPassed: z.boolean(), valid: z.boolean(),
  error: z.string().optional(), directory: z.string().optional(),
});
const bundle = (executable: string) => join(dirname(executable), "resources", "app.asar");

function request<T>(runtime: ChildProcess, request: unknown, internal?: "shutdown") {
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMessage = (response: any) => {
      if (response.id !== id) return;
      finish();
      if (response.ok) resolve(response.value);
      else reject(new Error(String(response.error)));
    };
    const onExit = () => { finish(); reject(new Error("隔离 Hub 在回执前退出")); };
    const finish = () => { clearTimeout(timer); runtime.off("message", onMessage); runtime.off("exit", onExit); };
    const timer = setTimeout(() => { finish(); reject(new Error("隔离 Hub 回执超时")); }, 15000);
    runtime.on("message", onMessage);
    runtime.on("exit", onExit);
    runtime.send({ id, request, internal }, (error) => {
      if (error) { finish(); reject(new Error("隔离 Hub 连接中断", { cause: error })); }
    });
  });
}

async function load() {
  const frozen = await taskSet(resolve("experiments/advance-loop/l1-followup"));
  const raw = await readFile(inventoryPath);
  const inventory = inventorySchema.parse(JSON.parse(raw.toString("utf8")));
  assert.equal(inventory.l1FixtureManifest, frozen.manifestHash);
  const cases = [];
  for (const row of inventory.candidates) {
    const source = await within(experiment, resolve("..", row.ledger));
    const submitted = await within(experiment, resolve("..", row.submitted));
    assert.equal(hash(await readFile(source)), row.ledgerHash);
    const files = await tree(submitted);
    const hashes = await Promise.all(files.map(async (path) => ({ path, hash: hash(await readFile(join(submitted, path))) })));
    assert.equal(files.length, row.fileCount);
    assert.equal(hash(JSON.stringify(hashes)), row.treeHash);
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      const all = <T>(kind: string): T[] => db.prepare("SELECT data FROM records WHERE kind=?")
        .all(kind).map((row) => JSON.parse(String(row.data)));
      const lookup = <T>(kind: string, id: string): T => JSON.parse(String(db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id)?.data));
      const definition = frozen.tasks.find((t) => t.id === row.taskId)!;
      const checks = all<Check>("check");
      const criteria = all<Criterion>("criterion");
      for (const saved of row.blocked) {
        const c = lookup<Criterion>("criterion", saved.criterionId);
        const loop = lookup<Loop>("loop", c.loopId);
        const task = lookup<Task>("task", loop.taskId);
        assert.equal(c.status, "blocked");
        assert.equal(c.definitionHash, saved.definitionHash);
        const allowed = checks.filter((check) => check.loopId === loop.id && check.status === "authorized");
        const names = allowed.filter((check) => c.verify.checkIds.includes(check.id)).map((check) => check.input.name);
        const authored = criteria.flatMap((row) => {
          const name = row.loopId === loop.id ? row.author?.path?.replaceAll("\\", "/") : undefined;
          const found = name && hashes.find((entry) => entry.path.toLowerCase() === name.toLowerCase());
          return found ? [{ path: found.path, hash: found.hash }] : [];
        });
        const locked = hashes.filter((item) => loop.protectedPaths.some((name) => name.replaceAll("\\", "/").toLowerCase() === item.path.toLowerCase()));
        cases.push({ row, definition, submitted, c, task, names, allowed, authored, locked });
      }
    } finally {
      db.close();
    }
  }
  assert.equal(cases.length, 22);
  assert.equal(new Set(cases.map((entry) => entry.c.id)).size, 22);
  for (const row of cases) input(row, "replay-preflight");
  return { cases, inventoryHash: hash(raw), manifestHash: frozen.manifestHash };
}
type Replay = Awaited<ReturnType<typeof load>>["cases"][number];
function input(job: Replay, projectId: string) {
  const lesson = job.c.failure?.detail || job.c.blockedReason;
  return TaskInput.parse({
    projectId, goal: job.task.goal, mode: "write", advance: "loop",
    constraints: [job.task.constraints, lesson && "上一次的失败依据：" + lesson].filter(Boolean).join("\n").slice(0, 9000),
    criteria: [{ ...job.c.input, method: job.c.verify.method, checks: job.names, needsAuthoredCheck: false }],
    selectedChecks: [], loopChecks: job.allowed.map((c) => c.input), protect: job.locked.map((entry) => entry.path),
  });
}

async function runArm(job: Replay, ordinal: number, arm: Arm,
  out: string, executable: string, key: string,
): Promise<Outcome> {
  const caseDir = join(out, `case-${ordinal.toString().padStart(2, "0")}`);
  await mkdir(caseDir, { recursive: true });
  const dir = await mkdtemp(join(caseDir, arm + "-work-"));
  const state = join(dir, "state"), workspace = join(dir, "workspace");
  await copyTree(job.submitted, workspace);
  const vault = new Vault(state);
  await mkdir(state, { recursive: true });
  const runtime = fork(join(bundle(executable), "dist", "hub-entry.cjs"), [state], {
    execPath: executable, execArgv: [], cwd: dir, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1", CODEX_HOME: join(dir, "native") },
  });
  const finished = once(runtime, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { finish(); reject(new Error("隔离 Hub 未就绪")); }, 10000);
      const message = (event: any) => {
        if (event.event === "ready") { finish(); resolve(); }
        if (event.event === "fatal") { finish(); reject(new Error(String(event.error))); }
      };
      const gone = () => { finish(); reject(new Error("隔离 Hub 未能启动")); };
      const finish = () => { clearTimeout(timeout); runtime.off("message", message); runtime.off("exit", gone); };
      runtime.on("message", message);
      runtime.on("exit", gone);
    });
    // Each sealed executable owns its settings schema; do not seed today's defaults into an older bundle.
    const { settings } = await request<{ settings: Settings }>(runtime, { op: "snapshot" });
    assert.equal(settings.endpoint, defaults.endpoint);
    assert.equal(settings.apiSource, "custom");
    assert.equal(settings.model, defaults.model);
    assert.equal(settings.codexModel, defaults.codexModel);
    assert.equal(settings.memberEffort, defaults.memberEffort);
    const cfg = { ...settings, concurrency: 1, maxOutputTokens: 8000, checkPath: [dirname(process.execPath)],
      loopBudget: { ...settings.loopBudget, executorRuns: 4, retries: ordinaryRetries, wallMinutes: 15 },
    };
    await vault.save(cfg.endpoint, key);
    await request(runtime, { op: "settings", value: cfg });
    const project = await request<{ id: string }>(runtime, { op: "project.add", path: workspace, name: "升级阶梯固定回放" });
    const { id } = await request<{ id: string }>(runtime, { op: "task.create", requestId: "fixed-replay", value: input(job, project.id) });
    const end = Date.now() + 925_000;
    let view = await request<LoopView>(runtime, { op: "loop.view", id });
    while (!(["closed", "halted"].includes(view.loop.phase)) && Date.now() < end) {
      await delay(1000);
      view = await request<LoopView>(runtime, { op: "loop.view", id });
    }
    const snapshot = await request<{ approvals: unknown[]; launches: unknown[]; runs: Run[] }>(runtime, {op: "snapshot"});
    await request(runtime, undefined, "shutdown");
    if (!(await Promise.race([finished, delay(3500)]))) throw new Error("隔离 Hub 未确认退出");
    const proof = view.criteria[0]?.passed;
    const grader = proof?.grade;
    const scored = await checkWorkspace(job.definition, workspace, join(dir, "scored"), job.authored);
    const stillValid = await Promise.all(job.locked.map(async (file) => {
      try { return hash(await readFile(await within(workspace, join(workspace, file.path)))) === file.hash; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
    }));
    const protectedChanged = stillValid.filter((ok) => !ok).length + scored.protectedFilesChanged;
    const userRequests = snapshot.approvals.length + snapshot.launches.length;
    const valid = ["closed", "halted"].includes(view.loop.phase) && !snapshot.runs.some((r) => r.state === "unknown") && !scored.scoringTimedOut;
    return {
      ordinal, arm, task: job.definition.id, earlierPassed: job.row.scoredPass, valid, grader, userRequests, directory: dir,
      resolved: valid && view.loop.report?.outcome === "completed" && view.criteria[0]?.status === "passed" &&
        (job.c.verify.method === "judge" ? grader === "judged" && !!proof?.invocationId : grader === "program") &&
        scored.visiblePassed && !protectedChanged && !userRequests && (!job.row.scoredPass || scored.hiddenPassed),
      hiddenPassed: scored.hiddenPassed, protectedChanged, executorRuns: view.loop.budget.spent.executorRuns,
      intervention: view.criteria[0]?.escalation?.stage,
    };
  } finally {
    try {
      if (runtime.connected) await request(runtime, undefined, "shutdown");
    } finally {
      if (runtime.exitCode === null && !(await Promise.race([finished, delay(3500)]))) runtime.kill();
      await rm(join(state, vault.filename), { force: true });
    }
  }
}

async function auditReplay(path: string, verified: Awaited<ReturnType<typeof load>>) {
  const root = await within(stage, resolve(path));
  const environment = await optionalJson(join(root, "environment.json"), z.object({
    canary: z.literal(false), cases: z.literal(22), comparison: z.literal("same-ordinary-retries-v2"),
    inventoryHash: digest, manifestHash: digest, ordinary: z.string(), escalation: z.string(),
    ordinaryHash: digest, escalationHash: digest, model: z.string(), effort: z.string(),
    slots: z.literal(2), executorRuns: z.literal(4), ordinaryRetries: z.literal(2), maxOutputTokens: z.literal(8000),
  }));
  assert.ok(environment, "缺少冻结回放参数");
  assert.equal(environment.inventoryHash, verified.inventoryHash);
  assert.equal(environment.manifestHash, verified.manifestHash);
  for (const arm of ["ordinary", "escalation"] as const)
    assert.equal(hash(await readFile(bundle(environment[arm]))), environment[arm === "ordinary" ? "ordinaryHash" : "escalationHash"]);
  const results: Outcome[] = [];
  const blank = () => ({ received: 0, valid: 0, resolved: 0, runs: 0, outputCap: 0, inputPassRegressions: 0,
    protectedChanges: 0, userRequests: 0,
    diagnosisCalls: 0, freshSessions: 0, candidates: 0, splits: 0, advisorCalls: 0 });
  const counts = { ordinary: blank(), escalation: blank() };
  for (const [i, job] of verified.cases.entries()) {
    const group = join(root, `case-${(i + 1).toString().padStart(2, "0")}`);
    for (const arm of ["ordinary", "escalation"] as const) {
      const row = await optionalJson(join(group, arm, "result.json"), outcomeSchema);
      if (!row) continue;
      assert.equal(row.arm, arm);
      assert.equal(row.ordinal, i + 1);
      assert.equal(row.task, job.definition.id);
      assert.equal(row.earlierPassed, job.row.scoredPass);
      results.push(row);
      const n = counts[arm];
      n.received++;
      if (!row.valid) continue;
      assert.ok(row.directory);
      const saved = await within(group, row.directory);
      const db = new DatabaseSync(await within(saved, join(saved, "state", "state.sqlite")), { readOnly: true });
      try {
        const all = <T>(kind: string): T[] => db.prepare("SELECT data FROM records WHERE kind=? ORDER BY updated,id")
          .all(kind).map((r) => JSON.parse(String(r.data)));
        const [loop, ...otherLoops] = all<Loop>("loop");
        const [task, ...otherTasks] = all<Task>("task");
        const criteria = all<Criterion>("criterion");
        const [criterion, ...otherRoots] = criteria.filter((c) => !c.splitFrom);
        assert.ok(loop && task && criterion && !otherLoops.length && !otherTasks.length && !otherRoots.length);
        assert.equal(task.loopId, loop.id);
        assert.equal(criterion.loopId, loop.id);
        const expected = input(job, task.projectId);
        assert.equal(task.goal, expected.goal);
        assert.equal(task.constraints, expected.constraints);
        assert.equal(criterion.input.title, expected.criteria[0].title);
        const [{ value: cfg }] = all<{ value: Settings }>("settings");
        assert.equal(cfg.concurrency, 1);
        assert.equal(cfg.maxOutputTokens, environment.maxOutputTokens);
        assert.equal(loop.budget.limits.retries, environment.ordinaryRetries);
        assert.equal(loop.budget.limits.executorRuns, environment.executorRuns);
        assert.equal(loop.budget.limits.wallMinutes, 15);
        assert.equal(loop.budget.spent.executorRuns, row.executorRuns);
        assert.ok(row.executorRuns <= environment.executorRuns);
        assert.equal(loop.roster.executor.model, environment.model);
        assert.equal(loop.roster.executor.effort, environment.effort);
        assert.equal(loop.roster.advisor, undefined);
        assert.equal(criterion.verify.method, job.c.verify.method);
        assert.ok(loop.phase === "closed" || loop.phase === "halted");
        assert.equal(all("approval").length + all<{ state: string }>("agent-launch")
          .filter((item) => item.state === "pending").length, row.userRequests);
        const runs = all<Run>("run");
        assert.ok(runs.every((run) => run.taskId === task.id && run.state === "ended" &&
          run.profile?.model === environment.model && run.profile?.effort === environment.effort));
        const roles = all<{ role: string; id: string; loopId: string; status: string }>("invocation");
        if (row.resolved) {
          assert.equal(loop.report?.outcome, "completed");
          assert.equal(criterion.status, "passed");
          assert.equal(criterion.passed?.grade, row.grader);
          assert.ok(criterion.passed?.invocationId && (!row.earlierPassed || row.hiddenPassed));
          assert.ok(roles.some((call) => call.id === criterion.passed!.invocationId &&
            call.loopId === loop.id && call.role === "verifier" && call.status === "completed"));
        }
        n.valid++;
        n.resolved += Number(row.resolved);
        n.runs += runs.length;
        n.outputCap += runs.filter((run) => run.nativeEndReason === "max-tokens").length;
        n.inputPassRegressions += Number(row.earlierPassed && !row.hiddenPassed);
        n.protectedChanges += row.protectedChanged;
        n.userRequests += row.userRequests;
        n.diagnosisCalls += roles.filter((role) => role.role === "diagnoser").length;
        n.freshSessions += Math.max(0, new Set(runs.flatMap((run) => run.threadId ? [run.threadId] : [])).size - 1);
        n.candidates += all("candidate").length;
        n.splits += criteria.filter((item) => item.splitFrom).length;
        n.advisorCalls += roles.filter((role) => role.role === "advisor").length;
      } finally {
        db.close();
      }
    }
  }
  const summary = await optionalJson(join(root, "summary.json"), z.object({
    canary: z.literal(false), samples: z.literal(22), valid: z.boolean(), passed: z.boolean(),
    baseline: z.number(), upgraded: z.number(), results: z.array(outcomeSchema),
  }));
  if (summary) {
    assert.equal(results.length, verified.cases.length * 2);
    assert.deepEqual(summary.results, results);
    assert.equal(summary.baseline, counts.ordinary.resolved);
    assert.equal(summary.upgraded, counts.escalation.resolved);
    assert.equal(summary.valid, results.every((r) => r.valid && !r.protectedChanged && !r.userRequests));
    assert.equal(summary.passed, summary.valid && summary.upgraded > summary.baseline);
  }
  const completedPairs = results.filter((r) => r.arm === "ordinary" && results.some(
    (other) => other.arm === "escalation" && other.ordinal === r.ordinal,
  )).length;
  console.log(JSON.stringify({ cases: verified.cases.length, completedPairs,
    complete: !!summary, passed: summary?.passed, valid: summary?.valid, counts }));
}

async function main() {
  const args = process.argv.slice(2), verified = await load();
  if (args.includes("--verify")) {
    console.log(JSON.stringify({ verified: verified.cases.length, inventoryHash: verified.inventoryHash, manifestHash: verified.manifestHash }));
    return;
  }
  const audit = args.indexOf("--audit");
  if (audit >= 0) {
    if (!args[audit + 1]) throw new Error("请提供要核对的正式回放目录");
    await auditReplay(args[audit + 1], verified);
    return;
  }
  if (!args.includes("--authorized")) throw new Error("真实回放需要开工授权");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw new Error("真实回放没有可用的已授权模型凭据");
  const index = args.indexOf("--packs");
  if (index < 0 || !args[index + 1] || !args[index + 2]) throw new Error("请提供冻结旧包与本轮升级包");
  const ordinary = resolve(args[index + 1]), escalation = resolve(args[index + 2]);
  assert.notEqual(ordinary, escalation);
  const [ordinaryHash, escalationHash] = await Promise.all([ordinary, escalation].map(async (path) => hash(await readFile(bundle(path)))));
  assert.notEqual(ordinaryHash, escalationHash);
  const canary = args.includes("--canary");
  const resume = args.indexOf("--resume");
  if (resume >= 0 && !args[resume + 1]) throw new Error("缺少原回放目录");
  const out = resume >= 0 ? await within(stage, resolve(args[resume + 1]))
    : await mkdtemp(join(stage, canary ? "replay-canary-" : "replay-real-"));
  const environment = {
    canary, cases: canary ? 1 : 22, inventoryHash: verified.inventoryHash, manifestHash: verified.manifestHash,
    ordinary, escalation, ordinaryHash, escalationHash, model: defaults.model, effort: defaults.memberEffort,
    comparison: "same-ordinary-retries-v2", slots: 2, executorRuns: 4, ordinaryRetries, maxOutputTokens: 8000,
  };
  await withRound(out, async () => {
    const proof = join(out, "environment.json");
    if (resume >= 0) assert.deepEqual(JSON.parse(await readFile(proof, "utf8")), environment);
    else await saveJson(proof, environment);
    const results: Outcome[] = [];
    const cases = canary ? verified.cases.slice(0, 1) : verified.cases;
    for (const [i, job] of cases.entries()) {
      const pair = await Promise.all(([{ arm: "ordinary", executable: ordinary }, { arm: "escalation", executable: escalation }] as const)
        .map(async ({ arm, executable }) => {
          const groupDir = join(out, `case-${(i + 1).toString().padStart(2, "0")}`);
          const caseDir = join(groupDir, arm);
          const path = join(caseDir, "result.json");
          const saved = await optionalJson(path, outcomeSchema);
          if (saved) {
            assert.ok(saved.arm === arm && saved.ordinal === i + 1 && saved.task === job.definition.id);
            return saved;
          }
          const prior = await readdir(groupDir).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
            return [] as string[];
          });
          const missing = (reason: string): Outcome => ({
            arm, task: job.definition.id, ordinal: i + 1, valid: false, resolved: false, executorRuns: 0,
            earlierPassed: job.row.scoredPass, hiddenPassed: false, protectedChanged: 0, userRequests: 0, error: reason,
          });
          const result = prior.some((name) => name.startsWith(arm + "-work-"))
            ? missing("该配对上次运行回执不完整，保留现场并且不重派")
            : await runArm(job, i + 1, arm, out, executable, key).catch((error: Error) => missing(redact(error.message).slice(0, 400)));
          await mkdir(caseDir, { recursive: true });
          await saveJson(path, result);
          return result;
        }));
      results.push(...pair);
      console.log(JSON.stringify({ out, pair: i + 1, total: cases.length, valid: pair.every((p) => p.valid) }));
    }
    const count = (arm: Arm) => results.filter((sample) => sample.arm === arm && sample.resolved).length;
    const baseline = count("ordinary"), upgraded = count("escalation");
    const valid = results.length === cases.length * 2 && results.every((r) => r.valid && !r.protectedChanged && !r.userRequests);
    const passed = valid && (canary || upgraded > baseline);
    await saveJson(join(out, "summary.json"), { canary, valid, passed, baseline, upgraded, samples: cases.length, results });
    console.log(JSON.stringify({ out, valid, passed, baseline, upgraded, samples: cases.length }));
    if (!passed) process.exitCode = 1;
  });
}
void main().catch((error) => { console.error("升级阶梯回放失败：" + redact((error as Error).message)); process.exitCode = 1; });
