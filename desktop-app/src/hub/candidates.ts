import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { openDsh } from "../adapter/dsh";
import { workspaceMcp, type JournalSink } from "../adapter/dsh-files";
import { fileDiff } from "../core/diff";
import type { Task } from "../shared/contracts";
import type { Candidate, Criterion, Loop, LoopStep } from "../shared/loop-contracts";
import { pathKey } from "../core/glob";
import { type CandidateEdit, writableCandidatePath } from "./candidate-workspace";
import { redact } from "./security";
import type { Hub } from "./service";

type Approach = { title: string; plan: string };
export class CandidateWriter {
  constructor(private hub: Hub) {}
  async write(loop: Loop, task: Task, criterion: Criterion, candidate: Candidate, work: string,
    approach: Approach, signal: AbortSignal, rejected: (path: string, reason: string) => void) {
    const touched = new Map<string, string>();
    const cfg = this.hub.settings();
    const guard = (name: string) => {
      try { writableCandidatePath(name); }
      catch (error) { rejected(name, (error as Error).message); throw error; }
    };
    const session = await openDsh({
      dir: join(dirname(work), "dsh-" + candidate.id), cwd: work, cfg,
      profile: loop.roster.executor, key: await this.hub.brain.key(cfg), write: true,
      paths: { protect: loop.protectedPaths, lockPackageScripts: true },
      journal: {
        rejected,
        ensureActive: () => signal.throwIfAborted(),
        before: async (name) => {
          guard(name);
          touched.set(pathKey(name), name);
        },
        directory: guard,
      },
    });
    const close = () => session.close();
    signal.addEventListener("abort", close, { once: true });
    try {
      signal.throwIfAborted();
      const result = await session.prompt(redact(JSON.stringify({
        goal: task.goal, constraints: task.constraints,
        criterion: criterion.input, failure: criterion.failure?.detail, approach,
        rules: this.hub.rules(task.projectId).map((r) => r.text),
        instructions: "只用提供的文件工具处理当前条目。用给定思路独立完成，保留现有检查和依赖，不执行命令，不整合到原项目。",
      })), () => undefined);
      return { ...result, threadId: session.id, touched: new Set(touched.values()) };
    } finally {
      signal.removeEventListener("abort", close);
      close();
    }
  }
}

export function candidateDiff(edits: CandidateEdit[]) {
  const patches = edits.flatMap((edit) => fileDiff(edit.name, edit.before?.toString("utf8") ?? null, edit.after.toString("utf8")) ?? []);
  return {
    diff: patches.map((patch) => patch.patch).join("\n"),
    changedLines: patches.reduce((n, patch) => n + (patch.added ?? 0) + (patch.removed ?? 0), 0),
  };
}

export async function selectCandidate(hub: Hub, loop: Loop, step: LoopStep, options: Candidate[], signal: AbortSignal) {
  const ordered = [...options].sort((a, b) => a.changedLines! - b.changedLines!);
  if (ordered.length < 2 || ordered[0].changedLines !== ordered[1].changedLines) return ordered[0];
  const tied = ordered.filter((c) => c.changedLines === ordered[0].changedLines);
  const result = await hub.roles.call({
    loopId: loop.id, revision: loop.contractRevision, stepId: step.id,
    role: "verifier", purpose: "compare-candidates", promptVersion: 1,
    instructions: "两个或更多候选已通过同一套检查，改动行数相同。只比较实际差异，优先选使用路径完整、维护更简单的结果。只返回 {\"candidateId\":\"给出的标识\"}。",
    schema: z.object({ candidateId: z.string().refine((id) => tied.some((c) => c.id === id)) }).strict(),
    input: { options: tied.map((c) => ({ id: c.id, approach: c.approach })) },
    materials: tied.map((c) => ({ id: c.id, title: c.approach, kind: "diff", content: c.diff!.slice(0, 4000), sourceVersion: c.id })),
    timeoutMs: 120000, maxOutputTokens: 1600, signal,
  });
  return result.status === "completed" ? tied.find((c) => c.id === result.data.candidateId)! : tied[0];
}

export async function applyCandidateEdits(
  root: string, edits: CandidateEdit[], protect: string[], sink: JournalSink,
) {
  const expected = new Map(edits.map((edit) => [pathKey(edit.name), edit.before]));
  const tool = workspaceMcp(root, {
    write: true, paths: { protect, lockPackageScripts: true },
    journal: {
      ...sink,
      before: async (name, bytes) => {
        const initial = expected.get(pathKey(name));
        if (initial ? !bytes?.equals(initial) : bytes !== null)
          throw new Error("整合中原文件有新变化：" + name);
        await sink.before!(name, bytes);
      },
    },
  });
  const call = async (name: string, args: object) => {
    const response = await tool({ jsonrpc: "2.0", id: "candidate", method: "tools/call", params: { name, arguments: args } });
    if (!("result" in response) || !("isError" in response.result) || response.result.isError)
      throw new Error("候选整合文件工具拒绝写入" + ("path" in args ? "：" + String(args.path) : ""));
  };
  const ensureDir = async (path: string): Promise<void> => {
    if (path === ".") return;
    const existing = await lstat(join(root, path)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return undefined;
    });
    if (existing) return;
    await ensureDir(dirname(path));
    await call("create_directory", { path });
  };
  for (const edit of edits) {
    sink.ensureActive!();
    await ensureDir(dirname(edit.name));
    if (edit.before) await call("edit_file", { path: edit.name, old_text: edit.before.toString("utf8"), new_text: edit.after.toString("utf8") });
    else await call("write_file", { path: edit.name, text: edit.after.toString("utf8") });
  }
}
