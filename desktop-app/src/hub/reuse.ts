import { randomUUID } from "node:crypto";
import type { ReuseGrant, ReuseItem, ReuseKind, ReuseMaterial, ReuseRef, ReuseUse, ReuseVersion, Run, Task } from "../shared/contracts";
import { redact } from "./security";
import type { Hub } from "./service";
import { entity, stamp } from "./store";

type Item = Omit<ReuseItem, "projectIds" | "kind"> & { kind?: ReuseKind; grants: Record<string, string> };
type Version = Omit<ReuseVersion, "kind"> & { kind?: ReuseKind };
const key = (ref: ReuseRef) => JSON.stringify([ref.id, ref.versionId]);

export class Reuse {
  constructor(private h: Hub) {}

  private get store() { return this.h.store; }
  private item(id: string) {
    const item = this.store.get<Item>("reuse-item", id);
    if (!item) throw new Error("找不到这项留用内容");
    return item;
  }

  private bound(item: Item, projectId: string) {
    const grant = Object.hasOwn(item.grants, projectId) ? item.grants[projectId] : undefined;
    return item.active && grant && !this.store.db.prepare("SELECT 1 FROM tombstones WHERE id=?").get("reuse-grant:" + grant)
      ? grant : undefined;
  }

  private public(item: Item): ReuseItem {
    const { grants, ...meta } = item;
    return { ...meta, kind: item.kind ?? "content", projectIds: Object.keys(grants).filter(p => !!this.bound(item, p)) };
  }

  list() { return this.store.all<Item>("reuse-item").map(item => this.public(item)); }
  uses() { return this.store.all<ReuseUse>("reuse-use"); }

  private accepted(task: Task, runId: string) {
    const run = this.store.get<Run>("run", runId);
    if (!run || run.taskId !== task.id || task.runId !== runId || run.revision !== task.revision ||
        task.state !== "done" || run.state !== "ended" || run.outcome !== "completed" ||
        !this.store.db.prepare(`SELECT 1 FROM records WHERE kind='acceptance'
          AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.runId')=? AND json_extract(data,'$.revision')=? LIMIT 1`)
          .get(task.id, runId, task.revision))
      throw new Error("请选择账本中已经验收的交付回合");
    return run;
  }

  private grants(projectIds: string[], before?: Item) {
    if (new Set(projectIds).size !== projectIds.length) throw new Error("不能重复选择项目");
    for (const project of projectIds) this.h.project(project);
    return Object.fromEntries(projectIds.map(id => [id, before && this.bound(before, id) || randomUUID()]));
  }

  private save(item: Item, previous?: Item) {
    if (previous) for (const [id, oldGrant] of Object.entries(previous.grants)) {
      if (item.active && item.grants[id] === oldGrant) continue;
      this.store.db.prepare("INSERT OR IGNORE INTO tombstones VALUES(?,?)").run("reuse-grant:" + oldGrant, stamp());
    }
    this.store.put("reuse-item", item);
    return this.public(item);
  }

  publish(input: { id?: string; revision?: number; taskId: string; runId: string; title: string; condition: string; excerpt: string;
    kind?: ReuseKind; guidance?: string; projectIds: string[] }) {
    const task = this.h.getTask(input.taskId), project = this.h.project(task.projectId);
    const run = this.accepted(task, input.runId);
    if (!run.response.includes(input.excerpt)) throw new Error("留用内容应来自该回合的一段连续原文");
    const localPath = (text: string) => text.replaceAll("\\", "/").toLowerCase();
    if (localPath([input.title, input.condition, input.excerpt, input.guidance].join("\n")).includes(localPath(project.path)))
      throw new Error("请去掉原项目目录，只保留可分享的文字");
    const prior = input.id ? this.item(input.id) : undefined;
    if ((prior && (prior.revision !== input.revision || prior.projectId !== task.projectId)) || (!prior && input.revision))
      throw new Error("留用条目或来源已变化，请重新核对");
    const priorKind = prior?.kind ?? "content";
    const kind = input.kind ?? priorKind;
    if (prior && kind !== priorKind) throw new Error("留用条目的类别不能随版本更改");
    if (kind === "experience" && !input.guidance) throw new Error("请填写可复用的做法");
    if (kind !== "experience" && input.guidance !== undefined) throw new Error("只有经验可以另写可复用的做法");
    const item: Item = { ...(prior ?? entity()), kind, title: redact(input.title), condition: redact(input.condition),
      projectId: task.projectId, version: (prior?.version ?? 0) + 1, versionId: randomUUID(), revision: (prior?.revision ?? 0) + 1,
      grants: this.grants(input.projectIds, prior), active: true, updatedAt: stamp() };
    return this.store.tx(() => {
      this.store.put("reuse-version", { id: key(item), kind, title: item.title, condition: item.condition, version: item.version,
        text: redact(input.guidance ?? input.excerpt), ...(kind === "experience" && { sourceExcerpt: redact(input.excerpt) }),
        taskId: task.id, runId: run.id } satisfies Version);
      return this.save(item, prior);
    });
  }

