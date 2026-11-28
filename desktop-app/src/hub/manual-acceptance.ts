import type { Artifact, DecisionReview, ManualAcceptance, ManualAcceptanceDetail, Memory, RuleReference, Run, Task } from "../shared/contracts";
import { resultArtifacts, resultEvidence } from "../shared/result-evidence";
import { hash, redact } from "./security";
import type { Store } from "./store";
import { decisionText, usableRule } from "./project-decisions";

type Row = Omit<ManualAcceptance, "at"> & { createdAt: string; reviewedBy?: "user"; resultHash?: string; evidenceHash?: string;
  decisionAdoptions?: RuleReference[] };
export const MANUAL_ACCEPTANCE_LIMIT = 100;

function isManual(row: Row) {
  return row.method === "user-review" || row.method === "loop-contract" && row.reviewedBy === "user";
}

const referenceKey = (ref: RuleReference) => JSON.stringify([ref.id, ref.revision]);

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
  const task = store.get<Task>("task", row.taskId);
  const adopted = new Set((row.decisionAdoptions ?? []).map(referenceKey));
  const decisions = task && run.turnId ? (run.decisionInputs ?? []).flatMap(ref => {
    const text = decisionText(store.get<Memory>("memory", ref.id), task.projectId, ref.revision);
    return text === undefined ? [] : [{ ...ref, text, adopted: adopted.has(referenceKey(ref)) }];
  }) : [];
  const response = run.response.slice(0, 80000), diff = run.diff.slice(0, 24000);
  return { ...view, ...(decisions.length ? { decisions } : {}), result: { response, diff,
    truncated: response.length < run.response.length || diff.length < run.diff.length || files.length > 30,
    files: files.slice(0, 30).map(({ id, name }) => ({ id, name })) } };
}

export function adoptAcceptanceDecisions(store: Store, id: string, references: RuleReference[]): ManualAcceptanceDetail {
  return store.tx(() => {
    const view = readManualAcceptance(store, id);
    const eligible = new Set(view.decisions?.map(referenceKey));
    if (!references.every(ref => eligible.has(referenceKey(ref))))
      throw new Error("所选决定无法在这次验收的原回合核对");
    const row = store.get<Row>("acceptance", id)!;
    const prior = row.decisionAdoptions ?? [];
    const confirmed = new Set(prior.map(referenceKey));
    const added = references.filter(ref => {
      const key = referenceKey(ref);
      if (confirmed.has(key)) return false;
      confirmed.add(key);
      return true;
    });
    if (added.length) {
      store.put("acceptance", { ...row, decisionAdoptions: [...prior, ...added], updatedAt: row.createdAt });
      store.event("decision.adoption", id, { taskId: row.taskId, runId: row.runId, references: added });
    }
    return { ...view, decisions: view.decisions!.map(ref => ({ ...ref, adopted: confirmed.has(referenceKey(ref)) })) };
  });
}

export function projectDecisionReviews(store: Store, projectId: string): DecisionReview[] {
  const rows = store.db.prepare(`SELECT a.data AS receipt, t.data AS task FROM records a
    JOIN records t ON t.kind='task' AND t.id=json_extract(a.data,'$.taskId')
    WHERE a.kind='acceptance' AND json_extract(t.data,'$.projectId')=? AND json_extract(t.data,'$.state')='done'
      AND COALESCE(json_extract(t.data,'$.archived'),0)=0
      AND json_extract(t.data,'$.runId')=json_extract(a.data,'$.runId')
      AND json_extract(t.data,'$.revision')=json_extract(a.data,'$.revision')
      AND json_type(a.data,'$.decisionAdoptions')='array'
    ORDER BY a.updated DESC, a.id`).all(projectId);
  const rules = new Map(store.all<Memory>("memory", projectId).map(rule => [rule.id, rule]));
  const reviews: DecisionReview[] = [];
  for (const row of rows) {
    const accepted = JSON.parse(String(row.receipt)) as Row, task = JSON.parse(String(row.task)) as Task;
    if (!isManual(accepted) || !accepted.runId || !(accepted.resultHash ?? accepted.evidenceHash)) continue;
    const run = store.get<Run>("run", accepted.runId);
    if (!run?.turnId || run.taskId !== task.id || run.revision !== accepted.revision || run.state !== "ended" || run.outcome !== "completed") continue;
    const selected = new Set((run.decisionInputs ?? []).map(referenceKey));
    const changes = (accepted.decisionAdoptions ?? []).flatMap(ref => {
      const rule = rules.get(ref.id);
      if (!selected.has(referenceKey(ref)) || !rule || !usableRule(rule) || rule.revision === ref.revision) return [];
      const text = decisionText(rule, projectId, ref.revision);
      if (text === undefined || text === rule.text) return [];
      return [{ id: ref.id, previous: { revision: ref.revision, text }, current: { revision: rule.revision, text: rule.text } }];
    });
    if (changes.length) reviews.push({ acceptanceId: accepted.id, taskId: task.id, runId: accepted.runId,
      taskRevision: accepted.revision, title: accepted.title ?? task.title, changes });
  }
  return reviews;
}
