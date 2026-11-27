import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  DshDesktop,
  DshDesktopSendUnknown,
  DshDesktopUnavailable,
  dshBridgeVault,
  type DshDesktopSnapshot,
} from "../adapter/dsh-desktop";
import { overlaps } from "../core/policy";
import type { Entity, Project, Run } from "../shared/contracts";
import { samePath, verifiedDir } from "./local-projects";
import {
  cachedNative,
  publicNativeHistory,
  saveNative,
  type NativeHistory,
  type NativeList,
} from "./native-history";
import { hash, redact, Vault } from "./security";
import type { Hub } from "./service";
import { entity, stamp } from "./store";

export interface DesktopAction extends Entity {
  source: string;
  originalSource?: string;
  bridge: string;
  projectId: string;
  threadId: string;
  path: string;
  kind: "owner-send";
  payloadHash: string;
  text: string;
  state: "dispatching" | "accepted" | "unknown" | "rejected";
  turnId?: string;
  end?: "completed" | "interrupted" | "failed";
  checkError?: string;
}

const wireEvent = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.unknown()),
});
const content = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);
const sourceShape = z.object({
  kind: z.literal("user"),
  rpcId: z.string().optional(),
});

function terminal(reason: unknown) {
  const kind = z.object({ kind: z.string() }).safeParse(reason);
  if (!kind.success) return;
  switch (kind.data.kind) {
    case "completed":
      return "completed";
    case "aborted":
    case "cancelled":
      return "interrupted";
    case "error":
    case "failed":
      return "failed";
  }
}

function historyOf(snapshot: DshDesktopSnapshot) {
  type Receipt = {
    requestId: string;
    textHash: string;
    turnId?: string;
    end?: DesktopAction["end"];
  };
  type Group = {
    id: string;
    status: string;
    items: object[];
    receipts: Receipt[];
  };
  const groups: Group[] = [],
    receipts: Receipt[] = [];
  const events = snapshot.records
    .flatMap((record) => {
      const value = wireEvent.safeParse(
        z.object({ event: z.unknown() }).safeParse(record).data?.event,
      );
      return value.success ? [value.data] : [];
    })
    .sort((a, b) => a.seq - b.seq);
  if (events.some((event, i) => i > 0 && event.seq === events[i - 1].seq))
    throw new Error("DSH 原桌面历史含重复序号，不能据此核对");
  let active: Group | undefined, loose: Group | undefined;
  for (const event of events) {
    const { seq, data } = event;
    if (event.type === "turn/start") {
      loose = undefined;
      active = Number.isSafeInteger(data.turn)
        ? {
            id: "DSH #" + data.turn,
            status: "inProgress",
            items: [],
            receipts: [],
          }
        : undefined;
      if (active) groups.push(active);
      continue;
    }
    if (event.type === "turn/end") {
      const end = terminal(data.reason);
      if (active && active.id === "DSH #" + data.turn && end) {
        active.status = end;
        for (const receipt of active.receipts) receipt.end = end;
      }
      active = loose = undefined;
      continue;
    }
    const user =
      event.type === "user/message"
        ? sourceShape.safeParse(data.source).data
        : undefined;
    const assistant =
      event.type === "assistant/message"
        ? z.object({ content: z.unknown() }).safeParse(data.message).data
        : undefined;
    if (!user && !assistant) continue;
    const blocks = content.safeParse(user ? data.content : assistant?.content);
    if (!blocks.success) continue;
    const text = blocks.data
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("\n");
    if (!text) continue;
    if (!active && !loose) {
      loose = {
        id: "DSH 历史片段 #" + seq,
        status: "unknown",
        items: [],
        receipts: [],
      };
      groups.push(loose);
    }
    const group = active ?? loose!;
    const message = { id: "dsh-event:" + seq };
    group.items.push(
      user
        ? {
            ...message,
            type: "userMessage",
            clientId: user.rpcId,
            content: [{ type: "text", text }],
          }
        : { ...message, type: "agentMessage", text },
    );
    if (user?.rpcId) {
      const receipt = {
        requestId: user.rpcId,
        textHash: hash(text),
        turnId: active?.id,
      };
      receipts.push(receipt);
      active?.receipts.push(receipt);
    }
  }
  return {
    value: {
      title: redact(
        snapshot.projections?.values?.title || "DSH 原生会话",
      ).slice(0, 120),
      turns: publicNativeHistory(groups),
    },
    receipts,
  };
}

