import { realpath, stat, open } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { z } from "zod";
import { Store, entity, stamp } from "./store";
import { aliasesFor, pathKey, samePath } from "./local-projects";
export { exactProjects, visibleProjects, samePath } from "./local-projects";
import { within, childEnv, redact, hash } from "./security";
import type {
  Project,
  ProjectCatalog,
  ProjectSource,
} from "../shared/contracts";

interface Reader {
  call(
    method: string,
    params: unknown,
    mutation?: boolean,
    timeout?: number,
  ): Promise<any>;
}
const projectPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      roots: z.array(z.object({ path: z.string() })),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
const threadPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      cwd: z.string(),
      name: z.string().nullish(),
      preview: z.string().nullish(),
      projectId: z.string().nullish(),
      updatedAt: z.number().optional(),
      status: z.unknown().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
export async function discoverProjects(
  store: Store,
  reader: Reader,
): Promise<ProjectCatalog> {
  const incoming: { id: string; name: string; roots: { path: string }[] }[] =
    [];
  let cursor: string | undefined,
    complete = false;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = projectPage.parse(
      await reader.call(
        "project/list",
        { limit: 100, ...(cursor ? { cursor } : {}) },
        false,
        10000,
      ),
    );
    incoming.push(...result.data);
    if (!result.nextCursor) {
      complete = true;
      break;
    }
    if (cursors.has(result.nextCursor)) break;
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  const discovered = new Map<
    string,
    { path: string; available: boolean; name: string; nativeId: string }
  >();
  const now = stamp();
  for (const native of incoming)
    for (const root of native.roots) {
      if (!isAbsolute(root.path) || root.path.startsWith("\\\\")) continue;
      let path = root.path,
        available = false;
      try {
        path = await realpath(path);
        available = (await stat(path)).isDirectory();
      } catch {}
      const key = pathKey(path);
      if (!discovered.has(key))
        discovered.set(key, {
          path,
          available,
          name: native.name || basename(path),
          nativeId: native.id,
        });
    }
  const result: ProjectCatalog = {
    status: complete ? "ready" : "partial",
    checkedAt: now,
    lastSuccessAt: now,
    count: 0,
    ...(!complete
      ? { error: "原生项目目录尚未完整加载，已保留已发现项目" }
      : {}),
  };
  store.tx(() => {
    // Merge against current rows at commit time, including edits made during pagination.
    const known = new Map(
      store.all<Project>("project").map((p) => [pathKey(p.path), p]),
    );
    for (const [key, item] of discovered) {
      const old = known.get(key);
      if (old?.removed) continue;
      const project: Project = old
        ? { ...old }
        : { ...entity(), path: item.path, name: item.name, origin: "codex" };
      if (old?.origin === "codex" && !old.nameCustomized)
        project.name = item.name;
      project.aliases = aliasesFor(project, old?.name || "", item.name);
      project.nativeProjectId ||= item.nativeId;
      project.available = item.available;
      project.discoveredAt = now;
      store.put("project", project);
      result.count++;
    }
    store.put("catalog", { id: "codex", ...result });
    store.event("projects.discovered", "codex", {
      count: result.count,
      complete,
    });
  });
  return result;
}

