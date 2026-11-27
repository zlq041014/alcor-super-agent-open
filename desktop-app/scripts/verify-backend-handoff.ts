import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Codex } from "../src/adapter/codex";
import { Hub } from "../src/hub/service";
import { hash, Vault } from "../src/hub/security";
import { submitAgentForm } from "../src/shared/agent-form";
import {
  defaultProfile,
  type Command,
  type Run,
  type Task,
} from "../src/shared/contracts";
import { entity } from "../src/hub/store";

const placeholder = "ALCOR-ISOLATED-LOOPBACK";
const inputs = ["ALCOR-CODEX-FIRST", "ALCOR-DSH-SECOND", "ALCOR-CODEX-THIRD"];
const answers = ["ALCOR-RESULT-A", "ALCOR-RESULT-B", "ALCOR-RESULT-C"];

async function main() {
  const codexPath = process.argv[2];
  if (!codexPath) throw new Error("请指定已安装的 Codex CLI 路径");
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "backend-handoff-"));
  const state = join(dir, "state"),
    home = join(dir, "codex"),
    work = join(dir, "workspace");
  await Promise.all([state, home, work].map((path) => mkdir(path)));
  const seen: number[] = [];
  let codexImageSeen = false,
    dshTextSeen = false;
  const attachmentText = "ALCOR-HANDOFF-ATTACHMENT";
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const input = JSON.stringify(request.messages ?? request.input);
      const model = String(request.model);
      const stage = inputs.findLastIndex((marker) => input.includes(marker));
      if (stage < 0 || (stage > 0 && !input.includes(answers[stage - 1]))) {
        res.writeHead(422).end();
        return;
      }
      if (stage === 1) {
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(model, "deepseek-flash");
        dshTextSeen = input.includes(attachmentText);
      } else {
        assert.equal(req.url, "/v1/responses");
        assert.equal(model, "gpt-6.2-sol");
        if (stage === 0) codexImageSeen = input.includes('"input_image"');
      }
      seen.push(stage);
      const answer = answers[stage];
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (stage === 1) {
        const chunk = (delta: object, finish_reason: string | null) =>
          "data: " +
          JSON.stringify({
            id: "chat-alcor",
            model,
            object: "chat.completion.chunk",
            created: 0,
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n";
        res.end(
          chunk({ role: "assistant", content: answer }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
        return;
      }
      const output = {
        id: "msg_fixture_" + stage,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: answer, annotations: [] }],
        status: "completed",
      };
      const response = {
        id: "resp_fixture_" + stage,
        object: "response",
        created_at: 0,
        status: "in_progress",
        model,
        output: [],
      };
      const event = (type: string, more: object) =>
        res.write(
          "event: " +
            type +
            "\ndata: " +
            JSON.stringify({ type, ...more }) +
            "\n\n",
        );
      event("response.created", { response });
      event("response.output_item.added", {
        output_index: 0,
        item: { ...output, status: "in_progress", content: [] },
      });
      event("response.output_text.delta", {
        item_id: output.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
      });
      event("response.output_item.done", { output_index: 0, item: output });
      event("response.completed", {
        response: {
          ...response,
          status: "completed",
          output: [output],
          usage: {
            input_tokens: 7,
            output_tokens: 4,
            total_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  const hub = new Hub(state, new Codex(home));
  const vault = hub.brain.vaultFor(hub.settings());
  const result = {
    dir,
    passed: false,
    codexToDsh: false,
    dshToCodex: false,
    isolatedModel: true,
    nativeHistoryReconciled: false,
    managedHistoryReconciled: false,
    attachmentsAcknowledged: false,
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const endpoint =
      "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
    await writeFile(
      join(home, "config.toml"),
      [
        'model_provider = "alcor_fixture"',
        "[model_providers.alcor_fixture]",
        'name = "Alcor local fixture"',
        "base_url = " + JSON.stringify(endpoint),
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "responses"',
        "[windows]",
        'sandbox = "unelevated"',
      ].join("\n"),
    );
    const base = {
      ...hub.settings(),
      endpoint,
      codexPath,
      codexCredentialEnv: "OPENAI_API_KEY",
      protocol: "chat" as const,
      maxMinutes: 2,
      concurrency: 1,
    };
    await new Vault(state, "codex-native.dpapi").save(
      "codex:OPENAI_API_KEY",
      placeholder,
    );
    await vault.save(endpoint, placeholder);
    const project = await hub.request({
      op: "project.add",
      path: work,
      name: "后端交接隔离验收",
    });
    const imagePath = resolve("assets/alcor.png"),
      textPath = join(dir, "sample.txt");
    await writeFile(textPath, attachmentText);
    const image = await hub.addAttachment(imagePath),
      text = await hub.addAttachment(textPath);
    const done: Task[] = [];
    for (const [i, goal] of inputs.entries()) {
      const backend = i === 1 ? "dsh" : "codex";
      const config = { ...base, executorBackend: backend as "dsh" | "codex" };
      await hub.request({ op: "settings", value: config });
      const t = await submitAgentForm(hub.request.bind(hub), {
        op: "task.create",
        requestId: "handoff-" + i,
        profile:
          backend === "codex"
            ? { model: "gpt-6.2-sol", effort: "max" }
            : defaultProfile(config),
        value: {
          projectId: project.id,
          goal: "只回复本轮合成结果，不使用工具：" + goal,
          mode: "read",
          advance: "single",
          dependencies: i ? [done[i - 1].id] : [],
          attachments: i === 0 ? [image.id] : i === 1 ? [text.id] : [],
        },
      });
      const until = Date.now() + 110000;
      while (Date.now() < until) {
        await hub.tick();
        if (["verifying", "blocked"].includes(hub.getTask(t.id).state)) break;
        await delay(200);
      }
      const task = hub.getTask(t.id);
      const run = task.runId
        ? hub.store.get<Run>("run", task.runId)
        : undefined;
      if (
        task.state !== "verifying" ||
        run?.outcome !== "completed" ||
        run.backend !== backend
      )
        throw new Error("第 " + (i + 1) + " 个真实执行端未完成");
      assert.equal(run.response.trim(), answers[i]);
      if (i < 2) {
        assert.ok(run.inputsAcceptedAt);
        assert.deepEqual(run.attachmentInputs, [
          i === 0
            ? { id: image.id, kind: "image" }
            : { id: text.id, kind: "text" },
        ]);
      }
      await hub.control(
        task.id,
        "accept",
        task.revision,
        hash(run.response + run.diff),
      );
      done.push(hub.getTask(task.id));
      if (i === 1) result.codexToDsh = true;
      if (i === 2) result.dshToCodex = true;
    }
    assert.deepEqual(seen, [0, 1, 2]);
    assert.ok(codexImageSeen);
    assert.ok(dshTextSeen);
    result.attachmentsAcknowledged = true;
    const runs = hub.store.all<Run>("run");
    assert.equal(runs.length, 3);
    assert.equal(new Set(runs.map((run) => run.threadId)).size, 3);
    for (const [offset, task] of done.slice(1).entries()) {
      const upstream = done[offset];
      const ctx = hub.store
        .all("context")
        .find((row) => row.taskId === task.id);
      assert.deepEqual(ctx.dependencies, [
        { id: upstream.id, revision: upstream.revision, runId: upstream.runId },
      ]);
    }
    const nativeRun = hub.store.get<Run>("run", done[2].runId!)!;
    const sent = hub.store.get<Command>("command", nativeRun.commandId)!;
    hub.store.put("native-action", {
      ...entity(),
      id: sent.id,
      projectId: project.id,
      threadId: nativeRun.threadId,
      kind: "owner-send",
      state: "unknown",
      payloadHash: sent.payloadHash,
    });
    hub.owner.owner = async () => null; // Do not contact the user's desktop owner.
    const recovered = await hub.request({
      op: "session.read",
      projectId: project.id,
      threadId: nativeRun.threadId,
    });
    assert.equal(recovered.actions[0]?.state, "accepted");
    assert.equal(recovered.actions[0]?.turnId, nativeRun.turnId);
    assert.deepEqual(seen, [0, 1, 2]);
    result.nativeHistoryReconciled = true;
    const managed = hub.store.get<Run>("run", done[0].runId!)!;
    const task = hub.getTask(managed.taskId);
    hub.store.tx(() => {
      const command = hub.store.get<Command>("command", managed.commandId)!;
      hub.store.put("command", {
        ...command,
        state: "unknown",
        receipt: undefined,
      });
      hub.store.put("task", { ...task, state: "blocked" });
      hub.store.put("run", {
        ...managed,
        state: "unknown",
        turnId: undefined,
        inputsAcceptedAt: undefined,
      });
    });
    await hub.control(task.id, "reconcile", task.revision);
    const reconciled = hub.store.get<Run>("run", managed.id)!;
    assert.equal(reconciled.turnId, managed.turnId);
    assert.equal(reconciled.state, "ended");
    assert.ok(reconciled.inputsAcceptedAt);
    assert.deepEqual(seen, [0, 1, 2]);
    result.managedHistoryReconciled = true;
    result.passed = true;
  } finally {
    await hub.shutdown();
    hub.store.close();
    server.closeAllConnections();
    server.close();
    for (const name of ["codex-native.dpapi", vault.filename]) {
      await rm(join(state, name), { force: true });
    }
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
}
void main().catch((e) => {
  console.error((e as Error).message.slice(0, 250));
  process.exitCode = 1;
});
