import { z } from "zod";
import type { Entity, ModelProfile } from "./contracts";

export const AdvanceSchema = z.enum(["single", "loop", "loop-improve", "loop-native"]);
export const LoopCloseSchema = z.enum(["auto", "review-judged"]);
export const LoopBudgetSchema = z
  .object({
    executorRuns: z.number().int().min(1).max(200).default(30),
    roleCalls: z.number().int().min(0).max(2000).default(200),
    retries: z.number().int().min(0).max(5).default(2),
    candidates: z.number().int().min(1).max(5).default(3),
    improveRounds: z.number().int().min(0).max(5).default(2),
    findingsPerLens: z.number().int().min(1).max(10).default(5),
    findingsPerRound: z.number().int().min(1).max(10).default(3),
    refutationsPerRound: z.number().int().min(0).max(30).default(10),
    comparisonsPerRound: z.number().int().min(0).max(200).default(40),
    wallMinutes: z.number().int().min(10).max(1440).default(180),
    roleConcurrency: z.number().int().min(1).max(8).default(4),
    criteria: z.number().int().min(1).max(100).default(40),
    checkTimeoutSec: z.number().int().min(10).max(1800).default(600),
  })
  .strict();
export type LoopBudget = z.infer<typeof LoopBudgetSchema>;
export type Advance = z.infer<typeof AdvanceSchema>;

export const LoopRelativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !/^[\\/]|[:\x00-\x1f]/.test(path) &&
      !path.split(/[\\/]/).some((part) => part.replace(/ +$/, "") === ".."),
    "必须使用项目内相对路径",
  );
const checkName = z.string().trim().min(1).max(80);
export const CommandCheckInput = z
  .object({
    kind: z.literal("command"),
    name: checkName,
    program: z.string().min(1).max(200),
    args: z.array(z.string().min(1).max(300)).max(20).default([]),
    cwd: LoopRelativePath.default("."),
    timeoutSec: z.number().int().min(10).max(1800).optional(),
  })
  .strict();
export const CheckInput = z.discriminatedUnion("kind", [
  CommandCheckInput,
  z
    .object({
      kind: z.literal("file"),
      name: checkName,
      path: LoopRelativePath,
      contains: z.string().max(6000).default(""),
    })
    .strict(),
]);
export type CheckInput = z.infer<typeof CheckInput>;
export const CriterionInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    detail: z.string().max(4000).default(""),
    necessity: z.enum(["required", "optional"]).default("required"),
    method: z.enum(["command", "file", "judge", "user"]).default("command"),
    checks: z.array(checkName).max(10).default([]),
    points: z.string().max(4000).default(""),
    needsAuthoredCheck: z.boolean().optional(),
    checkIntent: z.string().max(4000).optional(),
  })
  .strict();
export type CriterionInput = z.infer<typeof CriterionInput>;

