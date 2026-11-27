import {
  mkdir,
  lstat,
  readFile,
  readdir,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { CheckInput } from "../src/shared/loop-contracts";
import { runCheck } from "../src/hub/checks";
import { hash } from "../src/hub/security";

const taskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    category: z.enum(["bugfix", "feature", "refactor", "docs"]),
    prompt: z.string().min(1).max(300),
    visibleChecks: z.array(CheckInput).min(1),
    hiddenChecks: z.array(CheckInput).min(1),
    timeLimitMinutes: z.literal(20),
  })
  .strict();
export type ExperimentTask = z.infer<typeof taskSchema> & { dir: string };
export type Group = "A" | "B" | "C" | "D";
export type TrialScore = {
  group: Group;
  task: string;
  run: number;
  systemCompleted: boolean;
  visiblePassed: boolean;
  hiddenPassed: boolean;
  passed: boolean;
  mechanicalFalseCompletion: number;
  protectedFilesChanged: number;
  executorRuns: number;
  rejectedWrites: number;
  wallMs: number;
  tokensKnown: number | null;
  infrastructureRetry: boolean;
  timedOut: boolean;
  interrupted?: boolean;
};

export async function tree(root: string, dir = root): Promise<string[]> {
  const names = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const child = join(dir, item.name);
    if (item.isSymbolicLink())
      throw new Error("隔离样本内不允许目录或文件链接");
    if (item.isDirectory()) names.push(...(await tree(root, child)));
    else if (item.isFile())
      names.push(relative(root, child).replaceAll("\\", "/"));
  }
  return names;
}

export async function copyTree(from: string, to: string, skip?: Set<string>) {
  for (const name of await tree(from)) {
    if (skip?.has(name.toLowerCase())) continue;
    const target = join(to, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(from, name), target);
  }
}

export async function taskSet(
  root: string,
  mode: "read" | "preview" | "freeze" = "read",
) {
  const folder = join(root, "tasks");
  const files: Record<string, string> = Object.create(null);
  for (const name of await tree(folder))
    files[name] = hash(await readFile(join(folder, name)));
  const manifest = JSON.stringify({ version: 1, files }, null, 2) + "\n";
  const path = join(root, "tasks.manifest.json");
  if (mode === "read" && (await readFile(path, "utf8")) !== manifest)
    throw new Error("任务集与冻结清单不一致");
  const tasks = await Promise.all(
    Object.keys(files)
      .filter((p) => p.split("/").length === 2 && p.endsWith("/task.json"))
      .map(async (p) => {
        const dir = join(folder, dirname(p));
        const data = taskSchema.parse(
          JSON.parse(await readFile(join(folder, p), "utf8")),
        );
        if (data.id !== dirname(p)) throw new Error("任务编号与目录不一致");
        return { ...data, dir };
      }),
  );
  for (const [category, count] of Object.entries({
    bugfix: 5,
    feature: 5,
    refactor: 3,
    docs: 2,
  }))
    if (tasks.filter((t) => t.category === category).length !== count)
      throw new Error("任务集分类或数量不符合冻结规则");
  if (mode === "freeze") await writeFile(path, manifest, { flag: "wx" });
  return { tasks, manifestHash: hash(manifest) };
}

function isVisibleCheck(name: string) {
  return (
    /^(?:test|tests)\//i.test(name) || /\.(?:test|spec)\.[^/]+$/i.test(name)
  );
}

