import { z } from "zod";

const id = z.string().uuid();
const millis = z.number().int().nonnegative();
export const PreviewJobDefinition = z.object({
  id, receiptKey: id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  ffmpeg: z.string().min(1).max(1000),
  frames: z.number().int().min(1).max(120),
  hardAt: millis,
  intervalMs: z.number().int().min(50).max(10_800_000).optional(),
}).strict();
export type PreviewJobDefinition = z.infer<typeof PreviewJobDefinition>;

export const PreviewStop = z.object({
  id, receiptKey: id, reason: z.enum(["user", "hard", "stalled"]),
}).strict();
export type PreviewStop = z.infer<typeof PreviewStop>;

export const PreviewReceipt = z.object({
  id, receiptKey: id, sequence: z.number().int().positive(), at: millis,
  phase: z.enum(["preparing", "running", "stopping", "unknown", "completed", "stopped", "failed"]),
  frames: z.number().int().min(0).max(120),
  observeAt: millis.optional(),
  reason: z.enum(["user", "hard", "stalled", "input", "process", "frames", "receipt"]).optional(),
}).strict();
export type PreviewReceipt = z.infer<typeof PreviewReceipt>;
export const previewTerminal = (phase: string) =>
  phase === "completed" || phase === "stopped" || phase === "failed";