const id = z.string().min(1).max(200);
export const CriterionChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), value: CriterionInput }).strict(),
  z.object({ action: z.literal("edit"), id, value: CriterionInput }).strict(),
  z.object({ action: z.literal("waive"), id }).strict(),
  z.object({ action: z.literal("reopen"), id }).strict(),
]);
export type CriterionChange = z.infer<typeof CriterionChange>;
export const LoopAddition = z
  .object({
    executorRuns: z.number().int().min(1).max(200).optional(),
    wallMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict()
  .refine(
    (v) => v.executorRuns !== undefined || v.wallMinutes !== undefined,
    "至少追加一项预算",
  );
export type LoopAddition = z.infer<typeof LoopAddition>;

export interface Loop extends Entity {
  taskId: string;
  projectId: string;
  mode: Exclude<Advance, "single">;
  nativeBrief?: { checks: CheckInput[]; criteria: CriterionInput[] };
  nativePlan?: { version: 1; nodeId: string };
  phase:
    | "contracting"
    | "baseline"
    | "advancing"
    | "reviewing"
    | "closing"
    | "closed"
    | "halted";
  step?: LoopStep;
  contractRevision: number;
  roster: {
    executor: ModelProfile;
    verifier?: ModelProfile;
    planner?: ModelProfile;
    critic?: ModelProfile;
    advisor?: ModelProfile;
  };
  contract?: {
    understanding: string;
    outOfScope: string[];
    plannedBy?: string;
    reviewedBy?: string;
    fallback?: string;
  };
  closeMode: z.infer<typeof LoopCloseSchema>;
  budget: { limits: LoopBudget; spent: LoopSpent };
  blockedStreak: number;
  reviewedRounds?: number;
  rejectedWrites: number;
  protectedPaths: string[];
  assumptions: string[];
  startedAt: string;
  halt?: {
    reason:
      | "budget"
      | "no_progress"
      | "unknown_run"
      | "all_blocked"
      | "restored"
      | "cancelled";
    detail: string;
  };
  report?: LoopReport;
}
export interface LoopStep {
  id: string;
  kind:
    | "contract"
    | "baseline"
    | "author"
    | "judge"
    | "diagnose"
    | "candidates"
    | "split"
    | "advisor"
    | "execute"
    | "check"
    | "review"
    | "close";
  criterionId?: string;
  attempt: number;
  state: "pending" | "running" | "done";
  runId?: string;
  supplements?: string[];
  fresh?: boolean;
  review?: boolean;
  previousRunId?: string;
  supplementsAtStart?: number;
}
export interface NativeLoopNode extends Entity {
  loopId: string;
  revision: number;
  step: LoopStep;
}
export interface LoopSpent {
  executorRuns: number;
  roleCalls: number;
  tokensKnown: number;
  unknownUsageCalls: number;
}
export interface Criterion extends Entity {
  loopId: string;
  order: number;
  input: CriterionInput;
  verify: { method: CriterionInput["method"]; checkIds: string[] };
  author?: {
    attempts: number;
    path?: string;
    beforeFail?: string;
    reason?: string;
    rewrites?: number;
    replacement?: { file: string; hash: string };
  };
  judgedInitial?: boolean;
  rollbackPending?: boolean;
  failedAttempts?: { runId: string; detail: string; checkRunId?: string; review?: string }[];
  escalation?: {
    stage: "diagnose" | "fresh" | "attempted" | "candidates" | "candidate-applied" | "split" | "split-parent" | "advisor" | "advisor-ready" | "advisor-attempted";
    diagnosis?: { causes: string[]; approaches: { title: string; plan: string }[] };
    invocationId?: string;
    fallback?: string;
    previousLevel?: string;
    childIds?: string[];
    advisor?: { title: string; plan: string; invocationId: string; actualModel?: string };
  };
  splitFrom?: string;
  review?: { detail: string; invocationId?: string };
  findingIds?: string[];
  sourceQuote?: string;
  assumption?: boolean;
  dependsOn: string[];
  implicit?: boolean;
  supplements?: string[];
  baselinePass?: boolean;
  status:
    | "pending"
    | "in_progress"
    | "passed"
    | "failed"
    | "stale"
    | "blocked"
    | "waived";
  attempts: number;
  noProgress: number;
  definitionHash: string;
  blockedReason?: string;
  failure?: { signature: string; detail: string; checkRunId?: string };
  passed?: {
    grade: "program" | "judged" | "user";
    checkRunIds: string[];
    workspaceVersion: string;
    at: string;
    invocationId?: string;
  };
}
export interface Check extends Entity {
  projectId: string;
  loopId: string;
  input: CheckInput;
  origin: "existing" | "user" | "authored";
  status: "authorized" | "rejected" | "unavailable";
  policyRule: string;
  bindingHash: string;
  baseline?: "passed" | "failed" | "unavailable";
}
export interface CheckRun extends Entity {
  checkId: string;
  loopId: string;
  stepId: string;
  runId?: string;
  criterionIds: string[];
  purpose:
    | "baseline"
    | "criterion"
    | "regression"
    | "final"
    | "author-before"
    | "author-after"
    | "candidate";
  workspaceVersion: string;
  state: "running" | "ended" | "unknown";
  outcome?: "passed" | "failed" | "environment" | "timeout" | "unstable";
  exitCode?: number;
  outputRef?: string;
  failureSignature?: string;
  durationMs?: number;
  pid?: number;
  guarded?: boolean;
}
export type FindingReference =
  | { kind: "file"; path: string; quote: string }
  | { kind: "check-run"; id: string; excerpt: string }
  | { kind: "criterion"; id: string }
  | { kind: "steps"; text: string };
export interface Finding extends Entity {
  loopId: string;
  round: number;
  lens: string;
  title: string;
  claim: string;
  impact: string;
  severity: "blocker" | "major" | "minor";
  evidence: FindingReference[];
  workspaceVersion: string;
  status:
    | "proposed"
    | "invalid_evidence"
    | "duplicate"
    | "refuted"
    | "unverified"
    | "confirmed"
    | "queued"
    | "deferred"
    | "fixed"
    | "declined";
  reason?: string;
  duplicateOf?: string;
  scope?: "reopen" | "in-goal" | "beyond-goal";
  sourceQuote?: string;
  rank?: number;
  criterionId?: string;
}
export interface Candidate extends Entity {
  loopId: string;
  criterionId: string;
  stepId: string;
  approach: string;
  status: "running" | "rejected" | "passed" | "integrating" | "selected" | "discarded" | "unknown";
  checkRunIds: string[];
  diff?: string;
  changedLines?: number;
  reason?: string;
  threadId?: string;
}
export interface LoopReport {
  outcome: "completed" | "awaiting_user" | "halted";
  blockedRequired: { criterionId: string; reason: string }[];
  preexistingPasses: string[];
  workspaceVersion?: string;
  scopeLimited?: boolean;
  judgedOnly: string[];
  assumptions: string[];
  deferredFindings: string[];
  rejectedWrites: number;
  unavailableChecks: string[];
  unrestoredFiles: string[];
  usage: LoopSpent & { wallMs: number };
  roleUsage?: {
    role: string;
    calls: number;
    tokensKnown: number;
    unknown: number;
  }[];
}
export interface LoopView {
  loop: Loop;
  criteria: Criterion[];
  checks: Check[];
  checkRuns: CheckRun[];
  findings: Finding[];
  candidates: Candidate[];
}

export interface MissEntry {
  id: string;
  taskRevision: number;
  contractRevision: number;
  text: string;
  materialStatus: "frozen" | "partial" | "unavailable";
  materialReason?: string;
  attribution?: {
    revision: number;
    state: "pending" | "calling" | "derived" | "none" | "failed" | "paused";
    category?: MissCategory;
    reason?: string;
    candidate?: string;
  };
  replay?: MissReplayState;
}

export interface MissReplayState {
  state: "pending" | "waiting" | "calling" | "passed" | "rejected" | "paused";
  reason?: string;
  holdoutTaskId?: string;
  invocationIds?: string[];
  proof?: {
    baselineFound?: boolean;
    candidateFound?: boolean;
    candidateGrounded?: boolean;
    holdoutUnsupported?: number;
  };
}

export interface LearnedCheckEntry {
  id: string;
  projectId: string;
  taskId: string;
  text: string;
  reminder: string;
  revision: number;
  replay: MissReplayState;
  enabled: boolean;
  editable: boolean;
}

export const MissCategorySchema = z.enum(["contract", "check", "review", "triage", "implementation"]);
export type MissCategory = z.infer<typeof MissCategorySchema>;
