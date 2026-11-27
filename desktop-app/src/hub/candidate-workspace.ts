import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathKey } from "../core/glob";
import { overlaps } from "../core/policy";
import { LoopRelativePath } from "../shared/loop-contracts";
import { candidateSourceNames, workspaceVersion } from "./workspaces";
import { sensitive } from "./native-work";

const maxFile = 2 * 1024 * 1024;
const dependency = (name: string) => name.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules");

async function present(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });
}

function sourcePath(root: string, name: string) {
  if (!LoopRelativePath.safeParse(name).success || name === "." || sensitive(name))
    throw new Error("候选工作区包含不允许的文件路径");
  return resolve(root, name);
}

async function ordinary(root: string, name: string) {
  const path = sourcePath(root, name), st = await present(path);
  if (!st) return undefined;
  if (!st.isFile() || st.nlink !== 1 || st.size > maxFile || pathKey(await realpath(path)) !== pathKey(path))
    throw new Error("候选源文件不是可隔离的普通文件：" + name);
  return readFile(path);
}

async function copyDependencies(source: string, target: string) {
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (path) => {
      const st = await lstat(path);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) ||
          (st.isFile() && st.nlink !== 1) || pathKey(await realpath(path)) !== pathKey(path) ||
          sensitive(relative(source, path)))
        throw new Error("已有依赖含链接或不能安全复制的文件");
      return true;
    },
  });
}

export async function prepareCandidates(root: string, parent: string, count: number) {
  if (overlaps(root, parent)) throw new Error("候选暂存目录不能位于原项目内");
  const base = await workspaceVersion(root);
  if (base.truncated) throw new Error("原目录版本不完整，无法并行候选");
  const names = await candidateSourceNames(root);
  if (names.length > 5000) throw new Error("源文件超过并行候选复制的范围");
  const files = new Map<string, Buffer>();
  let bytes = 0;
  for (const name of names) {
    if (dependency(name)) continue;
    const data = await ordinary(root, name);
    if (!data) continue; // A path removed in the working directory stays removed in every copy.
    bytes += data.length;
    if (bytes > 40 * 1024 * 1024) throw new Error("源文件超过并行候选复制的容量");
    files.set(name, data);
  }
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  if (overlaps(root, actualParent)) throw new Error("候选暂存目录不能位于原项目内");
  const container = await mkdtemp(join(actualParent, "pair-"));
  const clean = async () => {
    if (!pathKey(container).startsWith(pathKey(await realpath(parent)) + "/") ||
        pathKey(await realpath(container)) !== pathKey(container))
      throw new Error("候选清理目录已变化");
    await rm(container, { recursive: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    const baseline = join(container, "source");
    await mkdir(baseline);
    for (const [name, bytes] of files) {
      const to = sourcePath(baseline, name);
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, bytes, { flag: "wx" });
    }
    const moduleDirs = new Set(["node_modules", ...[...files.keys()]
      .filter((name) => basename(name).toLowerCase() === "package.json")
      .map((name) => join(dirname(name), "node_modules"))]);
    for (const name of moduleDirs) {
      const from = sourcePath(root, name);
      const st = await present(from);
      if (!st) continue;
      if (!st.isDirectory()) throw new Error("已有依赖路径不是独立普通目录");
      const to = sourcePath(baseline, name);
      await mkdir(dirname(to), { recursive: true });
      await copyDependencies(from, to);
    }
    const after = await workspaceVersion(root);
    if (after.truncated || after.version !== base.version)
      throw new Error("复制期间原目录已变化，未派发候选");
    const paths: string[] = [];
    for (let index = 0; index < count; index++) {
      const path = join(container, "candidate-" + index);
      await cp(baseline, path, { recursive: true, force: false, errorOnExist: true });
      paths.push(path);
    }
    return { paths, files, baseVersion: base.version, clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

export function writableCandidatePath(name: string) {
  if (dependency(name)) throw new Error("候选不能修改已有依赖目录");
}

export type CandidateEdit = { name: string; before?: Buffer; after: Buffer };
export async function candidateEdits(work: string, files: Map<string, Buffer>, touched: Set<string>) {
  const baseline = new Map([...files].map(([name, content]) => [pathKey(name), { name, content }]));
  const edits: CandidateEdit[] = [];
  for (const name of touched) {
    writableCandidatePath(name);
    const previous = baseline.get(pathKey(name));
    const after = await ordinary(work, name);
    if (!after) throw new Error("候选文件在验证前消失：" + name);
    if (!previous?.content.equals(after)) edits.push({ name: previous?.name ?? name, before: previous?.content, after });
  }
  const expected = new Map(edits.map((e) => [pathKey(e.name), e.after]));
  for (const [key, row] of baseline) {
    if (!(await ordinary(work, row.name))?.equals(expected.get(key) ?? row.content))
      throw new Error("候选有无法归因的源文件变更：" + row.name);
  }
  return edits;
}

export async function preflightCandidate(root: string, version: string, edits: CandidateEdit[]) {
  const current = await workspaceVersion(root);
  if (current.truncated || current.version !== version)
    throw new Error("原目录已变化，保留现有文件并停止整合");
  for (const edit of edits) {
    const original = await ordinary(root, edit.name);
    if (edit.before ? !original?.equals(edit.before) : !!original)
      throw new Error("候选与原目录文件冲突：" + edit.name);
  }
}
