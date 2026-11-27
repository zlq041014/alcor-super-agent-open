import {
  type Agent,
  type AgentLine,
  type Run,
  type Task,
  type WorkStep,
  type WorkFile,
  CHIEF,
} from "../shared/contracts";
import { entity, stamp, Store } from "./store";
import { redact } from "./security";
import { nativeStep, verifiedFiles, describeFiles } from "./native-work";

export const workerId = (id: string) => "exec:" + id;
export function assigned(store: Store, t: Task, parent = CHIEF): Agent {
  const id = workerId(t.id);
  const old = store.get<Agent>("agent", id);
  if (old) return old;
  return store.put("agent", {
    id,
    kind: "executor",
    parentAgentId: parent,
    projectId: t.projectId,
    title: t.title,
    taskId: t.id,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });
}
export function line(
  store: Store,
  agentId: string,
  kind: AgentLine["kind"],
  label: string,
  text: string,
  extra: Partial<AgentLine> = {},
): AgentLine {
  return store.put("agent-line", {
    ...entity(),
    agentId,
    kind,
    ...extra,
    label: redact(label).slice(0, 200),
    text: redact(text).slice(0, 50000),
  });
}
// SQLite rowid is the arrival order, even when two items share a millisecond or a streaming item is updated.
export function pageLines(
  store: Store,
  agentId: string,
  before?: string,
  limit = 120,
) {
  const rows = store.db
    .prepare(
      "SELECT data FROM records WHERE kind='agent-line' AND json_extract(data,'$.agentId')=? AND rowid < COALESCE((SELECT rowid FROM records WHERE kind='agent-line' AND id=?),9223372036854775807) ORDER BY rowid DESC LIMIT ?",
    )
    .all(agentId, before || "", limit + 1);
  return {
    more: rows.length > limit,
    lines: rows
      .slice(0, limit)
      .reverse()
      .map((r) => JSON.parse(String(r.data)) as AgentLine),
  };
}
// 0.1.0–0.1.2 stored some evidence outside the timeline. Project it when reading;
// never invent a command, timestamp, diff or model summary, or re-run the work.
export function historicalPage(
  store: Store,
  agent: Agent,
  before?: string,
  limit = 120,
) {
  if (!agent.taskId) return pageLines(store, agent.id, before, limit);
  const records = (q: string, ...p: string[]) =>
    store.db
      .prepare(q)
      .all(...p)
      .map((r) => JSON.parse(String(r.data)));
  const runs = records(
    "SELECT data FROM records WHERE kind='run' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.workRecordVersion') IS NULL",
    agent.taskId,
  ) as Run[];
  if (!runs.length) return pageLines(store, agent.id, before, limit);
  const lines = records(
    "SELECT data FROM records WHERE kind='agent-line' AND json_extract(data,'$.agentId')=? ORDER BY rowid",
    agent.id,
  ) as AgentLine[];
  for (const r of runs) {
    const existing = lines.filter((l) => l.runId === r.id),
      seen = new Set<string>();
    let commands = 0;
    for (const l of existing) {
      if (l.kind === "tool" && l.label.includes("命令")) commands++;
      if (
        !l.work &&
        l.kind === "tool" &&
        l.label.includes("文件") &&
        l.id.startsWith(r.id + ":")
      ) {
        const preserved = store.get("native-item", l.id.slice(r.id.length + 1));
        const files =
          preserved?.runId === r.id
            ? describeFiles(preserved.changes, r.workPath)
            : [];
        if (files.length)
          l.work = {
            id: l.id,
            at: l.createdAt,
            title: "旧版文件记录",
            kind: "file",
            state: l.label.includes("失败")
              ? "failed"
              : l.label.includes("已结束")
                ? "done"
                : "unknown",
            files,
          };
        else
          for (const path of l.text.split("\n").filter(Boolean))
            seen.add(path.replaceAll("\\", "/"));
      }
      for (const f of l.work?.files || []) seen.add(f.path);
    }
    const push = (w: WorkStep) =>
      lines.push({
        id: w.id,
        createdAt: w.at,
        updatedAt: w.at,
        agentId: agent.id,
        groupId: r.id,
        runId: r.id,
        kind: "tool",
        label: w.title,
        text: w.detail || "",
        work: w,
      });
    if (commands === 0) {
      for (const ev of records(
        "SELECT data FROM records WHERE kind='evidence' AND json_extract(data,'$.runId')=? ORDER BY rowid",
        r.id,
      )) {
        if (ev.kind !== "command") continue;
        push({
          id: "history-cmd:" + ev.id,
          at: ev.createdAt || r.startedAt,
          kind: "command",
          title: redact(String(ev.command || "历史命令")).slice(0, 4500),
          detail: redact(String(ev.output || "")).slice(0, 36000),
          exitCode: ev.exitCode,
          state:
            typeof ev.exitCode !== "number"
              ? "unknown"
              : ev.exitCode
                ? "failed"
                : "done",
        });
      }
    }
    const check = store.get("file-check", r.id);
    const files = verifiedFiles(
      r.workPath,
      check?.changed || [],
      check?.deleted || [],
      r.diff || "",
    ).filter((f) => !seen.has(f.path));
    if (files.length)
      push({
        id: "history-file:" + r.id,
        at: r.endedAt || r.updatedAt,
        kind: "file",
        title: "历史文件版本核对",
        state: "done",
        files,
      });
    if (r.response && !existing.some((l) => l.kind === "assistant"))
      lines.push({
        id: "history-reply:" + r.id,
        createdAt: r.endedAt || r.updatedAt,
        updatedAt: r.updatedAt,
        agentId: agent.id,
        runId: r.id,
        kind: "assistant",
        label: "执行回复",
        text: redact(r.response),
      });
  }
  lines.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const end = before ? lines.findIndex((x) => x.id === before) : lines.length;
  if (end < 0) return { more: false, lines: [] };
  return {
    more: end > limit,
    lines: lines.slice(Math.max(0, end - limit), end),
  };
}
export function rememberNative(store: Store, run: Run, method: string, p: any) {
  const agent = store.get<Agent>("agent", workerId(run.taskId));
  if (!agent) return;
  const item = p.item || {},
    iid = p.itemId || item.id;
  const put = (
    key: string,
    kind: AgentLine["kind"],
    label: string,
    text: string,
    append = false,
    work?: Omit<WorkStep, "id" | "at">,
    phase?: AgentLine["phase"],
  ) => {
    const id = run.id + ":" + key,
      old = store.get<AgentLine>("agent-line", id);
    if (work?.state === "running" && old?.work && old.work.state !== "running")
      return;
    const value = redact((append ? old?.text || "" : "") + text).slice(
      0,
      50000,
    );
    line(store, agent.id, kind, label, value, {
      id,
      runId: run.id,
      createdAt: old?.createdAt || stamp(),
      updatedAt: stamp(),
      phase: phase || old?.phase,
      groupId: run.id,
      ...(work ? { work: { ...work, id, at: old?.createdAt || stamp() } } : {}),
    });
    const activity =
      kind === "tool" && label.startsWith("进行中")
        ? label + " · " + value.split("\n")[0].slice(0, 70)
        : label;
    if (agent.activity !== activity)
      store.put("agent", { ...agent, activity, updatedAt: stamp() });
  };
  if (method === "turn/plan/updated") {
    const steps = Array.isArray(p.plan)
      ? p.plan
          .map(
            (s: any) =>
              (({ completed: "✓", inProgress: "▶", pending: "·" })[
                String(s.status)
              ] || "·") +
              " " +
              String(s.step || ""),
          )
          .join("\n")
      : "";
    if (steps) put("plan", "plan", "执行计划", steps);
    return;
  }
  if (!iid) return;
  if (
    method === "item/commandExecution/outputDelta" &&
    typeof p.delta === "string"
  ) {
    const id = run.id + ":" + iid,
      old = store.get<AgentLine>("agent-line", id);
    if (old?.work?.kind === "command" && old.work.state === "running") {
      const data = redact((old.work.detail || "") + p.delta).slice(0, 36000);
      store.put("agent-line", {
        ...old,
        work: { ...old.work, detail: data },
        updatedAt: stamp(),
      });
    }
    return;
  }
  if (method === "item/fileChange/patchUpdated") {
    const w = nativeStep(
      { type: "fileChange", changes: p.changes },
      run.workPath,
      false,
    )!;
    put(iid, "tool", "进行中 · 文件修改", "", false, w);
    return;
  }
  if (method === "item/agentMessage/delta" && typeof p.delta === "string")
    put(iid, "assistant", "执行 Agent", p.delta, true);
  if (
    method === "item/reasoning/summaryTextDelta" &&
    typeof p.delta === "string"
  )
    put(
      iid + ":summary:" + Number(p.summaryIndex || 0),
      "summary",
      "公开思路摘要",
      p.delta,
      true,
    );
  if (method === "item/plan/delta" && typeof p.delta === "string")
    put(iid, "plan", "执行计划", p.delta, true);
  if (method !== "item/started" && method !== "item/completed") return;
  const end = method === "item/completed";
  if (item.type === "reasoning") {
    if (end && Array.isArray(item.summary))
      item.summary.forEach((s: unknown, i: number) => {
        if (typeof s === "string" && s.trim())
          put(iid + ":summary:" + i, "summary", "公开思路摘要", s);
      });
    return; // Native raw reasoning and encrypted content are never read.
  }
  if (item.type === "agentMessage" || item.type === "plan") {
    if (end && typeof item.text === "string" && item.text)
      put(
        iid,
        item.type === "plan" ? "plan" : "assistant",
        item.type === "plan" ? "执行计划" : "执行 Agent",
        item.text,
        false,
        undefined,
        item.phase === "commentary"
          ? "commentary"
          : item.phase === "final_answer"
            ? "final_answer"
            : undefined,
      );
    return;
  }
  const names: Record<string, string> = {
    commandExecution: "命令",
    fileChange: "文件修改",
    mcpToolCall: "工具调用",
    dynamicToolCall: "工具调用",
    webSearch: "搜索",
    imageView: "查看图片",
    imageGeneration: "生成图片",
    collabAgentToolCall: "Agent 协作",
    contextCompaction: "整理上下文",
  };
  if (!names[item.type]) return;
  const w = nativeStep(item, run.workPath, end);
  if (w) {
    const old = store.get<AgentLine>("agent-line", run.id + ":" + iid)?.work;
    if (w.kind === "file" && !w.files?.length && old?.files)
      w.files = old.files;
    if (w.kind === "command" && !w.detail && old?.detail) w.detail = old.detail;
    put(
      iid,
      "tool",
      (w.state === "running"
        ? "进行中 · "
        : w.state === "failed"
          ? "失败 · "
          : w.state === "stopped"
            ? "已停止 · "
            : "已结束 · ") + names[item.type],
      w.kind === "command" ? w.title : w.title,
      false,
      w,
    );
    return;
  }
}
export function sealWork(
  store: Store,
  run: Run,
  changed: string[],
  deleted: string[],
  journalFiles: WorkFile[] = [],
) {
  const all = store.db
    .prepare(
      "SELECT data FROM records WHERE kind='agent-line' AND json_extract(data,'$.runId')=?",
    )
    .all(run.id)
    .map((r) => JSON.parse(String(r.data)) as AgentLine);
  const seen = new Set<string>();
  for (const l of all) {
    const w = l.work;
    if (w?.kind === "file") for (const f of w.files || []) seen.add(f.path);
    if (w?.state === "running")
      store.put("agent-line", {
        ...l,
        work: {
          ...w,
          state: run.outcome === "interrupted" ? "stopped" : "unknown",
        },
      });
  }
  const known = new Set(
    journalFiles.map((f) => f.path.replaceAll("\\", "/").toLowerCase()),
  );
  const files = [
    ...journalFiles,
    ...verifiedFiles(run.workPath, changed, deleted, run.diff).filter(
      (f) =>
        !seen.has(f.path) &&
        !known.has(f.path.replaceAll("\\", "/").toLowerCase()),
    ),
  ];
  if (files.length) {
    const at = stamp(),
      id = "verified:" + run.id;
    line(store, workerId(run.taskId), "tool", "执行后文件核对", "", {
      id,
      groupId: run.id,
      runId: run.id,
      work: {
        id,
        at,
        kind: "file",
        title: "执行后文件核对",
        state: "done",
        files,
      },
    });
  }
}
