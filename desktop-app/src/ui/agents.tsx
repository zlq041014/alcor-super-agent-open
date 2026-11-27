import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  GitBranch,
  MessagesSquare,
  Plus,
  Sparkles,
  Terminal,
  Workflow,
} from "lucide-react";
import {
  CHIEF,
  stateLabels,
  type Agent,
  type AgentLine,
  type Snapshot,
} from "../shared/contracts";
import "./agents.css";
import { defaultProfile } from "../shared/contracts";
import { effortName } from "./model-profile";
import { WorkRecord, groupedLines } from "./work-record";
import { outgoing, useOutgoing, useSending, withEchoes } from "./outgoing";

const clock = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const request = (v: any) => window.alcor.request(v);
export const roleLabels: Record<string, string> = {
  executor: "执行者",
  planner: "清单规划",
  critic: "清单审查",
  "check-author": "检查编写",
  verifier: "独立验证",
  reviewer: "视角评审",
  triager: "分诊",
  refuter: "反驳",
  ranker: "排序",
  diagnoser: "诊断",
  advisor: "顾问",
};
const roleStates: Record<string, string> = {
  calling: "进行中",
  completed: "已结束",
  failed: "失败",
  invalid: "结果无效",
  cancelled: "已取消",
  unknown: "状态待核对",
};
export function stateOf(a: Agent, s: Snapshot) {
  if (a.kind === "discussion")
    return {
      state: a.activity === "正在整理讨论回复" ? "active" : "idle",
      label: a.activity || "等待讨论",
      action: a.title,
    };
  const t = s.tasks.find((t) => t.id === a.taskId),
    r = s.runs.find((r) => r.id === t?.runId);
  if (!t) return { state: "idle", label: "无执行记录", action: a.title };
  const label =
    r?.state === "unknown"
      ? "状态待核对"
      : r?.state === "waiting_input"
        ? "等你回复"
        : r?.state === "waiting_approval"
          ? "等你审批"
          : stateLabels[t.state];
  return {
    state:
      t.state === "active" && r?.state === "running"
        ? "active"
        : ["blocked", "verifying"].includes(t.state) ||
            r?.state.startsWith("waiting")
          ? "attention"
          : "idle",
    label,
    action:
      t.state === "active" && r?.state === "running"
        ? a.activity || "正在执行"
        : t.reason || a.title,
  };
}
export function AgentTree({
  s,
  selected,
  onOpen,
  onNew,
}: {
  s: Snapshot;
  selected?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setClosed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const members = s.agents.filter((a) =>
    s.projects.some((p) => p.id === a.projectId && !p.removed),
  );
  const keep = new Set<string>(),
    byId = new Map(members.map((a) => [a.id, a]));
  for (const a of members) {
    if (s.tasks.find((t) => t.id === a.taskId)?.archived) continue;
    let ancestor: Agent | undefined = a;
    while (ancestor && !keep.has(ancestor.id)) {
      keep.add(ancestor.id);
      ancestor = byId.get(ancestor.parentAgentId);
    }
  }
  const visible = members
    .filter((a) => keep.has(a.id))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  function node(a: Agent | undefined, visited: Set<string>): ReactNode {
    const id = a?.id || CHIEF;
    if (visited.has(id)) return null;
    const path = new Set(visited).add(id);
    const children = visible.filter((x) => x.parentAgentId === id);
    const task = a?.taskId
      ? s.tasks.find((item) => item.id === a.taskId)
      : undefined;
    const roles = new Map<string, any[]>();
    if (task?.loopId)
      for (const call of s.invocations) {
        if (call.loopId !== task.loopId || !roleLabels[call.role]) continue;
        const rows = roles.get(call.role);
        if (rows) rows.push(call);
        else roles.set(call.role, [call]);
      }
    const chosen = (selected || CHIEF) === id,
      name = a
        ? a.kind === "discussion"
          ? "讨论 Agent"
          : "执行 Agent"
        : "星引总管";
    const p = a && s.projects.find((p) => p.id === a.projectId),
      info = a && stateOf(a, s);
    const Icon = !a
      ? Sparkles
      : a.kind === "discussion"
        ? MessagesSquare
        : Terminal;
    return (
      <li key={id}>
        <div className={"tree-row" + (chosen ? " chosen" : "")}>
          {children.length || roles.size ? (
            <button
              className="tree-toggle"
              aria-label={(closed.has(id) ? "展开" : "收起") + name + "分支"}
              aria-expanded={!closed.has(id)}
              onClick={() => toggle(id)}
            >
              {closed.has(id) ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          ) : (
            <i className="tree-spacer" />
          )}
          <button
            className="tree-node"
            aria-current={chosen ? "page" : undefined}
            onClick={() => onOpen(id)}
          >
            <span className={"agent-icon " + (!a ? "chief" : a.kind)}>
              <Icon size={16} />
            </span>
            <span className="tree-copy">
              <strong title={a?.title}>{a?.title || name}</strong>
              {a && (
                <small>
                  {p?.name} · {name}
                </small>
              )}
              {!a && <small>跨项目主对话</small>}
              {info && (
                <em className={"agent-state " + info.state} title={info.action}>
                  {info.label}
                  {info.state === "active" && a?.kind === "executor"
                    ? " · " + info.action
                    : ""}
                </em>
              )}
            </span>
          </button>
        </div>
        {(children.length > 0 || roles.size > 0) && !closed.has(id) && (
          <ul>
            {children.map((c) => node(c, path))}
            {[...roles].map(([name, rows]) => (
              <li key={"role:" + name}>
                <details className="tree-role">
                  <summary>
                    {roleLabels[name]} · {rows.length} 次
                  </summary>
                  <ul>
                    {rows
                      .slice()
                      .reverse()
                      .map((row) => (
                        <li key={row.id}>
                          <span>{roleStates[row.status] || "已记录"}</span>
                          {row.profile?.model && (
                            <small> · {row.profile.model}</small>
                          )}
                          <small> · {clock(row.createdAt)}</small>
                          {row.error && <div>{row.error}</div>}
                        </li>
                      ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }
  useEffect(() => {
    if (!selected) return;
    setClosed((old) => {
      const next = new Set(old),
        seen = new Set<string>();
      let id: string | undefined = selected;
      while (id && !seen.has(id)) {
        seen.add(id);
        id = s.agents.find((a) => a.id === id)?.parentAgentId;
        if (id) next.delete(id);
      }
      return next;
    });
  }, [selected]);
  return (
    <aside className="activity-panel agent-tree" aria-label="Agent 委派树">
      <div className="panel-heading">
        <h2>
          <GitBranch size={17} />
          Agent 树
        </h2>
        <span className="tree-count">已委派 {visible.length} 位</span>
      </div>
      <div className="tree-scroll">
        <ul className="tree-root">{node(undefined, new Set())}</ul>
        {!visible.length && (
          <div className="tree-empty">
            <Workflow size={24} />
            <strong>还没有委派的 Agent</strong>
            <p>
              在总管对话里说「和某项目开一场讨论」，讨论和执行成员会出现在这里。
            </p>
          </div>
        )}
      </div>
      <button className="tree-new" onClick={onNew}>
        <Plus size={15} />
        新建项目讨论
      </button>
    </aside>
  );
}

const draftCache = new Map<string, string>(),
  scrollCache = new Map<string, { top: number; pinned: boolean }>();
const statusLabels = {
  sending: "正在发送",
  sent: "已接收",
  failed: "未送达",
  unknown: "送达未知",
  queued: "已排队",
  held: "未发送",
};
type WorkspaceProps = {
  onLaunch: (id: string) => void;
  onProfile: () => void;
  a: Agent;
  s: Snapshot;
  onOpen: (id: string) => void;
  notify: (t: string) => void;
  details?: ReactNode;
  approvals?: ReactNode;
  rich: (t: string) => ReactNode;
  onDelegate?: () => void;
};
export function AgentWorkspace({
  onLaunch,
  onProfile,
  a,
  s,
  onOpen,
  notify,
  details,
  approvals,
  rich,
  onDelegate,
}: WorkspaceProps) {
  const [rows, setRows] = useState<AgentLine[]>([]),
    [older, setOlder] = useState<AgentLine[]>([]),
    [more, setMore] = useState(false),
    [olderDone, setOlderDone] = useState(false);
  const [draft, setDraft] = useState(draftCache.get(a.id) || ""),
    [ready, setReady] = useState(false),
    [tab, setTab] = useState("chat"),
    [queue, setQueue] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    dirty = useRef(draftCache.has(a.id)),
    init = useRef(false),
    requestedView = useRef(0),
    appliedView = useRef(0);
  const scope = "agent:" + a.id,
    echoes = useOutgoing(scope),
    busy = useSending(scope);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    active = useRef(true),
    position = useRef(scrollCache.get(a.id) || { top: 0, pinned: true });
  const t = s.tasks.find((t) => t.id === a.taskId),
    r = s.runs.find((r) => r.id === t?.runId),
    p = s.projects.find((p) => p.id === a.projectId);
  const live = !!r && r.state !== "ended" && r.state !== "unknown",
    state = stateOf(a, s),
    discussion = a.kind === "discussion";
  const who = discussion ? "讨论 Agent" : "执行 Agent";
  const chosen = a.profile || defaultProfile(s.settings),
    differentRun =
      live &&
      r?.profile &&
      (r.profile.model !== chosen.model || r.profile.effort !== chosen.effort);
  const loop = t?.loopId
    ? s.loops.find((item) => item.id === t.loopId)
    : undefined;
  const disabledReason = loop
    ? loop.step?.criterionId &&
      loop.phase === "advancing" &&
      !t?.archived &&
      t?.state !== "cancelled" &&
      !t?.control?.endsWith("_requested")
      ? ""
      : "当前没有可补充的执行条目，可在工作详情查看清单"
    : discussion
      ? a.activity === "正在整理讨论回复"
        ? "讨论 Agent 正在回复"
        : ""
      : !r
        ? "等执行者就绪后即可发送"
        : r.state === "unknown"
          ? "请先在工作详情核对原生状态"
          : t?.archived || t?.state === "cancelled"
            ? "这项工作已结束并关闭"
            : t?.revision !== r.revision || t?.control?.endsWith("_requested")
              ? "要求已更新或正在停止，请先核对工作详情"
              : r.state === "starting" || (live && !r.turnId)
                ? "正在连接执行者"
                : live && r.state !== "running" && !queue
                  ? "请先处理上方请求，或将消息排到下一轮"
                  : r.state === "ended" &&
                      (t?.attempt || 0) >= s.settings.maxRuns
                    ? "已到运行次数上限，请先调整额度"
                    : "";
  const save = (value: string) =>
    request({ op: "agent.draft", agentId: a.id, text: value }).catch(() => {});
  const update = (v: string) => {
    dirty.current = true;
    draftCache.set(a.id, v);
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(v), 180);
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
      if (dirty.current) void save(draftCache.get(a.id) || "");
      scrollCache.set(a.id, position.current);
    };
  }, [a.id]);
  function readView() {
    const n = ++requestedView.current;
    return request({ op: "agent.view", agentId: a.id })
      .then((v) => {
        if (!active.current || n < appliedView.current) return;
        appliedView.current = n;
        setRows(v.lines);
        setMore(v.more);
        if (!init.current) {
          if (!dirty.current) {
            setDraft(v.draft);
            draftCache.set(a.id, v.draft);
          }
          init.current = true;
        }
        setReady(true);
      })
      .catch((e) => {
        if (active.current) notify(e.message);
      });
  }
  useEffect(() => {
    void readView();
  }, [a.id, s]);
  useEffect(() => {
    outgoing.reconcile(
      scope,
      rows
        .filter((l) => l.kind === "user" && l.id.startsWith("user:"))
        .map((l) => l.id.slice(5)),
    );
  }, [scope, rows]);
  useLayoutEffect(() => {
    if (!ready || tab !== "chat" || !scroll.current) return;
    const el = scroll.current;
    if (position.current.pinned) el.scrollTop = el.scrollHeight;
    else el.scrollTop = position.current.top;
  }, [rows, echoes, ready, tab]);
  async function submit(value?: string, mode = queue ? "queue" : "now") {
    if (live && r?.backend === "dsh") mode = "queue";
    const typed = value === undefined,
      v = (value ?? draftCache.get(a.id) ?? draft).trim();
    if (!v || outgoing.busy(scope) || !ready || disabledReason) return;
    const echo = outgoing.begin(
      scope,
      v,
      discussion
        ? "你"
        : mode === "queue"
          ? "下一轮"
          : live
            ? "本轮补充"
            : "继续对话",
    );
    if (typed) {
      clearTimeout(timer.current);
      dirty.current = false;
      draftCache.set(a.id, "");
      setDraft("");
    }
    position.current.pinned = true;
    input.current?.focus();
    try {
      const result = await request({
        op: "agent.send",
        agentId: a.id,
        text: v,
        requestId: echo.id,
        mode,
        preserveDraft: !typed,
        ...(t ? { revision: t.revision, runId: r?.id, turnId: r?.turnId } : {}),
      });
      if (result.saved) outgoing.update(scope, echo.id, { state: "accepted" });
      else outgoing.reject(scope, echo.id, result.error || "消息未发送");
      if (result.error) notify(result.error);
      if (result.launchId) onLaunch(result.launchId);
    } catch (e) {
      outgoing.reject(scope, echo.id, e);
      notify((e as Error).message);
    } finally {
      outgoing.finish(scope, echo.id);
      if (active.current) void readView();
    }
  }
  async function loadEarlier() {
    const first = older[0] || rows[0];
    if (!first) return;
    const el = scroll.current,
      height = el?.scrollHeight || 0,
      top = el?.scrollTop || 0;
    try {
      const v = await request({
        op: "agent.view",
        agentId: a.id,
        before: first.id,
      });
      setOlder((prev) => [...v.lines, ...prev]);
      setOlderDone(!v.more);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = top + el.scrollHeight - height;
      });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const all = withEchoes<AgentLine>(
    [...new Map([...older, ...rows].map((x) => [x.id, x])).values()],
    echoes,
    (e) => ({
      id: "user:" + e.id,
      agentId: a.id,
      createdAt: e.at,
      updatedAt: e.at,
      kind: "user",
      label: e.label,
      text: e.text,
      status: e.state === "accepted" ? undefined : e.state,
      deliveryError: e.detail,
    }),
  );
  const keepReading = (target: EventTarget | null) => {
    if (
      target instanceof Element &&
      target.closest(".work-record summary") &&
      scroll.current
    )
      position.current = { top: scroll.current.scrollTop, pinned: false };
  };
  return (
    <section className="agent-workspace">
      <header className="agent-header">
        <button className="agent-back" onClick={() => onOpen(CHIEF)}>
          <ArrowLeft size={15} />
          回到总管
        </button>
        <div className="agent-headline">
          <div>
            <small>
              {p?.name} / {who}
            </small>
            <h2>{a.title}</h2>
          </div>
          <span className={"agent-state " + state.state}>{state.label}</span>
        </div>
        <div className="agent-tabs">
          <button aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
            <MessagesSquare size={14} /> 对话与过程
          </button>
          {details && (
            <button
              aria-pressed={tab === "details"}
              onClick={() => setTab("details")}
            >
              <BookOpen size={14} /> 工作详情与操作
            </button>
          )}
          {onDelegate && (
            <button onClick={onDelegate}>
              <CornerDownRight size={14} /> 委派子 Agent
            </button>
          )}
        </div>
      </header>
      {tab === "details" ? (
        <div className="agent-details">{details}</div>
      ) : (
        <>
          <div
            className="agent-stream"
            ref={scroll}
            onPointerDownCapture={(e) => keepReading(e.target)}
            onKeyDownCapture={(e) => {
              if (e.key === "Enter" || e.key === " ") keepReading(e.target);
            }}
            onScroll={() => {
              const el = scroll.current;
              if (el)
                position.current = {
                  top: el.scrollTop,
                  pinned: el.scrollHeight - el.clientHeight - el.scrollTop < 48,
                };
            }}
          >
            <div className="conversation-lane">
              {more && !olderDone && (
                <button
                  className="older-lines"
                  onClick={() => void loadEarlier()}
                >
                  查看更早记录
                </button>
              )}
              {(!ready || !all.length) && (
                <div className="thread-intro">
                  <span className="agent-icon discussion">
                    {discussion ? (
                      <MessagesSquare size={20} />
                    ) : (
                      <Terminal size={20} />
                    )}
                  </span>
                  <h3>
                    {!ready
                      ? "正在读取对话…"
                      : discussion
                        ? "从这个项目的需求聊起"
                        : "等待执行记录"}
                  </h3>
                  <p>
                    {discussion
                      ? "这段讨论会保留。方案定下后，说「按这个方案做」即可交给执行 Agent。"
                      : "执行者公开的摘要、工具调用和回复会按发生顺序显示。"}
                  </p>
                </div>
              )}
              {groupedLines(all).map((group) => {
                if (group.type === "work")
                  return (
                    <div className="work-section" key={group.key}>
                      <WorkRecord steps={group.steps} />
                    </div>
                  );
                const l = group.line;
                const label =
                  l.kind === "user"
                    ? l.label.replace(/(?:^| · )(?:你|用户)$/, "")
                    : l.phase === "commentary"
                      ? "阶段进展"
                      : l.label;
                return (
                  <article
                    key={l.id}
                    className={"agent-line line-" + l.kind}
                    aria-label={l.kind === "user" ? "用户消息" : undefined}
                    data-message-id={l.id}
                  >
                    <div className="line-meta">
                      {label && <strong>{label}</strong>}
                      <time>{clock(l.createdAt)}</time>
                      {l.status && <span>{statusLabels[l.status]}</span>}
                    </div>
                    {rich(l.text)}
                    {l.deliveryError && (
                      <small className="error-text">{l.deliveryError}</small>
                    )}
                    {(l.status === "failed" || l.status === "held") && (
                      <button
                        className="inline-link"
                        disabled={!!draft}
                        onClick={() => {
                          update(l.text);
                          input.current?.focus();
                        }}
                      >
                        放回输入框
                      </button>
                    )}
                    {l.linkAgentId && (
                      <button
                        className="inline-link"
                        onClick={() => onOpen(l.linkAgentId!)}
                      >
                        打开执行 Agent <ChevronRight size={13} />
                      </button>
                    )}
                  </article>
                );
              })}
              {!discussion &&
                s.runs
                  .filter(
                    (x) =>
                      x.taskId === t?.id &&
                      x.response &&
                      !all.some(
                        (l) => l.runId === x.id && l.kind === "assistant",
                      ),
                  )
                  .map((x) => (
                    <article className="agent-line" key={x.id}>
                      <strong>执行回复 · {clock(x.startedAt)}</strong>
                      {rich(x.response)}
                    </article>
                  ))}
              {approvals}
            </div>
          </div>
          <div className="agent-compose">
            <div className="composer">
              <textarea
                aria-label={"发送给" + who}
                ref={input}
                placeholder={
                  disabledReason ||
                  (discussion
                    ? "继续这场讨论…"
                    : live
                      ? "给当前执行轮次补充说明…"
                      : "接着这个执行 Agent 的对话…")
                }
                value={draft}
                maxLength={24000}
                onChange={(e) => update(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing &&
                    (!e.shiftKey || e.ctrlKey)
                  ) {
                    e.preventDefault();
                    void submit(
                      undefined,
                      e.ctrlKey && e.shiftKey
                        ? queue
                          ? "now"
                          : "queue"
                        : queue
                          ? "queue"
                          : "now",
                    );
                  }
                }}
              />
              <div className="composer-tools">
                <div>
                  <button
                    className="model-pill"
                    aria-label="配置当前 Agent 模型"
                    onClick={onProfile}
                  >
                    {discussion ? (
                      <MessagesSquare size={12} />
                    ) : (
                      <Terminal size={12} />
                    )}{" "}
                    {differentRun ? "下轮配置" : "发给" + who} · {chosen.model}{" "}
                    · {effortName(chosen.effort)}
                  </button>
                  {differentRun && (
                    <small>
                      本轮：{r.profile!.model} · {effortName(r.profile!.effort)}
                    </small>
                  )}
                  {live && (
                    <label className="queue-option">
                      <input
                        type="checkbox"
                        checked={queue || r?.backend === "dsh"}
                        disabled={r?.backend === "dsh"}
                        onChange={(e) => setQueue(e.target.checked)}
                      />
                      排到下一轮
                    </label>
                  )}
                </div>
                <button
                  className="send-button"
                  aria-label="发送给当前 Agent"
                  disabled={!ready || busy || !draft.trim() || !!disabledReason}
                  onClick={() => void submit()}
                >
                  <ArrowUp size={19} />
                </button>
              </div>
            </div>
            <div className="composer-caption">
              <span>
                {disabledReason ||
                  (live
                    ? "Enter 补充当前轮次 · 可选下一轮"
                    : discussion
                      ? "Enter 发送 · Shift + Enter 换行"
                      : "Enter 开始下一轮")}
              </span>
              {discussion && all.some((l) => l.kind === "assistant") && (
                <button
                  className="inline-link"
                  disabled={busy || !!draft.trim() || !!disabledReason}
                  onClick={() => void submit("按刚才讨论确定的方案做。")}
                >
                  按方案执行 <ChevronRight size={12} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
