import type { RosterMember, Task } from "../shared/contracts";
import { redact } from "./security";
import { entity, stamp, type Store } from "./store";

type RecordedLink = { id: string; memberId: string; projectId: string };

export class Roster {
  constructor(private store: Store) {}

  list() { return this.store.all<RosterMember>("agent-roster"); }

  private get(id: string) {
    const member = this.store.get<RosterMember>("agent-roster", id);
    if (!member) throw new Error("找不到名册中的 Agent");
    return member;
  }

  add(value: Pick<RosterMember, "name" | "note" | "mode" | "source">) {
    if (value.source === "manual" && value.mode === "managed") throw new Error("未接入的 Agent 只能登记分工");
    const member: RosterMember = { ...entity(), ...value, name: redact(value.name), note: redact(value.note), state: "active", revision: 1 };
    return this.store.put("agent-roster", member);
  }

  update(id: string, revision: number, value: Pick<RosterMember, "name" | "note" | "state">) {
    const member = this.get(id);
    if (member.revision !== revision) throw new Error("Agent 名册已变化，请重新打开");
    const name = redact(value.name), note = redact(value.note);
    if (member.name === name && member.note === note && member.state === value.state) return member;
    return this.store.put("agent-roster", { ...member, name, note, state: value.state, revision: revision + 1, updatedAt: stamp() });
  }

  link(id: string, task: Task) {
    const member = this.get(id);
    const before = this.forTask(task);
    if (before === id) return false;
    if (before) throw new Error("此工作已有登记身份，请从原工作核对");
    if (member.state === "retired") throw new Error("此 Agent 已退出管理");
    if (member.source !== "manual" && member.source !== (task.backend ?? "codex"))
      throw new Error("工作的实际执行端与登记来源不同");
    this.store.put("agent-roster-link", { id: task.id, memberId: id, projectId: task.projectId });
    return true;
  }

  forTask(task: Task) {
    return task.rosterId ?? this.store.get<RecordedLink>("agent-roster-link", task.id)?.memberId;
  }

  tasks(tasks: Task[]) {
    const recorded = new Map(this.store.all<RecordedLink>("agent-roster-link").map(link => [link.id, link.memberId]));
    return tasks.map(task => {
      const member = recorded.get(task.id);
      return !task.rosterId && member ? { ...task, rosterId: member, rosterRecorded: true as const } : task;
    });
  }

  dispatch(id: string, revision?: number) {
    const member = this.get(id);
    if (revision !== undefined && member.revision !== revision) throw new Error("Agent 名册已变化，请重新准备工作");
    if (member.mode !== "managed" || member.source === "manual" || member.state !== "active")
      throw new Error("该 Agent 当前不能接新工作");
    return { ...member, source: member.source };
  }
}
