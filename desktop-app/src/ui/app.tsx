import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MobileSettings } from "./mobile-settings";
import {
  outgoing,
  useOutgoing,
  useSending,
  withEchoes,
  echoLabels,
  type Echo,
} from "./outgoing";
import { createRoot } from "react-dom/client";
import {
  Sparkles,
  MessageSquare,
  Layers3,
  FolderOpen,
  History,
  BookOpen,
  Settings2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  ArrowUp,
  Paperclip,
  X,
  ChevronRight,
  ArrowLeft,
  Play,
  Pause,
  Square,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock3,
  FileText,
  Terminal,
  Sun,
  Moon,
  RefreshCw,
  ShieldCheck,
  ExternalLink,
  Copy,
  Archive,
  Activity,
  KeyRound,
  Download,
  RotateCcw,
  MoreHorizontal,
} from "lucide-react";
import type {
  Snapshot,
  Task,
  Project,
  ProjectRoot,
  Settings,
  Artifact,
  Memory,
  Approval,
  Run,
  Message,
  HistorySearchResult,
  ReplyPreference,
  WorkMethod,
} from "../shared/contracts";
import {
  stateLabels,
  APP_VERSION,
  CODEX_CLI_VERSIONS,
  CHIEF,
  apiTarget,
  CUSTOM_ENDPOINT,
  type ExecutorBackend,
} from "../shared/contracts";
import { AgentTree, AgentWorkspace, stateOf } from "./agents";
import { AgentRoster } from "./agent-roster";
import { ExecutorDefaults } from "./executor-defaults";
import { AcceptanceHistory } from "./acceptance-history";
import { resultArtifacts, resultEvidence } from "../shared/result-evidence";
import { MobileDelivery } from "./mobile-delivery";
import { RecordReuse, ReuseLibrary, SaveReuse } from "./reuse-items";
import { WorkRecord, messageWork } from "./work-record";
import { ProfilePicker, effortName, executorProfileIssue } from "./model-profile";
import {
  AdvanceSelect,
  GraphDetails,
  LearnedCheckCard,
  LoopDetails,
  LoopSettings,
} from "./loop";
import { emptyResearch, ResearchFieldsForm, researchValue } from "./research";
import { GraphTiming } from "../shared/graph-progress";
import {
  defaultProfile,
  REUSE_KIND_LABELS,
  executorProfile,
  type ModelProfile,
  type LaunchCard,
} from "../shared/contracts";
import "./style.css";
import "./conversation.css";