export async function checkWorkspace(
  task: ExperimentTask,
  workspace: string,
  scoring: string,
  authored: { path: string; hash: string }[] = [],
  options: { auditOnly?: boolean; timeoutMs?: number } = {},
) {
  if (
    !isAbsolute(scoring) ||
    relative(workspace, scoring).startsWith("..") === false
  )
    throw new Error("评分目录必须独立于工作区");
  const initial = join(task.dir, "workspace");
  const frozen = await tree(initial);
  const stored = new Set(frozen.map((file) => file.toLowerCase()));
  const accepted = authored.filter(
    (item) => !stored.has(item.path.replaceAll("\\", "/").toLowerCase()),
  );
  const skip = new Set(
    accepted.map((item) => item.path.replaceAll("\\", "/").toLowerCase()),
  );
  await mkdir(scoring, { recursive: true });
  await copyTree(workspace, scoring, skip);
  let protectedFilesChanged = 0;
  for (const item of accepted) {
    const candidate = join(workspace, item.path);
    const actual = await lstat(candidate).then(
      (info) =>
        info.isFile() && info.nlink === 1
          ? readFile(candidate).then(hash)
          : null,
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      },
    );
    if (actual !== item.hash) protectedFilesChanged++;
  }
  const original = JSON.parse(
    await readFile(join(initial, "package.json"), "utf8"),
  );
  let candidate;
  try {
    candidate = JSON.parse(
      await readFile(join(scoring, "package.json"), "utf8"),
    );
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new SyntaxError("无效的包清单");
  } catch (e) {
    if (
      !(e instanceof SyntaxError) &&
      (e as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw e;
    candidate = {};
  }
  if (JSON.stringify(candidate.scripts) !== JSON.stringify(original.scripts))
    protectedFilesChanged++;
  await writeFile(
    join(scoring, "package.json"),
    JSON.stringify({ ...candidate, scripts: original.scripts }, null, 2),
  );
  for (const name of frozen.filter(isVisibleCheck)) {
    const target = join(scoring, name);
    const known = await lstat(target).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    const contents = await readFile(join(initial, name));
    if (!known?.isFile() || !(await readFile(target)).equals(contents))
      protectedFilesChanged++;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  if (options.auditOnly)
    return { visiblePassed: false, hiddenPassed: false, protectedFilesChanged };
  const run = async (inputs: readonly z.infer<typeof CheckInput>[]) => {
    const outcomes = [];
    for (const input of inputs) {
      const result = await runCheck(input, {
        root: scoring,
        checkPath: [dirname(process.execPath)],
        timeoutMs: options.timeoutMs ?? 300_000,
      });
      outcomes.push(result.outcome || result.state);
    }
    if (outcomes.some((v) => !["passed", "failed", "timeout"].includes(v)))
      throw new Error(
        "评分检查没有有效结果：" + task.id + " " + outcomes.join(","),
      );
    return {
      passed: outcomes.every((v) => v === "passed"),
      timedOut: outcomes.includes("timeout"),
    };
  };
  const visible = await run(task.visibleChecks);
  if (visible.timedOut)
    return {
      visiblePassed: false,
      hiddenPassed: false,
      protectedFilesChanged,
      scoringTimedOut: true as const,
    };
  await copyTree(join(task.dir, "hidden"), join(scoring, "hidden"));
  const hidden = await run(task.hiddenChecks);
  return {
    visiblePassed: visible.passed,
    hiddenPassed: hidden.passed,
    protectedFilesChanged,
    ...(hidden.timedOut ? { scoringTimedOut: true as const } : {}),
  };
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return !sorted.length
    ? null
    : sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metrics(trials: TrialScore[]) {
  const passed = trials.filter((t) => t.passed).length;
  const completed = trials.filter((t) => t.systemCompleted);
  return {
    total: trials.length,
    passed,
    rate: trials.length ? passed / trials.length : null,
    mechanicalFalseCompletion: trials.reduce(
      (sum, t) => sum + t.mechanicalFalseCompletion,
      0,
    ),
    hiddenGap: completed.length
      ? completed.filter((t) => !t.passed).length / completed.length
      : null,
    medianRuns: median(trials.map((t) => t.executorRuns)),
    medianWallMs: trials.some((t) => t.interrupted)
      ? null
      : median(trials.map((t) => t.wallMs)),
    tokensKnown: trials.reduce((sum, t) => sum + (t.tokensKnown || 0), 0),
    unknownUsage: trials.filter((t) => t.tokensKnown === null).length,
    rejectedWrites: trials.reduce((sum, t) => sum + t.rejectedWrites, 0),
  };
}

export function compare(trials: TrialScore[]) {
  const group = (key: Group) => metrics(trials.filter((t) => t.group === key));
  const A = group("A"),
    B = group("B"),
    C = group("C"),
    D = group("D");
  const valid =
    A.total === 45 && A.rate !== null && A.rate >= 0.2 && A.rate <= 0.8;
  const failureReduction =
    A.rate !== null && B.rate !== null && A.rate < 1
      ? (B.rate - A.rate) / (1 - A.rate)
      : null;
  const continuation =
    valid &&
    B.total === 45 &&
    failureReduction !== null &&
    3 * (B.passed - A.passed) >= 45 - A.passed &&
    B.mechanicalFalseCompletion === 0 &&
    B.medianWallMs !== null &&
    B.medianWallMs <= 30 * 60_000;
  const support =
    continuation && C.total === 45 && 100 * (C.passed - B.passed) <= 5 * 45;
  return {
    groups: { A, B, C, D },
    gates: { valid, continuation, support, failureReduction },
  };
}
