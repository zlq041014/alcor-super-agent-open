import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { OwnerClient } from "../src/adapter/owner";
import { RpcError } from "../src/adapter/codex";

function frame(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

test(
  "real IPC framing binds mutations to the original peer and reconnects after an invalid handshake",
  {
    skip: process.platform !== "win32",
    timeout: 10000,
  },
  async () => {
    const address = "\\\\.\\pipe\\alcor-owner-transport-" + randomUUID();
    const thread = randomUUID();
    const nativeOwner = "fixture-original-owner";
    let connections = 0;
    const subscriptions: boolean[] = [];
    const peers = new Set<net.Socket>();
    const recorded: {
      method: string;
      version: number;
      targetClientId?: string;
    }[] = [];
    const server = net.createServer((socket) => {
      const connection = ++connections;
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const size = pending.readUInt32LE();
          if (pending.length < 4 + size) return;
          const message = JSON.parse(
            pending.subarray(4, size + 4).toString("utf8"),
          );
          pending = pending.subarray(4 + size);
          if (message.method === "thread-stream-following-changed") {
            assert.deepEqual(message.targetClientIds, [nativeOwner]);
            assert.equal(message.params.conversationId, thread);
            subscriptions.push(message.params.following);
            if (message.params.following) {
              const state = {
                type: "broadcast",
                method: "thread-stream-state-changed",
                version: 13,
                targetClientIds: ["alcor-fixture"],
                params: {
                  conversationId: thread,
                  hostId: "local",
                  change: {
                    type: "snapshot",
                    conversationState: {
                      id: thread,
                      cwd: process.cwd(),
                      threadRuntimeStatus: { type: "active" },
                      turnHistory: {
                        kind: "canonical",
                        history: {
                          islands: [
                            {
                              newerBoundary: { status: "exhausted" },
                              entries: [{ value: "last" }],
                            },
                          ],
                          entitiesByKey: {
                            last: {
                              turnId: "durable-turn",
                              status: "inProgress",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              };
              const wrong = {
                ...state.params,
                change: {
                  type: "snapshot",
                  conversationState: {
                    id: thread,
                    cwd: process.cwd(),
                    threadRuntimeStatus: { type: "idle" },
                    turns: [{ turnId: "different-turn", status: "completed" }],
                  },
                },
              };
              socket.write(
                frame({
                  ...state,
                  params: wrong,
                  sourceClientId: "some-other-peer",
                }),
              );
              socket.write(
                frame({
                  ...state,
                  params: wrong,
                  version: 12,
                  sourceClientId: nativeOwner,
                }),
              );
              socket.write(frame({ ...state, sourceClientId: nativeOwner }));
            }
            continue;
          }
          if (message.type !== "request") continue;
          const { method, version, targetClientId, requestId, params } =
            message;
          recorded.push({ method, version, targetClientId });
          if (method === "initialize" && connection === 1) {
            socket.write(frame(null));
            continue;
          }
          const result =
            method === "initialize"
              ? { clientId: "alcor-fixture" }
              : method === "thread-follower-start-turn"
                ? { result: { turnId: "durable-turn" } }
                : method === "thread-follower-interrupt-turn"
                  ? {
                      ok: true,
                      interruptedTurnId: params.expectedTurnId,
                    }
                  : {};
          const reply = frame({
            type: "response",
            method,
            requestId,
            resultType: "success",
            handledByClientId:
              params.turnStart?.request?.clientUserMessageId ===
              "ambiguous-receipt"
                ? "different-fixture-peer"
                : nativeOwner,
            result,
          });
          socket.write(reply.subarray(0, 3));
          setImmediate(() => {
            if (!socket.destroyed) socket.write(reply.subarray(3));
          });
        }
      });
    });
    const client = new OwnerClient(address);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    try {
      await assert.rejects(client.connect(), /连接中断/);
      assert.equal(await client.owner(thread), nativeOwner);
      await assert.rejects(
        client.send(thread, "本地协议夹具", process.cwd(), "ambiguous-receipt"),
        (error: unknown) =>
          error instanceof RpcError &&
          error.uncertain &&
          /未匹配/.test(error.message),
      );
      const accepted = await client.send(
        thread,
        "独立请求",
        process.cwd(),
        "valid-receipt",
      );
      assert.equal(accepted.turnId, "durable-turn");
      const current = await client.observe(thread, nativeOwner);
      assert.deepEqual(current, {
        cwd: process.cwd(),
        runtime: "active",
        turn: { id: "durable-turn", status: "inProgress" },
      });
      assert.equal(await client.stop(thread, accepted.turnId), true);
      assert.equal(connections, 2);
      assert.deepEqual(subscriptions, [true, false]);
      assert.deepEqual(
        recorded.filter((record) => record.targetClientId),
        [
          {
            method: "thread-follower-start-turn",
            version: 2,
            targetClientId: nativeOwner,
          },
          {
            method: "thread-follower-start-turn",
            version: 2,
            targetClientId: nativeOwner,
          },
          {
            method: "thread-follower-interrupt-turn",
            version: 4,
            targetClientId: nativeOwner,
          },
        ],
      );
    } finally {
      client.close();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