export class DshDesktopSessions {
  private checking?: Promise<void>;
  private nextCheckAt = 0;
  private lastChecked?: string;
  constructor(private readonly h: Hub) {}

  async source() {
    const endpoint = this.h.settings().dshDesktopUrl;
    if (!endpoint) return;
    const vault = new Vault(this.h.dir, dshBridgeVault);
    const generation = await vault.revision(endpoint);
    if (generation) return hash(JSON.stringify([endpoint, generation]));
  }

  async resultSource(projectId: string, threadId: string, requestId: string) {
    const action = this.h.store.get<DesktopAction>("dsh-native-action", requestId);
    const source = await this.source();
    const project = this.h.project(projectId);
    if (!source || !action?.end || action.projectId !== projectId || action.threadId !== threadId ||
        !samePath(action.path, project.path) || action.bridge !== hash(this.h.settings().dshDesktopUrl))
      throw new Error("原回合所属 DSH 桥或项目已变化，暂不能读取结果");
    return source;
  }

  private async binding(expected?: string) {
    const endpoint = this.h.settings().dshDesktopUrl;
    if (!endpoint) throw new Error("请先在设置保存 DSH 原桌面桥地址");
    const vault = new Vault(this.h.dir, dshBridgeVault);
    const revision = await vault.revision(endpoint);
    if (!revision) throw new Error("请先录入这个 DSH 原桌面桥的令牌");
    const source = hash(JSON.stringify([endpoint, revision]));
    if (expected !== undefined && expected !== source)
      throw new Error("DSH 原桌面桥或令牌已更换，请重新读取会话列表");
    const transport = new DshDesktop(
      endpoint,
      await vault.get(endpoint, revision),
    );
    return { source, bridge: hash(endpoint), transport };
  }

  private async assertBound(project: Project, source: string) {
    if (
      (await this.source()) !== source ||
      !samePath(project.path, this.h.project(project.id).path)
    )
      throw new Error("DSH 桥接或授权目录在读取期间变化");
  }

  async list(projectId: string) {
    const p = this.h.project(projectId),
      { source, transport } = await this.binding();
    const key = JSON.stringify([p.id, source]);
    try {
      const index = await transport.list();
      if (index.items.length) await verifiedDir(p.path, true);
      await this.assertBound(p, source);
      const items = index.items
        .filter((item) => item.cwd && samePath(item.cwd, p.path))
        .slice(0, 60)
        .map((item) => ({
          id: item.sessionId,
          title: redact(
            item.projections?.values?.title || "DSH 原生会话",
          ).slice(0, 120),
          projectId: null,
          cwd: p.path,
        }));
      const value = {
        items,
        incomplete:
          !!index.hasMore ||
          !!index.cursor ||
          index.items.length !== items.length,
      };
      if (items.length || !value.incomplete)
        saveNative(this.h.store, "dsh-native-list", key, p.path, value);
      return { ...value, source, offline: false };
    } catch (error) {
      if (!(error instanceof DshDesktopUnavailable)) throw error;
      await this.assertBound(p, source);
      const saved = cachedNative<NativeList>(
        this.h.store,
        "dsh-native-list",
        key,
        p.path,
      );
      return {
        items: saved?.value.items ?? [],
        incomplete: true,
        source,
        offline: true,
        cachedAt: saved?.fetchedAt,
      };
    }
  }

