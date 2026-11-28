import { randomUUID } from "node:crypto";
import type { ExecutorBackend, ExecutorModels, ModelEntry } from "../shared/contracts";
import { redact } from "./security";
import { stamp } from "./store";

const TTL = 5 * 60_000;

export class ExecutorCatalog {
  private rows = new Map<ExecutorBackend, ExecutorModels>();
  private inFlight = new Map<ExecutorBackend, Promise<ExecutorModels>>();
  private generation: Record<ExecutorBackend, number> = { codex: 0, dsh: 0 };
  constructor(private changed: () => void) {}

  current(backend: ExecutorBackend): ExecutorModels {
    const row = this.rows.get(backend);
    return row?.checkedAt && Date.now() - Date.parse(row.checkedAt) < TTL ? row : { state: "unread", entries: [] };
  }

  clear(backend: ExecutorBackend) {
    this.generation[backend]++;
    this.rows.delete(backend);
    this.inFlight.delete(backend);
  }

  refresh(backend: ExecutorBackend, read: () => Promise<ModelEntry[]>) {
    const prior = this.inFlight.get(backend);
    if (prior) return prior;
    const generation = this.generation[backend];
    this.rows.delete(backend);
    this.changed();
    const result = Promise.resolve().then(read).then<ExecutorModels, ExecutorModels>(entries => ({
      state: entries.length ? "available" : "empty", entries, checkedAt: stamp(), catalogVersion: randomUUID(),
    }), error => ({ state: "unavailable", entries: [], checkedAt: stamp(), issue: redact((error as Error).message).slice(0, 240) }))
      .then(row => {
        if (generation !== this.generation[backend]) return this.current(backend);
        this.rows.set(backend, row);
        this.changed();
        return row;
      }).finally(() => { if (this.inFlight.get(backend) === result) this.inFlight.delete(backend); });
    this.inFlight.set(backend, result);
    return result;
  }
}
