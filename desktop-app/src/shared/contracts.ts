import { z } from "zod";
import {
  AdvanceSchema,
  CheckInput,
  CriterionChange,
  CriterionInput,
  LoopAddition,
  LoopBudgetSchema,
  LoopCloseSchema,
  MissCategorySchema,
  type Advance,
  type Loop,
  type Criterion,
  type Check,
  type CheckRun,
  type Finding,
} from "./loop-contracts";
import { GraphInput, type GraphAttempt } from "./native-graph";
import { ResearchSpec } from "./research";

export const VERSION = 1;
export const APP_VERSION = "0.2.1";
export const CHIEF = "chief";
export const CHIEF_MODEL = "deepseek-flash",
  MEMBER_MODEL = CHIEF_MODEL;
export const CUSTOM_ENDPOINT = "https://example.invalid/v1";
export const OFFICIAL_ENDPOINT = "https://api.deepseek.com";
export type ExecutorBackend = "codex" | "dsh";
export const CODEX_CLI_VERSIONS = ["0.169.0-alpha.11.1", "0.169.1"] as const;
export const DshUsageSchema = z
  .object({
    requests: z.number().int().positive(),
    knownRequests: z.number().int().nonnegative(),
    tokensKnown: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((usage) => usage.knownRequests <= usage.requests);
export type DshUsage = z.infer<typeof DshUsageSchema>;
export const DshEndReason = z.enum([
  "completed",
  "interrupted",
  "aborted",
  "max-tokens",
  "blocked",
  "error",
]);
export const EffortSchema = z.enum([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type Effort = z.infer<typeof EffortSchema>;
export const ProfileSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.:_/@-]*$/, "请输入模型 ID"),
    effort: EffortSchema,
  })
  .strict();