  private async readBound(
    p: Project,
    threadId: string,
    binding: Awaited<ReturnType<DshDesktopSessions["binding"]>>,
  ) {
    const index = await binding.transport.list();
    if (
      !index.items.some(
        (item) =>
          item.sessionId === threadId && item.cwd && samePath(item.cwd, p.path),
      )
    )
      throw new Error("DSH 原桌面桥未确认这个会话属于当前项目");
    const snapshot = await binding.transport.read(threadId);
    if (
      !samePath(snapshot.header.cwd, p.path) ||
      !samePath(await realpath(snapshot.header.cwd), p.path)
    )
      throw new Error("DSH 原桌面会话目录与授权项目不一致");
    await this.assertBound(p, binding.source);
    return historyOf(snapshot);
  }

  async read(projectId: string, threadId: string, source: string) {
    const p = this.h.project(projectId),
      binding = await this.binding(source);
    const key = JSON.stringify([projectId, threadId, source]);
    let value: NativeHistory,
      cachedAt: string,
      offline = false;
    try {
      const live = await this.readBound(p, threadId, binding);
      this.reconcile(p, threadId, binding, live.receipts);
      value = live.value;
      cachedAt = saveNative(
        this.h.store,
        "dsh-native-history",
        key,
        p.path,
        value,
      );
    } catch (error) {
      if (!(error instanceof DshDesktopUnavailable)) throw error;
      await this.assertBound(p, source);
      const saved = cachedNative<NativeHistory>(
        this.h.store,
        "dsh-native-history",
        key,
        p.path,
      );
      if (!saved) throw new Error("DSH 原桌面暂不可用，也没有已核对的历史副本");
      value = saved.value;
      cachedAt = saved.fetchedAt;
      offline = true;
    }
    return {
      projectId,
      threadId,
      source,
      ...value,
      cachedAt,
      offline,
      ownerAvailable: !offline,
      ownerRuntime: null,
      ownerReason: offline ? "DSH 原桌面桥当前离线。" : null,
      activeTurnId: null,
      incomplete: true,
      workspacePending: this.h.workspaceHolds().some((path) => overlaps(path, p.path)),
      note: offline
        ? "DSH 原桌面 · 已保存的只读历史副本。"
        : "DSH 原桌面近期历史。续聊沿用原会话权限；停止请在原窗口操作。",
      actions: this.h.store
        .all<DesktopAction>("dsh-native-action")
        .filter(
          (a) =>
            a.projectId === projectId &&
            a.threadId === threadId &&
            a.source === source &&
            samePath(a.path, p.path),
        )
        .slice(-10),
    };
  }

  private reconcile(
    p: Project,
    threadId: string,
    binding: { source: string; bridge: string },
    receipts: ReturnType<typeof historyOf>["receipts"],
  ) {
    let changed = false;
    for (const action of this.h.store.all<DesktopAction>("dsh-native-action")) {
      if (
        action.bridge !== binding.bridge ||
        action.projectId !== p.id ||
        action.threadId !== threadId ||
        !samePath(action.path, p.path) ||
        action.state === "rejected" ||
        action.state === "dispatching" ||
        (action.end && action.source === binding.source)
      )
        continue;
      const matches = receipts.filter(
        (r) => r.requestId === action.id && r.textHash === action.payloadHash,
      );
      if (matches.length !== 1) continue;
      const [receipt] = matches;
      if (
        (action.turnId && action.turnId !== receipt.turnId) ||
        (action.end && action.end !== receipt.end) ||
        (action.source === binding.source &&
          action.state === "accepted" &&
          action.turnId === receipt.turnId &&
          !receipt.end)
      )
        continue;
      this.h.store.put("dsh-native-action", {
        ...action,
        originalSource: action.originalSource ?? (action.source !== binding.source ? action.source : undefined),
        source: binding.source,
        state: "accepted",
        turnId: receipt.turnId,
        end: receipt.end,
        checkError: undefined,
        updatedAt: stamp(),
      });
      changed = true;
    }
    if (changed) this.h.changed();
  }

