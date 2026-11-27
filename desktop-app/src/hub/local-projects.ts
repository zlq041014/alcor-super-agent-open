import { lstat, mkdir, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, parse } from "node:path";
import { Store, entity, stamp } from "./store";
import type { Project, ProjectRoot } from "../shared/contracts";

export const pathKey = (s: string) =>
  s.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
export const projectRoots = (s: Store) => s.all<ProjectRoot>("project-root");
export const visibleProjects = (s: Store) =>
  s.all<Project>("project").filter((p) => !p.removed);
const fold = (s: string) => s.normalize("NFKC").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
export function namedProjects(name: string, projects: Project[]) {
  const t = fold(name.trim());
  if (/^[a-z]:[\\/]/i.test(t))
    return projects.filter((p) => samePath(p.path, name));
  const names = (p: Project) =>
    [p.name, basename(p.path), ...(p.aliases || [])].map(fold);
  const literal = projects.filter((p) => names(p).includes(t));
  if (literal.length || !t) return literal;
  const stem = (n: string) => n.replace(/(?:项目|工程)$/, "");
  return projects.filter((p) =>
    names(p).some((n) => !!stem(n) && stem(n) === stem(t)),
  );
}
export function exactProjects(text: string, projects: Project[]) {
  const t = fold(text).replaceAll("\\", "/");
  if (/[a-z]:\//i.test(t)) {
    return projects.filter((p) =>
      new RegExp(
        escape(fold(pathKey(p.path))) +
          "(?=$|[\\s」”』\"'，。；;！？?!]|的(?:项目|进度|状态))",
      ).test(t),
    );
  }
  return projects.filter((p) =>
    [p.name, basename(p.path), ...(p.aliases || [])].some((name) => {
      const n = fold(name.trim());
      if (!n) return false;
      return new RegExp(
        (/^[a-z0-9_-]/.test(n) ? "(?<![a-z0-9_-])" : "") +
          escape(n) +
          (/[a-z0-9_-]$/.test(n) ? "(?![a-z0-9_-])" : ""),
      ).test(t);
    }),
  );
}

function localPath(path: string) {
  if (
    !/^[A-Za-z]:[\\/]/.test(path) ||
    /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(path) ||
    /[:\x00-\x1f*?"<>|]/.test(path.slice(2))
  )
    throw new Error("请选择本机磁盘上的绝对目录");
  return normalize(path);
}
export async function verifiedDir(path: string, bound = false) {
  const input = localPath(path);
  const actual = await realpath(input).catch(() => {
    throw new Error("目录不存在或暂不可访问");
  });
  if (
    !/^[A-Za-z]:[\\/]/.test(actual) ||
    !(await stat(actual)).isDirectory() ||
    (bound && !samePath(input, actual))
  )
    throw new Error("目录不可用或实际位置已变化，请重新选择");
  return actual;
}
export async function parentDir(path: string) {
  const actual = await verifiedDir(path, true);
  if (samePath(actual, parse(actual).root))
    throw new Error("请选择存放项目的文件夹，不能选择整个磁盘");
  return actual;
}
export function validFolderName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    name === name.trim() &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/i.test(
      name,
    )
  );
}
export function aliasesFor(p: Project, ...names: string[]) {
  return [
    ...new Set(
      [...(p.aliases || []), ...names].filter(
        (n) => n && n !== p.name && n !== basename(p.path),
      ),
    ),
  ].slice(-32);
}
export function bindDirectory(s: Store, path: string, name = ""): Project {
  const existing = s
    .all<Project>("project")
    .find((p) => samePath(p.path, path));
  const p: Project = existing
    ? { ...existing, origin: "manual", removed: false, available: true }
    : {
        ...entity(),
        path,
        name: name.trim() || basename(path),
        origin: "manual",
        available: true,
      };
  if (
    existing?.origin === "local" &&
    !existing.nameCustomized &&
    name.trim() &&
    name.trim() !== basename(path) &&
    name.trim() !== existing.name
  ) {
    p.name = name.trim();
    p.nameCustomized = true;
    p.aliases = aliasesFor(p, existing.name);
  }
  s.tx(() => {
    s.put("project", p);
    s.event("project.bound", p.id, { existing: !!existing });
  });
  return p;
}
export async function createDirectory(
  s: Store,
  parent: string,
  name: string,
  reuse = false,
) {
  if (!validFolderName(name))
    throw new Error(
      "请输入单个有效的文件夹名，不能包含路径、保留名或结尾的点及空格",
    );
  const base = await parentDir(parent),
    path = join(base, name);
  let created = false;
  if (!reuse) {
    if (
      s.all<Project>("project").some((p) => samePath(p.path, path)) &&
      !(await lstat(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return;
        throw e;
      }))
    )
      throw new Error(
        "这个路径曾绑定的项目目录当前失联。请找回原目录，或给新项目另选位置，以保留旧历史",
      );
    try {
      await mkdir(path);
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("无法在此位置创建文件夹，请检查位置和写入权限");
    }
  }
  if (
    !(await lstat(path).catch(() => undefined))?.isDirectory() ||
    !samePath(await verifiedDir(path, true), path)
  )
    throw new Error("目标不是可直接使用的本机目录，请另选名称或位置");
  if (!created && !reuse) return { status: "exists" as const, path };
  try {
    const project = bindDirectory(s, path);
    s.event(
      created ? "project.directory-created" : "project.directory-reused",
      project.id,
      {},
    );
    return {
      status: created ? ("created" as const) : ("reused" as const),
      path,
      project,
    };
  } catch {
    throw new Error(
      "文件夹已存在，但项目绑定未保存；请用「选择已有文件夹」重新添加",
    );
  }
}

