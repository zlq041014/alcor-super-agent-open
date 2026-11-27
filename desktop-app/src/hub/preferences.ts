import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Message,
  PreferenceReference,
  Project,
  ReplyPreference,
  ReplyStyle,
} from "../shared/contracts";
import type { Hub } from "./service";
import { stamp, type Store } from "./store";

const windowMs = 60 * 86400000;
const keyFor = (projectId: string) => "reply-style:" + projectId;
const forgotten = (requestId: string) => "reply-style-source:" + requestId;
type Signal = ReplyPreference["evidence"][number];
interface Record extends PreferenceReference {
  projectId: string;
  evidence: Signal[];
  approved?: ReplyStyle;
  lastUsedAt?: string;
  updatedAt: string;
}

export function preferenceLearning(store: Store) {
  return (
    store.get<{ enabled: boolean }>("preference-setting", "global")?.enabled ===
    true
  );
}

function assessment(
  record: Record,
  learning: boolean,
  now: number,
): ReplyPreference {
  const evidence = record.evidence.filter(
    (item) => Date.parse(item.at) + windowMs > now,
  );
  const directions = new Set(evidence.map((item) => item.style));
  const style =
    directions.size === 1 && evidence.length >= 2
      ? evidence[0].style
      : undefined;
  const expiresAt = style
    ? new Date(
        evidence.map((item) => Date.parse(item.at)).sort((a, b) => b - a)[1] +
          windowMs,
      ).toISOString()
    : undefined;
  const state =
    directions.size > 1
      ? "conflicted"
      : !style
        ? evidence.length < record.evidence.length
          ? "expired"
          : "insufficient"
        : learning && record.approved === style
          ? "active"
          : "candidate";
  return {
    id: record.id,
    projectId: record.projectId,
    revision: record.revision,
    generation: record.generation,
    state,
    style,
    expiresAt,
    lastUsedAt: record.lastUsedAt,
    evidence: record.evidence,
  };
}

function currentScope(store: Store, projectId: string) {
  if (!projectId) return true;
  const project = store.get<Project>("project", projectId);
  return !!project && !project.removed;
}

export function currentPreference(store: Store, ref: PreferenceReference) {
  const record = store.get<Record>("reply-preference", ref.id);
  return (
    !!record &&
    record.revision === ref.revision &&
    record.generation === ref.generation &&
    currentScope(store, record.projectId) &&
    assessment(record, preferenceLearning(store), Date.now()).state === "active"
  );
}

export function restorePreference(record: Record, tombstones: Set<string>) {
  const evidence = record.evidence.filter(
    (item) => !tombstones.has(forgotten(item.requestId)),
  );
  return evidence.length
    ? {
        ...record,
        evidence,
        approved: undefined,
        revision: record.revision + 1,
        generation: crypto.randomUUID(),
      }
    : undefined;
}

export class Preferences {
  constructor(private readonly hub: Hub) {}

  list(now = Date.now()) {
    const { store } = this.hub;
    const learning = preferenceLearning(store);
    return store
      .all<Record>("reply-preference")
      .map((item) =>
        assessment(item, learning && currentScope(store, item.projectId), now),
      );
  }

  setLearning(enabled: boolean) {
    const { store } = this.hub;
    if (preferenceLearning(store) === enabled) return true;
    store.tx(() => {
      store.put("preference-setting", { id: "global", enabled });
      if (!enabled)
        for (const record of store.all<Record>("reply-preference"))
          if (record.approved) this.save(record, { approved: undefined });
      store.event("preference.learning", "global", { enabled });
    });
    this.hub.changed();
    return true;
  }

  private save(record: Record, change: Partial<Record>) {
    return this.hub.store.put("reply-preference", {
      ...record,
      ...change,
      revision: record.revision + 1,
      updatedAt: stamp(),
    }) as Record;
  }

