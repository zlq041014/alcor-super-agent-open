import { z } from "zod";
import type { Entity } from "./contracts";
import { ResearchSpec, type ResearchEvidence, type ResearchUse } from "./research";
import { GraphTiming, type GraphObservation } from "./graph-progress";
import type { PreviewReceipt } from "./preview-job";

const key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const GraphWorkspaceId = z.string().uuid();
export const graphStandard = { key: "standard", path: "quality-standard.md" } as const;
export const GraphPath = z.string().max(240).refine(
  (path) => path.split("/").every((part) =>
    /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(part) &&
    !/[ .]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
  ),
  "使用普通的项目相对文件路径",
);
const paths = z.array(GraphPath).max(40);
export const GraphInput = z.object({
  inputs: paths, nativeTools: z.boolean().optional(), standard: z.boolean().optional(),
  research: z.array(ResearchSpec).max(4).optional(), timing: GraphTiming.optional(),
  preview: z.object({
    video: GraphPath.refine((path) => /\.mp4$/i.test(path), "请选择 MP4 视频"),
    frames: z.number().int().min(1).max(60),
  }).strict().optional(),
}).strict();
export const GraphProposal = z.object({
  nodes: z.array(z.object({
    key,
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(3000),
    acceptance: z.string().trim().min(1).max(1500),
    outputs: paths.min(1),
    dependencies: z.array(key).max(8),
    resources: z.array(z.string().regex(/^[a-z][a-z0-9:_-]{0,79}$/)).max(8),
    required: z.boolean(),
  }).strict()).min(1).max(8),
}).strict();
export const GraphHandoff = z.object({ paths: paths.min(1) }).strict();
export type GraphProposal = z.infer<typeof GraphProposal>;
export type GraphRole = "execute" | "review" | "final" | "research";
export type GraphVersion = { nodeId: string; revision: number; reviewRunId: string };
export type GraphFile = { path: string; blob: string; media?: "png" };
export type GraphDraft = { runId: string; files: GraphFile[]; inputs: GraphVersion[] };
export type GraphAccepted = GraphDraft & { reviewRunId: string };
export type GraphAttempt = {
  nodeId: string;
  nodeRevision: number;
  role: GraphRole;
  inputs: GraphVersion[];
  resources: string[];
  researchInputs?: GraphVersion[];
};

export interface GraphNode extends Entity {
  loopId: string;
  key: string;
  kind?: "standard";
  title: string;
  goal: string;
  acceptance: string;
  outputs: string[];
  dependencies: string[];
  resources: string[];
  required: boolean;
  revision: number;
  activeRunId?: string;
  previewJobId?: string;
  draft?: GraphDraft;
  accepted?: GraphAccepted;
  blocked?: string;
  attempts: number;
  feedbackRunId?: string;
  repair?: GraphDraft;
  instruction?: string;
  research?: { spec: ResearchSpec; evidence?: ResearchEvidence };
}
export interface GraphPlan extends Entity {
  version: 2 | 3;
  nativeTools?: boolean;
  taskId: string;
  projectId: string;
  rootNodeId: string;
  inputs: GraphFile[];
  spent: number;
  timing?: GraphTiming;
  preview?: { ffmpeg: string; video: string; blob: string; frames: number };
  reviewByUser?: boolean;
  limits: { runs: number; wallMinutes: number; runMinutes: number; retries: number };
  assembled?: {
    id: string;
    versions: GraphVersion[];
    files: GraphFile[];
    path: string;
    state: "applying" | "unknown" | "ready" | "failed";
    failure?: string;
    stale?: boolean;
    restored?: boolean;
  };
  finalRunId?: string;
  finalAccepted?: string;
  finalFailure?: string;
  manualReview?: boolean;
  userAccepted?: boolean;
  lastClaimAt?: string;
}
export type GraphWait = "input" | "resource" | "receipt" | "budget" | "paused" | "blocked" | "preview";
export type GraphView = {
  nodes: {
    id: string; title: string; key: string; revision: number; required: boolean;
    outputs: string[]; dependencies: string[]; resources: string[];
    waiting?: GraphWait; blocked?: string;
    attempt?: { id: string; role: GraphRole; state: string; turnId?: string; stopping: boolean;
      observation?: Pick<GraphObservation, "observeAt" | "hardAt" | "latest" | "stop"> };
    accepted?: { runId: string; reviewRunId: string };
    standard?: { card?: string };
    preview?: {
      id: string; state: PreviewReceipt["phase"] | "queued" | "dispatching";
      frames: number; expected: number; hardAt: number; requested: boolean;
      receiptAt?: number; observeAt?: number; reason?: PreviewReceipt["reason"];
    };
    research?: {
      key: string; consumer: string; mode: ResearchSpec["mode"]; question: string; version: string;
      spec: ResearchSpec;
      evidence?: ResearchEvidence;
      use?: ResearchUse;
    };
  }[];
  limits: GraphPlan["limits"];
  spent: number;
  minimum: number;
  deadline: string;
  timing?: GraphTiming;
  assembly?: { state: NonNullable<GraphPlan["assembled"]>["state"]; failure?: string };
  final?: { runId: string; state: string };
  finalFailure?: string;
};