const omitted = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "$recycle.bin",
  "system volume information",
]);
const entryLimit = 1000;
export async function scanRoot(s: Store, root: ProjectRoot) {
  const found = new Map<string, string>();
  let status: ProjectRoot["status"] = "ready",
    inspected = 0;
  try {
    await parentDir(root.path);
    for await (const entry of await opendir(root.path)) {
      if (++inspected > entryLimit) {
        status = "partial";
        break;
      }
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        omitted.has(entry.name.toLowerCase())
      )
        continue;
      const path = join(root.path, entry.name);
      try {
        const actual = await realpath(path);
        if (samePath(path, actual)) found.set(pathKey(actual), actual);
      } catch {
        status = "partial";
      }
    }
    await parentDir(root.path);
  } catch {
    status = "unavailable";
    found.clear();
  }
  const checkedAt = stamp();
  s.tx(() => {
    if (!s.get("project-root", root.id)) return; // The location was removed while the disk was being read.
    const known = new Map(
      s.all<Project>("project").map((p) => [pathKey(p.path), p]),
    );
    for (const [key, path] of found) {
      const old = known.get(key);
      if (old?.removed) continue;
      if (!old || old.available !== true)
        s.put(
          "project",
          old
            ? { ...old, available: true }
            : {
                ...entity(),
                name: basename(path),
                path,
                origin: "local",
                available: true,
                discoveredAt: checkedAt,
              },
        );
    }
    for (const p of known.values()) {
      if (
        !p.removed &&
        p.available !== false &&
        samePath(dirname(p.path), root.path) &&
        !found.has(pathKey(p.path)) &&
        status !== "partial" &&
        !basename(p.path).startsWith(".") &&
        !omitted.has(basename(p.path).toLowerCase())
      )
        s.put("project", { ...p, available: false });
    }
    s.put("project-root", { ...root, status, checkedAt, count: found.size });
    s.event("projects.local-scan", root.id, { status, count: found.size });
  });
}
export function searchSummary(s: Store) {
  const roots = projectRoots(s);
  return roots.length
    ? "查找位置：" +
        roots
          .map(
            (r) =>
              r.path +
              (r.status === "ready"
                ? ""
                : r.status === "unavailable"
                  ? "（无法访问）"
                  : r.status === "partial"
                    ? "（仅检查了部分目录）"
                    : "（尚未检查）"),
          )
          .join("、") +
        "。"
    : "已核对已知项目。还未设置本机查找位置，可在项目页添加常用父目录。";
}
