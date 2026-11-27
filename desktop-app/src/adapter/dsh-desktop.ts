import { randomUUID } from "node:crypto";
import { z } from "zod";
import { endpointUrl } from "../core/policy";

export const dshBridgeVault = "dsh-desktop-bridge.dpapi";
export class DshDesktopUnavailable extends Error {}
export class DshDesktopSendUnknown extends Error {}

const id = z.string().min(1).max(200);
const projections = z.object({ values: z.object({ title: z.string().nullish() }).optional() }).optional();
const envelope = z.object({
  type: z.literal("server-response"),
  rpcId: id,
  result: z.object({
    ok: z.boolean(),
    value: z.unknown(),
    error: z.object({ code: z.string() }).optional(),
  }),
});
const sessionIndex = z.object({
  items: z.array(
    z.object({
      sessionId: id,
      cwd: z.string().max(4096).optional(),
      projections,
    }),
  ),
  hasMore: z.boolean().optional(),
  cursor: z.unknown().optional(),
});
const snapshotShape = z.object({
  type: z.literal("snapshot"),
  header: z.object({
    id,
    cwd: z.string().min(1).max(4096),
    version: z.literal(4),
  }),
  records: z.array(z.unknown()),
  hasMore: z.boolean(),
  projections,
});
export type DshDesktopSnapshot = z.infer<typeof snapshotShape>;
const maxFrame = 4 * 1024 * 1024;

async function readJson(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    body = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > maxFrame) {
      await reader.cancel();
      throw new Error("DSH 原桌面响应超过读取上限");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode()) as unknown;
}

export class DshDesktop {
  constructor(
    private readonly address: string,
    private readonly key: string,
  ) {}

  private async unary(method: "session/list" | "session/prompt", args: object) {
    const mutation = method === "session/prompt";
    const rpcId = randomUUID();
    const url = endpointUrl(this.address, "api/" + method);
    const unavailable = () =>
      mutation
        ? new DshDesktopSendUnknown("DSH 原桌面送达未确认，未重发")
        : new DshDesktopUnavailable("DSH 原桌面桥暂不可达");
    let reply: Response;
    try {
      reply = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          authorization: "Bearer " + this.key,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method,
          payload: { args },
        }),
      });
    } catch {
      throw unavailable();
    }
    if (!reply.ok) void reply.body?.cancel();
    if ([401, 403].includes(reply.status))
      throw new Error("DSH 原桌面桥拒绝了凭据或访问范围");
    if (
      reply.status >= 500 ||
      (mutation && !reply.ok && ![404, 405].includes(reply.status))
    )
      throw unavailable();
    if (!reply.ok)
      throw new Error("DSH 原桌面桥未提供受支持的接口");
    if (!reply.body) {
      if (mutation) throw unavailable();
      throw new Error("DSH 原桌面桥未返回读取回执");
    }
    let body: unknown;
    try {
      body = await readJson(reply);
    } catch {
      if (mutation) throw unavailable();
      throw new Error("DSH 原桌面响应无效或超过读取上限");
    }
    const parsed = envelope.safeParse(body);
    if (!parsed.success || parsed.data.rpcId !== rpcId) {
      if (mutation) throw unavailable();
      throw new Error("DSH 原桌面回执与请求不匹配");
    }
    if (!parsed.data.result.ok) {
      if (
        mutation &&
        ![
          "gateway/arguments-invalid",
          "gateway/input-invalid",
          "session/not-found",
        ].includes(parsed.data.result.error?.code || "")
      )
        throw unavailable();
      if (mutation) throw new Error("DSH 原桌面拒绝发送，未派发操作");
      throw new Error("DSH 原桌面拒绝读取会话");
    }
    return parsed.data.result.value;
  }

  async list() {
    const parsed = sessionIndex.safeParse(
      await this.unary("session/list", { _request: {} }),
    );
    if (!parsed.success) throw new Error("DSH 原桌面未返回可核对的会话列表");
    return parsed.data;
  }

  async read(threadId: string) {
    const endpoint = new URL(endpointUrl(this.address, "api/remote.mux"));
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    // Node's client supports headers; the renderer's browser WebSocket is not used here.
    const Socket =
      WebSocket as unknown as typeof import("undici-types").WebSocket;
    const socket = new Socket(endpoint, {
      headers: { authorization: "Bearer " + this.key },
    });
    const streamId = randomUUID();
    return new Promise<DshDesktopSnapshot>((resolve, reject) => {
      const finish = (result: DshDesktopSnapshot | Error) => {
        clearTimeout(timeout);
        socket.onclose =
          socket.onerror =
          socket.onopen =
          socket.onmessage =
            null;
        if (socket.readyState === Socket.OPEN)
          socket.send(JSON.stringify({ type: "cancel", streamId }));
        socket.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const unavailable = () =>
        finish(new DshDesktopUnavailable("DSH 原桌面历史暂不可达"));
      const timeout = setTimeout(unavailable, 10000);
      socket.onclose = socket.onerror = unavailable;
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            type: "open",
            streamId,
            endpoint: "session/follow",
            payload: {
              args: {
                request: {
                  address: { kind: "session", sessionId: threadId },
                  assistantStream: true,
                  maxMessages: 60,
                },
              },
            },
          }),
        );
      socket.onmessage = (event) => {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > maxFrame
        )
          return finish(new Error("DSH 原桌面历史响应超过读取上限或格式无效"));
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return finish(new Error("DSH 原桌面历史格式无效"));
        }
        if (message?.streamId !== streamId) return;
        if (message.type === "end" || message.type === "error")
          return finish(new Error("DSH 原桌面未返回会话快照"));
        if (message.type !== "item" || message.value?.type !== "snapshot")
          return;
        const snapshot = snapshotShape.safeParse(message.value);
        if (!snapshot.success || snapshot.data.header.id !== threadId)
          return finish(new Error("DSH 原桌面会话或协议版本与请求不匹配"));
        finish(snapshot.data);
      };
    });
  }

  async send(threadId: string, text: string, requestId: string) {
    const receipt = await this.unary("session/prompt", {
      request: {
        sessionId: threadId,
        requestId,
        mode: "queue",
        content: [{ type: "text", text }],
        clientTimeZone:
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
    });
    const parsed = z.object({ accepted: z.boolean() }).safeParse(receipt);
    if (!parsed.success)
      throw new DshDesktopSendUnknown("DSH 原桌面送达未确认，未重发");
    if (!parsed.data.accepted) throw new Error("DSH 原桌面没有接收这条消息");
  }
}
