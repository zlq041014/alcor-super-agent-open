import type { Agent, RosterMember, Run, Task } from "../shared/contracts";
import { redact } from "./security";
import { Roster } from "./roster";
import { stamp, type Store } from "./store";

const LIMIT = 250;

export function projectAgentTree(store: Store, projectId: string, workForTask: ReadonlyMap<string, string>) {
  const rows = store.db.prepare(
    "SELECT data FROM records WHERE kind='agent' AND json_extract(data,'$.projectId')=? ORDER BY updated DESC, id LIMIT ?",
  ).all(projectId, LIMIT + 1);
  const agents = rows.slice(0, LIMIT).map((row) => JSON.parse(String(row.data)) as Agent);
  const known = new Set(agents.map((a) => a.id));
  const members = new Map<string, RosterMember | undefined>();
  const roster = new Roster(store);
  return {
    at: stamp(), truncated: rows.length > LIMIT,
    nodes: agents.map((agent) => {
      const raw = agent.taskId ? store.get<Task>("task", agent.taskId) : undefined;
      const task = raw?.projectId === projectId ? raw : undefined;
      const rosterId = task ? roster.forTask(task) : undefined;
      if (rosterId && !members.has(rosterId)) members.set(rosterId, store.get<RosterMember>("agent-roster", rosterId));
      const member = rosterId ? members.get(rosterId) : undefined;
      const recent = task?.runId ? store.get<Run>("run", task.runId) : undefined;
      const run = task && recent?.taskId === task.id && recent.revision === task.revision ? recent : undefined;
      const bound = store.get<{ projectId: string; threadId: string; nativeSource?: string }>("agent-source", agent.id);
      const session = bound?.projectId === projectId && bound.threadId ? {
        backend: bound.nativeSource ? "dsh" : "codex", threadId: bound.threadId, source: bound.nativeSource,
      } : undefined;
      const backend = session?.backend ?? run?.backend ?? task?.backend ?? (task ? "codex" : undefined);
      return {
        id: agent.id,
        parentId: known.has(agent.parentAgentId) ? agent.parentAgentId : undefined,
        kind: agent.kind,
        title: redact(agent.title).slice(0, 160),
        backend,
        model: redact(run?.profile?.model ?? task?.model ?? agent.profile?.model ?? "").slice(0, 120) || undefined,
        at: [agent.updatedAt, task?.updatedAt, run?.updatedAt].filter(Boolean).sort().at(-1),
        state: task?.state === "active" && run && run.state !== "ended" ? run.state :
          task?.state ?? (agent.kind === "discussion" ? "discussion" : "unknown"),
        session, discussionId: agent.kind === "discussion" ? agent.id : undefined,
        workId: task ? workForTask.get(task.id) : undefined,
        ...(member ? { roster: { id: member.id, name: member.name, source: member.source, recorded: !task?.rosterId } } : {}),
      };
    }),
  };
}
