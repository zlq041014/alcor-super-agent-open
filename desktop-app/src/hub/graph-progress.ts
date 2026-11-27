import { evaluateWindow, startWindow } from "../core/graph-progress";
import { pathKey } from "../core/glob";
import type { GraphObservation } from "../shared/graph-progress";
import { hash } from "./security";
import type { Store } from "./store";

export class GraphProgress {
  constructor(private store: Store) {}
  get(id: string) { return this.store.get<GraphObservation>("graph-progress", id); }
  start(id: string, now: number, intervalMs: number, hardAt: number) {
    this.store.put("graph-progress", { id, ...startWindow(now, intervalMs, hardAt),
      outputs: [], frames: 0 } satisfies GraphObservation);
  }
  file(id: string, relative: string, contents: Buffer, now = Date.now()) {
    const record = this.get(id);
    const file = pathKey(relative);
    const digest = hash(contents);
    if (!record || record.stop || now >= record.hardAt ||
        !contents.toString("utf8").trim() || record.outputs.length >= 40 ||
        record.outputs.some((item) => item.path === file || item.digest === digest)) return;
    record.outputs.push({ path: file, digest });
    record.latest = { kind: "file", at: now, value: record.outputs.length };
    this.store.put("graph-progress", record);
  }
  frames(id: string, count: number, now = Date.now()) {
    const record = this.get(id);
    if (!record || record.stop || now >= record.hardAt || count <= record.frames) return;
    record.frames = count;
    record.latest = { kind: "frames", at: now, value: count };
    this.store.put("graph-progress", record);
  }
  check(id: string, now: number) {
    const observation = this.get(id);
    if (!observation || observation.stop) return observation?.stop;
    const decision = evaluateWindow(observation, observation.outputs.length + observation.frames, now);
    if (decision.kind === "extend")
      this.store.tx(() => {
        this.store.put("graph-progress", { ...observation, ...decision.window });
        this.store.event("graph.observation-extended", id, {
          evidence: observation.latest, observeAt: decision.window.observeAt, hardAt: observation.hardAt,
        });
      });
    else if (decision.kind === "stop") {
      this.store.tx(() => {
        this.store.put("graph-progress", { ...observation, stop: decision.reason });
        this.store.event("graph.observation-stop", id, { reason: decision.reason, hardAt: observation.hardAt });
      });
      return decision.reason;
    }
  }
}
