import type { Agent, Run, Task } from "../shared/contracts";
import { redact } from "./security";
import { stamp, type Store } from "./store";

type Decision = { id: string; discussion: string; heads: string[]; versions: { version: string; text: string; at: string }[] };
type Work = { taskId?: string; data: { id: string; goal: string }; last?: {
  stage: string; runId?: string; evidenceHash?: string; question?: { expiresAt: string };
} };
type Target = { kind: "discussion" | "work"; id: string } | { kind: "decision"; id: string; discussion: string; version: string };
type Row = { id: string; text: string; at?: string; target?: Target };
const short = (text: string) => redact(text).slice(0, 240);
const receiptText: Record<string, string> = { queued: "电脑已登记", waiting: "等待回答", verify: "回执待核对", running: "执行中", review: "待验收", done: "已完成", failed: "未完成" };

export function mobileResume(store: Store, mobile: Store, projectId: string, deviceId: string, evidence = false) {
  const discussions = store.db.prepare(`SELECT data FROM records WHERE kind='agent' AND
    json_extract(data,'$.projectId')=? AND json_extract(data,'$.kind')='discussion' ORDER BY updated DESC, id LIMIT 250`)
    .all(projectId).map(row => JSON.parse(String(row.data)) as Agent);
  const changes: Row[] = discussions.slice(0, 6).map(row => ({ id: "discussion:" + row.id, text: short(row.title), at: row.updatedAt,
    target: { kind: "discussion", id: row.id } }));
  const decisions: Row[] = [], pending: Row[] = [], gaps: Row[] = [];
  const source = store.db.prepare(`SELECT data FROM records WHERE kind='mobile-decision'
    AND json_extract(data,'$.discussion') IN (SELECT value FROM json_each(?)) ORDER BY updated DESC, id LIMIT 18`)
    .all(JSON.stringify(discussions.map(d => d.id)));
  for (const row of source) {
    const record = JSON.parse(String(row.data)) as Decision;
    const target = { kind: "discussion" as const, id: record.discussion };
    const version = record.heads.length === 1 ? record.versions.find(v => v.version === record.heads[0]) : undefined;
    if (version) decisions.push({ id: record.id + ":" + version.version, text: short(version.text),
      ...(!evidence ? { at: version.at, target } : { target: { kind: "decision", id: record.id, discussion: record.discussion, version: version.version } }) });
    else gaps.push({ id: record.id, text: record.heads.length > 1 ? "原讨论有并列决定，等待核对。" : "原决定版本不可核对。", target });
  }

  const work = mobile.db.prepare(`SELECT data,updated FROM records WHERE kind='mobile-work'
    AND json_extract(data,'$.device')=? AND json_extract(data,'$.data.projectId')=? ORDER BY updated DESC, id LIMIT 24`)
    .all(deviceId, projectId);
  for (const entry of work) {
    const row = JSON.parse(String(entry.data)) as Work;
    const receipt = row.last;
    if (!receipt || !Object.hasOwn(receiptText, receipt.stage)) continue;
    const target = { kind: "work" as const, id: row.data.id };
    const item = { id: row.data.id, text: short(row.data.goal), at: String(entry.updated), target };
    if (receipt.stage === "review") {
      const task = row.taskId && store.get<Task>("task", row.taskId);
      const current = task && task.runId ? store.get<Run>("run", task.runId) : undefined;
      if (!receipt.evidenceHash || row.taskId && (!task || task.projectId !== projectId || task.state !== "verifying" ||
          !current || current.id !== receipt.runId || task.revision !== current.revision || current.state !== "ended" || current.outcome !== "completed")) {
        gaps.push({ ...item, text: "原验收回执有变化，请重新核对。" });
        continue;
      }
    }
    if (receipt.stage === "waiting" && receipt.question && Date.parse(receipt.question.expiresAt) <= Date.now()) {
      gaps.push({ ...item, text: "原待答请求已过期。" });
      continue;
    }
    item.text = receiptText[receipt.stage] + " · " + item.text;
    changes.push(item);
    if (receipt.stage === "review" || receipt.stage === "waiting") pending.push(item);
    if (receipt.stage === "verify") gaps.push(item);
  }
  return { at: stamp(), decisions: decisions.slice(0, 6), pending: pending.slice(0, 6), gaps: gaps.slice(0, 6),
    changes: changes.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 6) };
}
