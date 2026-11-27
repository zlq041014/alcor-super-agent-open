import React from "react";
import {
  BookOpen,
  BrainCircuit,
  ChevronRight,
  FilePenLine,
  GitBranch,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Terminal,
  Wrench,
} from "lucide-react";
import type {
  AgentLine,
  Message,
  WorkFile,
  WorkStep,
} from "../shared/contracts";
import "./work-record.css";
const icons = {
  command: Terminal,
  file: FilePenLine,
  image: ImageIcon,
  read: BookOpen,
  model: BrainCircuit,
  delegate: GitBranch,
  tool: Wrench,
  summary: BrainCircuit,
  finding: MessageSquareText,
  plan: ListChecks,
};
const labels = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  unknown: "结果未确认",
  stopped: "已停止",
};
function at(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function commandPreview(command: string) {
  const wrapped =
    /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?["']?\s+(?:(?:-NoProfile|-NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(
      command,
    );
  if (wrapped) {
    let s = wrapped[1].trim();
    if ((s[0] === "'" || s[0] === '"') && s.at(-1) === s[0]) s = s.slice(1, -1);
    return s;
  }
  return command.replace(
    /^git --no-optional-locks -c core\.fsmonitor=false -c core\.hooksPath=NUL /,
    "git ",
  );
}
function counts(steps: WorkStep[]) {
  const counts = new Map<string, number>(),
    files = new Set<string>();
  const names: Record<string, string> = {
    command: "条命令",
    image: "项图像操作",
    read: "项读取",
    model: "次模型调用",
    delegate: "项委派",
    tool: "次工具调用",
    summary: "段公开摘要",
    plan: "份计划",
    finding: "项阶段结论",
  };
  for (const s of steps) {
    if (s.kind === "file") {
      for (const f of s.files || []) files.add(f.path);
      if (!s.files?.length)
        counts.set("项文件操作", (counts.get("项文件操作") || 0) + 1);
    } else {
      const name = names[s.kind];
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const parts = files.size ? [files.size + " 个文件"] : [];
  for (const [key, n] of counts) parts.push(n + " " + key);
  return parts;
}
function FileRow({
  file: f,
  state,
}: {
  file: WorkFile;
  state: WorkStep["state"];
}) {
  const verb =
    state === "running"
      ? "正在处理"
      : state === "failed"
        ? "修改未成功"
        : state === "stopped"
          ? "已停止"
          : state === "unknown"
            ? "待核对"
            : f.action === "版本变化"
              ? "已核对版本变化"
              : "已" + f.action;
  return (
    <details className="work-file">
      <summary>
        <FilePenLine size={14} />
        <span>
          {verb} <b title={f.path}>{f.path}</b>
        </span>
        {f.added !== undefined && <small className="added">+{f.added}</small>}
        {f.removed !== undefined && (
          <small className="removed">−{f.removed}</small>
        )}
        <ChevronRight className="work-chevron" size={12} />
      </summary>
      {f.patch ? (
        <pre className="work-patch">
          {f.patch.split("\n").map((l, i) => (
            <span
              key={i}
              className={
                l.startsWith("+") ? "plus" : l.startsWith("-") ? "minus" : ""
              }
            >
              {l || " "}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <p className="work-info">{f.note || "没有可展示的逐行补丁。"}</p>
      )}
    </details>
  );
}
export function WorkRecord({ steps }: { steps: WorkStep[] }) {
  if (!steps.length) return null;
  const parts = counts(steps),
    active = steps.some((x) => x.state === "running"),
    failed = steps.filter((x) => x.state === "failed").length;
  return (
    <details className="work-record">
      <summary className="work-heading" title={parts.join(" · ")}>
        {active ? (
          <LoaderCircle className="spin-work" size={15} />
        ) : (
          <ListChecks size={15} />
        )}
        <strong>{active ? "正在工作" : "工作记录"}</strong>
        <span className="work-glance">{parts.join(" · ")}</span>
        {failed > 0 && <small className="work-fail">{failed} 项失败</small>}
        <ChevronRight className="work-chevron" size={14} />
      </summary>
      <div className="work-tree">
        {steps.map((s) => {
          const Icon = icons[s.kind],
            status = s.state !== "done" ? labels[s.state] : null;
          if (s.kind === "file" && s.files?.length)
            return (
              <div key={s.id} className="work-file-list">
                {s.files.map((f, i) => (
                  <FileRow key={i} file={f} state={s.state} />
                ))}
              </div>
            );
          const summary =
            s.kind === "command"
              ? (s.state === "running"
                  ? "正在运行 "
                  : s.state === "failed"
                    ? "命令失败 "
                    : s.state === "unknown"
                      ? "命令状态待核对 "
                      : "已运行 ") + commandPreview(s.title)
              : (s.kind === "summary" || s.kind === "finding") && s.detail
                ? s.title +
                  " · " +
                  s.detail
                    .replace(/\*\*/g, "")
                    .replace(/\s+/g, " ")
                    .slice(0, 140)
                : s.title;
          return (
            <details
              key={s.id}
              className={"work-item kind-" + s.kind + " state-" + s.state}
            >
              <summary>
                <Icon size={14} />
                <span title={summary}>{summary}</span>
                {status && <small>{status}</small>}
                <ChevronRight className="work-chevron" size={12} />
              </summary>
              <div className="work-info">
                <small>
                  {at(s.at)} · {labels[s.state]}
                  {s.durationMs != null
                    ? " · " + (s.durationMs / 1000).toFixed(1) + " 秒"
                    : ""}
                  {s.exitCode != null ? " · 退出码 " + s.exitCode : ""}
                </small>
                {s.kind === "command" && (
                  <pre className="work-command">{s.title}</pre>
                )}
                {s.detail ? (
                  <pre>{s.detail}</pre>
                ) : (
                  <p>
                    {s.kind === "command"
                      ? active && s.state === "running"
                        ? "等待命令输出。"
                        : "没有记录标准输出。"
                      : "没有更多可展示的内容。"}
                  </p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}
function fromLine(l: AgentLine): WorkStep | undefined {
  if (l.work) return l.work;
  if (l.kind === "summary" || l.kind === "plan")
    return {
      id: l.id,
      at: l.createdAt,
      kind: l.kind,
      title: l.label,
      state: "done",
      detail: l.text,
    };
  if (l.kind !== "tool") return;
  const first = l.text.split("\n")[0];
  let kind: WorkStep["kind"] = l.label.includes("命令")
    ? "command"
    : l.label.includes("文件")
      ? "file"
      : /图片|图像/.test(l.label)
        ? "image"
        : "tool";
  return {
    id: l.id,
    at: l.createdAt,
    kind,
    title: kind === "command" ? first : l.label,
    state: l.label.startsWith("失败")
      ? "failed"
      : l.label.startsWith("进行中")
        ? "unknown"
        : "done",
    detail:
      kind === "command" ? l.text.split("\n").slice(1).join("\n") : l.text,
    files:
      kind === "file"
        ? l.text
            .split("\n")
            .filter(Boolean)
            .map((path) => ({
              path,
              action: "版本变化",
              note: "旧版记录未保留逐行补丁。",
            }))
        : undefined,
  };
}
export function groupedLines(lines: AgentLine[]) {
  const groups: (
    | { type: "message"; line: AgentLine }
    | { type: "work"; key: string; scope: string; steps: WorkStep[] }
  )[] = [];
  for (const l of lines) {
    const w = fromLine(l);
    if (!w) {
      groups.push({ type: "message", line: l });
      continue;
    }
    const scope = l.groupId || l.runId || l.agentId,
      last = groups.at(-1);
    if (last?.type === "work" && last.scope === scope) last.steps.push(w);
    else groups.push({ type: "work", key: l.id, scope, steps: [w] });
  }
  return groups;
}
export function messageWork(m: Message): WorkStep[] {
  if (m.work?.length) return m.work;
  const steps: WorkStep[] = (m.steps || []).map((title, i) => ({
    id: m.id + ":" + i,
    title,
    at: m.createdAt,
    kind: "tool",
    state:
      m.status === "pending" || m.status === "interrupted" ? "unknown" : "done",
    detail: "旧版记录只保留了这个步骤名称。",
  }));
  if (m.publicSummary)
    steps.push({
      id: m.id + ":summary",
      title: "公开思路摘要",
      at: m.createdAt,
      kind: "summary",
      state: "done",
      detail: m.publicSummary,
    });
  for (const source of m.workRequestId ? [] : m.sources || [])
    steps.push({
      id: "source:" + source.id,
      at: source.fetchedAt,
      kind: "read",
      title: source.title,
      state: "done",
      detail: source.complete
        ? "旧版查证保存的资料来源。"
        : "旧版查证保存的部分资料；未保留更细的操作过程。",
    });
  return steps;
}
