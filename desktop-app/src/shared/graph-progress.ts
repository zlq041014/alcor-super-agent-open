import { z } from "zod";

export const GraphTiming = z.object({
  observeMinutes: z.number().int().min(1).max(180),
  hardMinutes: z.number().int().min(1).max(180),
}).strict().refine(({ observeMinutes, hardMinutes }) => observeMinutes < hardMinutes,
  "进展检查须早于单回合硬截止");
export type GraphTiming = z.infer<typeof GraphTiming>;

export type ProgressWindow = {
  observeAt: number;
  hardAt: number;
  intervalMs: number;
  lastObserved: number;
};
export type ProgressStop = "hard" | "stalled";
export type GraphObservation = ProgressWindow & {
  id: string;
  outputs: { path: string; digest: string }[];
  frames: number;
  latest?: { kind: "file" | "frames"; at: number; value: number };
  stop?: ProgressStop;
};
