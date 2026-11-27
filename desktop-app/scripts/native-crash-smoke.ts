import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { assigned } from "../src/hub/agent-ledger";
import { childEnv, Vault } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";
import {
  defaults,
  type Command,
  type Project,
  type Run,
  type Snapshot,
  type Task,
} from "../src/shared/contracts";
import { submitAgentForm } from "../src/shared/agent-form";

async function until<T>(
  read: () => T | undefined,
  timeout: number,
  reason: string,
) {
  const end = Date.now() + timeout;
  do {
    const state = read();
    if (state !== undefined) return state;
    await delay(60);
  } while (Date.now() < end);
  throw new Error(reason);
}

function request<T>(hub: ChildProcess, value: any, internal?: string) {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clear();
      reject(new Error("Hub 测试请求超时"));
    }, 15000);
    const clear = () => {
      clearTimeout(timeout);
      hub.off("message", message);
      hub.off("exit", exit);
    };
    const message = (result: any) => {
      if (result.id !== id) return;
      clear();
      result.ok ? resolve(result.value) : reject(new Error(result.error));
    };
    const exit = () => {
      clear();
      reject(new Error("测试 Hub 在回复前退出"));
    };
    hub.on("message", message);
    hub.on("exit", exit);
    hub.send({ id, request: value, internal }, (error) => {
      if (!error) return;
      clear();
      reject(error);
    });
  });
}

