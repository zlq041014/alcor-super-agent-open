import {
  CHIEF,
  defaultProfile,
  executorProfile,
  ProfileSchema,
  TaskInput,
  type LaunchCard,
  type ModelProfile,
  type ReuseGrant,
  type Task,
} from "../shared/contracts";
import type { Hub } from "./service";
import { stamp } from "./store";
import { workerId } from "./agent-ledger";
import { redact, hash } from "./security";
export type Delegation = { parent: string; bridge: any; through?: string; preview?: true };
type Data =
  | {
      kind: "discussion";
      projectId: string;
      title: string;
      route?: any;
      native?: string;
      nativeSource?: string;
    }
  | {
      kind: "executor";
      value: ReturnType<typeof TaskInput.parse>;
      delegation?: Delegation;
      openWorker?: boolean;
    };
type Record = {
  id: string;
  card: LaunchCard;
  data: Data;
  hash: string;
  state: "pending" | "confirming" | "created" | "cancelled" | "failed";
  profile?: ModelProfile;
  catalogVersion?: string;
  reuse?: ReuseGrant[];
  result?: any;
  revision?: number;
  error?: string;
};
export class Launches {
  constructor(private h: Hub) {}
  pending() {
    return this.h.store
      .all<Record>("agent-launch")
      .filter((r) => r.state === "pending")
      .map((r) => r.card);
  }
  propose(key: string, data: Data) {
    const id = "launch:" + key,
      store = this.h.store,
      digest = hash(JSON.stringify(data)),
      old = store.get<Record>("agent-launch", id);
    if (old) {
      if (old.hash !== digest) throw new Error("创建请求编号冲突");
      if (old.state === "created") return { saved: true, launchId: id };
      if (old.state !== "pending") throw new Error("这个创建请求已关闭");
      return { saved: true, launchId: id };
    }
    const parent =
      data.kind === "executor" ? data.delegation?.parent || CHIEF : CHIEF;
    const p = this.h.project(
      data.kind === "executor" ? data.value.projectId : data.projectId,
    );
    const cfg = this.h.settings();
    const member = data.kind === "executor" && data.value.rosterId ? this.h.rosterExecutor(data.value.rosterId) : undefined;
    const reuse = data.kind === "executor" && data.value.reuse?.length ? this.h.reuse.plan(p.id, data.value.reuse) : undefined;
    const materials = reuse && this.h.reuse.materials(p.id, reuse);
    const backend = member?.source ?? cfg.executorBackend;
    const profile = data.kind === "executor" ? executorProfile(cfg, backend) : defaultProfile(cfg);
    const card: LaunchCard = {
      id,
      kind: data.kind,
      ...(data.kind === "executor" ? { backend } : {}),
      ...(member ? { roster: { id: member.id, name: member.name, revision: member.revision } } : {}),
      ...(materials ? { reuse: materials.map(({ title, version }) => ({ title, version })) } : {}),
      parentAgentId: parent,
      projectId: p.id,
      title:
        data.kind === "executor"
          ? data.value.title || data.value.goal.slice(0, 80)
          : data.title,
      detail:
        data.kind === "executor"
          ? data.value.goal
          : data.native
            ? "引用指定原生会话的公开记录，开启星引讨论。"
            : "在此项目内开始独立讨论。",
      scope:
        data.kind === "discussion"
          ? "discussion"
          : data.value.mode === "read"
            ? "read"
            : materials || backend === "dsh" ||
                data.value.access === "project" ||
                data.value.isolate
              ? "project"
              : "codex",
      profile,
      approval:
        data.kind === "executor" && backend === "dsh"
          ? "never"
          : cfg.toolApproval,
      createdAt: stamp(),
      ...(data.kind === "executor" && data.delegation?.preview ? {
        handoff: {
          request: data.delegation.bridge.authorization,
          constraints: data.value.constraints,
          acceptance: data.value.acceptance,
          discussion: data.delegation.bridge.discussion,
        },
      } : {}),
    };
    const parentTask =
      parent !== CHIEF ? this.h.desk.agent(parent).taskId : undefined;
    store.put("agent-launch", {
      id,
      card,
      data,
      hash: digest,
      state: "pending",
      ...(reuse ? { reuse } : {}),
      revision: parentTask ? this.h.getTask(parentTask).revision : undefined,
    } satisfies Record);
    this.h.changed();
    return { saved: true, launchId: id };
  }
  cancel(id: string) {
    const r = this.h.store.get<Record>("agent-launch", id);
    if (!r || r.state !== "pending") throw new Error("此请求已处理");
    this.h.store.put("agent-launch", { ...r, state: "cancelled" });
    this.h.store.event("agent.creation-cancelled", id, {});
    this.h.changed();
    return true;
  }
  invalidateHandoffs(projectId: string) {
    for (const r of this.h.store.all<Record>("agent-launch")) {
      if (
        r.state !== "pending" || r.data.kind !== "executor" ||
        (projectId && r.card.projectId !== projectId)
      ) continue;
      const bridge = r.data.delegation?.bridge;
      if (bridge?.agentId && bridge.ruleVersion !== this.h.ruleVersion(r.card.projectId))
        this.cancel(r.id);
    }
  }
  checkDiscussionHandoff(delegation?: Delegation) {
    if (!delegation?.bridge?.agentId) return;
    const project = this.h.desk.agent(delegation.parent).projectId;
    if (delegation.bridge.ruleVersion !== this.h.ruleVersion(project))
      throw new Error("适用规则已更新，请重新整理讨论交接");
    const newest = this.h.desk
      .lines(delegation.parent)
      .filter(
        (line) =>
          (line.kind === "user" || line.kind === "assistant") &&
          line.label !== "开工指令" && line.status !== "failed",
      )
      .at(-1);
    if (newest?.id !== delegation.through)
      throw new Error("讨论内容已更新，请按最新讨论重新交接");
  }
  async confirm(id: string, raw: ModelProfile, catalogVersion?: string) {
    const profile = ProfileSchema.parse(raw),
      s = this.h.store,
      r = s.get<Record>("agent-launch", id);
    if (!r) throw new Error("创建请求不存在");
    if (
      r.state === "created" &&
      JSON.stringify(r.profile) === JSON.stringify(profile)
    )
      return r.result;
    if (r.state !== "pending")
      throw new Error("此创建请求已处理，不能重复创建");
    this.h.assertDispatchAvailable();
    this.h.project(r.card.projectId);
    if (r.card.parentAgentId !== CHIEF) {
      const parent = this.h.desk.agent(r.card.parentAgentId);
      if (parent.projectId !== r.card.projectId)
        throw new Error("委派项目已变化");
      if (parent.taskId) {
        const t = this.h.getTask(parent.taskId);
        if (t.archived || t.state === "cancelled" || t.revision !== r.revision)
          throw new Error("委派方的要求已变化，请取消并重新委派");
      }
      if (parent.kind === "discussion" && r.data.kind === "executor")
        this.checkDiscussionHandoff(r.data.delegation);
    }
    const backend = r.card.backend ?? "codex";
    if (catalogVersion !== undefined) {
      if (r.data.kind !== "executor") throw new Error("讨论不能使用执行端目录确认");
      this.h.executorCatalog.requireSelection(backend, catalogVersion, profile);
    }
    if (r.reuse) this.h.reuse.materials(r.card.projectId, r.reuse);
    if (r.card.roster && this.h.rosterExecutor(r.card.roster.id, r.card.roster.revision).source !== backend)
      throw new Error("Agent 执行来源已变化，请重新准备工作");
    if (r.data.kind === "executor") this.h.checkProfile(profile, backend);
    if (
      r.card.kind === "executor" &&
      backend === "codex" &&
      r.card.approval !== this.h.settings().toolApproval
    ) {
      s.put("agent-launch", {
        ...r,
        card: { ...r.card, approval: this.h.settings().toolApproval },
      });
      this.h.changed();
      throw new Error("工具审批设置已变更，请核对后再次确认");
    }
    s.put("agent-launch", { ...r, profile, catalogVersion, state: "confirming" });
    try {
      let result: any;
      if (r.data.kind === "executor") {
        const t = this.h.createTask(
          r.data.value,
          "confirmed:" + id,
          r.data.delegation,
          profile,
          r.card.approval,
          backend,
        );
        result = {
          revision: t.revision,
          state: t.state,
          saved: true,
          worker: workerId(t.id),
          id: t.id,
          ...(r.data.openWorker ? { openAgentId: workerId(t.id) } : {}),
        };
      } else if (r.data.native) {
        result = await this.h.desk.fromNative(
          r.data.projectId,
          r.data.native,
          profile,
          id,
          r.data.nativeSource,
        );
      } else {
        const a = this.h.desk.open(
          this.h.project(r.data.projectId),
          r.data.title,
          profile,
          id,
        );
        result = { saved: true, openAgentId: a.id };
        if (r.data.route)
          result = await this.h.desk.routed(
            r.data.route,
            a,
            "confirmed:" + id,
            true,
          );
      }
      s.put("agent-launch", { ...r, profile, catalogVersion, state: "created", result });
      s.event("agent.creation-confirmed", id, {
        profile,
        agentId: result.worker || result.openAgentId,
      });
      if (r.data.kind === "executor" && r.data.delegation?.bridge.agentId) {
        const a = this.h.desk.agent(result.worker);
        this.h.desk.note(
          "已确认并委派执行 · " + r.card.title,
          a,
          "handoff-trace:" + r.data.delegation.bridge.requestId,
        );
      }
      return result;
    } catch (e) {
      s.put("agent-launch", {
        ...r,
        profile,
        catalogVersion,
        state: "failed",
        error: redact((e as Error).message),
      });
      throw e;
    } finally {
      this.h.changed();
    }
  }
  recover() {
    for (const r of this.h.store.all<Record>("agent-launch"))
      if (r.state === "confirming") {
        const result = this.h.store.db
          .prepare("SELECT result FROM inbox WHERE id=?")
          .get("confirmed:" + r.id);
        const a = this.h.store.get("agent", "discussion:" + r.id);
        const t = result
          ? (JSON.parse(String(result.result)) as Task)
          : undefined;
        this.h.store.put("agent-launch", {
          ...r,
          state: t || a ? "created" : "failed",
          result: t
            ? { saved: true, worker: workerId(t.id), id: t.id }
            : a
              ? { saved: true, openAgentId: a.id }
              : undefined,
        });
      }
  }
}