  holdPaths() {
    return this.h.store
      .all<DesktopAction>("dsh-native-action")
      .filter((action) => action.state !== "rejected" && !action.end)
      .map((action) => action.path);
  }

  tick() {
    if (this.checking || Date.now() < this.nextCheckAt) return;
    const waiting = this.h.store
      .all<DesktopAction>("dsh-native-action")
      .filter(
        (a) => (a.state === "accepted" || a.state === "unknown") && !a.end,
      );
    if (!waiting.length) return;
    const pending =
      waiting[
        (waiting.findIndex((a) => a.id === this.lastChecked) + 1) %
          waiting.length
      ];
    this.lastChecked = pending.id;
    this.checking = (async () => {
      try {
        const project = this.h.project(pending.projectId);
        const binding = await this.binding();
        if (
          binding.bridge !== pending.bridge ||
          !samePath(project.path, pending.path)
        )
          throw new Error("DSH 原桌面的桥地址或项目绑定已变化");
        const live = await this.readBound(project, pending.threadId, binding);
        if (!this.h.shuttingDown)
          this.reconcile(project, pending.threadId, binding, live.receipts);
      } catch (error) {
        if (this.h.shuttingDown) return;
        const action = this.h.store.get<DesktopAction>(
          "dsh-native-action",
          pending.id,
        );
        const checkError = redact((error as Error).message).slice(0, 220);
        if (action && !action.end && action.checkError !== checkError) {
          this.h.store.put("dsh-native-action", { ...action, checkError });
          this.h.changed();
        }
      }
    })()
      .catch(() => this.h.fault("DSH 原桌面回执保存失败"))
      .finally(() => {
        this.nextCheckAt = Date.now() + 8000;
        this.checking = undefined;
      });
  }

  async settle() {
    await this.checking;
  }

  async send(
    projectId: string,
    threadId: string,
    source: string,
    text: string,
    requestId: string,
    beforeNativeSend?: () => void,
  ) {
    const p = this.h.project(projectId),
      payloadHash = hash(text);
    const prior = () => {
      const action = this.h.store.get<DesktopAction>(
        "dsh-native-action",
        requestId,
      );
      if (
        action &&
        (action.projectId !== projectId ||
          action.threadId !== threadId ||
          action.source !== source ||
          action.payloadHash !== payloadHash ||
          !samePath(action.path, p.path))
      )
        throw new Error("DSH 原桌面发送请求编号冲突");
      return action;
    };
    const saved = prior();
    if (saved) return saved;
    this.h.assertDispatchAvailable();
    const binding = await this.binding(source);
    const live = await this.readBound(p, threadId, binding);
    this.reconcile(p, threadId, binding, live.receipts);
    const concurrent = prior();
    if (concurrent) return concurrent;
    this.h.assertDispatchAvailable();
    if (
      [
        ...this.h.workspaceHolds(),
        ...this.h.loop.busyPaths(),
        ...this.h.store
          .all<Run>("run")
          .filter((run) => run.state !== "ended")
          .map((run) => run.workPath),
      ].some((path) => overlaps(path, p.path))
    )
      throw new Error(
        "这个目录仍有执行或结果待核对；核对结束后再发送到 DSH 原桌面",
      );
    beforeNativeSend?.();
    const action: DesktopAction = {
      ...entity(),
      id: requestId,
      projectId,
      threadId,
      source,
      bridge: binding.bridge,
      path: p.path,
      payloadHash,
      kind: "owner-send",
      state: "dispatching",
      text: redact(text),
    };
    this.h.store.put("dsh-native-action", action);
    this.h.changed();
    try {
      await binding.transport.send(threadId, text, requestId);
      action.state = "accepted";
    } catch (error) {
      action.state =
        error instanceof DshDesktopSendUnknown ? "unknown" : "rejected";
      this.h.store.put("dsh-native-action", { ...action, updatedAt: stamp() });
      this.h.changed();
      throw error;
    }
    this.h.store.put("dsh-native-action", { ...action, updatedAt: stamp() });
    this.h.changed();
    return action;
  }
}