async function main() {
  const codexPath = process.argv[2];
  if (!codexPath) throw new Error("请提供已验证的 Codex CLI 绝对路径");
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "native-crash-")),
    data = join(dir, "state"),
    project = join(dir, "project"),
    native = join(dir, "native");
  await Promise.all([data, project, native].map((path) => mkdir(path)));
  const model = { model: "gpt-6.2-sol", effort: "max" as const };
  const fixture = "ALCOR_CRASH_FIXTURE";
  const keyEnv = "OPENAI_API_KEY";
  let calls = 0;
  const server = createServer((incoming, response) => {
    if (incoming.url !== "/v1/responses" || incoming.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      let body = "";
      for await (const part of incoming) body += part;
      if (!body.includes(fixture)) {
        response.writeHead(422).end();
        return;
      }
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        "event: response.created\ndata: " +
          JSON.stringify({
            type: "response.created",
            response: {
              id: "resp_fixture_held",
              object: "response",
              model: model.model,
              output: [],
              status: "in_progress",
              created_at: 0,
            },
          }) +
          "\n\n",
      );
      // Hold the native turn in progress until the real Hub process is killed.
    })().catch(() => response.destroy());
  });
  const children: ChildProcess[] = [];
  async function start() {
    const child = fork(resolve("dist/hub-entry.cjs"), [data], {
      env: { ...childEnv(), CODEX_HOME: native },
      silent: true,
      windowsHide: true,
    });
    children.push(child);
    child.stdout?.resume();
    child.stderr?.resume();
    await new Promise<void>((ok, fail) => {
      const timeout = setTimeout(() => {
        cleanup();
        fail(new Error("隔离 Hub 未就绪"));
      }, 8000);
      const message = (event: any) => {
        if (event?.event === "ready" || event?.event === "fatal") {
          cleanup();
          event.event === "ready" ? ok() : fail(new Error(event.error));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", message);
      };
      child.on("message", message);
    });
    return child;
  }
  const persisted = <T>(kind: string) => {
    const db = new DatabaseSync(join(data, "state.sqlite"), { readOnly: true });
    try {
      return db
        .prepare("SELECT data FROM records WHERE kind=?")
        .all(kind)
        .map((row) => JSON.parse(String(row.data)) as T);
    } finally {
      db.close();
    }
  };
  try {
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", ok);
    });
    const endpoint =
      "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
    await writeFile(
      join(native, "config.toml"),
      [
        'model_provider = "alcor_fixture"',
        "[model_providers.alcor_fixture]",
        'name = "Alcor Crash Fixture"',
        "base_url = " + JSON.stringify(endpoint),
        'env_key = "' + keyEnv + '"',
        'wire_api = "responses"',
        "[windows]",
        'sandbox = "unelevated"',
      ].join("\n"),
    );
    await new Vault(data, "codex-native.dpapi").save(
      "codex:" + keyEnv,
      "ALCOR-ISOLATED-LOOPBACK",
    );

    const seededProject: Project = {
      ...entity(),
      name: "崩溃恢复隔离验收",
      path: project,
    };
    const prepared = entity(),
      run = entity();
    const task: Task = {
      ...entity(),
      projectId: seededProject.id,
      title: fixture,
      goal: "只根据本轮合成夹具返回简短答复：" + fixture,
      constraints: "只读；不调用工具。",
      acceptance: "",
      revision: 1,
      state: "active",
      stateVersion: 1,
      mode: "read",
      model: model.model,
      backend: "codex",
      access: "project",
      attempt: 1,
      runId: run.id,
      unread: false,
      archived: false,
      attachments: [],
      dependencies: [],
    };
    const seed = new Store(data);
    try {
      seed.tx(() => {
        seed.put("settings", {
          id: "global",
          value: {
            ...defaults,
            codexPath,
            codexCredentialEnv: keyEnv,
            executorBackend: "codex",
            toolApproval: "never",
            maxRuns: 3,
          },
        });
        seed.put("project", seededProject);
        seed.put("task", task);
        seed.put("agent", { ...assigned(seed, task), profile: model });
        seed.put("run", {
          ...run,
          taskId: task.id,
          commandId: prepared.id,
          revision: 1,
          state: "starting",
          backend: "codex",
          workPath: project,
          startedAt: run.createdAt,
          response: "",
          diff: "",
        } satisfies Run);
        seed.put("command", {
          ...prepared,
          taskId: task.id,
          runId: run.id,
          kind: "start",
          revision: 1,
          state: "prepared",
          payloadHash: "",
        } satisfies Command);
      });
    } finally {
      seed.close();
    }

    const first = await start();
    const before = await request<Snapshot>(first, { op: "snapshot" });
    assert.equal(before.tasks[0].state, "blocked");
    assert.equal(before.runs[0].state, "ended");
    assert.equal(persisted<Command>("command")[0].state, "voided");
    assert.equal(calls, 0);
    await request(first, {
      op: "task.control",
      id: task.id,
      action: "resume",
      revision: 1,
    });
    const outbound = await until(
      () =>
        calls > 0
          ? persisted<Command>("command").find(
              (c) =>
                c.id !== prepared.id && c.state === "accepted" && c.receipt,
            )
          : undefined,
      20000,
      "没有观察到真实 Codex 请求与持久接收回执",
    );
    const executing = persisted<Run>("run").find(
      ({ id }) => id === outbound.runId,
    )!;
    assert.equal(executing.state, "running");
    const dead = once(first, "exit");
    assert.ok(first.kill("SIGKILL"));
    await dead;

    const second = await start();
    const after = await request<Snapshot>(second, { op: "snapshot" });
    assert.ok(after.hub.generation > before.hub.generation);
    assert.equal(
      after.tasks.find((entry) => entry.id === task.id)?.state,
      "blocked",
    );
    const unknown = after.runs.find(({ id }) => id === executing.id)!;
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.turnId, executing.turnId);
    await assert.rejects(
      request(second, {
        op: "task.control",
        id: task.id,
        action: "resume",
        revision: 1,
      }),
      /未知|核对/,
    );
    await submitAgentForm((input) => request(second, input), {
      op: "task.create",
      requestId: "same-project-queued",
      profile: model,
      value: {
        projectId: seededProject.id,
        mode: "read",
        goal: "等待同一项目的未知回合核对：" + fixture,
      },
    });
    await delay(2100);
    const queued = await request<Snapshot>(second, { op: "snapshot" });
    assert.equal(
      queued.tasks.find((entry) => entry.id !== task.id)?.state,
      "ready",
    );
    assert.equal(queued.runs.length, 2);
    assert.equal(calls, 1);
    const result = {
      dir,
      passed: true,
      realHubProcesses: 2,
      nativeCli: "Codex",
      modelProvider: "loopback-test",
      preparedRecovery: "voided",
      acceptedBeforeCrash: true,
      taskAfterCrash: "blocked",
      runAfterCrash: "unknown",
      sameWorkspaceStillHeld: true,
      modelRequests: calls,
    };
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    server.closeAllConnections();
    server.close();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, "exit");
      try {
        await request(child, null, "shutdown");
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        throw error;
      } finally {
        await exit;
      }
    }
    await rm(join(data, "codex-native.dpapi"), { force: true });
  }
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
