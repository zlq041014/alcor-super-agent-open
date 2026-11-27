import net from "node:net";
import { randomUUID } from "node:crypto";
import { RpcError } from "./codex";
import { redact } from "../shared/redact";
const versions: Record<string, number> = {
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-interrupt-turn": 4,
};
const streamSnapshotVersion = 13;
type TerminalStatus = "completed" | "failed" | "interrupted";
type OwnerState = {
  cwd: string;
  runtime: "active" | "idle";
  turn?: {
    id: string;
    status: "inProgress" | TerminalStatus;
  };
  terminalTurns?: Map<string, TerminalStatus>;
};

function snapshotState(state: any): OwnerState | undefined {
  const runtime = state?.threadRuntimeStatus?.type;
  if (
    typeof state?.cwd !== "string" ||
    (runtime !== "active" && runtime !== "idle")
  )
    return;
  let turns: any[] = [];
  if (state.turnHistory?.kind === "canonical") {
    const history = state.turnHistory.history;
    const island = Array.isArray(history?.islands)
      ? history.islands.at(-1)
      : undefined;
    if (
      island?.newerBoundary?.status === "exhausted" &&
      Array.isArray(island.entries)
    ) {
      turns = island.entries.map((entry: any) => {
        const key = entry?.value;
        return typeof key === "string" && history.entitiesByKey && Object.hasOwn(history.entitiesByKey, key)
          ? history.entitiesByKey[key] : undefined;
      });
    }
  } else if (Array.isArray(state.turns)) turns = state.turns;
  const latest = turns.at(-1);
  const turn =
    typeof latest?.turnId === "string" &&
    latest.turnId &&
    ["inProgress", "completed", "failed", "interrupted"].includes(latest.status)
      ? { id: latest.turnId, status: latest.status }
      : undefined;
  const terminalTurns = runtime === "idle" ? new Map<string, TerminalStatus>(turns.flatMap((row) =>
    typeof row?.turnId === "string" && row.turnId &&
    (row.status === "completed" || row.status === "failed" || row.status === "interrupted")
      ? [[row.turnId, row.status]] : [],
  )) : undefined;
  return { cwd: state.cwd, runtime, turn, ...(terminalTurns?.size ? { terminalTurns } : {}) };
}

