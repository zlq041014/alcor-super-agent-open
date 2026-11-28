import type { Artifact, ManualAcceptance, ManualAcceptanceDetail, Run, Task } from "../shared/contracts";
import { resultArtifacts, resultEvidence } from "../shared/result-evidence";
import { hash, redact } from "./security";
import type { Store } from "./store";

type Row = Omit<ManualAcceptance, "at"> & { createdAt: string; reviewedBy?: "user"; resultHash?: string; evidenceHash?: string };
export const MANUAL_ACCEPTANCE_LIMIT = 100;

function isManual(row: Row) {
  return row.method === "user-review" || row.method === "loop-contract" && row.reviewedBy === "user";
}

function summary(store: Store, row: Row): ManualAcceptance {
  const { id, taskId, runId, revision, createdAt: at, method } = row;
  const task = row.title ? undefined : store.get<Task>("task", taskId);
  return { id, taskId, runId, revision, at, method, title: row.title ?? (task?.revision === revision ? task.title : undefined) };
}

export function resultBasis(store: Store, task: Task, run?: Run) {
  const title = redact(task.title);
  if (run?.taskId !== task.id || run.revision !== task.revision || run.state !== "ended" || run.outcome !== "completed") return { title };
  return { title, resultHash: hash(resultEvidence(run, resultArtifacts(store.all<Artifact>("artifact"), run))) };
}

export function manualAcceptances(store: Store): ManualAcceptance[] {
  return store.db.prepare(`SELECT json_remove(data,'$.evidence','$.evidenceHash','$.resultHash','$.versions') AS data
    FROM records WHERE kind='acceptance' AND (json_extract(data,'$.method')='user-review' OR
      (json_extract(data,'$.method')='loop-contract' AND json_extract(data,'$.reviewedBy')='user'))
    ORDER BY updated DESC,id LIMIT ?`).all(MANUAL_ACCEPTANCE_LIMIT)
    .map(row => summary(store, JSON.parse(String(row.data)) as Row));
}

export function readManualAcceptance(store: Store, id: string): ManualAcceptanceDetail {
  const row = store.get<Row>("acceptance", id);
  if (!row || !isManual(row)) throw new Error("找不到这条人工验收记录");
  const view = summary(store, row), run = row.runId ? store.get<Run>("run", row.runId) : undefined;
  if (!run || run.taskId !== row.taskId || run.revision !== row.revision || run.state !== "ended" || run.outcome !== "completed") return view;
  const files = resultArtifacts(store.all<Artifact>("artifact"), run);
  const actual = hash(resultEvidence(run, files));
  if ((row.resultHash ?? row.evidenceHash) !== actual) return view;
  const response = run.response.slice(0, 80000), diff = run.diff.slice(0, 24000);
  return { ...view, result: { response, diff,
    truncated: response.length < run.response.length || diff.length < run.diff.length || files.length > 30,
    files: files.slice(0, 30).map(({ id, name }) => ({ id, name })) } };
}