  scope(id: string, revision: number, projectIds: string[], active: boolean) {
    const before = this.item(id);
    if (before.revision !== revision) throw new Error("留用条目已变化，请重新打开");
    const grants = active ? this.grants(projectIds, before) : {};
    return this.store.tx(() => this.save({ ...before, grants, active, revision: revision + 1, updatedAt: stamp() }, before));
  }

  inspect(ref: ReuseRef): ReuseVersion {
    const version = this.store.get<Version>("reuse-version", key(ref));
    if (!version || version.version !== ref.version) throw new Error("留用版本不可核对");
    return { ...version, kind: version.kind ?? "content" };
  }

  inspectProject(projectId: string, ref: ReuseRef) {
    this.h.project(projectId);
    return this.materials(projectId, this.plan(projectId, [ref]))[0];
  }

  project(projectId: string) {
    this.h.project(projectId);
    return this.store.all<Item>("reuse-item").filter(item => this.bound(item, projectId)).map(item => ({
      id: item.id, version: item.version, versionId: item.versionId, kind: item.kind ?? "content", title: item.title, condition: item.condition,
    }));
  }

  plan(projectId: string, refs: ReuseRef[]) {
    if (new Set(refs.map(r => r.id)).size !== refs.length) throw new Error("每项留用内容只能选择一个版本");
    return refs.map(ref => {
      const item = this.item(ref.id), grant = this.bound(item, projectId);
      if (!grant || item.version !== ref.version || item.versionId !== ref.versionId) throw new Error("留用版本或项目授权已变化，请重新选择");
      return { ...ref, grant };
    });
  }

  materials(projectId: string, refs: ReuseGrant[]): ReuseMaterial[] {
    return refs.map(ref => {
      const item = this.item(ref.id);
      if (this.bound(item, projectId) !== ref.grant) throw new Error("留用内容已撤回或停用，未发送到执行端");
      const { title, condition, kind, text, taskId, runId } = this.inspect(ref);
      if (!this.store.get("task", taskId) || !this.store.get("run", runId)) throw new Error("留用来源已无法核对");
      return { title, condition, kind, text, version: ref.version };
    });
  }

  record(taskId: string, runId: string, ref: ReuseRef, outcome: ReuseUse["outcome"], note: string) {
    const task = this.h.getTask(taskId), run = this.accepted(task, runId);
    if (!run.turnId || !run.reuseInputs?.some(input => key(input) === key(ref) && input.version === ref.version))
      throw new Error("这个执行回合没有发送所选留用版本");
    if (outcome === "counterexample" && !note) throw new Error("请记录这次不适用的原因");
    const id = JSON.stringify([taskId, ref.id, ref.versionId]);
    const previous = this.store.get<ReuseUse>("reuse-use", id);
    if (previous) {
      if (previous.runId !== runId || previous.outcome !== outcome || previous.note !== redact(note))
        throw new Error("该任务已记录此版本的采用结果");
      return previous;
    }
    const item = this.item(ref.id);
    return this.store.tx(() => {
      const result = this.store.put("reuse-use", { ...entity(), id, ref, taskId, runId, projectId: task.projectId, outcome, note: redact(note) } satisfies ReuseUse);
      if (outcome === "counterexample" && item.versionId === ref.versionId && item.active)
        this.save({ ...item, grants: {}, active: false, revision: item.revision + 1, updatedAt: stamp() }, item);
      return result;
    });
  }
}