const documentNames = [
  "README.md",
  "docs/roadmap.md",
  "docs/status.md",
  "docs/progress.md",
  "docs/README.md",
  "docs/architecture.md",
  "TODO.md",
];
export interface ProgressEvidence {
  project: { id: string; name: string; path: string; nativeProjectId?: string };
  fetchedAt: string;
  sources: ProjectSource[];
  documents: { sourceId: string; text: string; truncated: boolean }[];
  sessions: {
    sourceId: string;
    threadId: string;
    title: string;
    nativeProjectId: string | null;
    runtimeStatus: string;
    turns: { id: string; status: string; text: string[] }[];
  }[];
  git?: {
    sourceId: string;
    branch: string;
    changedFiles: number;
    untrackedFiles: number;
    recentCommits: string;
  };
  limitations: string[];
}
import type { WorkTrace } from "./work-trace";
export async function readProgress(
  project: Project,
  reader: Reader,
  ensure: () => Promise<void>,
  trace?: WorkTrace,
): Promise<ProgressEvidence> {
  const fetchedAt = stamp();
  const result: ProgressEvidence = {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      nativeProjectId: project.nativeProjectId,
    },
    fetchedAt,
    sources: [],
    documents: [],
    sessions: [],
    limitations: [],
  };
  const root = await realpath(project.path);
  if (!samePath(root, project.path))
    throw new Error("项目实际目录发生变化，请核对绑定后重试");
  const source = (
    kind: ProjectSource["kind"],
    title: string,
    extra: Partial<ProjectSource> = {},
  ) => ({
    id: `${kind}-${hash(project.id + title).slice(0, 12)}`,
    kind,
    title,
    projectId: project.id,
    fetchedAt,
    complete: true,
    ...extra,
  });
  let remaining = 46000;
  for (const name of documentNames) {
    let handle;
    try {
      const path = await within(root, join(root, name));
      handle = await open(path, "r");
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const limit = Math.min(16000, remaining);
      if (limit <= 0) {
        result.limitations.push("文档摘录达到本次上下文上限");
        break;
      }
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      remaining -= bytesRead;
      const ref = source("document", name, {
        updatedAt: info.mtime.toISOString(),
        complete: info.size <= bytesRead,
      });
      const text = redact(buffer.subarray(0, bytesRead).toString("utf8"));
      result.documents.push({
        sourceId: ref.id,
        text,
        truncated: !ref.complete,
      });
      result.sources.push(ref);
      trace?.add(
        "read",
        name,
        "已读取 " +
          bytesRead +
          " 字节" +
          (ref.complete ? "，文件已读完。" : "，本次只取有界摘录。"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        result.limitations.push(`文档 ${name} 无法在授权根目录内读取`);
    } finally {
      await handle?.close();
    }
  }
  if (!result.documents.length)
    result.limitations.push("未找到可读取的项目入口/进度文档");
  await Promise.all([
    (async () => {
      try {
        await ensure();
        const tracedReader: Reader = {
          call: (method, params, mutation, timeout) =>
            trace
              ? trace.call(
                  "read",
                  "Codex · " + method,
                  () => reader.call(method, params, mutation, timeout),
                  (r) =>
                    Array.isArray(r?.data)
                      ? "取得 " + r.data.length + " 条记录。"
                      : "已取得会话元数据。",
                )
              : reader.call(method, params, mutation, timeout),
        };
        const threads = threadPage.parse(
          await tracedReader.call(
            "thread/list",
            {
              cwd: root,
              limit: 8,
              sortKey: "updated_at",
              sortDirection: "desc",
              sourceKinds: [],
              modelProviders: [],
            },
            false,
            10000,
          ),
        );
        if (threads.nextCursor)
          result.limitations.push(
            "本次只查看最近 8 个会话目录项；更早历史未遍历",
          );
        let textBudget = 36000;
        for (const t of threads.data.slice(0, 4)) {
          let verified: string;
          try {
            verified = await realpath(t.cwd);
          } catch {
            continue;
          }
          if (!samePath(verified, root)) continue;
          const ref = source(
            "session",
            t.name || t.preview?.slice(0, 120) || t.id,
            {
              threadId: t.id,
              updatedAt: t.updatedAt
                ? new Date(t.updatedAt * 1000).toISOString()
                : undefined,
              complete: false,
            },
          );
          const turns: { id: string; status: string; text: string[] }[] = [];
          try {
            // Only the paginated, bounded native read path is used. Reading never resumes a thread.
            const meta = await tracedReader.call(
              "thread/read",
              { threadId: t.id, includeTurns: false },
              false,
              10000,
            );
            if (
              !meta.thread?.cwd ||
              !samePath(await realpath(meta.thread.cwd), root)
            )
              continue;
            const page = await tracedReader.call(
              "thread/turns/list",
              {
                threadId: t.id,
                limit: 3,
                sortDirection: "desc",
                itemsView: "full",
              },
              false,
              10000,
            );
            if (!Array.isArray(page.data)) throw new Error("invalid history");
            ref.complete = !page.nextCursor;
            for (const turn of [...page.data].reverse()) {
              const items = Array.isArray(turn.items) ? turn.items : [];
              const messages = items
                .filter(
                  (i: any) =>
                    i?.type === "agentMessage" || i?.type === "userMessage",
                )
                .slice(-6)
                .map((i: any) =>
                  redact(
                    i.type === "agentMessage"
                      ? String(i.text || "")
                      : Array.isArray(i.content)
                        ? i.content
                            .filter((c: any) => c.type === "text")
                            .map((c: any) => c.text)
                            .join("\n")
                        : "",
                  ),
                );
              const selected: string[] = [];
              for (const m of messages) {
                if (textBudget <= 0) {
                  ref.complete = false;
                  break;
                }
                const limit = Math.min(6500, textBudget);
                const excerpt =
                  m.length > limit
                    ? m.slice(0, Math.floor(limit / 2)) +
                      "\n[中间内容省略]\n" +
                      m.slice(-Math.floor(limit / 2))
                    : m;
                selected.push(excerpt);
                textBudget -= excerpt.length;
                if (m.length > limit) ref.complete = false;
              }
              turns.push({
                id: String(turn.id),
                status: String(turn.status),
                text: selected,
              });
            }
          } catch {
            ref.complete = false;
            result.limitations.push(
              `会话 ${t.id} 的近期正文无法完整读取，不能用标题推断完成`,
            );
          }
          const runtimeStatus = (t.status as any)?.type || "unknown";
          result.sources.push(ref);
          result.sessions.push({
            sourceId: ref.id,
            threadId: t.id,
            title: ref.title,
            nativeProjectId: t.projectId || null,
            runtimeStatus,
            turns,
          });
        }
        if (!result.sessions.length)
          result.limitations.push(
            "当前目录查询没有取得匹配会话；这不代表项目没有历史",
          );
        if (textBudget <= 0)
          result.limitations.push(
            "会话正文达到本次 36000 字符上下文上限，较早部分未加载",
          );
      } catch {
        result.limitations.push(
          "Codex 会话读取不可用，当前仅根据已取得的本地资料核对",
        );
      }
    })(),
    (async () => {
      try {
        const git = existsSync("D:/dev/git/cmd/git.exe")
          ? "D:/dev/git/cmd/git.exe"
          : "git.exe";
        const exec = promisify(execFile);
        const prefix = [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=NUL",
        ];
        const invoke = (args: string[]) =>
          exec(git, [...prefix, ...args], {
            cwd: root,
            windowsHide: true,
            timeout: 7000,
            maxBuffer: 512000,
            env: { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" },
          });
        const run = (args: string[]) =>
          trace
            ? trace.call(
                "command",
                "git " +
                  [...prefix, ...args]
                    .map((a) => (a.includes(" ") ? JSON.stringify(a) : a))
                    .join(" "),
                () => invoke(args),
                (r) => r.stdout.trim() || "命令已正常结束，无标准输出。",
              )
            : invoke(args);
        const top = (await run(["rev-parse", "--show-toplevel"])).stdout.trim();
        if (!samePath(await realpath(top), root)) return;
        const [state, branch, log] = await Promise.all([
          run(["status", "--porcelain", "--untracked-files=normal"]),
          run(["branch", "--show-current"]),
          run(["log", "-5", "--date=iso-strict", "--format=%h %ad %s"]),
        ]);
        const rows = state.stdout.split(/\r?\n/).filter(Boolean);
        const ref = source("git", "当前 Git 工作树和最近 5 次提交");
        result.sources.push(ref);
        result.git = {
          sourceId: ref.id,
          branch: branch.stdout.trim(),
          changedFiles: rows.filter((s) => !s.startsWith("??")).length,
          untrackedFiles: rows.filter((s) => s.startsWith("??")).length,
          recentCommits: redact(log.stdout.slice(0, 6000)),
        };
      } catch {
        result.limitations.push(
          "未取得可核对的 Git 状态；不将未提交改动计为已交付",
        );
      }
    })(),
  ]);
  result.limitations.push(
    "这是有时间戳的只读进度快照；文档计划、原生回合结束、交付完成和本人验收必须分别判断。notLoaded 表示本连接未加载会话，并不证明运行已停止。",
  );
  return result;
}
