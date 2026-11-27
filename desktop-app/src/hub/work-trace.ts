import {
  type AgentLine,
  type Message,
  type WorkStep,
} from "../shared/contracts";
import { entity, stamp, Store } from "./store";
import { redact } from "./security";
import type { PublicProgress } from "./public-progress";
type Sink = (step: WorkStep) => void;
export class WorkTrace {
  constructor(private save: Sink) {}
  reporter(): PublicProgress {
    const entries = new Map<string, { id: string; at: string; last: number }>();
    return (key, kind, text, done) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = { id: entity().id, at: stamp(), last: 0 };
        entries.set(key, entry);
      }
      if (!done && Date.now() - entry.last < 180) return;
      entry.last = Date.now();
      this.save({
        id: entry.id,
        at: entry.at,
        kind,
        title: kind === "summary" ? "公开思路摘要" : "阶段进展",
        state: "done",
        detail: redact(text).slice(0, 16000),
      });
    };
  }
  add(
    kind: WorkStep["kind"],
    title: string,
    detail?: string,
    state: WorkStep["state"] = "done",
  ) {
    this.save({
      id: entity().id,
      at: stamp(),
      kind,
      title: redact(title).slice(0, 240),
      detail: detail ? redact(detail).slice(0, 8000) : undefined,
      state,
    });
  }
  async call<T>(
    kind: WorkStep["kind"],
    title: string,
    fn: () => Promise<T>,
    result?: (x: T) => string,
  ) {
    const step: WorkStep = {
      id: entity().id,
      at: stamp(),
      kind,
      title: redact(title).slice(0, 2400),
      state: "running",
    };
    this.save(step);
    const start = Date.now();
    try {
      const value = await fn();
      this.save({
        ...step,
        state: "done",
        durationMs: Date.now() - start,
        exitCode: kind === "command" ? 0 : undefined,
        detail: result ? redact(result(value)).slice(0, 8000) : undefined,
      });
      return value;
    } catch (e) {
      const code =
        typeof (e as any)?.code === "number" ? (e as any).code : undefined;
      this.save({
        ...step,
        state: "failed",
        durationMs: Date.now() - start,
        exitCode: code,
        detail:
          kind === "command"
            ? "未取得成功的命令结果。"
            : "未取得本次操作的成功回执。",
      });
      throw e;
    }
  }
}
export function workTrace(
  store: Store,
  changed: () => void,
  target: { message?: string; agent?: string; group?: string },
) {
  return new WorkTrace((step) => {
    if (target.message) {
      const m = store.get<Message>("message", target.message);
      if (m) {
        const work = [...(m.work || [])];
        const i = work.findIndex((x) => x.id === step.id);
        if (i >= 0) work[i] = step;
        else if (work.length < 150) work.push(step);
        store.put("message", { ...m, work });
      }
    }
    if (target.agent) {
      const id = "work:" + step.id,
        old = store.get<AgentLine>("agent-line", id);
      store.put("agent-line", {
        id,
        agentId: target.agent,
        groupId: target.group,
        kind:
          step.kind === "summary"
            ? "summary"
            : step.kind === "plan"
              ? "plan"
              : "tool",
        createdAt: old?.createdAt || step.at,
        updatedAt: stamp(),
        label: step.title,
        text: step.detail || "",
        work: step,
      });
    }
    changed();
  });
}
export function publicResult(trace: WorkTrace, result: { summary?: string }) {
  if (result.summary?.trim())
    trace.add("summary", "公开思路摘要", result.summary);
}
