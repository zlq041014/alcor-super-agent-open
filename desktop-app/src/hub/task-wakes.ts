import { loopExpired } from "../core/loop-policy";
import type { ModelProfile, Project, Run, Task, TaskWake } from "../shared/contracts";
import { workerId } from "./agent-ledger";
import { samePath, verifiedDir } from "./local-projects";
import type { Hub } from "./service";
import { entity, stamp } from "./store";

interface Wake extends TaskWake {
  stateVersion: number;
  projectPath: string;
  settingsRevision: number;
  contractRevision?: number;
  ruleVersion: string;
  profile: ModelProfile;
}

export class TaskWakes {
  constructor(private readonly hub: Hub) {}

  list(): TaskWake[] {
    return this.hub.store.all<Wake>("task-wake").map(
      ({ id, createdAt, updatedAt, taskId, wakeId, revision, at, state, reason }) =>
        ({ id, createdAt, updatedAt, taskId, wakeId, revision, at, state, reason }),
    );
  }

  private constraint(task: Task, now: number) {
    const cfg = this.hub.settings();
    if (!cfg.background) return "后台保留已关闭";
    if (task.state !== "paused" || task.archived || task.control?.endsWith("_requested"))
      return "只有已暂停且停止已确认的工作可以预约";
    const run = task.runId ? this.hub.store.get<Run>("run", task.runId) : undefined;
    if ((run && run.state !== "ended") || this.hub.loop.busy(task))
      return "执行或检查仍有活动或未知回执，不能预约";
    if (task.graph) {
      if (this.hub.graph.open(task).length || this.hub.graph.busy(task))
        return "成果仍有活动或未知回执，不能预约";
      const plan = this.hub.graph.ledger.get(task.loopId!);
      if (this.hub.graph.ledger.expired(plan, now) || plan.spent >= plan.limits.runs)
        return "原有额度已用完";
      return;
    }
    const loop = this.hub.loop.forTask(task);
    if (loop ? loopExpired(loop, now) || loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns
      : task.attempt >= cfg.maxRuns)
      return "原有额度已用完";
  }

  async schedule(taskId: string, revision: number, stateVersion: number, at: string) {
    const { hub } = this;
    hub.assertDispatchAvailable();
    const now = Date.now(), due = Date.parse(at);
    if (!Number.isFinite(due) || due <= now || due - now > 30 * 86400000)
      throw new Error("请选择未来 30 天内的时间");
    const project = hub.project(hub.getTask(taskId).projectId);
    await verifiedDir(project.path, true);
    const task = hub.getTask(taskId);
    if (task.revision !== revision || task.stateVersion !== stateVersion ||
        !samePath(hub.project(task.projectId).path, project.path))
      throw new Error("工作已更新，请刷新后预约");
    hub.assertDispatchAvailable();
    const reason = this.constraint(task, due);
    if (reason) throw new Error(reason);
    const existing = this.get(taskId);
    if (existing?.state === "scheduled")
      throw new Error("此工作已有预约，请先取消原预约");
    const issued = entity();
    const wake: Wake = {
      ...issued, id: taskId, wakeId: issued.id,
      taskId, revision, stateVersion, at: new Date(due).toISOString(), state: "scheduled",
      projectPath: project.path, settingsRevision: hub.settings().revision,
      contractRevision: hub.loop.forTask(task)?.contractRevision,
      ruleVersion: hub.ruleVersion(project.id),
      profile: hub.profile(workerId(task.id)),
    };
    hub.store.tx(() => this.write(wake, "scheduled"));
    hub.changed();
    return true;
  }

  cancel(taskId: string, wakeId: string) {
    const { hub } = this;
    const wake = this.get(taskId);
    if (!wake || wake.wakeId !== wakeId || wake.state !== "scheduled")
      throw new Error("预约已变化，请刷新后操作");
    hub.store.tx(() => this.write(wake, "cancelled", "用户取消了预约"));
    hub.changed();
    return true;
  }

  private get(taskId: string) {
    return this.hub.store.get<Wake>("task-wake", taskId);
  }

  private write(wake: Wake, state: Wake["state"], reason?: string) {
    // One displayed appointment per task; the event ledger keeps each appointment identity.
    this.hub.store.put("task-wake", { ...wake, state, reason, updatedAt: stamp() });
    this.hub.store.event("task.wake." + state, wake.taskId, { wakeId: wake.wakeId, revision: wake.revision });
  }

  private valid(wake: Wake, now: number) {
    const { hub } = this;
    if (now - Date.parse(wake.at) > 15 * 60000)
      return { reason: "星引未能在预约后 15 分钟内接续，预约已过期" };
    const task = hub.store.get<Task>("task", wake.taskId);
    if (!task || task.revision !== wake.revision || task.stateVersion !== wake.stateVersion)
      return { reason: "工作要求或状态已变化" };
    const reason = this.constraint(task, now);
    if (reason) return { reason };
    const project = hub.store.get<Project>("project", task.projectId);
    if (!project || project.removed || !samePath(project.path, wake.projectPath))
      return { reason: "原预约的授权目录已变化" };
    const profile = hub.profile(workerId(task.id));
    if (hub.settings().revision !== wake.settingsRevision ||
        hub.loop.forTask(task)?.contractRevision !== wake.contractRevision ||
        hub.ruleVersion(project.id) !== wake.ruleVersion ||
        profile.model !== wake.profile.model || profile.effort !== wake.profile.effort)
      return { reason: "预约所依据的模型、规则、清单或设置已变化" };
    return { task };
  }

  async tick(now = Date.now()) {
    const { hub } = this;
    const records = hub.store.all<Wake>("task-wake");
    for (const wake of records) {
      if (hub.shuttingDown) return;
      if (wake.state !== "scheduled") continue;
      let live = this.valid(wake, now);
      if (!live.reason && Date.parse(wake.at) > now) continue;
      if (!live.reason) {
        try {
          await verifiedDir(wake.projectPath, true);
        } catch (error) {
          live = { reason: (error as Error).message };
        }
        if (hub.shuttingDown) return;
        const latest = this.get(wake.taskId);
        if (latest?.wakeId !== wake.wakeId || latest.state !== "scheduled") continue;
        if (!live.reason) live = this.valid(wake, now);
      }
      hub.store.tx(() => {
        if (live.task) hub.prepareResume(live.task);
        this.write(wake, live.task ? "released" : "cancelled", live.reason);
      });
      hub.changed();
    }
  }
}