// Verified against the installed 26.1111.2228.0 desktop protocol table.
// Calls are routed to the existing owner. This client never resumes a foreign thread in app-server.
export class OwnerClient {
  constructor(private endpoint = "\\\\.\\pipe\\codex-ipc") {}
  private socket?: net.Socket;
  private id?: string;
  private buffer = Buffer.alloc(0);
  private connecting?: Promise<void>;
  private observing = new Map<
    string,
    {
      result: Promise<OwnerState | undefined>;
      finish: (value?: OwnerState) => void;
    }
  >();
  private pending = new Map<
    string,
    {
      method: string;
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      mutation: boolean;
      targetClientId?: string;
    }
  >();
  async connect() {
    if (this.id && this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      socket.on("data", (data) => {
        if (this.socket === socket) this.receive(data);
      });
      socket.on("close", () => this.disconnect(socket));
      socket.on("error", () => this.disconnect(socket));
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => fail("Codex 桌面控制通道不可达"),
            3000,
          );
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off("connect", connected);
            socket.off("close", closed);
          };
          const fail = (message: string) => {
            cleanup();
            reject(new Error(message));
          };
          const connected = () => {
            cleanup();
            resolve();
          };
          const closed = () => fail("Codex 桌面未启动或控制通道不可用");
          socket.once("connect", connected);
          socket.once("close", closed);
        });
        const response = await this.request("initialize", {
          clientType: "alcor-desktop",
        });
        if (
          typeof response.result?.clientId !== "string" ||
          !response.result.clientId
        )
          throw new Error("Codex 桌面握手没有可核对的客户端编号");
        this.id = response.result.clientId;
      } catch (error) {
        this.disconnect(socket);
        socket.destroy();
        throw error;
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private write(value: object) {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > 8 * 1024 * 1024) throw new RpcError("原生控制请求过大");
    if (!this.socket || this.socket.destroyed)
      throw new RpcError("Codex 桌面连接已断开，未发送此请求");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([header, data]));
  }
  request(
    method: string,
    params: any,
    targetClientId?: string,
    mutation = false,
  ): Promise<any> {
    if (!Object.hasOwn(versions, method)) throw new Error("原生控制方法未开放");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RpcError("原生 owner 响应超时，请先核对操作结果", mutation));
      }, 15000);
      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer,
        mutation,
        targetClientId,
      });
      try {
        this.write({
          type: "request",
          requestId,
          sourceClientId: this.id || "initializing-client",
          method,
          version: versions[method],
          params,
          ...(targetClientId ? { targetClientId } : {}),
          timeoutMs: 14000,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt32LE();
      if (!n || n > 8 * 1024 * 1024) {
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < n + 4) return;
      let value: any;
      try {
        value = JSON.parse(this.buffer.subarray(4, n + 4).toString("utf8"));
      } catch {
        this.socket?.destroy();
        return;
      }
      this.buffer = this.buffer.subarray(n + 4);
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.type !== "string"
      ) {
        this.socket?.destroy();
        return;
      }
      if (
        value.type === "client-discovery-request" &&
        typeof value.requestId === "string"
      ) {
        this.write({
          type: "client-discovery-response",
          requestId: value.requestId,
          response: { canHandle: false },
        });
        continue;
      }
      if (
        value.type === "broadcast" &&
        value.method === "thread-stream-state-changed"
      ) {
        const params = value.params,
          change = params?.change;
        if (
          value.version === streamSnapshotVersion &&
          typeof value.sourceClientId === "string" &&
          Array.isArray(value.targetClientIds) &&
          value.targetClientIds.includes(this.id) &&
          params?.hostId === "local" &&
          typeof params.conversationId === "string" &&
          change?.type === "snapshot" &&
          change.conversationState?.id === params.conversationId
        ) {
          const pending = this.observing.get(
            JSON.stringify([params.conversationId, value.sourceClientId]),
          );
          if (pending) pending.finish(snapshotState(change.conversationState));
        }
        continue;
      }
      if (value.type !== "response") continue;
      const p = this.pending.get(value.requestId);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(value.requestId);
      if (
        value.resultType === "success" &&
        value.method === p.method &&
        (!p.targetClientId || value.handledByClientId === p.targetClientId)
      )
        p.resolve(value);
      else if (value.resultType === "success")
        p.reject(new RpcError("原生回执未匹配请求的方法或原窗口", p.mutation));
      else
        p.reject(
          new RpcError(
            `原生 owner 拒绝请求：${redact(String(value.error?.code || value.error || "unknown")).slice(0, 150)}`,
            p.mutation,
          ),
        );
    }
  }
  async observe(threadId: string, ownerId: string) {
    const socket = this.socket;
    if (!socket?.writable || !this.id) return;
    const key = JSON.stringify([threadId, ownerId]);
    const existing = this.observing.get(key);
    if (existing) return existing.result;
    const follow = (following: boolean) =>
      this.write({
        type: "broadcast",
        sourceClientId: this.id,
        targetClientIds: [ownerId],
        method: "thread-stream-following-changed",
        version: 1,
        params: { hostId: "local", conversationId: threadId, following },
      });
    let finish!: (value?: OwnerState) => void;
    const result = new Promise<OwnerState | undefined>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(finish, 2000);
    this.observing.set(key, { result, finish });
    try {
      follow(true);
      return await result;
    } finally {
      clearTimeout(timer);
      if (this.observing.get(key)?.result === result)
        this.observing.delete(key);
      if (this.socket === socket && socket.writable) follow(false);
    }
  }
  async owner(threadId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error("原生身份无效");
    await this.connect();
    try {
      const r = await this.request("thread-owner-discovery", {
        hostId: "local",
        conversationId: threadId,
      });
      return typeof r.handledByClientId === "string"
        ? r.handledByClientId
        : null;
    } catch (e) {
      if (
        e instanceof RpcError &&
        /^原生 owner 拒绝请求：(no-client-found|client-cannot-handle)$/.test(
          e.message,
        )
      )
        return null;
      throw e;
    }
  }
  private async requireOwner(threadId: string) {
    const owner = await this.owner(threadId).catch((e) => {
      throw new RpcError((e as Error).message);
    });
    if (!owner)
      throw new RpcError(
        "这个会话没有可用的原 owner，请在 Codex 原生界面打开后重试",
      );
    return owner;
  }
  async send(threadId: string, text: string, cwd: string, requestId: string, beforeSend?: () => void) {
    const owner = await this.requireOwner(threadId);
    try { beforeSend?.(); }
    catch (error) { throw new RpcError((error as Error).message); }
    const restoreMessage = {
      id: requestId,
      text,
      cwd,
      createdAt: Date.now(),
      context: {
        prompt: text,
        addedFiles: [],
        fileAttachments: [],
        imageAttachments: [],
        ideContext: null,
        workspaceRoots: [cwd],
      },
    };
    const r = await this.request(
      "thread-follower-start-turn",
      {
        conversationId: threadId,
        turnStart: {
          request: {
            threadId,
            input: [{ type: "text", text, text_elements: [] }],
            clientUserMessageId: requestId,
          },
          context: { restoreMessage, inheritThreadSettings: true },
        },
      },
      owner,
      true,
    );
    const turnId = r.result?.result?.turnId || r.result?.result?.turn?.id;
    if (typeof turnId !== "string" || !turnId)
      throw new RpcError("原 owner 缺少发送回合回执", true);
    return { threadId, turnId, accepted: true };
  }
  async stop(threadId: string, turnId: string, observedOwner?: string) {
    const owner = observedOwner || (await this.requireOwner(threadId));
    const response = await this.request(
      "thread-follower-interrupt-turn",
      { conversationId: threadId, mode: "user-stop", expectedTurnId: turnId },
      owner,
      true,
    );
    if (response.result?.ok === true) {
      if (response.result.interruptedTurnId === null) return false;
      if (response.result.interruptedTurnId === turnId) return true;
    }
    throw new RpcError("原 owner 未提供目标回合的停止接收回执", true);
  }
  private disconnect(socket: net.Socket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.id = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError("原生 owner 连接中断", p.mutation));
    }
    this.pending.clear();
    for (const p of this.observing.values()) p.finish();
    this.observing.clear();
  }
  close() {
    this.socket?.destroy();
  }
}
