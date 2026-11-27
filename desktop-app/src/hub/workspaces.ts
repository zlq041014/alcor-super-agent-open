import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  realpath,
  readdir,
  stat,
  lstat,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { childEnv, within, hash, fileInfo } from "./security";
import { sensitive } from "./native-work";
const exec = promisify(execFile);
const git = existsSync("D:/dev/git/cmd/git.exe")
  ? "D:/dev/git/cmd/git.exe"
  : "git.exe";
function gitOptions(cwd: string) {
  return {
    cwd,
    env: { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" },
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  };
}
async function command(cwd: string, args: string[]) {
  return exec(
    git,
    [
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "apply.ignoreWhitespace=no",
      "-c",
      "apply.whitespace=nowarn",
      ...args,
    ],
    gitOptions(cwd),
  );
}
const diffOptions = [
  "--binary",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];
async function gitDiff(cwd: string, args: string[], noIndex = false) {
  try {
    return (
      await exec(
        git,
        [
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "core.quotepath=true",
          "--no-pager",
          "diff",
          ...diffOptions,
          ...args,
        ],
        { ...gitOptions(cwd), encoding: "buffer" },
      )
    ).stdout;
  } catch (error) {
    const e = error as { code?: number; stdout?: Buffer };
    if (noIndex && e.code === 1 && Buffer.isBuffer(e.stdout)) return e.stdout;
    throw error;
  }
}
export async function isolateWorkspace(
  source: string,
  dataDir: string,
  runId: string,
) {
  const path = join(dataDir, "workspaces", runId);
  await mkdir(join(dataDir, "workspaces"), { recursive: true });
  let baseCommit: string | undefined;
  try {
    baseCommit = (await command(source, ["rev-parse", "HEAD"])).stdout.trim();
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (
      e.code !== "ENOENT" &&
      !/not a git repository|ambiguous argument 'HEAD'/i.test(e.stderr || "")
    )
      throw error;
  }
  if (baseCommit) {
    const gitRoot = (
      await command(source, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    if (
      resolve(await realpath(gitRoot)).toLowerCase() !==
      resolve(source).toLowerCase()
    )
      throw new Error(
        "所选项目只是 Git 仓库的子目录；使用隔离工作树须先绑定仓库根目录",
      );
    await command(source, ["worktree", "add", "--detach", path, baseCommit]);
    return { path, isolation: "worktree" as const, baseCommit };
  }
  await mkdir(path);
  return { path, isolation: "output" as const };
}
export async function collectOutputs(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 8) throw new Error("隔离产物目录过深，请缩小交付范围");
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (
        f.name.startsWith(".") ||
        ["node_modules", "vendor", "dist", "target"].includes(f.name)
      )
        continue;
      const path = join(dir, f.name);
      if (f.isSymbolicLink()) continue;
      if (f.isDirectory()) await visit(path, depth + 1);
      else if (f.isFile()) {
        if (files.length >= 100)
          throw new Error("隔离产物超过 100 个文件，请缩小交付范围");
        await within(root, path);
        files.push(path);
      }
    }
  }
  await visit(root, 0);
  return files;
}
export async function snapshotFiles(root: string, observe?: (relativePath: string, data: Buffer, digest: string) => void) {
  const files: Record<string, { hash: string; size: number }> =
    Object.create(null);
  let entries = 0,
    bytes = 0,
    truncated = false;
  async function visit(dir: string, depth: number) {
    if (depth > 10) {
      truncated = true;
      return;
    }
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 5000) {
        truncated = true;
        return;
      }
      if (
        f.name.startsWith(".") ||
        [
          "node_modules",
          "vendor",
          "dist",
          "target",
          "release",
          "build",
          "coverage",
        ].includes(f.name) ||
        sensitive(f.name)
      )
        continue;
      const path = join(dir, f.name);
      if (f.isSymbolicLink()) continue;
      if (f.isDirectory()) await visit(path, depth + 1);
      else if (f.isFile()) {
        const info = await stat(path);
        if (
          info.size > 2 * 1024 * 1024 ||
          bytes + info.size > 40 * 1024 * 1024
        ) {
          truncated = true;
          continue;
        }
        await within(root, path);
        const data = await readFile(path);
        bytes += data.length;
        const name = relative(root, path), digest = hash(data);
        files[name] = { hash: digest, size: data.length };
        observe?.(name, data, digest);
      }
    }
  }
  await visit(root, 0);
  return { files, truncated };
}
export async function workspaceVersion(root: string) {
  let head: string | undefined;
  try {
    head = (await command(root, ["rev-parse", "HEAD"])).stdout.trim();
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { stderr?: string };
    if (
      error.code !== "ENOENT" &&
      !/not a git repository|ambiguous argument 'HEAD'/i.test(
        error.stderr || "",
      )
    )
      throw e;
  }
  if (head) {
    const raw = (
      await command(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ])
    ).stdout;
    const states: [string, string][] = [];
    let truncated = false;
    for (const item of raw.split("\0").filter(Boolean)) {
      const name = item.slice(3);
      if (sensitive(name)) {
        truncated = true;
        continue;
      }
      const code = item.slice(0, 2);
      const path = join(root, name);
      const info = await stat(path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      if (!info) states.push([item, "missing"]);
      else if (!info.isFile() || info.size > 2 * 1024 * 1024) truncated = true;
      else {
        const actual = await realpath(path);
        if (resolve(path).toLowerCase() !== resolve(actual).toLowerCase())
          truncated = true;
        else
          states.push([
            name + ":" + code,
            hash(await readFile(await within(root, actual))),
          ]);
      }
    }
    return { version: hash(JSON.stringify([head, states])), truncated };
  }
  const snapshot = await snapshotFiles(root);
  return {
    version: hash(
      JSON.stringify(
        Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
    truncated: snapshot.truncated,
  };
}
async function integrationPlan(
  workPath: string,
  kind: "worktree" | "output",
  baseCommit?: string,
) {
  if (kind === "worktree") {
    if (!baseCommit) throw new Error("隔离工作区缺少 Git 基线");
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(baseCommit))
      throw new Error("隔离工作区的 Git 基线无效");
    const tracked = (
      await command(workPath, [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        baseCommit,
        "--",
      ])
    ).stdout.split("\0");
    for (let i = 0; i + 1 < tracked.length; i += 2) {
      if (
        sensitive(tracked[i + 1]) ||
        /^:\d{6} (120000|160000) |^:(120000|160000) /.test(tracked[i])
      )
        throw new Error("差异包含敏感文件、链接或子模块，需要人工核对");
    }
    const untracked = (
      await command(workPath, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
    const patches = [
      await gitDiff(workPath, ["--no-renames", baseCommit, "--"]),
    ];
    let bytes = patches[0].length;
    if (untracked.length > 100)
      throw new Error("新增文件超过 100 项，请缩小交付范围");
    for (const name of untracked) {
      const path = join(workPath, name);
      if (!(await lstat(path)).isFile() || sensitive(name))
        throw new Error("新增文件类型不支持自动整合");
      await within(workPath, path);
      const patch = await gitDiff(
        workPath,
        ["--no-index", "--", "/dev/null", name],
        true,
      );
      bytes += patch.length;
      if (bytes > 10 * 1024 * 1024)
        throw new Error("隔离差异过大，请缩小交付范围");
      patches.push(patch);
    }
    const patch = Buffer.concat(patches);
    return { kind, patch, version: hash(patch) };
  }
  const files = [];
  for (const path of (await collectOutputs(workPath)).sort()) {
    const info = await fileInfo(path);
    files.push({ path, name: relative(workPath, path), hash: info.hash });
  }
  return {
    kind,
    files,
    version: hash(JSON.stringify(files.map(({ name, hash }) => [name, hash]))),
  };
}

export async function integrationVersion(
  workPath: string,
  kind: "worktree" | "output",
  baseCommit?: string,
) {
  return (await integrationPlan(workPath, kind, baseCommit)).version;
}

async function assertSameDirectory(path: string) {
  if (
    resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()
  )
    throw new Error("工作区目录已变化，请先重新核对项目位置");
}

export async function candidateSourceNames(root: string) {
  await assertSameDirectory(root);
  let top: string;
  try {
    top = (await command(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    await command(root, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT" || /not a git repository|single revision|ambiguous argument/i.test(e.stderr || ""))
      throw new Error("并行候选需要有基线的 Git 仓库");
    throw error;
  }
  if (resolve(await realpath(top)).toLowerCase() !== resolve(root).toLowerCase())
    throw new Error("并行候选只在已授权的 Git 仓库根目录运行");
  return [...new Set((await command(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean))].sort();
}

async function withGitPatch<T>(
  workPath: string,
  patch: Buffer,
  action: (path: string) => Promise<T>,
) {
  const scratch = await mkdtemp(join(dirname(workPath), ".integration-"));
  try {
    const path = join(scratch, "changes.patch");
    await writeFile(path, patch);
    return await action(path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function integrate(
  source: string,
  workPath: string,
  kind: "worktree" | "output",
  baseCommit: string | undefined,
  expectedVersion: string,
  beginWrite: (beforeVersion?: string) => void,
) {
  await assertSameDirectory(source);
  await assertSameDirectory(workPath);
  const plan = await integrationPlan(workPath, kind, baseCommit);
  if (plan.version !== expectedVersion)
    throw new Error("隔离产物在回合结束后有变化，请重新核对交付结果");
  const startWrite = async () => {
    await assertSameDirectory(source);
    const before = await workspaceVersion(source);
    beginWrite(before.truncated ? undefined : before.version);
  };
  if (plan.kind === "worktree") {
    const checkHead = async () => {
      if (
        (await command(source, ["rev-parse", "HEAD"])).stdout.trim() !==
        baseCommit
      )
        throw new Error("原项目 HEAD 已变化，请先人工核对隔离产物");
    };
    await checkHead();
    if (!plan.patch.length) return { changed: false };
    return withGitPatch(workPath, plan.patch, async (patch) => {
      try {
        await command(source, ["apply", "--check", patch]);
      } catch {
        throw new Error("差异与原项目冲突，未写入任何文件");
      }
      await checkHead();
      await startWrite();
      try {
        await command(source, ["apply", patch]);
      } catch (cause) {
        throw new Error("整合已开始但 Git 未确认成功，请核对原项目", { cause });
      }
      return { changed: true };
    });
  }
  const planned = [];
  for (const file of plan.files) {
    const rel = file.name;
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("产物路径无效");
    const target = resolve(source, rel);
    if (existsSync(target))
      throw new Error(`原项目已有同名文件，保留双方版本：${rel}`);
    let parent = dirname(target);
    while (!existsSync(parent)) parent = dirname(parent);
    await within(source, parent);
    planned.push({ file, target });
  }
  if (planned.length) await startWrite();
  for (const { file, target } of planned) {
    await mkdir(resolve(target, ".."), { recursive: true });
    await within(source, resolve(target, ".."));
    const data = await readFile(await within(workPath, file.path));
    if (hash(data) !== file.hash)
      throw new Error("整合期间隔离文件发生变化，请核对已写入的产物");
    await writeFile(target, data, { flag: "wx" });
  }
  return { changed: planned.length > 0, files: planned.length };
}

export async function inspectIntegration(
  source: string,
  workPath: string,
  kind: "worktree" | "output",
  baseCommit: string | undefined,
  expectedVersion: string,
  beforeVersion?: string,
): Promise<"observed" | "unchanged" | "unknown"> {
  await assertSameDirectory(source);
  await assertSameDirectory(workPath);
  const plan = await integrationPlan(workPath, kind, baseCommit);
  if (plan.version !== expectedVersion) return "unknown";
  const before = await workspaceVersion(source);
  if (before.truncated) return "unknown";
  let outcome: "observed" | "unchanged" | "unknown" = "unknown";
  if (!before.truncated && before.version === beforeVersion)
    outcome = "unchanged";
  else if (plan.kind === "worktree") {
    if (
      (await command(source, ["rev-parse", "HEAD"])).stdout.trim() !==
      baseCommit
    )
      return "unknown";
    outcome = await withGitPatch(workPath, plan.patch, async (patch) => {
      const [reverse, forward] = await Promise.allSettled([
        command(source, ["apply", "--check", "--reverse", patch]),
        command(source, ["apply", "--check", patch]),
      ]);
      if (
        reverse.status === "fulfilled" &&
        forward.status === "rejected" &&
        (forward.reason as { code?: number }).code === 1
      )
        return "observed";
      return "unknown";
    });
  } else {
    let same = true;
    for (const file of plan.files) {
      const target = resolve(source, file.name);
      if (
        !existsSync(target) ||
        hash(await readFile(await within(source, target))) !== file.hash
      ) {
        same = false;
        break;
      }
    }
    if (same && plan.files.length) outcome = "observed";
  }
  if (outcome !== "unknown") {
    const after = await workspaceVersion(source);
    if (after.truncated || after.version !== before.version) return "unknown";
  }
  return outcome;
}
