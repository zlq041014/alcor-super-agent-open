import type { ProgressStop, ProgressWindow } from "../shared/graph-progress";

export function startWindow(now: number, intervalMs: number, hardAt: number): ProgressWindow {
  return { observeAt: Math.min(now + intervalMs, hardAt), hardAt, intervalMs, lastObserved: 0 };
}

export function evaluateWindow(
  window: ProgressWindow, verified: number, now: number,
): { kind: "wait" } | { kind: "extend"; window: ProgressWindow } | { kind: "stop"; reason: ProgressStop } {
  if (now >= window.hardAt) return { kind: "stop", reason: "hard" };
  if (now < window.observeAt) return { kind: "wait" };
  if (verified <= window.lastObserved) return { kind: "stop", reason: "stalled" };
  return { kind: "extend", window: { ...window, lastObserved: verified,
    observeAt: Math.min(now + window.intervalMs, window.hardAt) } };
}