type Bridge = {
  request: (r: any) => Promise<any>;
  mobile: (r: unknown) => Promise<any>;
  chooseDirectory: (purpose?: "root" | "parent") => Promise<string | null>;
  openProject: (id: string) => Promise<void>;
  everything: (action: "status" | "browse") => Promise<any>;
  chooseCodex: () => Promise<string | null>;
  attach: () => Promise<Artifact[]>;
  credentials: (kind?: boolean | "dsh-desktop") => Promise<void>;
  restore: () => Promise<any>;
  dataDirectory: () => Promise<any>;
  reveal: (id: string) => Promise<any>;
  quit: () => Promise<void>;
  onChange: (f: () => void) => () => void;
  onError: (f: (error: string) => void) => () => void;
};
declare global {
  interface Window {
    alcor: Bridge;
  }
}
import { submitAgentForm } from "../shared/agent-form";
const api: Bridge = {
  ...window.alcor,
  request: (r) => submitAgentForm((value) => window.alcor.request(value), r),
};
const time = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
function RichText({ text }: { text: string }) {
  return (
    <div className="rich-text">
      {text.split(/(```[\s\S]*?```)/g).map((part, i) =>
        part.startsWith("```") ? (
          <pre key={i}>
            <code>{part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code>
          </pre>
        ) : (
          part.split("\n").map((line, j) =>
            /^#{1,3} /.test(line) ? (
              <h3 key={`${i}-${j}`}>{line.replace(/^#+ /, "")}</h3>
            ) : (
              <div
                key={`${i}-${j}`}
                className={/^[-*] /.test(line) ? "bullet" : ""}
              >
                {line
                  .replace(/^[-*] /, "")
                  .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
                  .map((x, k) =>
                    x.startsWith("**") ? (
                      <strong key={k}>{x.slice(2, -2)}</strong>
                    ) : x.startsWith("`") && x.endsWith("`") ? (
                      <code key={k}>{x.slice(1, -1)}</code>
                    ) : (
                      x
                    ),
                  )}
                {!line && <br />}
              </div>
            ),
          )
        ),
      )}
    </div>
  );
}
function Badge({ task }: { task: Task }) {
  return (
    <span className={`badge ${task.state}`}>
      {task.control?.endsWith("_requested")
        ? "停止待确认"
        : stateLabels[task.state]}
    </span>
  );
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function App() {
  const rootEchoes = useOutgoing(CHIEF),
    rootSending = useRef(false);
  const [profileEdit, setProfileEdit] = useState<
    | { id: string; kind: "api" | ExecutorBackend; value: ModelProfile }
    | undefined
  >();
  const [manualProfile, setManualProfile] = useState<ModelProfile>();
  const [launchId, setLaunchId] = useState<string>(),
    [launchProfile, setLaunchProfile] = useState<ModelProfile>(),
    [launchBusy, setLaunchBusy] = useState(false);
  const seenLaunch = useRef(new Set<string>());
  const [hubError, setHubError] = useState("");
  const [s, setS] = useState<Snapshot>(),
    [view, setView] = useState("chat"),
    [panel, setPanel] = useState(true),
    [selected, setSelected] = useState<string>(),
    [reference, setReference] = useState<string>(),
    [discussionProject, setDiscussionProject] = useState(""),
    [discussionTitle, setDiscussionTitle] = useState(""),
    [delegateGoal, setDelegateGoal] = useState(""),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [discovering, setDiscovering] = useState(false),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<string>(),
    [projectPrompt, setProjectPrompt] = useState<Message>(),
    [editTask, setEditTask] = useState<Task>(),
    [attachments, setAttachments] = useState<Artifact[]>([]),
    [proposal, setProposal] = useState<any>(),
    [preview, setPreview] = useState<any>(),
    [query, setQuery] = useState(""),
    [projectFilter, setProjectFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [historyQuery, setHistoryQuery] = useState(""),
    [historyProject, setHistoryProject] = useState(""),
    [history, setHistory] = useState<HistorySearchResult>(),
    [sessions, setSessions] = useState<any>(),
    [sessionBackend, setSessionBackend] = useState<Settings["executorBackend"]>("codex"),
    [sessionProject, setSessionProject] = useState("");
  const initialized = useRef(false),
    navigation = useRef(0),
    sessionLoad = useRef(0),
    historySearch = useRef(0),
    reads = useRef(0),
    appliedRead = useRef(0),
    rootScroll = useRef<HTMLDivElement>(null),
    rootPosition = useRef({ top: 0, pinned: true }),
    draftLatest = useRef(""),
    composer = useRef<HTMLTextAreaElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function notify(text: string) {
    setToast(
      text.replace(/^Error invoking remote method '[^']+': Error: /, ""),
    );
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 7000);
  }
  async function run(fn: () => Promise<any>) {
    try {
      return await fn();
    } catch (e) {
      notify((e as Error).message);
      return undefined;
    }
  }
  async function refresh() {
    const seq = ++reads.current;
    try {
      const data = await api.request({ op: "snapshot" });
      if (seq < appliedRead.current) return;
      appliedRead.current = seq;
      setHubError(data.hub.error || "");
      setS(data);
      if (!initialized.current) {
        setDraft(data.draft);
        draftLatest.current = data.draft;
        initialized.current = true;
      }
    } catch (error) {
      const message = (error as Error).message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      );
      if (seq >= appliedRead.current && message !== "Hub 正在启动，请稍候")
        setHubError(message);
    }
  }
  useEffect(() => {
    void refresh();
    let queued: ReturnType<typeof setTimeout> | undefined;
    const off = api.onChange(() => {
      if (!queued)
        queued = setTimeout(() => {
          queued = undefined;
          void refresh();
        }, 100);
    });
    const err = api.onError((error) => {
      appliedRead.current = ++reads.current;
      setHubError(error);
      notify(error);
    });
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      off();
      clearTimeout(queued);
      err();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (s)
      document.documentElement.dataset.theme =
        s.settings.theme === "system"
          ? matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : s.settings.theme;
  }, [s?.settings.theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(undefined);
        setPreview(undefined);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setView("history");
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setEditTask(undefined);
        setModal("task");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  function changeDraft(value: string) {
    draftLatest.current = value;
    setDraft(value);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(
      () => void run(() => api.request({ op: "draft", text: value })),
      250,
    );
  }
  function openAgent(id: string) {
    navigation.current++;
    setSelected(id === CHIEF ? undefined : id);
    setReference(undefined);
    setView("chat");
  }
  function newDiscussion(projectId?: string) {
    if (s) setManualProfile(defaultProfile(s.settings));
    setDiscussionProject(projectId || projects[0]?.id || "");
    setDiscussionTitle("");
    setModal("discussion");
  }
  function showLaunch(c: LaunchCard) {
    seenLaunch.current.add(c.id);
    setLaunchId(c.id);
    setLaunchProfile(c.profile);
  }
  const pendingLaunch = s?.launches.find((c) => c.id === launchId);
  const launchCatalog = pendingLaunch?.kind === "executor" ? s?.executorModels[pendingLaunch.backend ?? "codex"] : undefined;
  const launchModelIssue = launchCatalog && launchProfile ? executorProfileIssue(launchCatalog, launchProfile) : "";
  useEffect(() => {
    if (!s || pendingLaunch || modal || profileEdit) return;
    const c = s.launches.find((x) => !seenLaunch.current.has(x.id));
    if (c) showLaunch(c);
  }, [s, modal, pendingLaunch, profileEdit]);
  function editProfile(id: string) {
    if (!s) return;
    const a = s.agents.find((x) => x.id === id);
    setProfileEdit({
      id,
      kind:
        a?.kind === "executor"
          ? (s.tasks.find((t) => t.id === a.taskId)?.backend ?? "codex")
          : "api",
      value: a?.profile || defaultProfile(s.settings, id === CHIEF),
    });
  }
  async function showRouted(result: any) {
    if (result.openFolderId) await api.openProject(result.openFolderId);
    if (result.launchId) {
      const snap = (await api.request({ op: "snapshot" })) as Snapshot;
      const c = snap.launches.find((x) => x.id === result.launchId);
      if (c) showLaunch(c);
    }
    if (result.openAgentId) openAgent(result.openAgentId);
    if (result.native)
      setPreview({
        type: "session",
        ...(await api.request({ op: "session.read", ...result.native })),
      });
  }
  const rootMessages = withEchoes<Message>(
    s?.messages || [],
    rootEchoes,
    (e) => ({
      id: e.id,
      createdAt: e.at,
      updatedAt: e.at,
      role: "user",
      text: e.text,
      status: "local:" + e.state,
    }),
  );
  useEffect(() => {
    if (view === "projects" && projectFilter)
      document
        .getElementById("project-card-" + projectFilter)
        ?.scrollIntoView({ block: "nearest" });
  }, [view, projectFilter]);
  useEffect(() => {
    if (s)
      outgoing.reconcile(
        CHIEF,
        s.messages.filter((m) => m.role === "user").map((m) => m.id),
      );
  }, [s]);
  useLayoutEffect(() => {
    const el = rootScroll.current;
    if (el && view === "chat" && !selected)
      el.scrollTop = rootPosition.current.pinned
        ? el.scrollHeight
        : rootPosition.current.top;
  }, [rootMessages.at(-1)?.id, view, selected]);
  async function send() {
    const text = draftLatest.current.trim();
    if (!text || busy || rootSending.current) return;
    rootSending.current = true;
    const origin = navigation.current;
    setBusy(true);
    clearTimeout(draftTimer.current);
    const echo = outgoing.begin(CHIEF, text, "你");
    draftLatest.current = "";
    setDraft("");
    rootPosition.current.pinned = true;
    composer.current?.focus();
    try {
      const result = await api.request({
        op: "chat",
        text,
        requestId: echo.id,
        taskId: reference,
      });
      if (result.saved) outgoing.update(CHIEF, echo.id, { state: "accepted" });
      else outgoing.reject(CHIEF, echo.id, result.error || "消息未发送");
      if (result.proposal)
        setProposal({ ...result.proposal, taskId: reference });
      if (result.error) notify(result.error);
      if (origin === navigation.current) await showRouted(result);
    } catch (e) {
      outgoing.reject(CHIEF, echo.id, e);
      notify((e as Error).message);
    } finally {
      rootSending.current = false;
      outgoing.finish(CHIEF, echo.id);
      setBusy(false);
      await refresh();
    }
  }
  async function showProgress(project: Project) {
    if (busy) return;
    setView("chat");
    setSelected(undefined);
    navigation.current++;
    setBusy(true);
    try {
      const result = await api.request({
        op: "project.progress",
        id: project.id,
        requestId: crypto.randomUUID(),
      });
      if (result.error) notify(result.error);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  async function discover() {
    setDiscovering(true);
    try {
      const result = await api.request({ op: "projects.discover" });
      notify(
        result.status === "ready"
          ? `已核对项目列表，共 ${result.count} 个项目`
          : result.error || "项目目录未完整加载",
      );
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }
  function projectForm(mode: "project" | "create-project", prompt?: Message) {
    setProjectPrompt(prompt);
    setModal(mode);
  }
  async function projectReady(project: Project) {
    const prompt = projectPrompt;
    setModal(undefined);
    setProjectPrompt(undefined);
    if (prompt)
      await run(async () => {
        const result = await api.request({
          op: "project.use",
          messageId: prompt.id,
          projectId: project.id,
          requestId: crypto.randomUUID(),
        });
        await showRouted(result);
        if (result.error) notify(result.error);
      });
    await refresh();
  }
  async function selectTask(t: Task) {
    openAgent("exec:" + t.id);
    setPanel(true);
    await run(() =>
      api.request({
        op: "task.control",
        id: t.id,
        action: "read",
        revision: t.revision,
      }),
    );
  }
  async function control(t: Task, action: string) {
    await run(() =>
      api.request({
        op: "task.control",
        id: t.id,
        action,
        revision: t.revision,
      }),
    );
    await refresh();
  }
  const projects = s?.projects.filter((p) => !p.removed) || [],
    tasks = s?.tasks.filter((t) => !t.archived) || [],
    selectedAgent = s?.agents.find((a) => a.id === selected),
    selectedTask = s?.tasks.find((t) => t.id === selectedAgent?.taskId),
    active = tasks.filter((t) => ["active", "ready"].includes(t.state)),
    needs = tasks.filter(
      (t) => t.state === "blocked" || t.state === "verifying",
    ),
    approvals = s?.approvals.filter((a) => a.state === "pending") || [];
  const title: Record<string, string> = {
    chat: "与星引对话",
    work: "所有工作",
    handled: "已处理",
    roster: "Agent 名册",
    library: "留用架",
    projects: "项目空间",
    sessions: "Codex 会话",
    memory: "明确规则",
    history: "历史与搜索",
    settings: "设置",
  };
  const menu = [
    ["chat", "对话", MessageSquare],
    ["work", "工作", Layers3],
    ["handled", "已处理", CheckCircle2],
    ["projects", "项目", FolderOpen],
    ["roster", "Agent 名册", Terminal],
    ["library", "留用架", BookOpen],
    ["sessions", "原生会话", Terminal],
    ["memory", "规则记忆", BookOpen],
    ["history", "历史搜索", History],
  ] as const;
  if (!s)
    return (
      <div className="loading">
        <div className="brand-mark">
          <Sparkles />
        </div>
        <h2>星引 Alcor</h2>
        {hubError
          ? <p role="alert">{hubError}</p>
          : <p>正在打开你的工作空间…</p>}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={23} />
          </div>
          <div>
            <strong>
              星引 <span>Alcor</span>
            </strong>
            <small>智能体总管</small>
          </div>
        </div>
        <button
          className="new-work"
          onClick={() => {
            setEditTask(undefined);
            setProposal(undefined);
            setModal("task");
          }}
        >
          <Plus size={18} />
          新建工作<span>⌃ N</span>
        </button>
        <nav>
          {menu.map(([key, label, Icon]) => (
            <button
              key={key}
              className={view === key ? "nav-active" : ""}
              onClick={() => {
                if (key === "chat") openAgent(CHIEF);
                else {
                  navigation.current++;
                  setView(key);
                }
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {key === "work" && tasks.length > 0 && <em>{tasks.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="eyebrow">
            项目空间
            <button
              aria-label="添加项目"
              onClick={() => projectForm("project")}
            >
              <Plus size={15} />
            </button>
          </div>
          {projects.slice(0, 5).map((p) => (
            <button
              className="project-shortcut"
              key={p.id}
              title={p.path}
              onClick={() => {
                setProjectFilter(p.id);
                setView("work");
              }}
            >
              <span className="project-dot" />
              {p.name}
            </button>
          ))}
          {projects.length === 0 && (
            <p className="muted small">添加一个项目，让工作有处可循。</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="connection">
            <span
              className={`status-dot ${s[s.settings.executorBackend].status.includes("就绪") ? "online" : ""}`}
            />
            <span>
              {s.settings.executorBackend === "dsh" ? "DSH" : "Codex"} ·{" "}
              {s[s.settings.executorBackend].status}
            </span>
            <button
              aria-label="检测所选执行端"
              onClick={() =>
                void run(() =>
                  api.request({ op: s.settings.executorBackend + ".probe" }),
                )
              }
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <button
            className={view === "settings" ? "nav-active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings2 size={18} />
            设置<span className="version">v{APP_VERSION}</span>
          </button>
          <div className="profile">
            <span className="avatar">我</span>
            <div>
              <strong>本地工作空间</strong>
              <small>数据保存在此设备</small>
            </div>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>
              {view === "chat" && selectedAgent
                ? selectedAgent.title
                : title[view]}
            </strong>
          </div>
          <div className="top-actions">
            <span className={"local-badge" + (hubError ? " attention" : "")}>
              <span aria-hidden="true" />
              {hubError ? "Hub 需要恢复" : "本地 Hub 在线"}
            </span>
            <button
              className="icon-button"
              title="切换明暗主题"
              onClick={() =>
                void run(() =>
                  api.request({
                    op: "settings",
                    value: {
                      ...s.settings,
                      theme: s.settings.theme === "dark" ? "light" : "dark",
                    },
                  }),
                )
              }
            >
              {s.settings.theme === "dark" ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </button>
            <button
              className="icon-button"
              aria-label="切换工作动态"
              onClick={() => setPanel(!panel)}
            >
              {panel ? (
                <PanelRightClose size={19} />
              ) : (
                <PanelRightOpen size={19} />
              )}
            </button>
          </div>
        </header>
        {hubError && (
          <div className="hub-alert" role="alert">
            {hubError}
          </div>
        )}
        <div className="workspace-body">
          <main
            className={`main-content ${view === "chat" ? "chat-main" : ""}`}
          >
            {view === "chat" && selectedAgent && (
              <AgentWorkspace
                onLaunch={(id) => void run(() => showRouted({ launchId: id }))}
                onProfile={() => editProfile(selectedAgent.id)}
                key={selectedAgent.id}
                a={selectedAgent}
                s={s}
                onOpen={openAgent}
                notify={notify}
                rich={(text) => <RichText text={text} />}
                onDelegate={
                  selectedTask &&
                  !selectedTask.archived &&
                  !selectedTask.isolate &&
                  selectedTask.state !== "cancelled"
                    ? () => {
                        setDelegateGoal("");
                        setManualProfile(defaultProfile(s.settings));
                        setModal("delegate");
                      }
                    : undefined
                }
                approvals={approvals
                  .filter(
                    (a) =>
                      a.taskId === selectedTask?.id ||
                      s.agents.some(
                        (w) =>
                          w.taskId === a.taskId &&
                          w.parentAgentId === selectedAgent.id,
                      ),
                  )
                  .map((a) => (
                    <ApprovalCard key={a.id} approval={a} run={run} />
                  ))}
                details={
                  selectedTask && (
                    <TaskDetail
                      key={selectedTask.id}
                      task={selectedTask}
                      snapshot={s}
                      refresh={refresh}
                      onBack={() => openAgent(CHIEF)}
                      onControl={control}
                      onEdit={() => {
                        setEditTask(selectedTask);
                        setModal("task");
                      }}
                      onReference={() => {
                        openAgent(CHIEF);
                        setReference(selectedTask.id);
                      }}
                      onPreview={(id) =>
                        void run(async () =>
                          setPreview({
                            type: "artifact",
                            ...(await api.request({ op: "artifact.read", id })),
                          }),
                        )
                      }
                      run={run}
                    />
                  )
                }
              />
            )}
            {view === "chat" && !selectedAgent && (
              <>
                <div
                  className="chat-scroll"
                  ref={rootScroll}
                  onScroll={() => {
                    const el = rootScroll.current;
                    if (el)
                      rootPosition.current = {
                        top: el.scrollTop,
                        pinned:
                          el.scrollHeight - el.clientHeight - el.scrollTop < 48,
                      };
                  }}
                >
                  {rootMessages.length === 0 ? (
                    <div className="welcome">
                      <div className="welcome-icon">
                        <Sparkles size={30} />
                      </div>
                      <div className="eyebrow">YOUR WORK, IN GOOD HANDS</div>
                      <h1>把目标交给星引。</h1>
                      <p>
                        在这一条对话里推进所有项目。也可以说「和某项目开一场需求讨论」。
                      </p>
                      <div className="suggestion-grid">
                        <button
                          onClick={() => {
                            setModal("task");
                            setEditTask(undefined);
                          }}
                        >
                          <div className="suggest-icon">
                            <Layers3 size={19} />
                          </div>
                          <strong>
                            开始一项工作
                            <ChevronRight size={16} />
                          </strong>
                          <span>说明目标、项目与交付要求</span>
                        </button>
                        <button
                          onClick={() => {
                            changeDraft("现在有哪些工作需要我处理？");
                            composer.current?.focus();
                          }}
                        >
                          <div className="suggest-icon mint">
                            <Activity size={19} />
                          </div>
                          <strong>
                            了解工作进展
                            <ChevronRight size={16} />
                          </strong>
                          <span>查看正在推进和需要关注的事</span>
                        </button>
                        <button onClick={() => setView("projects")}>
                          <div className="suggest-icon peach">
                            <FolderOpen size={19} />
                          </div>
                          <strong>
                            连接本地项目
                            <ChevronRight size={16} />
                          </strong>
                          <span>为执行者指定清晰的工作空间</span>
                        </button>
                      </div>
                      <div className="welcome-note">
                        <ShieldCheck size={15} />
                        执行范围由你决定，过程与结果随时可查。
                      </div>
                    </div>
                  ) : (
                    <div className="messages">
                      {rootMessages.map((m) => (
                        <React.Fragment key={m.id}>
                          {m.role !== "user" && messageWork(m).length > 0 && (
                            <div className="chief-work">
                              <WorkRecord steps={messageWork(m)} />
                            </div>
                          )}
                          <article
                            className={`message ${m.role}`}
                            aria-label={
                              m.role === "user" ? "用户消息" : undefined
                            }
                            key={m.id}
                            data-message-id={m.id}
                          >
                            <div className="message-avatar">
                              {m.role === "user" ? (
                                "我"
                              ) : (
                                <Sparkles size={17} />
                              )}
                            </div>
                            <div className="message-content">
                              <div className="message-heading">
                                {m.role !== "user" && (
                                  <strong>
                                    {m.role === "system" ? "运行提示" : "星引"}
                                  </strong>
                                )}
                                <time>{time(m.createdAt)}</time>
                                {m.linkAgentId && (
                                  <button
                                    className="inline-link chief-inline-result"
                                    onClick={() => openAgent(m.linkAgentId!)}
                                  >
                                    进入 Agent <ChevronRight size={13} />
                                  </button>
                                )}
                                {m.taskId && (
                                  <button
                                    className="inline-link"
                                    onClick={() => {
                                      const t = s.tasks.find(
                                        (t) => t.id === m.taskId,
                                      );
                                      if (t) void selectTask(t);
                                    }}
                                  >
                                    关联工作
                                  </button>
                                )}
                              </div>
                              <RichText text={m.text} />
                              {s.preferenceLearning && m.role === "assistant" && m.workRequestId && !m.taskId && (
                                <details className="reply-feedback">
                                  <summary>评价答复详略</summary>
                                  <div className="button-row">
                                    {(["concise", "detailed"] as const).map((style) => (
                                      <button key={style}
                                        aria-pressed={s.replyPreferences.some((item) => item.evidence.some((entry) =>
                                          entry.messageId === m.id && entry.style === style))}
                                        onClick={() => void run(() => api.request({
                                          op: "preference.feedback", id: m.id, style,
                                        }))}
                                      >{style === "concise" ? "更简洁" : "更详细"}</button>
                                    ))}
                                  </div>
                                </details>
                              )}
                              {m.status?.startsWith("local:") && (
                                <span className="delivery-state" role="status">
                                  {
                                    echoLabels[
                                      m.status.slice(6) as Echo["state"]
                                    ]
                                  }
                                </span>
                              )}
                              {(m.status === "local:failed" ||
                                m.status === "failed") && (
                                <button
                                  className="inline-link"
                                  disabled={!!draft}
                                  onClick={() => {
                                    changeDraft(m.text);
                                    composer.current?.focus();
                                  }}
                                >
                                  放回输入框
                                </button>
                              )}
                              {m.status?.startsWith("local:") &&
                                rootEchoes.find((e) => e.id === m.id)
                                  ?.detail && (
                                  <small className="delivery-state">
                                    {
                                      rootEchoes.find((e) => e.id === m.id)
                                        ?.detail
                                    }
                                  </small>
                                )}
                              {m.id.startsWith("assign:") &&
                                m.linkAgentId &&
                                s.agents
                                  .filter((a) => a.id === m.linkAgentId)
                                  .map((a) => {
                                    const info = stateOf(a, s);
                                    return (
                                      <div
                                        key={a.id}
                                        className={"agent-state " + info.state}
                                      >
                                        {
                                          s.projects.find(
                                            (p) => p.id === a.projectId,
                                          )?.name
                                        }{" "}
                                        · {info.label}
                                        {info.state === "active"
                                          ? " · " + info.action
                                          : ""}
                                      </div>
                                    );
                                  })}
                              {m.projectPicker && (
                                <div className="agent-choices">
                                  {m.projectPicker.collision && (
                                    <button
                                      onClick={() =>
                                        void run(async () => {
                                          const result = await api.request({
                                            op: "project.create",
                                            reuse: true,
                                            parent: m.projectPicker!.parent,
                                            name: m.projectPicker!.name,
                                          });
                                          await showRouted(
                                            await api.request({
                                              op: "project.use",
                                              messageId: m.id,
                                              projectId: result.project.id,
                                              requestId: crypto.randomUUID(),
                                            }),
                                          );
                                          await refresh();
                                        })
                                      }
                                    >
                                      使用已有目录
                                    </button>
                                  )}
                                  <button
                                    onClick={() => projectForm("project", m)}
                                  >
                                    选择已有文件夹
                                  </button>
                                  <button
                                    onClick={() =>
                                      projectForm("create-project", m)
                                    }
                                  >
                                    新建项目
                                  </button>
                                </div>
                              )}
                              {!!m.choices?.length && (
                                <div className="agent-choices">
                                  {m.choices.map((c, index) => (
                                    <button
                                      key={index}
                                      onClick={() =>
                                        void run(async () => {
                                          const result = await api.request({
                                            op: "agent.choose",
                                            messageId: m.id,
                                            index,
                                            requestId: crypto.randomUUID(),
                                          });
                                          await refresh();
                                          await showRouted(result);
                                          if (result.error)
                                            notify(result.error);
                                        })
                                      }
                                    >
                                      {c.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {m.id.startsWith("approval:") &&
                                approvals
                                  .filter((x) => m.id === "approval:" + x.id)
                                  .map((a) => (
                                    <ApprovalCard
                                      key={a.id}
                                      approval={a}
                                      run={run}
                                    />
                                  ))}
                              {m.sources?.length && (
                                <details className="message-sources">
                                  <summary>
                                    本次查证来源 · {m.sources.length} 项
                                  </summary>
                                  {m.sources.map((source) => (
                                    <div key={source.id}>
                                      <span>
                                        {source.kind === "document"
                                          ? "文档"
                                          : source.kind === "session"
                                            ? "原生会话"
                                            : "Git"}{" "}
                                        · {source.title}
                                      </span>
                                      <small>
                                        {source.updatedAt
                                          ? `资料时间 ${time(source.updatedAt)} · `
                                          : ""}
                                        读取于 {time(source.fetchedAt)}
                                        {!source.complete
                                          ? " · 部分历史/摘录"
                                          : ""}
                                      </small>
                                      {source.threadId && (
                                        <button
                                          className="inline-link"
                                          onClick={() =>
                                            void run(async () =>
                                              setPreview({
                                                type: "session",
                                                ...(await api.request({
                                                  op: "session.read",
                                                  projectId: source.projectId,
                                                  threadId: source.threadId,
                                                })),
                                              }),
                                            )
                                          }
                                        >
                                          查看原生记录
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </details>
                              )}
                              {m.projectId && (
                                <button
                                  className="inline-link"
                                  onClick={() => {
                                    setProjectFilter(m.projectId!);
                                    setView("projects");
                                  }}
                                >
                                  定位项目
                                </button>
                              )}
                              {m.status === "failed" && (
                                <span className="error-text small">
                                  消息已保存，处理未完成
                                </span>
                              )}
                            </div>
                          </article>
                          {m.status === "pending" && (
                            <div className="chief-wait" role="status">
                              总管正在处理…
                            </div>
                          )}
                          {m.role === "user" && messageWork(m).length > 0 && (
                            <div className="chief-work">
                              <WorkRecord steps={messageWork(m)} />
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  {proposal && (
                    <div className="proposal-card">
                      <Sparkles size={18} />
                      <div>
                        <strong>已整理工作建议</strong>
                        <p>{proposal.goal}</p>
                        <button
                          onClick={() => {
                            setEditTask(
                              proposal.taskId
                                ? s.tasks.find((t) => t.id === proposal.taskId)
                                : undefined,
                            );
                            setModal("task");
                          }}
                        >
                          选择项目并创建工作
                          <ChevronRight size={14} />
                        </button>
                      </div>
                      <button
                        className="icon-button"
                        onClick={() => setProposal(undefined)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  {!s.keyConfigured && (
                    <div className="setup-note">
                      <KeyRound size={18} />
                      <div>
                        <strong>配置总管，开启对话</strong>
                        <p>
                          选择自定义 API 或 DeepSeek 官方 Key，即可开始对话。
                        </p>
                      </div>
                      <button onClick={() => setView("settings")}>
                        前往设置
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="composer-wrap">
                  {reference && (
                    <div className="reference-chip">
                      <Layers3 size={14} />
                      正在讨论：{s.tasks.find((t) => t.id === reference)?.title}
                      <button
                        aria-label="移除工作引用"
                        onClick={() => setReference(undefined)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div className="composer">
                    <textarea
                      ref={composer}
                      aria-label="发送给星引"
                      maxLength={24000}
                      placeholder="告诉星引你想做什么，或问问工作的进展…"
                      value={draft}
                      onChange={(e) => changeDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-tools">
                      <div>
                        <button
                          title="附件用于新建工作的执行输入"
                          className="icon-button"
                          onClick={() =>
                            void run(async () => {
                              const files = await api.attach();
                              setAttachments([...attachments, ...files]);
                              if (files.length) {
                                setEditTask(undefined);
                                setModal("task");
                              }
                            })
                          }
                        >
                          <Paperclip size={18} />
                        </button>
                        <button
                          className="model-pill"
                          aria-label="配置总管模型"
                          onClick={() => editProfile(CHIEF)}
                        >
                          <Sparkles size={12} />
                          {s.settings.model} ·{" "}
                          {effortName(s.settings.reasoningEffort)}
                        </button>
                      </div>
                      <button
                        className="send-button"
                        aria-label="发送消息"
                        disabled={!draft.trim() || busy}
                        onClick={() => void send()}
                      >
                        {busy ? (
                          <MoreHorizontal size={20} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="composer-caption">
                    <span>Enter 发送 · Shift + Enter 换行</span>
                    <span>总管提出建议，任务内核核对执行范围</span>
                  </div>
                </div>
              </>
            )}
            {view === "roster" && <AgentRoster snapshot={s} request={api.request} refresh={refresh}
              openTask={t => void selectTask(t)} showLaunch={showRouted} />}
            {view === "library" && <ReuseLibrary snapshot={s} request={api.request} refresh={refresh}
              showLaunch={showRouted} openTask={t => void selectTask(t)} />}
            {view === "handled" && <div className="page"><AcceptanceHistory snapshot={s} request={api.request} /></div>}
            {view === "work" && (
              <div className="page">
                <PageTitle
                  title="每一项工作，都有下文。"
                  subtitle="目标、执行和结果，汇集在这里。"
                  action={
                    <button
                      className="primary"
                      onClick={() => {
                        setEditTask(undefined);
                        setModal("task");
                      }}
                    >
                      <Plus size={16} />
                      新建工作
                    </button>
                  }
                />
                <div className="stats">
                  <Stat value={active.length} label="正在推进" />
                  <Stat
                    value={needs.length + approvals.length}
                    label="需要关注"
                  />
                  <Stat
                    value={tasks.filter((t) => t.state === "done").length}
                    label="已完成"
                  />
                </div>
                <div className="filters">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="筛选工作"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索目标、项目或工作…"
                    />
                  </div>
                  <select
                    aria-label="按项目筛选"
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                  >
                    <option value="">全部项目</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="按状态筛选"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(stateLabels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="task-list">
                  {tasks
                    .filter(
                      (t) =>
                        (!projectFilter || t.projectId === projectFilter) &&
                        (!statusFilter || t.state === statusFilter) &&
                        `${t.title} ${t.goal}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                    )
                    .reverse()
                    .map((t) => (
                      <button
                        className="task-row"
                        key={t.id}
                        onClick={() => void selectTask(t)}
                      >
                        <span className={`task-symbol ${t.state}`}>
                          {t.state === "done" ? (
                            <Check size={17} />
                          ) : (
                            <Layers3 size={17} />
                          )}
                        </span>
                        <div>
                          <strong>{t.title}</strong>
                          <p>
                            {projects.find((p) => p.id === t.projectId)?.name} ·{" "}
                            {t.reason || `第 ${t.revision} 版要求`}
                          </p>
                        </div>
                        <Badge task={t} />
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  {tasks.length === 0 && (
                    <Empty
                      icon={<Layers3 />}
                      title="还没有工作"
                      description="从一个明确目标开始，星引会保存每次执行和交付证据。"
                    />
                  )}
                </div>
              </div>
            )}
            {view === "projects" && (
              <div className="page">
                <PageTitle
                  title="项目空间"
                  subtitle="在常用位置查找真实文件夹；同一路径的 Codex 记录会关联到同一个项目。"
                  action={
                    <div className="button-row">
                      <button
                        disabled={discovering}
                        onClick={() => void discover()}
                      >
                        <RefreshCw size={15} />
                        {discovering ? "正在查找…" : "刷新项目"}
                      </button>
                      <button onClick={() => projectForm("project")}>
                        <Plus size={16} />
                        选择已有文件夹
                      </button>
                      <button
                        className="primary"
                        onClick={() => projectForm("create-project")}
                      >
                        <Plus size={16} />
                        新建项目
                      </button>
                    </div>
                  }
                />
                <ProjectLocations
                  roots={s.projectRoots}
                  run={run}
                  refresh={refresh}
                />
                {s.catalog?.status === "offline" ||
                s.catalog?.status === "partial" ? (
                  <div className="info-box">
                    <AlertCircle size={16} />
                    {s.catalog.error}
                  </div>
                ) : (
                  <p className="field-help">
                    {s.catalog?.checkedAt
                      ? `项目列表核对于 ${time(s.catalog.checkedAt)}`
                      : "添加查找位置后即可发现本机项目。"}{" "}
                    · 发现项目只建立索引，不授予写入权限。
                  </p>
                )}
                <div className="project-grid">
                  {projects.map((p) => (
                    <article
                      className={
                        "project-card" +
                        (projectFilter === p.id ? " located-project" : "")
                      }
                      id={"project-card-" + p.id}
                      key={p.id}
                    >
                      <div className="project-card-top">
                        <span className="folder-icon">
                          <FolderOpen size={25} />
                        </span>
                        <button
                          className="subtle"
                          onClick={() => {
                            setProjectFilter(p.id);
                            setView("work");
                          }}
                        >
                          查看工作
                          <ChevronRight size={14} />
                        </button>
                      </div>
                      <h3>{p.name}</h3>
                      <p className="path">{p.path}</p>
                      <div className="project-meta">
                        <span>
                          {tasks.filter((t) => t.projectId === p.id).length}{" "}
                          项工作
                        </span>
                        <span>
                          {p.nativeProjectId
                            ? "Codex 已关联"
                            : p.origin === "local"
                              ? "本机发现"
                              : "本地绑定"}
                          {p.available === false ? " · 目录暂不可用" : ""}
                        </span>
                      </div>
                      <div className="card-actions">
                        <button
                          disabled={p.available === false}
                          onClick={() => void run(() => api.openProject(p.id))}
                        >
                          打开文件夹
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void showProgress(p)}
                        >
                          <Activity size={14} />
                          查看项目进度
                        </button>
                        <button onClick={() => newDiscussion(p.id)}>
                          新建项目讨论
                        </button>
                        <button
                          onClick={() => {
                            sessionLoad.current++;
                            setSessions(undefined);
                            setSessionProject(p.id);
                            setView("sessions");
                          }}
                        >
                          查看原生会话
                        </button>
                        <button
                          onClick={() => {
                            setPreview({ type: "project-edit", project: p });
                          }}
                        >
                          管理
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {projects.length === 0 && (
                  <Empty
                    icon={<FolderOpen />}
                    title="为工作选择一个空间"
                    description="选择存放项目的父目录，或直接新建项目。移除索引会保留工作文件。"
                  />
                )}
              </div>
            )}
            {view === "sessions" && (
              <div className="page">
                <PageTitle
                  title="原生会话"
                  subtitle="按授权目录查看原生记录。原生归属与星引项目绑定分别保留。"
                />
                <div className="filters">
                  <select aria-label="原生会话来源" value={sessionBackend} onChange={(e) => {
                    sessionLoad.current++;
                    setSessions(undefined);
                    setSessionBackend(e.target.value === "dsh" ? "dsh" : "codex");
                  }}>
                    <option value="codex">Codex 桌面</option>
                    <option value="dsh">DSH 桌面</option>
                  </select>
                  <select
                    aria-label="原生会话项目"
                    value={sessionProject}
                    onChange={(e) => {
                      sessionLoad.current++;
                      setSessionProject(e.target.value);
                      setSessions(undefined);
                    }}
                  >
                    <option value="">选择一个项目</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.path}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    disabled={!sessionProject}
                    onClick={() =>
                      void run(async () => {
                        const load = ++sessionLoad.current;
                        setSessions(undefined);
                        const value = await api.request({
                          op: "sessions",
                          projectId: sessionProject,
                          backend: sessionBackend,
                        });
                        if (load === sessionLoad.current) setSessions(value);
                      })
                    }
                  >
                    <RefreshCw size={15} />
                    读取会话
                  </button>
                </div>
                <div className="info-box">
                  <ShieldCheck size={18} />
                  <span>
                    {sessionBackend === "dsh"
                      ? "通过设置中的 DSH 原桌面桥读取和续聊。停止请使用 DSH 原窗口。"
                      : "托管任务可通过原会话续接。已有桌面会话核对到原窗口后，可沿用原生权限续聊和停止。"}
                  </span>
                </div>
                {sessions?.items.map((t: any) => (
                  <button
                    key={t.id}
                    className="task-row"
                    onClick={() =>
                      void run(async () => {
                        const load = sessionLoad.current;
                        const value = await api.request({
                          op: "session.read",
                          projectId: sessionProject,
                          threadId: t.id,
                          source: sessions.source,
                        });
                        if (load === sessionLoad.current)
                          setPreview({ type: "session", ...value });
                      })
                    }
                  >
                    <Terminal size={20} />
                    <div>
                      <strong>{t.title}</strong>
                      <p>
                        {sessionBackend === "dsh" ? "DSH 桌面" : "原生项目：" + (t.projectId || "未归属")} · {t.id}
                      </p>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {sessions?.offline && (
                  <p className="info-box" role="status">
                    {sessions.cachedAt
                      ? "原生端离线；会话列表为本地副本，保存于 " + time(sessions.cachedAt)
                      : "原生端离线；此项目还没有已保存的会话列表。"}
                  </p>
                )}
                {sessions?.items.length === 0 && !sessions.offline && !sessions.incomplete && (
                  <Empty
                    icon={<Terminal />}
                    title="这个目录下没有已列出的会话"
                    description="这是当前查询范围内的结果，不代表其他目录没有历史。"
                  />
                )}
                {sessions?.incomplete && !sessions.offline && (
                  <p className="muted">
                    会话列表可能不完整，仅显示已核对的最近记录。
                  </p>
                )}
              </div>
            )}
            {view === "memory" && (
              <div className="page">
                <PageTitle
                  title="把明确的规则，认真记住。"
                  subtitle="明确规则按你指定的范围生效。通过复验的漏检检查只供对应项目参考。"
                  action={
                    <button
                      className="primary"
                      onClick={() => setPreview({ type: "memory-edit" })}
                    >
                      <Plus size={16} />
                      添加规则
                    </button>
                  }
                />
                {s.memories.map((m) => (
                  <article
                    key={m.id}
                    className={`memory-card ${!m.enabled ? "disabled" : ""}`}
                  >
                    <div className="memory-heading">
                      <BookOpen size={17} />
                      <span>
                        {m.projectId
                          ? projects.find((p) => p.id === m.projectId)?.name
                          : "全局规则"}
                      </span>
                      <span className="badge">
                        {m.enabled ? "生效中" : "已停用"}
                      </span>
                      <button
                        onClick={() =>
                          setPreview({ type: "memory-edit", memory: m })
                        }
                      >
                        编辑
                      </button>
                    </div>
                    <p>{m.text}</p>
                    <small>
                      {m.source} · v{m.revision}
                    </small>
                    <div className="card-actions">
                      {m.decision && s.agents.some((a) => a.id === m.decision?.agentId) && (
                        <button onClick={() => openAgent(m.decision!.agentId)}>查看来源讨论</button>
                      )}
                      <button
                        onClick={() =>
                          void run(() =>
                            api.request({
                              op: "memory.save",
                              id: m.id,
                              text: m.text,
                              projectId: m.projectId,
                              enabled: !m.enabled,
                            }),
                          )
                        }
                      >
                        {m.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="danger-text"
                        onClick={() =>
                          setPreview({ type: "memory-delete", memory: m })
                        }
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
                <section aria-label="答复偏好">
                  <h2>答复偏好</h2>
                  <label className="check-label">
                    <input type="checkbox" checked={s.preferenceLearning}
                      onChange={(event) => void run(() => api.request({
                        op: "preference.learning", enabled: event.target.checked,
                      }))} />
                    <span>学习总管答复详略<small>打开后可在答复下反馈。启用候选前，不改变答复。</small></span>
                  </label>
                  {s.replyPreferences.map((item) => (
                    <ReplyPreferenceCard key={item.generation} item={item} learning={s.preferenceLearning}
                      project={item.projectId ? projects.find((p) => p.id === item.projectId)?.name || "原项目已移除" : "通用对话"}
                      run={run} exported={(path) => notify("已导出到 " + path)} />
                  ))}
                </section>
                {!!s.learnedChecks.length && <section aria-label="漏检检查">
                  <h2>漏检检查</h2>
                  {s.learnedChecks.map((item) => <LearnedCheckCard key={item.id} item={item}
                    project={projects.find((p) => p.id === item.projectId)?.name || "原项目已移除"}
                    request={api.request} run={run} open={() => openAgent("exec:" + item.taskId)} />)}
                </section>}
                {!!s.workMethods.length && <section aria-label="工作方法">
                  <h2>工作方法</h2>
                  {s.workMethods.map((item) => (
                    <WorkMethodCard key={item.id} item={item}
                      project={projects.find((p) => p.id === item.projectId)?.name || "原项目已移除"}
                      run={run} open={(taskId) => openAgent("exec:" + taskId)} />
                  ))}
                </section>}
                {s.memories.length === 0 && s.learnedChecks.length === 0 && (
                  <Empty
                    icon={<BookOpen />}
                    title="规则由你定义"
                    description="例如：所有项目的交付说明使用中文；某个项目只做调查、不改文件。"
                  />
                )}
              </div>
            )}
            {view === "history" && (
              <div className="page">
                <PageTitle
                  title="找到上次的线索"
                  subtitle="搜索本机已保存的工作和对话。原生历史副本会标明保存时间。"
                />
                <form
                  className="filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const search = ++historySearch.current;
                    void run(async () => {
                      const result = await api.request({
                        op: "search",
                        text: historyQuery,
                        projectId: historyProject || undefined,
                      });
                      if (search === historySearch.current) setHistory(result);
                    });
                  }}
                >
                  <div className="search-field">
                    <Search size={18} />
                    <input
                      autoFocus
                      aria-label="搜索本地历史"
                      placeholder="搜索目标或对话中的关键词"
                      value={historyQuery}
                      maxLength={200}
                      onChange={(e) => {
                        historySearch.current++;
                        setHistoryQuery(e.target.value);
                        setHistory(undefined);
                      }}
                    />
                  </div>
                  <select
                    aria-label="历史所属项目"
                    value={historyProject}
                    onChange={(e) => {
                      historySearch.current++;
                      setHistoryProject(e.target.value);
                      setHistory(undefined);
                    }}
                  >
                    <option value="">全部项目</option>
                    {s.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.path}{p.removed ? "（已移除）" : ""}
                      </option>
                    ))}
                  </select>
                  <button className="primary" type="submit">
                    搜索
                  </button>
                </form>
                {history && (
                  <>
                    <p className="eyebrow">工作 · {history.tasks.length}</p>
                    {history.tasks.map((t: Task) => (
                      <button
                        className="task-row"
                        key={t.id}
                        onClick={() => void selectTask(t)}
                      >
                        <History size={18} />
                        <div>
                          <strong>{t.title}</strong>
                          <p>
                            {time(t.updatedAt)}
                            {t.archived ? " · 已归档" : ""}
                          </p>
                        </div>
                        <Badge task={t} />
                      </button>
                    ))}
                    <p className="eyebrow">
                      对话 · 最近 {history.messages.length} 条匹配
                    </p>
                    {history.moreMessages && (
                      <p className="muted">还有更早的匹配记录，可缩小项目或关键词范围。</p>
                    )}
                    {history.messages.map((m) => {
                      const agent = s.agents.find((a) => a.id === m.agentId),
                        project = s.projects.find((p) => p.id === m.projectId),
                        source = m.nativeCachedAt ? "原生历史副本" : m.agentId === CHIEF
                          ? "总管"
                          : agent?.title || (m.legacy ? "执行 Agent" : "本机原生发送记录");
                      return (
                        <div className="search-result" key={(m.agentId || "native") + ":" + m.id}>
                          <small>
                            {[project?.name, m.nativeSource && "DSH", source, m.legacy && "旧版回执", m.role === "user" ? "你" : m.nativeCachedAt ? "原生执行者" : "星引", m.nativeCachedAt ? "保存于 " + time(m.nativeCachedAt) : time(m.createdAt)]
                              .filter(Boolean).join(" · ")}
                          </small>
                          <RichText text={m.text} />
                          {m.agentId && (
                            <button onClick={() => openAgent(m.agentId!)}>打开对话</button>
                          )}
                          {m.nativeThreadId && project && !project.removed && (
                            <button
                              onClick={() => void run(async () => setPreview({
                                type: "session",
                                ...(await api.request({
                                  op: "session.read",
                                  projectId: project.id,
                                  threadId: m.nativeThreadId,
                                  source: m.nativeSource,
                                })),
                              }))}
                            >查看原会话</button>
                          )}
                        </div>
                      );
                    })}
                    {history.tasks.length === 0 && history.messages.length === 0 && (
                      <p className="muted">没有找到匹配的本地记录。</p>
                    )}
                  </>
                )}
              </div>
            )}
            {view === "settings" && (
              <SettingsPage snapshot={s} notify={notify} run={run} refresh={refresh} />
            )}
          </main>
          {panel && (
            <AgentTree
              s={s}
              selected={view === "chat" ? selected : undefined}
              onOpen={openAgent}
              onNew={() => newDiscussion()}
            />
          )}
        </div>
      </section>
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={18} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "project" && (
        <ProjectForm
          onClose={() => setModal(undefined)}
          onSave={async (path, name) => {
            const result = await run(() =>
              api.request({ op: "project.add", path, name }),
            );
            if (result) {
              notify("项目已添加，工作目录保持原位。");
              await projectReady(result);
            }
          }}
        />
      )}
      {modal === "create-project" && (
        <NewProjectForm
          roots={s.projectRoots}
          name={projectPrompt?.projectPicker?.name}
          parent={projectPrompt?.projectPicker?.parent}
          onClose={() => setModal(undefined)}
          onDone={async (p, created) => {
            notify(created ? "已创建项目文件夹" : "已使用已有项目文件夹");
            await projectReady(p);
          }}
        />
      )}
      {!!s.launches.length && !pendingLaunch && (
        <button
          className="pending-models"
          onClick={() => showLaunch(s.launches[0])}
        >
          待确认创建 · {s.launches.length}
        </button>
      )}
      {pendingLaunch && launchProfile && (
        <Modal
          title={pendingLaunch.handoff ? "确认派工范围" : "确认创建 Agent"}
          onClose={() => {
            if (!launchBusy) setLaunchId(undefined);
          }}
        >
          <p className="field-help">
            {s.projects.find((p) => p.id === pendingLaunch.projectId)?.name} ·{" "}
            {pendingLaunch.parentAgentId === CHIEF
              ? "星引总管"
              : s.agents.find((a) => a.id === pendingLaunch.parentAgentId)
                  ?.title}{" "}
            委派{pendingLaunch.kind === "discussion" ? "讨论" : "执行"} Agent
          </p>
          {pendingLaunch.roster && <p className="field-help">承办 Agent：{pendingLaunch.roster.name}</p>}
          {pendingLaunch.reuse?.length ? <p className="field-help">本次留用：{pendingLaunch.reuse.map(item => `${item.title} · ${REUSE_KIND_LABELS[item.kind ?? "content"]} · 第 ${item.version} 版`).join("、")}</p> : null}
          <h3>{pendingLaunch.title}</h3>
          <p className="launch-goal">{pendingLaunch.detail}</p>
          {pendingLaunch.handoff && <>
            <strong>约束</strong><p className="launch-goal">{pendingLaunch.handoff.constraints.trim()}</p>
            <strong>验收条件</strong><p className="launch-goal">{pendingLaunch.handoff.acceptance}</p>
            <details><summary>本次材料 · 原话与 {pendingLaunch.handoff.discussion.length} 条讨论摘录</summary>
              <p className="launch-goal">{pendingLaunch.handoff.request}</p>
              {pendingLaunch.handoff.discussion.map(row => <p key={row.id} className="launch-goal">{row.role === "user" ? "你：" : "讨论 Agent："}{row.text}</p>)}
              <p className="field-help">不带外部文件。</p>
            </details>
          </>}
          <ProfilePicker
            s={s}
            backend={
              pendingLaunch.kind === "discussion"
                ? "api"
                : (pendingLaunch.backend ?? "codex")
            }
            value={launchProfile}
            onChange={setLaunchProfile}
            verified={!!launchCatalog}
          />
          <p className="field-help">
            {pendingLaunch.scope === "discussion"
              ? "仅讨论；不会派发项目操作。"
              : (pendingLaunch.scope === "read"
                  ? "强制只读"
                  : pendingLaunch.scope === "project"
                    ? "项目内写入沙箱"
                    : "沿用本机 Codex 权限") +
                " · 工具审批：" +
                (pendingLaunch.approval === "never"
                  ? "不逐次询问"
                  : "按需询问")}
          </p>
          <div className="modal-actions">
            <button
              disabled={launchBusy}
              onClick={() =>
                void run(async () => {
                  await api.request({
                    op: "agent.launch.cancel",
                    id: pendingLaunch.id,
                  });
                  setLaunchId(undefined);
                  await refresh();
                })
              }
            >
              {pendingLaunch.handoff ? "取消派工" : "取消创建"}
            </button>
            <button
              className="primary"
              disabled={launchBusy || !launchProfile.model.trim() || !!launchModelIssue}
              onClick={() =>
                void run(async () => {
                  setLaunchBusy(true);
                  try {
                    const result = await api.request({
                      op: "agent.launch.confirm",
                      id: pendingLaunch.id,
                      profile: launchProfile,
                      ...(launchCatalog?.catalogVersion ? { catalogVersion: launchCatalog.catalogVersion } : {}),
                    });
                    await refresh();
                    setLaunchId(undefined);
                    if (result.openAgentId) openAgent(result.openAgentId);
                    else notify("已按所选模型创建执行 Agent");
                  } finally {
                    setLaunchBusy(false);
                  }
                })
              }
            >
              {launchBusy ? "正在核对…" : pendingLaunch.handoff ? "确认派工" : "确认创建"}
            </button>
          </div>
        </Modal>
      )}
      {profileEdit && (
        <Modal
          title="配置 Agent 模型"
          onClose={() => setProfileEdit(undefined)}
        >
          <ProfilePicker
            key={profileEdit.id}
            s={s}
            backend={profileEdit.kind}
            value={profileEdit.value}
            onChange={(value) => setProfileEdit({ ...profileEdit, value })}
          />
          <p className="field-help">
            保存后，从这个 Agent 的下一轮调用生效。运行中插话仍交给当前轮次。
          </p>
          <div className="modal-actions">
            <button onClick={() => setProfileEdit(undefined)}>取消</button>
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  await api.request({
                    op: "agent.configure",
                    agentId: profileEdit.id,
                    profile: profileEdit.value,
                  });
                  setProfileEdit(undefined);
                  await refresh();
                })
              }
            >
              保存模型配置
            </button>
          </div>
        </Modal>
      )}
      {modal === "delegate" && selectedAgent && (
        <Modal title="委派只读核对" onClose={() => setModal(undefined)}>
          <form
            className="project-discussion-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api.request({
                  op: "agent.delegate",
                  profile: manualProfile || defaultProfile(s.settings),
                  agentId: selectedAgent.id,
                  goal: delegateGoal,
                  requestId: crypto.randomUUID(),
                });
                await refresh();
                setModal(undefined);
                if (result.worker) openAgent(result.worker);
              });
            }}
          >
            <label>
              需要子 Agent 核对什么？
              <textarea
                autoFocus
                required
                maxLength={12000}
                value={delegateGoal}
                onChange={(e) => setDelegateGoal(e.target.value)}
              />
            </label>
            <ProfilePicker
              s={s}
              backend={s.settings.executorBackend}
              value={manualProfile || defaultProfile(s.settings)}
              onChange={setManualProfile}
            />
            <p className="field-help">
              沿用当前项目，只读核对。工作区仍被占用时会等待派发。
            </p>
            <button
              className="primary"
              type="submit"
              disabled={!delegateGoal.trim()}
            >
              确认创建核对 Agent
            </button>
          </form>
        </Modal>
      )}
      {modal === "discussion" && (
        <Modal title="新建项目讨论" onClose={() => setModal(undefined)}>
          <form
            className="form-body project-discussion-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const out = await api.request({
                  op: "discussion.open",
                  profile: manualProfile || defaultProfile(s.settings),
                  projectId: discussionProject,
                  title: discussionTitle.trim() || "项目需求讨论",
                  requestId: crypto.randomUUID(),
                });
                await refresh();
                setModal(undefined);
                if (out.openAgentId) openAgent(out.openAgentId);
              });
            }}
          >
            <label>
              讨论项目
              <select
                required
                value={discussionProject}
                onChange={(e) => setDiscussionProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              讨论主题
              <input
                autoFocus
                maxLength={100}
                value={discussionTitle}
                onChange={(e) => setDiscussionTitle(e.target.value)}
                placeholder="例如：桌面端交互"
              />
            </label>
            <ProfilePicker
              s={s}
              backend="api"
              value={manualProfile || defaultProfile(s.settings)}
              onChange={setManualProfile}
            />
            <p className="field-help">
              已有讨论可从右侧树进入，也可以直接让总管接着上次聊。
            </p>
            {projects.length ? (
              <button className="primary" type="submit">
                确认创建讨论 Agent
              </button>
            ) : (
              <button type="button" onClick={() => projectForm("project")}>
                先添加项目
              </button>
            )}
          </form>
        </Modal>
      )}
      {modal === "task" && (
        <TaskForm
          snapshot={s}
          projects={projects}
          task={editTask}
          proposal={proposal}
          attachments={attachments}
          tasks={s.tasks}
          onAttachments={setAttachments}
          onClose={() => setModal(undefined)}
          onSave={async (value, profile, catalogVersion) => {
            const result = await run(() =>
              api.request(
                editTask
                  ? {
                      op: "task.revise",
                      id: editTask.id,
                      revision: editTask.revision,
                      goal: value.goal,
                      constraints: value.constraints,
                      acceptance: value.acceptance,
                      model: value.model,
                      checks: value.checks,
                    }
                  : {
                      op: "task.create",
                      ...(profile ? { profile } : {}),
                      ...(catalogVersion ? { catalogVersion } : {}),
                      value,
                      requestId: crypto.randomUUID(),
                    },
              ),
            );
            if (result) {
              setModal(undefined);
              setAttachments([]);
              setProposal(undefined);
              openAgent("exec:" + (editTask?.id || result.id));
              setPanel(true);
              await refresh();
            }
          }}
        />
      )}
      {preview && (
        <Preview
          key={JSON.stringify([preview.type, preview.projectId, preview.threadId || preview.id, preview.source])}
          value={preview}
          snapshot={s}
          onOpenAgent={(id) => {
            setPreview(undefined);
            openAgent(id);
          }}
          onClose={() => setPreview((current: any) => current === preview ? undefined : current)}
          run={run}
        />
      )}
    </div>
  );
}
function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <strong>{value.toString().padStart(2, "0")}</strong>
      <span>{label}</span>
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function TaskCard({
  task,
  projects,
  onClick,
}: {
  task: Task;
  projects: Project[];
  onClick: () => void;
}) {
  return (
    <button
      className={`task-card ${task.unread ? "unread" : ""}`}
      onClick={onClick}
    >
      <div>
        <span className="project-dot" />
        <small>{projects.find((p) => p.id === task.projectId)?.name}</small>
        {task.unread && <span className="unread-dot" />}
      </div>
      <strong>{task.title}</strong>
      <p>{task.reason || "已保存当前目标与授权范围"}</p>
      <div className="task-card-foot">
        <Badge task={task} />
        <ChevronRight size={14} />
      </div>
    </button>
  );
}
function AttachmentInputs({
  ids,
  current,
  artifacts,
  onPreview,
}: {
  ids: string[];
  current?: Run;
  artifacts: Artifact[];
  onPreview: (id: string) => void;
}) {
  return (
    <ul>
      {ids.map((id) => {
        const artifact = artifacts.find((a) => a.id === id);
        const input = current?.attachmentInputs?.find((a) => a.id === id);
        const status = !input
          ? "未记录本回合送达"
          : !current?.inputsAcceptedAt
            ? "送达尚未确认"
            : input.kind === "binary"
              ? "仅送达文件名和 SHA-256，未发送二进制正文"
              : (input.kind === "image" ? "图片交给 Codex" : input.truncated ? "文本前 30000 字符已送达" : "文本已送达") +
                "；未核实模型实际读取";
        return (
          <li key={id}>
            {artifact ? (
              <button className="inline-link" onClick={() => onPreview(id)}>{artifact.name}</button>
            ) : "附件记录缺失"}
            <span> · {status}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ReplyPreferenceCard({ item, project, learning, run, exported }: {
  item: ReplyPreference;
  project: string;
  learning: boolean;
  run: (fn: () => Promise<any>) => Promise<any>;
  exported: (path: string) => void;
}) {
  const [source, setSource] = useState<{ messageId: string; text: string }>();
  const [deleting, setDeleting] = useState(false);
  const labels = { insufficient: "证据不足", conflicted: "反馈不一致", expired: "证据已过期",
    candidate: "待启用", active: "生效中" };
  const apply = (action: "enable" | "pause" | "delete" | "export") => run(() => api.request({
    op: "preference.manage", id: item.id, revision: item.revision, generation: item.generation, action,
  }));
  return (
    <article className="memory-card">
      <div className="memory-heading"><span>{project}</span><span className="badge">{labels[item.state]}</span></div>
      <p>{item.style === "concise" ? "答复更简洁" : item.style === "detailed" ? "答复更详细" : "答复详略"}</p>
      <small>{item.lastUsedAt ? "上次应用：" + time(item.lastUsedAt) : "尚未应用"}
        {item.expiresAt ? " · 当前证据有效至 " + new Date(item.expiresAt).toLocaleDateString("zh-CN") : ""}</small>
      <details>
        <summary>查看反馈证据</summary>
        {item.evidence.slice().reverse().map((entry) => (
          <div className="button-row" key={entry.requestId}>
            <small>{time(entry.at)} · {entry.style === "concise" ? "更简洁" : "更详细"}</small>
            <button onClick={() => void run(async () => {
              const evidence = await api.request({ op: "preference.source", id: item.id, messageId: entry.messageId });
              setSource({ messageId: entry.messageId, text: evidence.text });
            })}>查看原答复</button>
            {source?.messageId === entry.messageId && <RichText text={source.text} />}
          </div>
        ))}
      </details>
      <div className="card-actions">
        {learning && item.state === "candidate" && <button onClick={() => void apply("enable")}>启用偏好</button>}
        {item.state === "active" && <button onClick={() => void apply("pause")}>停用偏好</button>}
        <button onClick={async () => { const result = await apply("export"); if (result) exported(result.path); }}>导出证据</button>
        {deleting ? <>
          <button className="danger-text" onClick={() => void apply("delete")}>确认删除偏好及证据</button>
          <button onClick={() => setDeleting(false)}>取消删除</button>
        </> : <button className="danger-text" onClick={() => setDeleting(true)}>删除偏好</button>}
      </div>
    </article>
  );
}

function WorkMethodCard({ item, project, run, open }: {
  item: WorkMethod; project: string;
  run: (fn: () => Promise<any>) => Promise<any>;
  open: (taskId: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const apply = (action: "enable" | "pause" | "delete" | "recheck") =>
    run(() => api.request({ op: "method.manage", id: item.id, revision: item.revision, action }));
  const labels = { candidate: "等待独立复验", verified: "已复验", active: "按环境启用", "needs-review": "需要重验" };
  return (
    <article className="memory-card">
      <div className="memory-heading"><span>{project}</span><span className="badge">{labels[item.state]}</span></div>
      <h3>文件交付验收前核对</h3>
      <ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <p>{item.reason}</p>
      <small>{item.environment.backend} · {item.environment.adapter} · {item.environment.model} / {item.environment.effort}</small>
      <details>
        <summary>查看复验证据</summary>
        <button onClick={() => open(item.originTaskId)}>打开原工作</button>
        {item.proofs.map((proof) => <p key={proof.runId}>
          原检查通过 · 工作 v{proof.revision}{" "}
          <button onClick={() => open(proof.taskId)}>打开复验工作</button>
        </p>)}
        {item.counterexample && <p>原检查仍失败：
          <button onClick={() => open(item.counterexample!.taskId)}>打开反例工作</button>
        </p>}
      </details>
      <div className="card-actions">
        {item.state === "verified" && <button onClick={() => void apply("enable")}>启用方法</button>}
        {item.state === "active" && <button onClick={() => void apply("pause")}>停用方法</button>}
        {item.state !== "needs-review" && <button onClick={() => void apply("recheck")}>要求重新复验</button>}
        {deleting ? <>
          <button className="danger-text" onClick={() => void apply("delete")}>确认删除方法</button>
          <button onClick={() => setDeleting(false)}>取消</button>
        </> : <button onClick={() => setDeleting(true)}>删除方法</button>}
      </div>
    </article>
  );
}

function TaskDetail({
  task: t,
  snapshot: s,
  onBack,
  onControl,
  onEdit,
  onReference,
  onPreview,
  refresh,
  run,
}: {
  task: Task;
  snapshot: Snapshot;
  onBack: () => void;
  onControl: (t: Task, a: string) => Promise<void>;
  onEdit: () => void;
  onReference: () => void;
  onPreview: (id: string) => void;
  refresh: () => Promise<void>;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [tab, setTab] = useState(t.loopId ? "loop" : "result");
  const [wakeAt, setWakeAt] = useState("");
  const r = s.runs.find((r) => r.id === t.runId);
  const wake = s.taskWakes.find((entry) => entry.taskId === t.id);
  const artifacts = s.artifacts.filter((a) => a.taskId === t.id);
  const integration = s.integrations.filter((item) => item.taskId === t.id)
    .findLast((item) => ["checking", "applying", "unknown"].includes(item.state));
  const p = s.projects.find((p) => p.id === t.projectId);
  const issues = s.workIssues.filter((issue) => issue.taskId === t.id);
  return (
    <>
      <div className="panel-heading">
        <button className="subtle" onClick={onBack}>
          <ArrowLeft size={16} />
          工作动态
        </button>
        <button
          className="icon-button"
          aria-label="引用工作"
          title="引用到对话"
          onClick={onReference}
        >
          <MessageSquare size={17} />
        </button>
      </div>
      <div className="detail-title">
        <small>{p?.name}</small>
        <h2>{t.title}</h2>
        <Badge task={t} />
        <p>{t.reason}</p>
        {!!issues.length && <details>
          <summary>复盘记录 · {issues.length}</summary>
          {issues.map((issue) => <div key={issue.id}>
            <p>工作 v{issue.revision} · {
              { "file-check": "文件验收反复失败", "native-recovery": "核对到未知回合终态", "scope-mismatch": "原生执行范围不匹配" }[issue.kind]
            } · {issue.state === "recovered" ? "已有恢复证据" : "尚未复验"}</p>
            <small>{issue.failed.length} 条原始记录{issue.recovery ? "，已保留恢复回执" : ""}。记录事实不代表已确认原因。</small>
          </div>)}
        </details>}
        <div className="detail-controls">
          {["draft", "ready", "active", "blocked", "verifying"].includes(
            t.state,
          ) && (
            <button onClick={() => void onControl(t, "pause")}>
              <Pause size={14} />
              暂停
            </button>
          )}
          {["paused", "blocked"].includes(t.state) && (
            <button
              className="primary"
              onClick={() => void onControl(t, "resume")}
            >
              <Play size={14} />
              继续
            </button>
          )}
          {!["done", "cancelled"].includes(t.state) && (
            <button onClick={() => void onControl(t, "cancel")}>
              <Square size={13} />
              取消
            </button>
          )}
          {t.state !== "cancelled" && (
            <button onClick={onEdit}>修改要求</button>
          )}
          {["done", "cancelled"].includes(t.state) && (
            <button onClick={() => void onControl(t, "archive")}>
              <Archive size={14} />
              归档
            </button>
          )}
        </div>
        {wake?.state === "scheduled" ? (
          <div className="button-row">
            <p>预约继续：{new Date(wake.at).toLocaleString("zh-CN")}</p>
            <button onClick={() => void run(() => api.request({
              op: "task.wake.cancel", id: t.id, wakeId: wake.wakeId,
            }))}>取消预约</button>
          </div>
        ) : (
          <>
            {wake?.state === "cancelled" && <p className="muted">预约未执行：{wake.reason}</p>}
            {wake?.state === "released" && <p className="muted">已按预约交回调度</p>}
            {s.settings.background && t.state === "paused" && (!r || r.state === "ended") &&
              !t.control?.endsWith("_requested") && (
              <details>
                <summary>预约继续</summary>
                <label>继续时间（本地时间）
                  <input type="datetime-local" value={wakeAt} onChange={(e) => setWakeAt(e.target.value)} />
                </label>
                <p className="muted">到时仍在相同范围和余额内继续一次。星引完全退出时不运行，超过预约 15 分钟后失效。</p>
                <button disabled={!wakeAt} onClick={async () => {
                  if (await run(() => api.request({
                    op: "task.wake.schedule", id: t.id, revision: t.revision,
                    stateVersion: t.stateVersion, at: new Date(wakeAt).toISOString(),
                  }))) setWakeAt("");
                }}>确认预约</button>
              </details>
            )}
          </>
        )}
      </div>
      <div className="tabs">
        {[
          ...(t.loopId ? [["loop", "推进循环"]] : []),
          ["result", "结果"],
          ["contract", "目标与范围"],
          ["history", "执行记录"],
        ].map(([k, v]) => (
          <button
            className={tab === k ? "active" : ""}
            key={k}
            onClick={() => setTab(k)}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {tab === "loop" && (t.graph
          ? <GraphDetails key={t.id} task={t} snapshot={s} request={api.request} run={run} />
          : <LoopDetails task={t} snapshot={s} request={api.request} run={run} />)}
        {tab === "result" && (
          <>
            {integration && (
              <div className="info-box vertical">
                <p>{integration.state === "unknown"
                  ? "整合结果未知，原工作区仍保留占用。"
                  : "正在核对并整合原工作区。"}</p>
                {integration.state === "unknown" && (
                  <button onClick={() => void run(async () => {
                    const result = await api.request({
                      op: "task.integration.reconcile",
                      id: t.id,
                      runId: integration.runId,
                      revision: t.revision,
                    });
                    return result;
                  })}>
                    只读核对整合结果
                  </button>
                )}
              </div>
            )}
            {r?.response ? (
              <RichText text={r.response} />
            ) : (
              <Empty
                icon={<FileText />}
                title="结果会留在这里"
                description="执行者的真实回复与产物形成后，在这里核对。"
              />
            )}
            {r?.diff && (
              <details>
                <summary>查看原生差异</summary>
                <pre className="diff">{r.diff}</pre>
              </details>
            )}
            {artifacts.map((a) => (
              <button
                className="artifact-row"
                key={a.id}
                onClick={() => onPreview(a.id)}
              >
                <FileText size={17} />
                <div>
                  <strong>{a.name}</strong>
                  <small>
                    {(a.size / 1024).toFixed(1)} KB · {a.hash.slice(0, 10)}
                  </small>
                </div>
                <ExternalLink size={14} />
              </button>
            ))}
            {r && <MobileDelivery key={r.id} task={t} run={r} files={resultArtifacts(artifacts, r)} request={api.mobile} />}
            {r && <><SaveReuse key={r.id + ":save"} snapshot={s} task={t} run={r} request={api.request} refresh={refresh} />
              <RecordReuse key={r.id + ":record"} snapshot={s} task={t} run={r} request={api.request} refresh={refresh} /></>}
            {r?.isolation && (
              <div className="info-box vertical">
                <p>独立工作区：{r.workPath}</p>
                <p>
                  {r.integratedAt
                    ? "此版本已整合"
                    : r.state === "ended" && !r.integrationVersion
                      ? "没有可核对的隔离版本；可查看或手动整合产物"
                      : "隔离产物尚未整合到原项目"}
                </p>
                {!r.integratedAt &&
                  !integration &&
                  r.state === "ended" &&
                  r.outcome === "completed" &&
                  !!r.integrationVersion &&
                  t.mode === "write" && (
                    <button
                      onClick={() =>
                        void run(() =>
                          api.request({
                            op: "task.integrate",
                            id: t.id,
                            revision: t.revision,
                          }),
                        )
                      }
                    >
                      核对基线并整合产物
                    </button>
                  )}
              </div>
            )}
            {!t.loopId && t.state === "verifying" && r && (
              <div className="accept-box">
                <p>
                  核对本版目标、原始回复和文件后，确认这项工作是否达到要求。
                </p>
                <button
                  className="primary"
                  onClick={() =>
                    void run(async () => {
                      const bytes = new TextEncoder().encode(
                        resultEvidence(r, resultArtifacts(artifacts, r)),
                      );
                      const digest = Array.from(
                        new Uint8Array(
                          await crypto.subtle.digest("SHA-256", bytes),
                        ),
                      )
                        .map((x) => x.toString(16).padStart(2, "0"))
                        .join("");
                      return api.request({
                        op: "task.control",
                        id: t.id,
                        action: "accept",
                        revision: t.revision,
                        runId: r.id,
                        evidenceHash: digest,
                      });
                    })
                  }
                >
                  <CheckCircle2 size={15} />
                  验收当前结果
                </button>
              </div>
            )}
            {r?.state === "unknown" && (
              <div className="info-box vertical">
                <AlertCircle size={18} />
                <p>执行状态未知，系统保留占用并禁止重复派发。</p>
                <button onClick={() => void onControl(t, "reconcile")}>
                  <RefreshCw size={14} />
                  核对原生状态
                </button>
              </div>
            )}
          </>
        )}
        {tab === "contract" && (
          <>
            <h3>目标 · v{t.revision}</h3>
            <p>{t.goal}</p>
            <h3>约束</h3>
            <p>{t.constraints || "未补充额外约束"}</p>
            <h3>交付依据</h3>
            <p>
              {t.acceptance ||
                "交付可核对的结果、实际检查和未解决项，由用户核对。"}
            </p>
            <h3>授权范围</h3>
            <p>
              {t.graph ? "仅在独立目录读取冻结文本和交付文件" : t.advance === "loop-native"
                ? "DSH 原生全权限 · 按任务授权操作"
                : t.mode === "read"
                ? "只读调查"
                : t.access === "codex" && !t.isolate
                  ? "沿用本机 Codex 权限"
                  : "项目内修改沙箱"}{" "}
              · {t.backend === "dsh" ? "DSH" : "Codex"} · 工具审批：
              {t.graph ? "不允许扩大范围" : t.advance === "loop-native"
                ? "由原生执行端处理"
                : t.backend === "dsh"
                ? "不允许扩大范围"
                : (r?.toolApproval || s.settings.toolApproval) === "never"
                  ? "不逐次询问"
                  : "按需询问"}
            </p>
            <code className="path">{p?.path}</code>
            <h3>执行 Agent 模型</h3>
            <p>
              {s.agents.find((a) => a.taskId === t.id)?.profile?.model ||
                s.settings.codexModel}{" "}
              ·{" "}
              {s.agents.find((a) => a.taskId === t.id)?.profile?.effort ||
                s.settings.memberEffort}
            </p>
            {t.attachments.length > 0 && (
              <>
                <h3>本轮附件</h3>
                <AttachmentInputs
                  ids={t.attachments}
                  current={r?.revision === t.revision ? r : undefined}
                  artifacts={s.artifacts}
                  onPreview={onPreview}
                />
              </>
            )}
            {!t.loopId && (
              <>
                <h3>预算</h3>
                <p>
                  已启动 {t.attempt} / {s.settings.maxRuns} 次 · 每次最长{" "}
                  {s.settings.maxMinutes} 分钟
                  <br />
                  金额未知，时间停止为软限制。
                </p>
              </>
            )}
          </>
        )}
        {tab === "history" &&
          s.runs
            .filter((x) => x.taskId === t.id)
            .reverse()
            .map((x) => (
              <article className="run-record" key={x.id}>
                <strong>
                  {x.state === "ended"
                    ? "回合已结束"
                    : x.state === "unknown"
                      ? "结果未知"
                      : "执行进行中"}{" "}
                  {t.advance === "loop-native" && (x.loopRole === "reviewer" ? "· 独立复核 " : "· 执行 ")}
                  · 要求 v{x.revision}
                </strong>
                <small>{time(x.startedAt)}</small>
                <p>原生结果：{x.outcome || "尚无结束证据"}</p>
                {x.nativeEndReason === "max-tokens" && (
                  <p>达到模型输出上限；本轮文件改动仍可核对。</p>
                )}
                <p>执行模型：{x.model || "未返回"}</p>
                {x.profile && (
                  <p>
                    本轮请求：{x.profile.model} · {effortName(x.profile.effort)}
                    {x.actualEffort ? "；原生回执强度：" + x.actualEffort : ""}
                    {x.actualSandbox ? "；原生沙箱：" + x.actualSandbox : ""}
                  </p>
                )}
                <code>{x.threadId || "尚无原生会话身份"}</code>
                <p>用量：{x.usage ? JSON.stringify(x.usage) : "未知"}</p>
                {!!x.attachmentInputs?.length && (
                  <details>
                    <summary>本回合附件</summary>
                    <AttachmentInputs
                      ids={x.attachmentInputs.map(({ id }) => id)}
                      current={x}
                      artifacts={s.artifacts}
                      onPreview={onPreview}
                    />
                  </details>
                )}
                {s.verifications
                  .filter((v) => v.runId === x.id)
                  .map((v) => (
                    <details key={v.id}>
                      <summary>
                        自动文件验收 · {v.passed ? "通过" : "未通过"}
                      </summary>
                      {v.evidence.map((e: any) => (
                        <p key={e.path}>
                          {e.path}：{e.reason}
                        </p>
                      ))}
                    </details>
                  ))}
                {s.fileChecks
                  .filter((c) => c.id === x.id)
                  .map((c) => (
                    <p key={c.id} className="field-help">
                      文件核对：
                      {c.truncated ? "清单不完整" : "当前扫描范围内完整"}。
                      {c.scope || c.error}
                    </p>
                  ))}
                {s.evidence
                  .filter((e) => e.runId === x.id)
                  .map((e) => (
                    <details key={e.id}>
                      <summary>
                        实际检查 · 退出码 {e.exitCode ?? "未知"}
                      </summary>
                      <pre>
                        {e.command}
                        {"\n"}
                        {e.output}
                      </pre>
                    </details>
                  ))}
              </article>
            ))}
      </div>
    </>
  );
}
function ApprovalCard({
  approval: a,
  run,
}: {
  approval: Approval;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div className="approval-card">
      <strong>{a.questions ? "执行者需要补充信息" : "原生执行请求"}</strong>
      <p>{a.detail}</p>
      {a.questions?.map((q) => (
        <label key={q.id}>
          {q.question}
          <input
            value={answers[q.id] || ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          />
        </label>
      ))}
      <small>{a.scopeReason} · 仅对当前任务版本有效</small>
      <div className="card-actions">
        <button
          disabled={!a.canAllow}
          className="primary"
          onClick={() =>
            void run(() =>
              api.request({
                op: "approval",
                id: a.id,
                revision: a.revision,
                allow: true,
                answers,
              }),
            )
          }
        >
          {a.questions ? "发送答复" : "允许本次"}
        </button>
        <button
          onClick={() =>
            void run(() =>
              api.request({
                op: "approval",
                id: a.id,
                revision: a.revision,
                allow: false,
              }),
            )
          }
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
function ProjectLocations({
  roots,
  run,
  refresh,
}: {
  roots: ProjectRoot[];
  run: (fn: () => Promise<any>) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [everything, setEverything] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .everything("status")
      .then((ok) => {
        if (active) setEverything(ok);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="project-locations" aria-label="本机查找位置">
      <div>
        <strong>本机查找位置</strong>
        <p className="field-help">
          选一次存放项目的父目录。只查直属文件夹；停止查找会保留已有项目。
        </p>
      </div>
      <div className="button-row">
        {everything && (
          <button onClick={() => void run(() => api.everything("browse"))}>
            <Search size={15} />在 Everything 中浏览
          </button>
        )}
        <button
          disabled={saving}
          onClick={() =>
            void run(async () => {
              setSaving(true);
              try {
                const path = await api.chooseDirectory("root");
                if (path) {
                  await api.request({ op: "projects.rootAdd", path });
                  await refresh();
                }
              } finally {
                setSaving(false);
              }
            })
          }
        >
          <FolderOpen size={15} />
          添加查找位置
        </button>
      </div>
      {roots.map((r) => (
        <div className="location-row" key={r.id}>
          <span className="path">{r.path}</span>
          <small>
            {r.status === "ready"
              ? "已检查"
              : r.status === "partial"
                ? "部分已检查"
                : r.status === "unavailable"
                  ? "暂不可访问"
                  : "等待检查"}
          </small>
          <button
            onClick={() =>
              void run(async () => {
                await api.request({ op: "projects.rootRemove", id: r.id });
                await refresh();
              })
            }
          >
            停止查找
          </button>
        </div>
      ))}
    </section>
  );
}
function NewProjectForm({
  roots,
  name: suggested,
  parent: initial,
  onClose,
  onDone,
}: {
  roots: ProjectRoot[];
  name?: string;
  parent?: string;
  onClose: () => void;
  onDone: (p: Project, created: boolean) => Promise<void>;
}) {
  const [parent, setParent] = useState(
      initial ||
        (roots.length === 1
          ? roots[0].path
          : roots.length
            ? ""
            : "D:\\projects"),
    ),
    [name, setName] = useState(suggested || ""),
    [saving, setSaving] = useState(false),
    [exists, setExists] = useState(""),
    [error, setError] = useState("");
  async function save(reuse = false) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.request({
        op: "project.create",
        parent,
        name,
        reuse,
      });
      if (result.status === "exists") setExists(result.path);
      else await onDone(result.project, result.status === "created");
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="新建本机项目" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          在选定位置创建一个空文件夹，以后可在此继续工作。
        </p>
        <label>
          存放位置
          <div className="input-action">
            <input
              aria-label="新项目父目录"
              list="project-parents"
              required
              value={parent}
              disabled={saving}
              onChange={(e) => {
                setParent(e.target.value);
                setExists("");
                setError("");
              }}
            />
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                try {
                  const p = await api.chooseDirectory("parent");
                  if (p) {
                    setParent(p);
                    setExists("");
                    setError("");
                  }
                } catch {
                  setError("目录选择失败");
                }
              }}
            >
              选择
            </button>
          </div>
        </label>
        <datalist id="project-parents">
          {roots.map((r) => (
            <option key={r.id} value={r.path} />
          ))}
        </datalist>
        <label>
          文件夹名
          <input
            aria-label="新项目文件夹名"
            required
            maxLength={100}
            disabled={saving}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setExists("");
              setError("");
            }}
          />
        </label>
        {parent && name && (
          <p className="field-help path">
            {parent.replace(/[\\/]+$/, "")}\{name}
          </p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {exists && (
          <p role="status">该目录已存在，可直接使用；原有文件会保留。</p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          {exists ? (
            <button
              type="button"
              className="primary"
              disabled={saving}
              onClick={() => void save(true)}
            >
              使用已有目录
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={saving || !name || !parent}
            >
              创建文件夹
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
function ProjectForm({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (path: string, name: string) => Promise<void>;
}) {
  const [path, setPath] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  return (
    <Modal title="添加本地项目" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(path, name);
        }}
      >
        <p className="muted">
          选择一个真实目录。名称只用于显示，目录和项目身份始终独立保存。
        </p>
        <label>
          项目目录
          <div className="input-action">
            <input
              aria-label="项目目录"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:\projects\my-project"
              required
            />
            <button
              type="button"
              onClick={() =>
                void api
                  .chooseDirectory()
                  .then((p) => {
                    if (p) {
                      setPath(p);
                      if (!name) setName(p.split(/[\\/]/).at(-1) || "");
                    }
                  })
                  .catch(() => setError("目录选择失败"))
              }
            >
              <FolderOpen size={16} />
              选择
            </button>
          </div>
        </label>
        <label>
          显示名称
          <input
            aria-label="项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：产品设计"
          />
        </label>
        {error && <p>{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            添加项目
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TaskForm({
  snapshot,
  projects,
  task,
  proposal,
  attachments,
  tasks,
  onAttachments,
  onClose,
  onSave,
}: {
  snapshot: Snapshot;
  projects: Project[];
  tasks: Task[];
  task?: Task;
  proposal?: any;
  attachments: Artifact[];
  onAttachments: (a: Artifact[]) => void;
  onClose: () => void;
  onSave: (value: any, profile?: ModelProfile, catalogVersion?: string) => Promise<void>;
}) {
  const [advance, setAdvance] = useState(
    task?.advance ?? (snapshot.settings.defaultAdvance === "single" ? "single" : "loop-native"),
  );
  const looping = advance !== "single";
  const nativeLoop = advance === "loop-native";
  const [graph, setGraph] = useState(!!task?.graph);
  const [graphInputs, setGraphInputs] = useState("");
  const [nativeGraphTools, setNativeGraphTools] = useState(true);
  const [standard, setStandard] = useState(false);
  const [elastic, setElastic] = useState(false);
  const [observeMinutes, setObserveMinutes] = useState(5);
  const [hardMinutes, setHardMinutes] = useState(snapshot.settings.maxMinutes);
  const [previewVideo, setPreviewVideo] = useState("");
  const [previewFrames, setPreviewFrames] = useState(6);
  const [preview, setPreview] = useState(false);
  const [research, setResearch] = useState(false);
  const [researchFields, setResearchFields] = useState(emptyResearch);
  const graphMode = nativeLoop && graph;
  const backend = looping
    ? "dsh"
    : task
      ? (task.backend ?? "codex")
      : snapshot.settings.executorBackend;
  const [goal, setGoal] = useState(
      proposal?.taskId === task?.id && task
        ? proposal.goal
        : task?.goal || proposal?.goal || "",
    ),
    [constraints, setConstraints] = useState(
      task?.constraints || proposal?.constraints || "",
    ),
    [acceptance, setAcceptance] = useState(
      task?.acceptance || proposal?.acceptance || "",
    ),
    [projectId, setProjectId] = useState(
      task?.projectId || (projects.length === 1 ? projects[0]?.id : "") || "",
    ),
    [mode, setMode] = useState(
      task
        ? task.mode === "read"
          ? "read"
          : task.access === "codex"
            ? "codex"
            : "write"
        : backend === "dsh"
          ? "write"
          : "codex",
    ),
    [profile, setProfile] = useState(() => executorProfile(snapshot.settings, backend)),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [isolate, setIsolate] = useState(task?.isolate || false),
    [checkPath, setCheckPath] = useState(task?.checks?.[0]?.path || ""),
    [checkContains, setCheckContains] = useState(
      task?.checks?.[0]?.contains || "",
    ),
    [dependency, setDependency] = useState(task?.dependencies[0] || "");
  const taskCatalog = !task && !looping ? snapshot.executorModels[backend] : undefined;
  const taskModelIssue = taskCatalog ? executorProfileIssue(taskCatalog, profile) : "";
  return (
    <Modal
      title={task ? "修改工作要求" : "创建一项工作"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (taskModelIssue) return;
          setError("");
          let graphValue;
          try {
            if (graphMode && !task) {
              const initial = research ? researchValue(researchFields, "research-main") : undefined;
              const inputs = graphInputs.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
              if (initial) inputs.push(initial.sample.path);
              const timing = elastic ? GraphTiming.safeParse({ observeMinutes, hardMinutes }) : undefined;
              if (timing && !timing.success) throw new Error(timing.error.issues[0].message);
              graphValue = { inputs: [...new Set(inputs)], nativeTools: nativeGraphTools, ...(initial && { research: [initial] }),
                ...(standard && !preview && { standard: true }),
                ...(timing?.success && { timing: timing.data }),
                ...(preview && { preview: { video: previewVideo.trim(), frames: previewFrames } }) };
            }
          } catch (err) {
            setError((err as Error).message);
            return;
          }
          setSaving(true);
          void onSave(
            {
              goal,
              projectId,
              constraints,
              acceptance,
              mode: mode === "read" ? "read" : "write",
              access:
                !looping && mode === "codex" && !isolate ? "codex" : "project",
              model: task?.model || "",
              attachments: attachments.map((a) => a.id),
              dependencies: dependency ? [dependency] : [],
              isolate: !looping && isolate,
              checks:
                !looping && checkPath
                  ? [{ path: checkPath, contains: checkContains }]
                  : [],
              ...(!task ? { advance, ...(graphValue && { graph: graphValue }) } : {}),
            },
            looping ? undefined : profile,
            taskCatalog?.catalogVersion,
          ).finally(() => setSaving(false));
        }}
      >
        <div className="form-grid">
          <label>
            项目
            <select
              aria-label="工作项目"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              required
              disabled={!!task}
            >
              <option value="">先添加一个项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            执行范围
            <select
              aria-label="执行范围"
              value={mode}
              onChange={(e) => setMode(e.target.value as any)}
              disabled={!!task || nativeLoop}
            >
              <option value="read">只读调查</option>
              {backend === "codex" && (
                <option value="codex">沿用本机 Codex 权限</option>
              )}
              <option value="write">{graphMode ? "独立工作目录" :
                nativeLoop ? "DSH 原生全权限" : "允许项目内修改"}</option>
            </select>
          </label>
        </div>
        {!task && (
          <AdvanceSelect
            value={advance}
            onChange={(next) => {
              setAdvance(next);
              if (next !== "single") setMode("write");
            }}
          />
        )}
        {!task && nativeLoop && <>
          <label className="check-label">
            <input type="checkbox" checked={graph} onChange={(e) => setGraph(e.target.checked)} />
            按成果并行（预览）
          </label>
          {graphMode && <label>
            <input type="checkbox" checked={nativeGraphTools} onChange={e => setNativeGraphTools(e.target.checked)} />
            使用 DSH 原生工具（可读取工作目录外的文件；需要限定读取时取消勾选）
          </label>}
          {graphMode && <label>
            授权读取的项目文本（可选，每行一个相对路径）
            <textarea rows={2} value={graphInputs} onChange={(e) => setGraphInputs(e.target.value)}
              placeholder="例如 docs/brief.md" />
          </label>}
          {graphMode && !preview && <>
            <label className="check-label">
              <input type="checkbox" checked={standard} onChange={(e) => setStandard(e.target.checked)} />
              开工前制定质量标准
            </label>
            {standard && <p className="field-help">先增加一项「质量标准」成果（至少两回合）：查找这类作品的优秀案例和理论，写出评分维度与达标线，之后的制作和复核都按它对照。联网查找需要勾选 DSH 原生工具，否则只凭模型已有知识。</p>}
          </>}
          {graphMode && <>
            <label className="check-label">
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
              主成果是独立视频预览
            </label>
            {preview && <div className="form-grid">
              <label>本地 MP4 视频（项目内相对路径）
                <input required value={previewVideo} onChange={(e) => setPreviewVideo(e.target.value)} placeholder="例如 demo.mp4" />
              </label>
              <label>预览帧数
                <input required type="number" min={1} max={60} value={previewFrames}
                  onChange={(e) => setPreviewFrames(e.target.valueAsNumber)} />
              </label>
              <p className="field-help">使用本机 FFmpeg；最多读取 20 MB，只在星引的预览目录写入。完成后仍需独立复核。</p>
            </div>}
            <label className="check-label">
              <input type="checkbox" checked={elastic} onChange={(e) => setElastic(e.target.checked)} />
              有可核对进展时延长观察
            </label>
            {elastic && <div className="form-grid">
              <label>进展检查间隔（分钟）
                <input type="number" min={1} max={179} value={observeMinutes}
                  onChange={(e) => setObserveMinutes(e.target.valueAsNumber)} />
              </label>
              <label>单回合硬截止（分钟）
                <input type="number" min={2} max={180} value={hardMinutes}
                  onChange={(e) => setHardMinutes(e.target.valueAsNumber)} />
              </label>
              <p className="field-help">只有新产物等可核对进展才会续时；最晚停止时间不延长。</p>
            </div>}
            <label className="check-label">
              <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
              为主成果登记研究决定
            </label>
            {research && <>
              <p className="field-help">你指定的小样文本会在开工前冻结。</p>
              <ResearchFieldsForm fields={researchFields} set={setResearchFields} />
            </>}
          </>}
        </>}
        <label>
          希望完成什么？
          <textarea
            autoFocus
            aria-label="工作目标"
            rows={3}
            required
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="描述要达到的结果，而不是每一个操作步骤。"
          />
        </label>
        <label>
          约束与边界
          <textarea
            aria-label="工作约束"
            rows={2}
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            placeholder="例如：只调查原因，不修改文件；不要推送或发布。"
          />
        </label>
        <label>
          怎样判断完成？
          <textarea
            aria-label="验收要求"
            rows={2}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder="可以写具体检查，也可以写希望回答的问题与需要的证据。"
          />
        </label>
        {!task && !looping && (
          <ProfilePicker
            s={snapshot}
            backend={backend}
            value={profile}
            onChange={setProfile}
            verified
          />
        )}
        <details>
          <summary>协作、自动验收与附件</summary>
          {!looping && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={isolate}
                  disabled={!!task}
                  onChange={(e) => setIsolate(e.target.checked)}
                />
                在独立工作区执行，完成后核对整合
              </label>
              <p className="field-help">
                Git 项目从当前 HEAD 建立 worktree；非 Git
                项目使用空输出目录，原目录仅供读取参考。未提交修改不会复制。
              </p>
            </>
          )}
          <label>
            依赖的前置工作
            <select
              value={dependency}
              disabled={!!task}
              onChange={(e) => setDependency(e.target.value)}
            >
              <option value="">无依赖</option>
              {tasks
                .filter((t) => t.id !== task?.id && !t.archived)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
          {!looping && (
            <>
              <label>
                自动验收文件（可选，相对于执行目录）
                <input
                  value={checkPath}
                  onChange={(e) => setCheckPath(e.target.value)}
                  placeholder="例如 output/report.md"
                />
              </label>
              <label>
                文件必须包含的文本
                <input
                  value={checkContains}
                  onChange={(e) => setCheckContains(e.target.value)}
                  placeholder="留空只检查文件存在"
                />
              </label>
              <p className="field-help">
                填写即确认这些文件检查足以判定完成。未通过时在现有范围及总次数额度内最多自动修正
                2 次；定性任务请留空，由你核对完整交付。
              </p>
            </>
          )}
          <div className="attachment-chips">
            {attachments.map((a) => (
              <span key={a.id}>
                <FileText size={13} />
                {a.name}
                <button
                  type="button"
                  onClick={() =>
                    onAttachments(attachments.filter((x) => x.id !== a.id))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          {!graphMode && <button
            type="button"
            onClick={() =>
              void api
                .attach()
                .then((a) => onAttachments([...attachments, ...a]))
                .catch(() => setError("附件读取失败"))
            }
          >
            <Paperclip size={15} />
            {backend === "dsh" ? "选择文件" : "选择文件 / 图片"}
          </button>}
        </details>
        <div className="info-box">
          <ShieldCheck size={18} />
          <span>
            {graphMode ? (
              "分支使用独立目录和选定的项目文本。成果组合并独立复核后，可在结果页核对并整合回项目。"
            ) : nativeLoop ? (
              "执行和复核 Agent 都可用本机原生工具。星引负责衔接回合；操作须遵守任务授权。"
            ) : looping ? (
              "循环由 DSH 在原目录执行。检查会运行项目代码，请在信任的项目上开启。"
            ) : (
              <>
                {backend === "dsh" ? "DSH " : "Codex "}
                {mode === "codex" && !isolate
                  ? "允许使用本机 Codex 的有效权限。"
                  : "仅在所选沙箱内执行。"}
                工具审批：
                {backend === "dsh"
                  ? "不允许扩大范围"
                  : snapshot.settings.toolApproval === "never"
                    ? "不逐次询问"
                    : "按需询问"}
                。文件附件仅在派发时交给执行端。
              </>
            )}
          </span>
        </div>
        {error && <p>{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={!projectId || saving || (looping && mode === "read") || !!taskModelIssue}
            type="submit"
          >
            {saving
              ? "正在保存…"
              : task
                ? "保存新要求"
                : looping
                  ? "创建并推进"
                  : "创建并开始"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SettingsPage({
  snapshot: s,
  notify,
  run,
  refresh,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [cfg, setCfg] = useState<Settings>(s.settings),
    [testing, setTesting] = useState("");
  const set = (k: keyof Settings, v: any) => setCfg({ ...cfg, [k]: v });
  const official = cfg.apiSource === "deepseek";
  const sameTarget =
    cfg.apiSource === s.settings.apiSource &&
    apiTarget(cfg).endpoint === apiTarget(s.settings).endpoint;
  const preview = {
    ...s,
    settings: cfg,
    models: sameTarget ? s.models : { ids: [] },
  };
  async function save() {
    await api.request({ op: "settings", value: cfg });
    notify("设置已保存，后续调用使用新配置。");
  }
  async function test(op: string) {
    setTesting(op);
    await run(async () => {
      await save();
      const result = await api.request({ op });
      notify(
        op === "model.list"
          ? `读取到 ${result.length} 个模型`
          : op.endsWith(".probe")
            ? `${op === "dsh.probe" ? "DSH" : "Codex"} · ${result.status}`
            : `连接成功 · ${result.model}`,
      );
    });
    setTesting("");
  }
  return (
    <div className="page settings-page">
      <PageTitle
        title="让星引按你的方式工作"
        subtitle="选择总管和讨论使用的 API，以及新工作使用的执行端。"
        action={
          <button className="primary" onClick={() => void run(save)}>
            <Check size={16} />
            保存设置
          </button>
        }
      />
      <section className="settings-section" aria-label="执行模型目录">
        <ExecutorDefaults settings={s.settings} catalogs={s.executorModels}
          blocked={{ codex: cfg.codexPath !== s.settings.codexPath || cfg.codexCredentialEnv !== s.settings.codexCredentialEnv,
            dsh: cfg.dshPath !== s.settings.dshPath || !sameTarget }} request={api.request}
          refresh={refresh} saving={() => {}} saved={source => { set("executorBackend", source); notify("新工作的默认执行模型已保存"); }} />
      </section>
      <section className="settings-section">
        <div className="section-title">
          <Sparkles size={20} />
          <div>
            <h2>总管模型</h2>
            <p>每次调用保留实际模型与用量，不自动切换模型。</p>
          </div>
          <span
            className={`badge ${sameTarget && s.keyConfigured ? "done" : "blocked"}`}
          >
            {!sameTarget
              ? "保存后查看密钥状态"
              : s.keyConfigured
                ? "密钥已加密保存"
                : "尚未配置密钥"}
          </span>
        </div>
        <label>
          API 来源
          <select
            aria-label="API 来源"
            value={cfg.apiSource}
            onChange={(e) => set("apiSource", e.target.value)}
          >
            <option value="custom">自定义 API</option>
            <option value="deepseek">DeepSeek 官方 Key</option>
          </select>
        </label>
        <label>
          API 基础地址
          <input
            aria-label="API 基础地址"
            readOnly={official}
            value={apiTarget(cfg).endpoint}
            onChange={(e) => set("endpoint", e.target.value)}
            placeholder={CUSTOM_ENDPOINT}
          />
        </label>
        <div className="form-grid">
          <label>
            接口协议
            <select
              disabled={official}
              value={apiTarget(cfg).protocol}
              onChange={(e) => set("protocol", e.target.value)}
            >
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
        </div>
        <ProfilePicker
          s={preview}
          backend="api"
          value={defaultProfile(cfg, true)}
          beforeLoad={save}
          onChange={(p) =>
            setCfg({ ...cfg, model: p.model, reasoningEffort: p.effort })
          }
        />
        <p className="field-help">
          {sameTarget && s.models.verified && cfg.model === s.settings.model
            ? `请求已验证：${s.models.verified}`
            : "模型候选不代表调用权限已验证。支持手动输入模型 ID。"}
        </p>
        <div className="button-row">
          <button
            onClick={() =>
              void run(async () => {
                await save();
                await api.credentials();
              })
            }
          >
            <KeyRound size={15} />
            {official ? "录入 DeepSeek 官方 Key" : "自定义 API 密钥设置"}
          </button>
          <button disabled={!!testing} onClick={() => void test("model.list")}>
            <RefreshCw size={15} />
            读取模型列表
          </button>
          <button disabled={!!testing} onClick={() => void test("model.test")}>
            <Activity size={15} />
            {testing === "model.test" ? "测试中…" : "测试连接"}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <Terminal size={20} />
          <div>
            <h2>托管执行端</h2>
            <p>新建工作使用所选后端；已有工作继续使用原来的执行端。</p>
          </div>
        </div>
        <label>
          新工作的执行端
          <select
            aria-label="新工作的执行端"
            value={cfg.executorBackend}
            onChange={(e) => set("executorBackend", e.target.value)}
          >
            <option value="dsh">DSH · DeepSeek Harness</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        {cfg.executorBackend === "dsh" && (
          <>
            <label>
              DeepSeek Harness 程序路径
              <input
                aria-label="DSH 路径"
                value={cfg.dshPath}
                onChange={(e) => set("dshPath", e.target.value)}
                placeholder="留空自动查找 DeepSeek Harness.exe"
              />
            </label>
            <div className="button-row">
              <button
                disabled={!!testing}
                onClick={() => void test("dsh.probe")}
              >
                <RefreshCw size={15} />
                {testing === "dsh.probe" ? "正在握手…" : "检测 DSH 连接"}
              </button>
              <span className="muted small">
                {s.dsh.status}
                {s.dsh.version && " · " + s.dsh.version}
              </span>
            </div>
            <p className="field-help">
              DSH 使用上面所选的 API 和
              Key，支持文本任务、读取和项目内文件修改。需要执行终端命令或传图片时选择
              Codex。
            </p>
          </>
        )}
        {cfg.executorBackend === "codex" && (
          <label>
            Codex CLI 路径
            <div className="input-action">
              <input
                aria-label="Codex 路径"
                value={cfg.codexPath}
                onChange={(e) => set("codexPath", e.target.value)}
                placeholder="选择 codex.exe"
              />
              <button
                onClick={() =>
                  void run(async () => {
                    const p = await api.chooseCodex();
                    if (p) set("codexPath", p);
                  })
                }
              >
                选择
              </button>
            </div>
          </label>
        )}
        <h3>新建非总管 Agent 的默认配置</h3>
        <ProfilePicker
          s={preview}
          backend={cfg.executorBackend}
          value={defaultProfile(cfg)}
          beforeLoad={save}
          onChange={(p) =>
            setCfg({ ...cfg, codexModel: p.model, memberEffort: p.effort })
          }
        />
        <p className="field-help">
          讨论、执行和更深层节点创建时可以沿用或更换；已有节点在各自对话里修改。
        </p>
        {cfg.executorBackend === "codex" && (
          <>
            <label>
              托管执行的工具审批
              <select
                aria-label="工具审批"
                value={cfg.toolApproval}
                onChange={(e) =>
                  set(
                    "toolApproval",
                    e.target.value as Settings["toolApproval"],
                  )
                }
              >
                <option value="never">不逐次询问（never）</option>
                <option value="on-request">需要时询问（on-request）</option>
              </select>
            </label>
            <p className="field-help">
              默认执行范围沿用本机 Codex
              权限。只读和项目沙箱可在创建工作时单独选择；执行者提出的业务问题仍会送达。
            </p>
            <label>
              原生提供商凭据变量名
              <input
                value={cfg.codexCredentialEnv}
                onChange={(e) => set("codexCredentialEnv", e.target.value)}
                placeholder="例如 ALCOR_NATIVE_API_KEY；使用原生登录时留空"
              />
            </label>
            <button
              onClick={() =>
                void run(async () => {
                  await save();
                  await api.credentials(true);
                })
              }
            >
              <KeyRound size={15} />
              配置独立的 Codex 凭据
            </button>
            <div className="button-row">
              <button
                disabled={!!testing}
                onClick={() => void test("codex.probe")}
              >
                <RefreshCw size={15} />
                {testing === "codex.probe" ? "正在检测…" : "检测安装与登录"}
              </button>
              <span className="muted small">
                {s.codex.version || "支持范围：" + CODEX_CLI_VERSIONS.join("、")} ·{" "}
                {s.codex.status}
              </span>
            </div>
            {s.codex.error && <p className="error-text">{s.codex.error}</p>}
          </>
        )}
      </section>
      <section className="settings-section">
        <div className="section-title"><Terminal size={20} /><div>
          <h2>DSH 原桌面桥</h2>
          <p>连接已授权的 DSH Remote 桥。此地址和令牌与托管执行的模型 API 分开保存。</p>
        </div></div>
        <label>DSH 原桌面桥地址
          <input value={cfg.dshDesktopUrl} onChange={(e) => set("dshDesktopUrl", e.target.value)}
            placeholder="例如 https://已配置的桥接地址/ui" />
        </label>
        <button onClick={() => void run(async () => { await save(); await api.credentials("dsh-desktop"); })}>
          <KeyRound size={15} /> 配置 DSH 原桌面桥令牌
        </button>
        <p className="field-help">保存后在「原生会话」选择 DSH 和项目。续聊沿用原会话的权限；停止请在 DSH 原窗口操作。</p>
      </section>
      <MobileSettings projects={s.projects} call={api.mobile} />
      <LoopSettings value={cfg} onChange={setCfg} />
      <section className="settings-section">
        <div className="section-title">
          <ShieldCheck size={20} />
          <div>
            <h2>运行与桌面</h2>
            <p>时间和次数约束新派发；原生费用未提供时显示未知。</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            并发工作上限
            <input
              type="number"
              min={1}
              max={4}
              value={cfg.concurrency}
              onChange={(e) => set("concurrency", Number(e.target.value))}
            />
          </label>
          <label>
            每项工作最多尝试
            <input
              type="number"
              min={1}
              max={10}
              value={cfg.maxRuns}
              onChange={(e) => set("maxRuns", Number(e.target.value))}
            />
          </label>
          <label>
            单次与清单任务运行上限（分钟；原生循环使用任务预算）
            <input
              type="number"
              min={1}
              max={120}
              value={cfg.maxMinutes}
              onChange={(e) => set("maxMinutes", Number(e.target.value))}
            />
          </label>
          <label>
            总管输出 token 上限
            <input
              type="number"
              min={256}
              max={16000}
              value={cfg.maxOutputTokens}
              onChange={(e) => set("maxOutputTokens", Number(e.target.value))}
            />
          </label>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={cfg.background}
            onChange={(e) => set("background", e.target.checked)}
          />
          <span>
            关闭窗口后保留后台执行
            <small>系统托盘菜单可完整退出；默认关闭。</small>
          </span>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={cfg.notifications}
            onChange={(e) => set("notifications", e.target.checked)}
          />
          <span>
            新结果使用系统通知<small>每次运行结束只通知一次。</small>
          </span>
        </label>
        <label>
          外观
          <select
            value={cfg.theme}
            onChange={(e) => set("theme", e.target.value)}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <option value="system">跟随系统</option>
          </select>
        </label>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <History size={20} />
          <div>
            <h2>数据与恢复</h2>
            <p>备份不含密钥；工作区文件与原生 Codex 历史由原位置维护。</p>
          </div>
        </div>
        <p className="path">{s.dataDir}</p>
        <div className="button-row">
          <button
            onClick={() =>
              void run(async () => {
                const r = await api.request({ op: "backup" });
                notify(`备份完成：${r.path}`);
              })
            }
          >
            <Download size={15} />
            一致性备份
          </button>
          <button
            onClick={() =>
              void run(async () => {
                const r = await api.restore();
                if (r) notify("恢复完成，未完成工作需核对后继续。");
              })
            }
          >
            <RotateCcw size={15} />
            从备份恢复
          </button>
          <button
            onClick={() =>
              void run(async () => {
                const r = await api.request({ op: "diagnostics" });
                notify(`脱敏诊断已导出：${r.path}`);
              })
            }
          >
            导出诊断
          </button>
          <button
            onClick={() =>
              void run(async () => {
                const r = await api.dataDirectory();
                if (r) notify(`下次启动使用：${r.path}。现有数据未迁移。`);
              })
            }
          >
            选择数据目录
          </button>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <Activity size={20} />
          <div>
            <h2>最近模型调用</h2>
            <p>只显示配置和用量，不显示认证信息。</p>
          </div>
        </div>
        {s.invocations.length === 0 ? (
          <p className="muted">暂无调用记录</p>
        ) : (
          s.invocations
            .slice(-8)
            .reverse()
            .map((i) => (
              <div className="invocation" key={i.id}>
                <strong>{i.actualModel || i.config?.model}</strong>
                <span>{i.status}</span>
                <small>
                  {i.usage
                    ? `${i.usage.total_tokens ?? i.usage.input_tokens ?? "?"} tokens`
                    : "用量 / 费用未知"}
                </small>
              </div>
            ))
        )}
      </section>
    </div>
  );
}
const nativeDrafts = new Map<string, string>();
function Preview({
  value: v,
  snapshot: s,
  onClose,
  run,
  onOpenAgent,
}: {
  value: any;
  snapshot: Snapshot;
  onOpenAgent: (id: string) => void;
  onClose: () => void;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [nativeProjects, setNativeProjects] = useState<any>();
  const nativeScope = "native:" + JSON.stringify([v.projectId, v.threadId, v.source]),
    nativeEcho = useOutgoing(nativeScope),
    nativeSending = useSending(nativeScope);
  const sessionActions: any[] = v.type === "session" ? v.actions || [] : [];
  const nativeActions = sessionActions.filter((x) => x.kind === "owner-send" && x.text);
  const nativeCheckError = nativeActions.findLast((action) => action.checkError)?.checkError;
  const unresolved = nativeActions.some((x) => x.state === "unknown" || x.state === "dispatching");
  const stopAction = sessionActions.findLast((x) => x.kind === "owner-stop" && x.state !== "rejected");
  const [stopNotice, setStopNotice] = useState("");
  const activeTurnId: string | null = v.activeTurnId;
  const refreshNative = async () => {
    try {
      Object.assign(v, await api.request({ op: "session.read", projectId: v.projectId, threadId: v.threadId, source: v.source }));
      setRefreshVersion((n) => n + 1);
    } catch (error) {
      onClose();
      throw error;
    }
  };
  const inNativeHistory = (id: string, turnId?: string) =>
    v.turns?.some((t: any) =>
      t.items?.some(
        (i: any) =>
          i.type === "userMessage" &&
          (i.id === id || i.clientId === id || (!i.clientId && !!turnId && t.id === turnId)),
      ),
    );
  useEffect(() => {
    if (v.type === "session")
      outgoing.reconcile(nativeScope, [
        ...nativeActions.map((x) => x.id),
        ...nativeEcho
          .filter((e) => !v.offline && inNativeHistory(e.id, e.turnId))
          .map((e) => e.id),
      ]);
  }, [v, refreshVersion, nativeScope, nativeEcho]);
  const [text, setText] = useState(
      v.type === "session"
        ? nativeDrafts.get(nativeScope) || ""
        : v.memory?.text || v.project?.name || "",
    ),
    [projectId, setProjectId] = useState(v.memory?.projectId || ""),
    [enabled, setEnabled] = useState(v.memory?.enabled ?? true);
  if (v.type === "artifact")
    return (
      <Modal title={v.name} onClose={onClose} wide>
        <p className="muted small">
          版本 {v.hash.slice(0, 16)} · {v.origin === "attachment" ? "本地附件副本" : v.status}
        </p>
        {v.kind === "image" ? (
          <img className="artifact-image" src={v.content} alt={v.name} />
        ) : v.kind === "text" ? (
          <RichText text={v.content} />
        ) : (
          <p>此格式无法在应用内安全预览，请在文件夹中查看。</p>
        )}
        <div className="modal-actions">
          <button onClick={() => void run(() => api.reveal(v.id))}>
            <FolderOpen size={15} />
            在文件夹中定位
          </button>
        </div>
      </Modal>
    );
  if (v.type === "session")
    return (
      <Modal
        title={v.source ? (v.offline ? "DSH 原生会话 · 离线只读" : "DSH 原生会话") : v.offline ? "原生会话 · 离线只读" : v.ownerAvailable ? "原生会话 · 原窗口在线" : "原生会话 · 只读"}
        onClose={onClose}
        wide
      >
        <p className="info-box">{v.note}</p>
        {v.offline && v.cachedAt && <p className="muted">副本保存于 {time(v.cachedAt)}。</p>}
        {!v.offline && v.ownerAvailable && !v.source && (
          <p className="field-help" role="status">
            {v.ownerRuntime === "active"
              ? activeTurnId
                ? "原窗口：回合正在运行。"
                : "原窗口正在运行，回合编号尚未核对。"
              : v.ownerRuntime === "idle"
                ? "原窗口：当前没有运行中的回合。"
                : "原窗口运行状态尚未核对。"}
          </p>
        )}
        {(stopNotice || stopAction) && (
          <p className="field-help" role="status">
            {stopNotice || (stopAction.stopResult
              ? stopAction.stopResult.status === "interrupted"
                ? "已核对原窗口：目标回合已停止。"
                : "已核对原窗口：目标回合已结束，未标记为停止。"
              : stopAction.state === "accepted"
                ? "原窗口已接收停止请求，等待回合结束回执。"
                : "停止回执尚未核对，请核对原窗口。")}
          </p>
        )}
        <div className="button-row">
          <button
            disabled={v.offline}
            onClick={() =>
              void run(async () => {
                const x = await api.request({
                  op: "discussion.fromNative",
                  projectId: v.projectId,
                  threadId: v.threadId,
                  source: v.source,
                  requestId: crypto.randomUUID(),
                });
                if (x.openAgentId) onOpenAgent(x.openAgentId);
                else onClose();
              })
            }
          >
            引用到新的星引讨论
          </button>
          <button
            onClick={() => void run(refreshNative)}
          >
            <RefreshCw size={14} />
            核对最新历史
          </button>
        </div>
        <div className="native-chat">
          {v.turns.map((t: any) => (
            <div key={t.id}>
              <h3>
                {t.id === activeTurnId ? "原窗口运行中" : "已保存历史 · " + t.status} · {t.id}
              </h3>
              {t.items
                ?.filter((i: any) =>
                  ["userMessage", "agentMessage"].includes(i.type),
                )
                .map((i: any) => (
                  <article
                    className={
                      "search-result native-message " +
                      (i.type === "userMessage"
                        ? "native-user"
                        : "native-assistant")
                    }
                    key={i.id}
                  >
                    {i.type !== "userMessage" && <small>执行者</small>}
                    <RichText
                      text={
                        i.text ||
                        i.content
                          ?.filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n") ||
                        ""
                      }
                    />
                  </article>
                ))}
            </div>
          ))}
          {nativeActions
            .filter((x) => x.state !== "accepted" || !inNativeHistory(x.id, x.turnId))
            .map((x) => (
              <article key={x.id} className="native-message native-user">
                <small>
                  {x.state === "accepted"
                    ? v.source ? "DSH 已接收" : "原窗口已接收"
                    : x.state === "unknown"
                      ? "送达未确认"
                      : x.state === "rejected"
                        ? "未送达"
                        : "正在发送…"}
                </small>
                <RichText text={x.text} />
              </article>
            ))}
          {nativeEcho
            .filter(
              (e) =>
                !nativeActions.some((x) => x.id === e.id) &&
                !inNativeHistory(e.id, e.turnId),
            )
            .map((e) => (
              <article key={e.id} className="native-message native-user">
                <small>{echoLabels[e.state]}</small>
                <RichText text={e.text} />
                {e.state === "failed" && (
                  <button
                    className="inline-link"
                    disabled={!!text}
                    onClick={() => setText(e.text)}
                  >
                    放回输入框
                  </button>
                )}
              </article>
            ))}
        </div>
        {unresolved && (
          <p className="field-help">有消息尚未确认送达。核对最新历史后可继续，星引不会重复发送。</p>
        )}
        {v.workspacePending && !unresolved && (
          <p className="field-help">该目录仍有原窗口工作或整合结果待核对。结束后可点「核对最新历史」刷新。</p>
        )}
        {nativeCheckError && (
          <p className="field-help" role="status">{nativeCheckError}</p>
        )}
        {v.ownerAvailable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = text.trim();
              if (!value || unresolved || v.workspacePending || outgoing.busy(nativeScope)) return;
              const echo = outgoing.begin(nativeScope, value, "你");
              nativeDrafts.delete(nativeScope);
              setText("");
              void run(async () => {
                try {
                  const receipt = await api.request({
                    op: "session.send",
                    projectId: v.projectId,
                    threadId: v.threadId,
                    source: v.source,
                    text: value,
                    requestId: echo.id,
                  });
                  outgoing.update(nativeScope, echo.id, {
                    state:
                      receipt.state === "accepted" ? "accepted" : "unknown",
                    turnId: receipt.turnId,
                  });
                  void run(refreshNative);
                } catch (error) {
                  outgoing.reject(nativeScope, echo.id, error);
                  void run(refreshNative);
                  throw error;
                } finally {
                  outgoing.finish(nativeScope, echo.id);
                }
              });
            }}
          >
            <label>
              {v.source ? "通过 DSH 原桌面桥继续此会话" : "通过原 owner 继续此会话"}
              <textarea
                value={text}
                onChange={(e) => {
                  nativeDrafts.set(nativeScope, e.target.value);
                  setText(e.target.value);
                }}
                rows={3}
                maxLength={24000}
                placeholder="消息交给原生会话，沿用其权限与模型。"
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                type="submit"
                disabled={!text.trim() || nativeSending || unresolved || v.workspacePending}
              >
                发送到原生会话
              </button>
              {activeTurnId && (
                <button
                  type="button"
                  disabled={stopAction?.turnId === activeTurnId}
                  onClick={() =>
                    void run(async () => {
                      setStopNotice("");
                      try {
                        const result = await api.request({
                          op: "session.stop",
                          projectId: v.projectId,
                          threadId: v.threadId,
                          turnId: activeTurnId,
                        });
                        if (!result.requested && result.message) setStopNotice(result.message);
                      } finally {
                        void run(refreshNative);
                      }
                    })
                  }
                >
                  <Square size={13} />
                  请求停止
                </button>
              )}
            </div>
          </form>
        )}
        {!v.ownerAvailable && (
          <p className="field-help">
            {v.ownerReason} 当前保持只读。
          </p>
        )}
      </Modal>
    );
  if (v.type === "project-edit")
    return (
      <Modal title="管理项目绑定" onClose={onClose}>
        <label>
          显示名称
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="path">{v.project.path}</p>
        <p className="field-help">
          原生项目绑定：{v.project.nativeProjectId || "未绑定"}
          。目录相同是核对依据，名称不用于自动合并。
        </p>
        <button
          onClick={() =>
            void run(async () =>
              setNativeProjects(
                await api.request({
                  op: "project.nativeCandidates",
                  id: v.project.id,
                }),
              ),
            )
          }
        >
          查找目录匹配的原生项目
        </button>
        {nativeProjects && (
          <label>
            手动校正原生绑定
            <select
              defaultValue={v.project.nativeProjectId || ""}
              onChange={(e) =>
                void run(async () => {
                  await api.request({
                    op: "project.nativeBind",
                    id: v.project.id,
                    nativeProjectId: e.target.value,
                  });
                  v.project.nativeProjectId = e.target.value;
                  setRefreshVersion(refreshVersion + 1);
                })
              }
            >
              <option value="">不绑定原生项目</option>
              {nativeProjects.items.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.id}
                </option>
              ))}
            </select>
            <small>
              只修改星引绑定及后续新建会话归属，不修改既有原生历史。
              {nativeProjects.incomplete ? "当前候选目录未完整加载。" : ""}
            </small>
          </label>
        )}
        <p className="muted">移除绑定不会删除实际目录或原生历史。</p>
        <div className="modal-actions">
          <button
            className="danger-text"
            onClick={() =>
              void run(async () => {
                await api.request({
                  op: "project.update",
                  id: v.project.id,
                  remove: true,
                });
                onClose();
              })
            }
          >
            移除索引
          </button>
          <button
            className="primary"
            onClick={() =>
              void run(async () => {
                await api.request({
                  op: "project.update",
                  id: v.project.id,
                  name: text,
                });
                onClose();
              })
            }
          >
            保存名称
          </button>
        </div>
      </Modal>
    );
  if (v.type === "memory-delete")
    return (
      <Modal title="删除这条规则？" onClose={onClose}>
        <p>
          规则正文会删除，后续上下文不再注入。删除标记在恢复旧备份后仍然有效。原生
          Codex 历史中的旧文本不会被自动删除。
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="danger"
            onClick={() =>
              void run(async () => {
                await api.request({ op: "memory.delete", id: v.memory.id });
                onClose();
              })
            }
          >
            确认删除
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title={v.memory ? "编辑明确规则" : "添加明确规则"} onClose={onClose}>
      <label>
        规则内容
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="写下你希望后续工作遵守的明确规则。"
        />
      </label>
      <label>
        作用范围
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">所有项目</option>
          {s.projects
            .filter((p) => !p.removed)
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用规则
      </label>
      <p className="field-help">
        规则改变时，相关运行会请求暂停；继续后从当前有效规则建立上下文。
      </p>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button
          disabled={!text.trim()}
          className="primary"
          onClick={() =>
            void run(async () => {
              await api.request({
                op: "memory.save",
                id: v.memory?.id,
                text,
                projectId,
                enabled,
              });
              onClose();
            })
          }
        >
          保存规则
        </button>
      </div>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
