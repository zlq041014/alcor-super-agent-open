import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { hash } from "../src/hub/security";
import { readResearchSource } from "../src/hub/research-source";
import { defaults, SettingsSchema, type Artifact, type Run } from "../src/shared/contracts";
import type { ResearchSpec } from "../src/shared/research";
import { openP4Model, type P4Usage } from "./p4-model";

type Arm = "A" | "B" | "C";
type Sample = { goal: string; inputs: Record<string, string>; expected: Record<string, unknown>; research?: ResearchSpec };
type Manifest = {
  model: string; effort: string;
  limits: { runs: number; wallMinutes: number; runMinutes: number; slots: number };
  ordering: Record<string, string[]>; cases: Record<string, Sample>;
};
type Trial = {
  caseId: string; pair: number; arm: Arm; dir: string; status: string;
  applicationDone: boolean; checks: Record<string, boolean>; extraFiles: number;
  firstMs: number | null; allMs: number | null; closeMs: number | null;
  directionRework: number; researchRuns: number; branchCount: number; maxConcurrentExecute: number;
  runCount: number; receiptUnknown: number; lateStarts: number; duplicateCommands: number;
  sourceReads: number; sourceVersions: string[]; adopted: number; transport: P4Usage;
  errorType?: string;
};

function normal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normal);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normal(v)]));
  return value;
}
function json(bytes?: string): unknown {
  try { return bytes === undefined ? undefined : JSON.parse(bytes.replace(/^\uFEFF/, "")); }
  catch { return undefined; }
}
function equivalent(actual: unknown, expected: unknown) {
  return JSON.stringify(normal(actual)) === JSON.stringify(normal(expected));
}
export function blindP4Score(expected: Record<string, unknown>, files: Map<string, string>) {
  return {
    checks: Object.fromEntries(Object.entries(expected).map(([name, shape]) => [name, equivalent(json(files.get(name)), shape)])),
    extraFiles: [...files.keys()].filter((name) => !(name in expected)).length,
  };
}
async function readMaybe(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function outputs(path: string, inputs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let entries: string[];
  try { entries = await readdir(path, { recursive: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return out; throw error; }
  const allowed = new Set(inputs);
  for (const entry of entries.slice(0, 100)) {
    const relative = entry.replaceAll("\\", "/");
    if (allowed.has(relative) || relative.split("/").some((part) => part.startsWith("."))) continue;
    try { out.set(relative, await readFile(join(path, entry), "utf8")); }
    catch (error) {
      if (!["EISDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return out;
}

async function freezeWcag(base: string) {
  const source = "https://www.w3.org/TR/WCAG22/";
  const path = join(base, "wcag-excerpt.json");
  const existing = await readMaybe(path);
  if (existing) return JSON.parse(existing) as { url: string; excerpt: string; capturedAt: string };
  const raw = await readResearchSource(new URL(source), AbortSignal.timeout(20_000));
  const at = raw.indexOf('id="focus-not-obscured-minimum"');
  const excerpt = raw.slice(at, Math.min(raw.indexOf("</section>", at) + "</section>".length, at + 4200));
  if (at < 0 || !excerpt.includes("2.4.11") || !excerpt.includes("Level AA"))
    throw new Error("不能冻结与 P4 判据相符的标准摘录");
  const payload = { url: source, excerpt: "<p>WCAG 2.2</p>" + excerpt, capturedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(payload, null, 2), { flag: "wx" });
  return payload;
}

const trialSettings = (manifest: Manifest, endpoint: string) => SettingsSchema.parse({
  ...defaults, endpoint, maxMinutes: manifest.limits.runMinutes,
  concurrency: manifest.limits.slots, codexModel: manifest.model, memberEffort: manifest.effort,
  loopBudget: { ...defaults.loopBudget, executorRuns: manifest.limits.runs,
    retries: 1, wallMinutes: manifest.limits.wallMinutes },
});

async function trial(options: {
  dir: string; sample: Sample; manifest: Manifest; arm: Arm; key: string;
  replay?: { url: string; excerpt: string }; caseId: string; pair: number;
}) {
  const { dir, sample, manifest, arm, key, replay, caseId, pair } = options;
  const project = join(dir, "project"), state = join(dir, "state");
  await mkdir(project, { recursive: true });
  for (const [name, value] of Object.entries(sample.inputs))
    await writeFile(join(project, name), value, { flag: "wx" });
  const api = await openP4Model({ key, model: manifest.model });
  const hub = new Hub(state);
  let taskId: string | undefined, startAt = 0, fault = false, sourceReads = 0;
  const reader = hub.graph.readSource;
  hub.graph.readSource = async (url, signal) => {
    sourceReads++;
    if (replay) {
      if (url.href !== replay.url) throw new Error("资料地址超出冻结范围");
      return replay.excerpt;
    }
    return reader(url, signal);
  };
  hub.on("fault", () => { fault = true; });
  let status = "harness-error", closedAt: number | null = null;
  let errorType: string | undefined;
  try {
    const cfg = trialSettings(manifest, api.endpoint);
    await hub.brain.vaultFor(cfg).save(cfg.endpoint, api.token);
    await hub.request({ op: "settings", value: cfg });
    const p = await hub.request({ op: "project.add", path: project, name: "P4 隔离样本" });
    startAt = Date.now();
    const started = await hub.request({
      op: "task.create", requestId: randomUUID(), value: {
        projectId: p.id, title: "独立交付", goal: sample.goal, mode: "write", advance: "loop-native",
        ...(arm !== "A" && { graph: { inputs: Object.keys(sample.inputs), nativeTools: true,
          ...(arm === "C" && sample.research && { research: [sample.research] }) } }),
      },
    });
    taskId = started.id;
    if (!taskId) throw new Error("试验任务没有启动");
    let quiet = 0;
    status = "timed-out";
    while (Date.now() < startAt + manifest.limits.wallMinutes * 60_000) {
      if (fault) { status = "hub-fault"; break; }
      const task = hub.getTask(taskId);
      if (task.state === "done") {
        status = "done";
        closedAt = Date.parse(task.updatedAt);
        break;
      }
      const unresolved = hub.store.all<Run>("run").filter((run) => run.taskId === taskId && run.state !== "ended");
      if (["blocked", "cancelled", "verifying"].includes(task.state) && !unresolved.some((r) => r.state !== "unknown")) {
        if (!quiet) quiet = Date.now();
        if (Date.now() - quiet > 2500) {
          status = unresolved.length ? "unknown" : task.state;
          break;
        }
      } else quiet = 0;
      // A native invocation can hang after the durable claim; let the clock keep moving.
      void hub.tick().catch(() => { fault = true; });
      await delay(125);
    }
  } catch (error) {
    errorType = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
    status = "harness-error";
  }
  try {
    const task = taskId ? hub.getTask(taskId) : undefined;
    const graph = task?.graph ? hub.graph.ledger.get(task.loopId!) : undefined;
    const files = await outputs(arm === "A" ? project : graph?.assembled?.path ?? join(dir, "no-combination"),
      arm === "A" ? Object.keys(sample.inputs) : []);
    const scored = blindP4Score(sample.expected, files);
    const runs = hub.store.all<Run>("run").filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const refs = hub.store.all<Artifact>("artifact").filter((a) => a.taskId === taskId && a.origin === "result");
    const usable = new Map<string, number>();
    const perRun = new Map<string, string>();
    for (const ref of refs) {
      const file = ref.name.replaceAll("\\", "/");
      if (!(file in sample.expected)) continue;
      const bytes = await readMaybe(ref.path);
      if (ref.runId && file === "profile.json" && bytes !== undefined) perRun.set(ref.runId, bytes);
      if (!equivalent(json(bytes), sample.expected[file])) continue;
      const at = Date.parse(ref.createdAt);
      usable.set(file, Math.min(at, usable.get(file) ?? Infinity));
    }
    let directionRework = 0, previousWrong = false;
    for (const run of runs.filter((r) => r.graphAttempt?.role === "execute")) {
      if (previousWrong) directionRework++;
      const value = json(perRun.get(run.id)) as { criterion?: unknown; level?: unknown; interaction?: unknown } | undefined;
      previousWrong = !!value && typeof value.criterion === "string" && typeof value.level === "string" &&
        typeof value.interaction === "string" && (value.criterion !== "2.4.11" || value.interaction !== "native-button");
    }
    const view = task?.graph ? hub.graph.view(task) : undefined;
    const execute = runs.filter((r) => !r.loopRole && r.graphAttempt?.role !== "research");
    const maxConcurrentExecute = Math.max(0, ...execute.map((r) => execute.filter((candidate) =>
      candidate.startedAt <= r.startedAt && (candidate.endedAt ?? "~") > r.startedAt).length));
    const result: Trial = {
      dir, caseId, pair, arm, status,
      applicationDone: task?.state === "done", ...scored,
      firstMs: usable.size ? Math.min(...usable.values()) - startAt : null,
      allMs: usable.size === Object.keys(sample.expected).length ? Math.max(...usable.values()) - startAt : null,
      closeMs: closedAt === null ? null : closedAt - startAt,
      directionRework, researchRuns: runs.filter((r) => r.graphAttempt?.role === "research").length,
      branchCount: view?.nodes.filter((n) => !n.research).length ?? 1, maxConcurrentExecute,
      runCount: runs.length,
      receiptUnknown: runs.filter((r) => r.state === "unknown").length,
      lateStarts: runs.filter((r) => Date.parse(r.startedAt) >= startAt + manifest.limits.wallMinutes * 60_000).length,
      duplicateCommands: runs.length - new Set(runs.map((r) => r.commandId)).size,
      sourceReads,
      sourceVersions: (view?.nodes ?? []).flatMap((n) => n.research?.evidence?.sources ?? [])
        .filter((s) => s.outcome === "matched").map((s) => s.version),
      adopted: (view?.nodes ?? []).filter((n) => n.research?.use?.disposition === "adopted").length,
      transport: { ...api.counters },
      errorType,
    };
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ caseId, pair, arm, status, errorType, checks: scored.checks, runs: result.runCount,
      calls: result.transport.requests, allMs: result.allMs }));
  } finally {
    api.close();
    await hub.shutdown();
    hub.store.close();
    await rm(join(state, "api-key.dpapi"), { force: true });
    await rm(join(state, "custom-api.dpapi"), { force: true });
  }
}

async function main() {
  if (!process.argv.includes("--authorized")) throw new Error("P4 真实模型未授权");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw new Error("未提供 P4 隔离试验凭据");
  const frozen = await readFile(resolve("experiments/native-loop/p4.json"));
  const manifest = JSON.parse(frozen.toString("utf8")) as Manifest;
  trialSettings(manifest, "http://127.0.0.1:1/v1");
  const base = resolve("../.dev/advance-loop/P4");
  await mkdir(base, { recursive: true });
  const resumed = process.argv.find((arg) => arg.startsWith("--resume="))?.slice(9);
  const dir = resumed ? resolve(resumed) : await mkdtemp(join(base, "comparison-"));
  if (!dir.toLowerCase().startsWith(base.toLowerCase() + "\\") &&
      !dir.toLowerCase().startsWith(base.toLowerCase() + "/"))
    throw new Error("P4 输出须位于隔离验证目录");
  if (!resumed) await writeFile(join(dir, "manifest.json"), frozen, { flag: "wx" });
  else if (hash(await readFile(join(dir, "manifest.json"))) !== hash(frozen))
    throw new Error("P4 冻结协议已变化，不复用旧试验");
  const selected = process.argv.find((arg) => arg.startsWith("--cases="))?.slice(8).split(",");
  const wantsFocus = !selected || selected.includes("focus");
  const publicClip = wantsFocus ? await freezeWcag(dir) : undefined;
  console.log(JSON.stringify({ directory: dir, protocol: hash(frozen), model: manifest.model }));
  for (const [caseId, order] of Object.entries(manifest.ordering)) {
    if (selected && !selected.includes(caseId)) continue;
    for (const [index, arms] of order.entries())
      for (const value of arms) {
        const arm = value as Arm, pair = index + 1;
        const trialDir = join(dir, `${caseId}-${pair}-${arm}`);
        if (resumed && await readMaybe(join(trialDir, "result.json"))) continue;
        await trial({ dir: trialDir, arm, key, manifest, sample: manifest.cases[caseId],
          caseId, pair, ...(caseId === "focus" && arm === "C" && { replay: publicClip }) });
      }
  }
  if (wantsFocus) {
    const live = join(dir, "focus-live-C");
    if (!resumed || !await readMaybe(join(live, "result.json")))
      await trial({ dir: live, arm: "C", key, manifest, sample: manifest.cases.focus, caseId: "focus-live", pair: 1 });
  }
}
void main().catch((error: Error) => {
  console.error(error.message.split("\n")[0]);
  process.exitCode = 1;
});
