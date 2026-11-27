import { overlaps } from "../core/policy";
import type { Entity, Run, Task } from "../shared/contracts";
import {
  previewTerminal, type PreviewJobDefinition, type PreviewReceipt, type PreviewStop,
} from "../shared/preview-job";
import { entity, stamp, type Store } from "./store";

export type PreviewJob = Entity & {
  taskId: string;
  taskRevision: number;
  loopId: string;
  nodeId: string;
  nodeRevision: number;
  runId: string;
  workPath: string;
  resources: string[];
  definition: PreviewJobDefinition;
  state: "queued" | "dispatching" | PreviewReceipt["phase"];
  receipt?: PreviewReceipt;
  stop?: PreviewStop["reason"];
  handoff?: true;
  applied?: true;
};

export class PreviewJobLedger {
  constructor(private store: Store) {}
  get(id: string) { return this.store.get<PreviewJob>("graph-preview-job", id); }
  open(taskId?: string) {
    return this.store.all<PreviewJob>("graph-preview-job").filter((job) =>
      !["completed", "stopped", "failed"].includes(job.state) &&
      (taskId === undefined || taskId === job.taskId));
  }
  held() { return this.open().filter((job) => job.state !== "queued"); }
  pending(taskId?: string) {
    return this.store.all<PreviewJob>("graph-preview-job").filter((job) =>
      !job.applied && (taskId === undefined || taskId === job.taskId));
  }
  private put(job: PreviewJob) {
    return this.store.put("graph-preview-job", { ...job, updatedAt: stamp() }) as PreviewJob;
  }
  forRun(runId: string) {
    const row = this.store.db.prepare(`SELECT data FROM records WHERE kind='graph-preview-job'
      AND json_extract(data,'$.runId')=? LIMIT 1`).get(runId);
    return row && JSON.parse(String(row.data)) as PreviewJob | undefined;
  }
  queue(task: Task, run: Run, definition: PreviewJobDefinition, workPath: string, resources: string[]) {
    if (task.id !== run.taskId || task.revision !== run.revision || !task.graph ||
        run.graphAttempt?.role !== "execute")
      throw new Error("只有当前成果执行回合可移交预览作业");
    const previous = this.forRun(run.id);
    if (previous) return previous;
    const job: PreviewJob = {
      ...entity(), id: definition.id, taskId: task.id, taskRevision: task.revision,
      loopId: task.loopId!, nodeId: run.graphAttempt.nodeId,
      nodeRevision: run.graphAttempt.nodeRevision, runId: run.id,
      state: "queued", definition, workPath, resources,
    };
    this.put(job);
    this.store.event("graph.preview.queued", job.id, { runId: job.runId, nodeId: job.nodeId });
    return job;
  }
  claim(id: string, now = Date.now()) {
    return this.store.tx(() => {
      const job = this.get(id);
      if (job?.state !== "queued") return;
      if (now >= job.definition.hardAt) {
        this.put({ ...job, state: "stopped", stop: "hard" });
        return;
      }
      const task = this.store.get<Task>("task", job.taskId);
      if (!task || !["active", "ready", "blocked"].includes(task.state) || task.revision !== job.taskRevision)
        return;
      const run = this.store.get<Run>("run", job.runId);
      if (!job.handoff || run?.state !== "ended" || run.outcome !== "completed") return;
      const conflict = (resources: string[], path: string) =>
        resources.some((value) => job.resources.includes(value)) || overlaps(path, job.workPath);
      if (this.held().some((other) => conflict(other.resources, other.workPath)) ||
          this.store.all<Run>("run").some((run) =>
            run.id !== job.runId && run.state !== "ended" &&
            conflict(run.graphAttempt?.resources ?? [], run.workPath))) return;
      const claimed = this.put({ ...job, state: "dispatching" });
      this.store.event("graph.preview.dispatching", job.id, { runId: job.runId, hardAt: job.definition.hardAt });
      return claimed;
    });
  }
  confirmHandoff(id: string) {
    const job = this.get(id)!;
    if (job.state === "queued" && !job.stop) {
      this.put({ ...job, handoff: true });
      this.store.event("graph.preview.handoff", id, { runId: job.runId });
    }
  }
  applied(id: string) {
    const job = this.get(id)!;
    this.put({ ...job, applied: true });
  }
  notDispatched(id: string) {
    const job = this.get(id)!;
    if (job.state === "dispatching") {
      this.put({ ...job, state: job.stop ? "stopped" : "failed" });
      this.store.event("graph.preview.not-dispatched", id, { stopped: !!job.stop });
    }
  }
  unknown(id: string) {
    const job = this.get(id)!;
    if (job.state === "dispatching" || job.state === "preparing" || job.state === "running" || job.state === "stopping") {
      this.put({ ...job, state: "unknown" });
      this.store.event("graph.preview.receipt-missing", id);
    }
  }
  recover() {
    for (const job of this.held())
      this.put({ ...job, state: "unknown" });
  }
  request(id: string, reason: PreviewStop["reason"]) {
    const job = this.get(id);
    if (!job || ["completed", "stopped", "failed"].includes(job.state)) return;
    return this.put({ ...job, stop: job.stop ?? reason, state: job.state === "queued" ? "stopped" : job.state });
  }
  observe(id: string, receipt: PreviewReceipt) {
    return this.store.tx(() => {
      const job = this.get(id);
      if (!job || job.state === "queued" || ["completed", "stopped", "failed"].includes(job.state) ||
          receipt.id !== job.id || receipt.receiptKey !== job.definition.receiptKey ||
          receipt.sequence <= (job.receipt?.sequence ?? 0) ||
          receipt.frames < (job.receipt?.frames ?? 0) ||
          receipt.frames > job.definition.frames ||
          (receipt.phase === "completed" && receipt.frames !== job.definition.frames)) return;
      const updated = this.put({ ...job, state: receipt.phase, receipt });
      if (previewTerminal(receipt.phase))
        this.store.event("graph.preview.terminal", job.id, {
          phase: receipt.phase, runId: job.runId, frames: receipt.frames, sequence: receipt.sequence,
        });
      return updated;
    });
  }
}