export type ModelProfile = z.infer<typeof ProfileSchema>;
export interface ModelEntry {
  id: string;
  efforts: Effort[];
}
export const SettingsSchema = z
  .object({
    apiSource: z.enum(["custom", "deepseek"]).default("custom"),
    // These two fields belong to the custom connection even when official is selected.
    endpoint: z.string().max(500).default(CUSTOM_ENDPOINT),
    protocol: z.enum(["responses", "chat"]).default("chat"),
    model: ProfileSchema.shape.model.default(CHIEF_MODEL),
    reasoningEffort: EffortSchema.default("max"),
    memberEffort: EffortSchema.default("max"),
    profileVersion: z.literal(2).default(2),
    executorBackend: z.enum(["dsh", "codex"]).default("dsh"),
    dshPath: z.string().max(1000).default(""),
    dshDesktopUrl: z.string().trim().max(500).default(""),
    toolApproval: z.enum(["never", "on-request"]).default("never"),
    codexPath: z.string().max(1000).default(""),
    codexModel: ProfileSchema.shape.model.default(MEMBER_MODEL),
    codexCredentialEnv: z
      .string()
      .regex(/^(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN))?$/)
      .max(100)
      .default(""),
    theme: z.enum(["light", "dark", "system"]).default("light"),
    background: z.boolean().default(false),
    notifications: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(4).default(2),
    maxMinutes: z.number().int().min(1).max(120).default(20),
    maxRuns: z.number().int().min(1).max(10).default(3),
    maxOutputTokens: z.number().int().min(256).max(16000).default(4000),
    defaultAdvance: AdvanceSchema.default("single"),
    loopCloseMode: LoopCloseSchema.default("auto"),
    loopBudget: LoopBudgetSchema.default({}),
    checkPath: z.array(z.string().min(1).max(500)).max(8).default([]),
    advisorModel: ProfileSchema.shape.model.or(z.literal("")).default(""),
    revision: z.number().int().default(1),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const defaults = SettingsSchema.parse({});
export function apiTarget(s: Settings) {
  return s.apiSource === "deepseek"
    ? { endpoint: OFFICIAL_ENDPOINT, protocol: "chat" as const }
    : { endpoint: s.endpoint, protocol: s.protocol };
}
export function readSettings(v: any = {}): Settings {
  if (v.profileVersion === 2) return SettingsSchema.parse(v);
  const oldChief =
    !v.model ||
    (!v.profileVersion && v.model === "gpt-6.1-sol") ||
    (v.model === "gpt-6.2-astra" && (v.reasoningEffort ?? "max") === "max");
  return SettingsSchema.parse({
    ...v,
    profileVersion: 2,
    endpoint: v.endpoint || CUSTOM_ENDPOINT,
    protocol:
      oldChief &&
      (!v.endpoint || v.endpoint.replace(/\/+$/, "") === CUSTOM_ENDPOINT)
        ? "chat"
        : v.protocol,
    model: oldChief ? CHIEF_MODEL : v.model,
    codexModel:
      !v.codexModel ||
      (v.codexModel === "gpt-6.2-sol" && (v.memberEffort ?? "max") === "max")
        ? MEMBER_MODEL
        : v.codexModel,
  });
}
export function defaultProfile(
  settings: Settings,
  chief = false,
): ModelProfile {
  return {
    model: chief ? settings.model : settings.codexModel,
    effort: chief ? settings.reasoningEffort : settings.memberEffort,
  };
}
export type TaskState =
  | "draft"
  | "ready"
  | "active"
  | "blocked"
  | "paused"
  | "verifying"
  | "done"
  | "cancelled";
export interface Entity {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project extends Entity {
  name: string;
  path: string;
  removed?: boolean;
  nativeProjectId?: string;
  origin?: "manual" | "codex" | "local";
  aliases?: string[];
  nameCustomized?: boolean;
  discoveredAt?: string;
  available?: boolean;
}
export interface ProjectCatalog {
  status: "idle" | "ready" | "partial" | "offline";
  checkedAt?: string;
  lastSuccessAt?: string;
  count: number;
  error?: string;
}
export interface ProjectRoot {
  id: string;
  path: string;
  status: "idle" | "ready" | "partial" | "unavailable";
  checkedAt?: string;
  count?: number;
}
export type ProjectPicker = {
  name?: string;
  parent?: string;
  collision?: boolean;
};
export interface ProjectSource {
  id: string;
  kind: "document" | "session" | "git";
  title: string;
  projectId: string;
  fetchedAt: string;
  updatedAt?: string;
  threadId?: string;
  complete: boolean;
}
export interface Task extends Entity {
  backend?: ExecutorBackend; // Tasks created before 0.1.8 belong to Codex.
  rosterId?: string;
  rosterRecorded?: true;
  reuse?: ReuseGrant[];
  advance?: Advance;
  loopId?: string;
  graph?: true;
  initialApproval?: "never" | "on-request";
  access?: "codex" | "project";
  title: string;
  goal: string;
  constraints: string;
  acceptance: string;
  projectId: string;
  state: TaskState;
  revision: number;
  stateVersion: number;
  mode: "read" | "write";
  model: string;
  runId?: string;
  reason?: string;
  archived: boolean;
  unread: boolean;
  attempt: number;
  control?: "pause_requested" | "cancel_requested" | "confirmed";
  parentId?: string;
  dependencies: string[];
  attachments: string[];
  memoryVersion?: string;
  isolate?: boolean;
  checks?: { path: string; contains: string }[];
  autoCorrections?: number;
}
export interface TaskWake extends Entity {
  taskId: string;
  wakeId: string;
  revision: number;
  at: string;
  state: "scheduled" | "released" | "cancelled";
  reason?: string;
}
export interface Run extends Entity {
  reuseInputs?: ReuseGrant[];
  graphAttempt?: GraphAttempt;
  loopRole?: "reviewer";
  nativeAttempt?: { nodeId: string; stepId: string };
  adapterVersion?: string;
  correctionInput?: string;
  methodInput?: { id: string; revision: number };
  backend?: ExecutorBackend;
  nativeEndReason?: z.infer<typeof DshEndReason>;
  apiSource?: Settings["apiSource"];
  apiRouteHash?: string;
  actualEffort?: string;
  profile?: ModelProfile;
  toolApproval?: "never" | "on-request";
  actualSandbox?: string;
  actualSandboxNetwork?: boolean;
  workRecordVersion?: number;
  taskId: string;
  revision: number;
  commandId: string;
  threadId?: string;
  turnId?: string;
  state:
    | "starting"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "ended"
    | "unknown";
  outcome?: "completed" | "failed" | "interrupted";
  response: string;
  diff: string;
  workPath: string;
  startedAt: string;
  endedAt?: string;
  usage?: unknown;
  attachmentInputs?: { id: string; kind: Artifact["kind"]; truncated?: true }[];
  inputsAcceptedAt?: string;
  model?: string;
  isolation?: "worktree" | "output";
  baseCommit?: string;
  integrationVersion?: string;
  integratedAt?: string;
}
export interface Command extends Entity {
  taskId: string;
  runId: string;
  revision: number;
  state:
    | "prepared"
    | "dispatching"
    | "accepted"
    | "unknown"
    | "resolved"
    | "voided";
  payloadHash: string;
  kind: "start" | "stop" | "approval";
  receipt?: string;
}
export interface Integration extends Entity {
  runId: string;
  taskId: string;
  path: string;
  state: "checking" | "applying" | "completed" | "rejected" | "unknown";
  beforeVersion?: string;
  resolution?: "observed" | "unchanged";
}
export interface Message extends Entity {
  ruleInputs?: RuleReference[];
  preferenceInput?: PreferenceReference;
  workRequestId?: string;
  work?: WorkStep[];
  audience?: "executor";
  role: "user" | "assistant" | "system";
  text: string;
  taskId?: string;
  status?: string;
  attachments?: string[];
  projectId?: string;
  sources?: ProjectSource[];
  linkAgentId?: string;
  projectPicker?: ProjectPicker;
  choices?: {
    label: string;
    projectId: string;
    agentId?: string;
    threadId?: string;
    nativeSource?: string;
    create?: boolean;
  }[];
  publicSummary?: string;
  steps?: string[];
}
export interface Agent extends Entity {
  profile?: ModelProfile;
  kind: "discussion" | "executor";
  parentAgentId: string;
  projectId: string;
  title: string;
  taskId?: string;
  activity?: string;
}
export interface RosterMember extends Entity {
  name: string;
  source: ExecutorBackend | "manual";
  mode: "managed" | "record";
  note: string;
  state: "active" | "paused" | "retired";
  revision: number;
}
export interface AgentLine extends Entity {
  ruleInputs?: RuleReference[];
  deliveryError?: string;
  work?: WorkStep;
  phase?: "commentary" | "final_answer";
  groupId?: string;
  agentId: string;
  kind: "user" | "assistant" | "system" | "summary" | "plan" | "tool";
  label: string;
  text: string;
  status?: "sending" | "sent" | "failed" | "unknown" | "queued" | "held";
  runId?: string;
  revision?: number;
  linkAgentId?: string;
}
export interface HistoryMessage {
  id: string;
  createdAt: string;
  role: Message["role"];
  text: string;
  projectId?: string;
  agentId?: string;
  nativeThreadId?: string;
  nativeCachedAt?: string;
  nativeSource?: string;
  legacy?: true;
}
export interface HistorySearchResult {
  tasks: Task[];
  messages: HistoryMessage[];
  moreMessages: boolean;
}
export interface WorkFile {
  path: string;
  action: "新增" | "修改" | "删除" | "移动" | "版本变化";
  added?: number;
  removed?: number;
  patch?: string;
  note?: string;
}
export interface WorkStep {
  id: string;
  kind:
    | "command"
    | "file"
    | "image"
    | "read"
    | "model"
    | "delegate"
    | "tool"
    | "summary"
    | "finding"
    | "plan";
  title: string;
  state: "running" | "done" | "failed" | "unknown" | "stopped";
  at: string;
  detail?: string;
  exitCode?: number;
  durationMs?: number;
  files?: WorkFile[];
}
export interface Memory extends Entity {
  text: string;
  projectId: string;
  enabled: boolean;
  deleted: boolean;
  source: string;
  decision?: { agentId: string; lineIds: string[] };
  revision: number;
}
export type RuleReference = Pick<Memory, "id" | "revision">;
export const ReplyStyleSchema = z.enum(["concise", "detailed"]);
export type ReplyStyle = z.infer<typeof ReplyStyleSchema>;
export interface PreferenceReference {
  id: string;
  revision: number;
  generation: string;
}
export interface MethodReceipt {
  taskId: string;
  revision: number;
  runId: string;
  verificationId?: string;
}
export interface WorkIssue extends Entity {
  projectId: string;
  taskId: string;
  revision: number;
  kind: "file-check" | "native-recovery" | "scope-mismatch";
  state: "open" | "recovered";
  failed: MethodReceipt[];
  recovery?: MethodReceipt;
}
export interface WorkMethod extends Entity {
  projectId: string;
  originIssueId: string;
  originTaskId: string;
  revision: number;
  state: "candidate" | "verified" | "active" | "needs-review";
  reason?: string;
  steps: string[];
  proofs: MethodReceipt[];
  counterexample?: MethodReceipt;
  environment: { app: string; backend: ExecutorBackend; adapter: string; model: string; effort: string };
}
export interface ReplyPreference extends PreferenceReference {
  projectId: string;
  state: "insufficient" | "conflicted" | "expired" | "candidate" | "active";
  style?: ReplyStyle;
  expiresAt?: string;
  lastUsedAt?: string;
  evidence: { messageId: string; requestId: string; style: ReplyStyle; at: string }[];
}
export interface Approval extends Entity {
  taskId: string;
  runId: string;
  revision: number;
  nativeId: string | number;
  method: string;
  detail: string;
  questions?: any[];
  state: "pending" | "dispatching" | "answered" | "expired" | "unknown";
  expiresAt: string;
  canAllow?: boolean;
  scopeReason?: string;
}
export interface Artifact extends Entity {
  taskId?: string;
  runId?: string;
  name: string;
  path: string;
  sourcePath?: string;
  hash: string;
  size: number;
  kind: "text" | "image" | "binary";
  origin: "attachment" | "result";
  status: string;
}
export interface ManualAcceptance {
  id: string;
  taskId: string;
  runId?: string;
  revision: number;
  at: string;
  method: "user-review" | "loop-contract";
  title?: string;
}
export type ManualAcceptanceDetail = ManualAcceptance & {
  result?: { response: string; diff: string; truncated: boolean; files: { id: string; name: string }[] };
};
export interface Snapshot {
  manualAcceptances: ManualAcceptance[];
  reuseItems: ReuseItem[];
  reuseUses: ReuseUse[];
  workIssues: WorkIssue[];
  workMethods: WorkMethod[];
  preferenceLearning: boolean;
  replyPreferences: ReplyPreference[];
  taskWakes: TaskWake[];
  loops: Loop[];
  criteria: Criterion[];
  checks: Check[];
  checkRuns: CheckRun[];
  findings: Finding[];
  candidates: import("./loop-contracts").Candidate[];
  learnedChecks: import("./loop-contracts").LearnedCheckEntry[];
  launches: LaunchCard[];
  nativeModels: ModelEntry[];
  settings: Settings;
  projects: Project[];
  catalog: ProjectCatalog;
  projectRoots: ProjectRoot[];
  tasks: Task[];
  runs: Run[];
  integrations: Integration[];
  messages: Message[];
  agents: Agent[];
  roster: RosterMember[];
  memories: Memory[];
  approvals: Approval[];
  artifacts: Artifact[];
  invocations: any[];
  evidence: any[];
  fileChecks: any[];
  verifications: any[];
  draft: string;
  dataDir: string;
  keyConfigured: boolean;
  dsh: { status: string; version?: string };
  codex: {
    status: string;
    version?: string;
    account?: string;
    error?: string;
    ownerControl: boolean;
  };
  hub: { generation: number; startedAt: string; error?: string };
  models: { ids: string[]; checkedAt?: string; verified?: string };
}
export interface LaunchCard {
  backend?: ExecutorBackend;
  id: string;
  kind: "discussion" | "executor";
  projectId: string;
  parentAgentId: string;
  title: string;
  detail: string;
  profile: ModelProfile;
  scope: "discussion" | "read" | "project" | "codex";
  approval: "never" | "on-request";
  createdAt: string;
  handoff?: {
    request: string;
    constraints: string;
    acceptance: string;
    discussion: { id: string; role: "user" | "assistant"; text: string }[];
  };
  roster?: { id: string; name: string; revision: number };
  reuse?: { title: string; version: number }[];
}
const ReuseSelection = z.object({ id: z.string().uuid(), version: z.number().int().positive(), versionId: z.string().uuid() }).strict();
export type ReuseRef = z.infer<typeof ReuseSelection>;
export type ReuseGrant = ReuseRef & { grant: string };
export interface ReuseItem extends Entity {
  title: string;
  condition: string;
  version: number;
  versionId: string;
  revision: number;
  projectId: string;
  projectIds: string[];
  active: boolean;
}
export interface ReuseUse extends Entity {
  ref: ReuseRef;
  taskId: string;
  runId: string;
  projectId: string;
  outcome: "used" | "not-used" | "counterexample";
  note: string;
}
export const TaskInput = z
  .object({
    projectId: z.string().min(1),
    rosterId: z.string().uuid().optional(),
    reuse: z.array(ReuseSelection).max(4).optional(),
    goal: z.string().trim().min(1).max(24000),
    title: z.string().max(120).optional(),
    constraints: z.string().max(12000).default(""),
    acceptance: z.string().max(12000).default(""),
    mode: z.enum(["read", "write"]).default("read"),
    access: z.enum(["codex", "project"]).optional(),
    model: z.string().max(120).default(""),
    attachments: z.array(z.string()).max(12).default([]),
    dependencies: z.array(z.string()).max(8).default([]),
    parentId: z.string().optional(),
    isolate: z.boolean().default(false),
    advance: AdvanceSchema.optional(),
    graph: GraphInput.optional(),
    criteria: z.array(CriterionInput).max(100).optional(),
    loopChecks: z.array(CheckInput).max(20).optional(),
    selectedChecks: z.array(z.string().min(1).max(80)).max(100).optional(),
    protect: z.array(z.string().min(1).max(300)).max(20).optional(),
    checks: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(500)
              .refine(
                (p) =>
                  !p.split(/[\\/]/).includes("..") &&
                  !/^[\\/]|^[A-Za-z]:/.test(p),
                "必须使用项目内相对路径",
              ),
            contains: z.string().max(6000),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();
const id = z.string().min(1).max(200);
export function taskAdvance(
  value: z.output<typeof TaskInput>,
  settings: Settings,
): Advance {
  const advance = value.advance ?? (settings.defaultAdvance === "single" ? "single" : "loop-native");
  if (value.graph && advance !== "loop-native")
    throw new Error("成果调度只能用于循环推进");
  if (advance !== "single") {
    if (value.mode !== "write") throw new Error("只读任务不能使用推进循环");
    if (value.isolate) throw new Error("推进循环需要使用项目原目录");
  }
  return advance;
}
export const Request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("acceptance.read"), id }).strict(),
  z.object({ op: z.literal("reuse.publish"), id: z.string().uuid().optional(), revision: z.number().int().positive().optional(), taskId: id, runId: id,
    title: z.string().trim().min(1).max(100), condition: z.string().trim().min(1).max(1000), excerpt: z.string().trim().min(1).max(6000),
    projectIds: z.array(id).min(1).max(12), requestId: id }).strict(),
  z.object({ op: z.literal("reuse.scope"), id, revision: z.number().int().positive(), projectIds: z.array(id).max(12), active: z.boolean() }).strict(),
  z.object({ op: z.literal("reuse.project"), projectId: id }).strict(),
  z.object({ op: z.literal("reuse.inspect"), ref: ReuseSelection }).strict(),
  z.object({ op: z.literal("reuse.record"), taskId: id, runId: id, ref: ReuseSelection,
    outcome: z.enum(["used", "not-used", "counterexample"]), note: z.string().trim().max(2000) }).strict(),
  z.object({ op: z.literal("roster.add"), name: z.string().trim().min(1).max(80),
    source: z.enum(["codex", "dsh", "manual"]), mode: z.enum(["managed", "record"]), note: z.string().trim().max(2000), requestId: id }).strict(),
  z.object({ op: z.literal("roster.update"), id, revision: z.number().int().positive(), name: z.string().trim().min(1).max(80),
    note: z.string().trim().max(2000), state: z.enum(["active", "paused", "retired"]) }).strict(),
  z.object({ op: z.literal("roster.link"), id, taskId: id, revision: z.number().int().positive() }).strict(),
  z.object({ op: z.literal("method.manage"), id, revision: z.number().int().positive(),
    action: z.enum(["enable", "pause", "delete", "recheck"]) }).strict(),
  z.object({ op: z.literal("preference.learning"), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal("preference.feedback"), id, style: ReplyStyleSchema }).strict(),
  z.object({ op: z.literal("preference.source"), id, messageId: id }).strict(),
  z.object({
    op: z.literal("preference.manage"), id, revision: z.number().int().positive(),
    generation: z.string().uuid(),
    action: z.enum(["enable", "pause", "delete", "export"]),
  }).strict(),
  z.object({
    op: z.literal("task.wake.schedule"),
    id,
    revision: z.number().int().positive(),
    stateVersion: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({ op: z.literal("task.wake.cancel"), id, wakeId: id }).strict(),
  z.object({ op: z.literal("loop.view"), id }).strict(),
  z.object({ op: z.literal("graph.view"), id }).strict(),
  z.object({
    op: z.literal("graph.research"), id, revision: z.number().int().positive(), spec: ResearchSpec,
    researchRevision: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    op: z.literal("graph.reconcile"), id, revision: z.number().int().positive(),
    runId: id.optional(),
  }).strict(),
  z.object({
    op: z.literal("graph.preview"), id, revision: z.number().int().positive(),
    jobId: z.string().uuid(), action: z.enum(["reconcile", "stop"]),
  }).strict(),
  z.object({
    op: z.literal("graph.revise"), id, revision: z.number().int().positive(),
    nodeId: id, nodeRevision: z.number().int().positive(),
    instruction: z.string().trim().min(1).max(3000),
  }).strict(),
  z.object({ op: z.literal("miss.list"), id }).strict(),
  z.object({
    op: z.literal("miss.record"),
    id,
    requestId: z.string().uuid(),
    taskRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    text: z.string().trim().min(1).max(4000),
  }).strict(),
  z.object({
    op: z.literal("miss.attribute"),
    id,
    revision: z.number().int().positive(),
    category: MissCategorySchema.optional(),
  }).strict(),
  z.object({
    op: z.literal("miss.manage"),
    id,
    revision: z.number().int().positive(),
    action: z.enum(["enable", "disable", "delete", "edit", "retry"]),
    text: z.string().trim().min(1).max(400).optional(),
  }).strict(),
  z.object({ op: z.literal("loop.discover"), projectId: id }).strict(),
  z
    .object({
      op: z.literal("loop.revise"),
      id,
      revision: z.number().int().positive(),
      changes: z.array(CriterionChange).min(1).max(100),
    })
    .strict(),
  z.object({ op: z.literal("loop.budget"), id, add: LoopAddition }).strict(),
  z.object({ op: z.literal("check.output"), id }).strict(),
  z
    .object({
      op: z.literal("agent.configure"),
      agentId: id,
      profile: ProfileSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("agent.launch.confirm"),
      id,
      profile: ProfileSchema,
    })
    .strict(),
  z.object({ op: z.literal("agent.launch.cancel"), id }).strict(),
  z.object({
    op: z.literal("discussion.prepareHandoff"),
    agentId: id,
    text: z.string().trim().min(1).max(12000),
    requestId: id,
  }).strict(),
  z
    .object({
      op: z.literal("agent.models"),
      backend: z.enum(["api", "codex", "dsh"]),
    })
    .strict(),
  z
    .object({
      op: z.literal("discussion.open"),
      projectId: id,
      title: z.string().trim().min(1).max(120),
      requestId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("discussion.fromNative"),
      projectId: id,
      threadId: id,
      source: id.optional(),
      requestId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("agent.delegate"),
      agentId: id,
      goal: z.string().trim().min(1).max(12000),
      requestId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("agent.choose"),
      messageId: id,
      index: z.number().int().nonnegative(),
      requestId: id,
    })
    .strict(),
  z
    .object({ op: z.literal("agent.view"), agentId: id, before: id.optional() })
    .strict(),
  z
    .object({
      op: z.literal("agent.draft"),
      agentId: id,
      text: z.string().max(24000),
    })
    .strict(),
  z
    .object({
      op: z.literal("agent.send"),
      preserveDraft: z.boolean().optional(),
      agentId: id,
      text: z.string().trim().min(1).max(24000),
      requestId: id,
      mode: z.enum(["now", "queue"]).default("now"),
      revision: z.number().int().optional(),
      runId: id.optional(),
      turnId: id.optional(),
    })
    .strict(),
  z.object({ op: z.literal("snapshot") }).strict(),
  z.object({ op: z.literal("projects.discover") }).strict(),
  z.object({ op: z.literal("projects.fileList") }).strict(),
  z
    .object({
      op: z.literal("projects.rootAdd"),
      path: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ op: z.literal("projects.rootRemove"), id }).strict(),
  z.object({ op: z.literal("project.directory"), id }).strict(),
  z
    .object({
      op: z.literal("project.create"),
      parent: z.string().min(1).max(1000),
      name: z.string().min(1).max(100),
      reuse: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("project.use"),
      messageId: id,
      projectId: id,
      requestId: id,
    })
    .strict(),
  z.object({ op: z.literal("project.progress"), id, requestId: id }).strict(),
  z.object({ op: z.literal("settings"), value: SettingsSchema }).strict(),
  z.object({ op: z.literal("draft"), text: z.string().max(24000) }).strict(),
  z
    .object({
      op: z.literal("project.add"),
      path: z.string().min(1).max(1000),
      name: z.string().max(100),
    })
    .strict(),
  z
    .object({
      op: z.literal("project.update"),
      id,
      name: z.string().min(1).max(100).optional(),
      remove: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("task.create"),
      value: TaskInput,
      requestId: id,
    })
    .strict(),
  z.object({ op: z.literal("project.nativeCandidates"), id }).strict(),
  z
    .object({
      op: z.literal("project.nativeBind"),
      id,
      nativeProjectId: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("task.control"),
      id,
      action: z.enum([
        "pause",
        "resume",
        "cancel",
        "archive",
        "read",
        "accept",
        "reconcile",
      ]),
      revision: z.number().int(),
      evidenceHash: z.string().optional(),
      runId: id.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("task.revise"),
      id,
      revision: z.number().int(),
      goal: z.string().min(1).max(24000),
      constraints: z.string().max(12000),
      acceptance: z.string().max(12000),
      model: z.string().max(120).default(""),
      checks: TaskInput.shape.checks,
    })
    .strict(),
  z
    .object({
      op: z.literal("chat"),
      text: z.string().trim().min(1).max(24000),
      taskId: id.optional(),
      requestId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("memory.save"),
      id: id.optional(),
      text: z.string().trim().min(1).max(6000),
      projectId: z.string(),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("memory.delete"), id }).strict(),
  z
    .object({
      op: z.literal("approval"),
      id,
      revision: z.number().int(),
      allow: z.boolean(),
      answers: z.record(z.string()).optional(),
    })
    .strict(),
  z.object({ op: z.literal("model.test") }).strict(),
  z.object({ op: z.literal("model.list") }).strict(),
  z.object({ op: z.literal("codex.probe") }).strict(),
  z.object({ op: z.literal("dsh.probe") }).strict(),
  z.object({ op: z.literal("sessions"), projectId: id, backend: z.enum(["codex", "dsh"]).optional() }).strict(),
  z
    .object({ op: z.literal("session.read"), projectId: id, threadId: id, source: id.optional() })
    .strict(),
  z
    .object({
      op: z.literal("session.send"),
      projectId: id,
      threadId: id,
      source: id.optional(),
      text: z.string().trim().min(1).max(24000),
      requestId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("session.stop"),
      projectId: id,
      threadId: id,
      turnId: id,
    })
    .strict(),
  z
    .object({
      op: z.literal("search"),
      text: z.string().max(200),
      projectId: z.string().optional(),
    })
    .strict(),
  z.object({ op: z.literal("artifact.read"), id }).strict(),
  z
    .object({ op: z.literal("task.integrate"), id, revision: z.number().int() })
    .strict(),
  z
    .object({ op: z.literal("task.integration.reconcile"), id, runId: id, revision: z.number().int() })
    .strict(),
  z.object({ op: z.literal("backup") }).strict(),
  z.object({ op: z.literal("diagnostics") }).strict(),
]);
export type RequestType = z.infer<typeof Request>;
export const stateLabels: Record<TaskState, string> = {
  draft: "草稿",
  ready: "等待执行",
  active: "执行中",
  blocked: "需要处理",
  paused: "已暂停",
  verifying: "待验收",
  done: "已完成",
  cancelled: "已取消",
};