  feedback(messageId: string, style: ReplyStyle) {
    const { store } = this.hub;
    if (!preferenceLearning(store)) throw new Error("请先打开答复偏好学习");
    const reply = store.get<Message>("message", messageId);
    const request =
      reply?.workRequestId &&
      store.get<Message>("message", reply.workRequestId);
    if (
      !reply ||
      reply.role !== "assistant" ||
      reply.taskId ||
      !request ||
      request.role !== "user" ||
      request.status !== "answered" ||
      request.taskId
    )
      throw new Error("只有已完成的总管答复可以作为偏好依据");
    const projectId = reply.projectId || "";
    if (!currentScope(store, projectId))
      throw new Error("答复所属项目已移除，不能新增偏好证据");
    if (
      store.db
        .prepare("SELECT 1 FROM tombstones WHERE id=?")
        .get(forgotten(request.id))
    )
      throw new Error("这轮答复的偏好证据已删除");
    const id = keyFor(projectId);
    const old = store.get<Record>("reply-preference", id) ?? {
      id,
      projectId,
      revision: 0,
      generation: crypto.randomUUID(),
      evidence: [],
      updatedAt: stamp(),
    };
    if (
      old.evidence.find((item) => item.requestId === request.id)?.style ===
      style
    )
      return assessment(old, true, Date.now());
    const now = Date.now();
    const evidence = [
      ...old.evidence.filter(
        (item) =>
          item.requestId !== request.id && Date.parse(item.at) + windowMs > now,
      ),
      { messageId, requestId: request.id, style, at: stamp() },
    ];
    const usable = assessment({ ...old, evidence }, true, now);
    const updated = store.tx(() => {
      const saved = this.save(old, {
        evidence,
        approved: old.approved === usable.style ? old.approved : undefined,
      });
      store.event("preference.observed", saved.id, {
        messageId,
        revision: saved.revision,
      });
      store.event(
        "preference.source",
        saved.id,
        { requestId: request.id },
        "preference-source:" + request.id,
      );
      return saved;
    });
    this.hub.changed();
    return assessment(updated, true, now);
  }

  hint(projectId: string) {
    const { store } = this.hub;
    if (!preferenceLearning(store) || !currentScope(store, projectId)) return;
    const record = store.get<Record>("reply-preference", keyFor(projectId));
    if (!record) return;
    const result = assessment(record, true, Date.now());
    if (result.state !== "active") return;
    return {
      ref: {
        id: record.id,
        revision: record.revision,
        generation: record.generation,
      },
      style: result.style!,
    };
  }

  used(ref: PreferenceReference) {
    const record = this.hub.store.get<Record>("reply-preference", ref.id)!;
    this.hub.store.put("reply-preference", { ...record, lastUsedAt: stamp() });
  }

  source(id: string, messageId: string) {
    const { store } = this.hub;
    const record = store.get<Record>("reply-preference", id);
    if (
      !record ||
      !currentScope(store, record.projectId) ||
      !record.evidence.some((item) => item.messageId === messageId)
    )
      throw new Error("这条偏好证据已不可用");
    const reply = store.get<Message>("message", messageId);
    if (!reply) throw new Error("原答复已不可用");
    return { text: reply.text, createdAt: reply.createdAt };
  }

  async manage(
    id: string,
    revision: number,
    generation: string,
    action: "enable" | "pause" | "delete" | "export",
  ) {
    const { store } = this.hub;
    const record = store.get<Record>("reply-preference", id);
    if (
      !record ||
      record.revision !== revision ||
      record.generation !== generation
    )
      throw new Error("偏好证据已变化，请刷新后操作");
    const learning =
      preferenceLearning(store) && currentScope(store, record.projectId);
    const result = assessment(record, learning, Date.now());
    if (action === "export") {
      const directory = join(this.hub.dir, "exports");
      await mkdir(directory, { recursive: true });
      const path = join(
        directory,
        "reply-preference-" + crypto.randomUUID() + ".json",
      );
      const live = store.get<Record>("reply-preference", id);
      if (live?.revision !== revision || live.generation !== generation)
        throw new Error("导出期间偏好证据已变化");
      await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" });
      return { path };
    }
    store.tx(() => {
      if (action === "delete") {
        const remember = store.db.prepare(
          "INSERT OR IGNORE INTO tombstones VALUES(?,?)",
        );
        const records = store.db
          .prepare(
            `
          SELECT json_extract(metadata,'$.requestId') AS requestId FROM events
          WHERE kind='preference.source' AND object_id=?
        `,
          )
          .all(id);
        for (const row of records)
          remember.run(forgotten(String(row.requestId)), stamp());
        for (const item of record.evidence)
          remember.run(forgotten(item.requestId), stamp());
        store.remove("reply-preference", id);
      } else {
        if (
          action === "enable" &&
          (!learning || result.state !== "candidate" || !result.style)
        )
          throw new Error("偏好学习未开启，或当前支持证据不足");
        this.save(record, {
          approved: action === "enable" ? result.style : undefined,
        });
      }
      store.event("preference." + action, id, { revision });
    });
    this.hub.changed();
    return true;
  }
}
