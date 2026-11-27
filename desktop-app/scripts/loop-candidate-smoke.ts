import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Hub } from "../src/hub/service";
import { childEnv } from "../src/hub/security";
import { defaults } from "../src/shared/contracts";

async function main() {
  const dir = await mkdtemp(resolve("../.dev/advance-loop/L3/candidate-native-"));
  const project = join(dir, "workspace"), data = join(dir, "data");
  await mkdir(join(project, "node_modules", "fixture-dependency"), { recursive: true });
  const git = (...args: string[]) => promisify(execFile)("D:/dev/git/cmd/git.exe", args, { cwd: project, windowsHide: true, env: childEnv() });
  await writeFile(join(project, ".gitignore"), "node_modules/\n");
  await writeFile(join(project, "node_modules", "fixture-dependency", "package.json"), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(project, "node_modules", "fixture-dependency", "index.js"), "export const required = 'accepted-marker';\n");
  await writeFile(join(project, "accept.test.mjs"), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { required } from 'fixture-dependency';",
    "test('contains marker', () => assert.ok(readFileSync('answer.txt','utf8').includes(required)));",
  ].join("\n"));
  await git("init", "--quiet");
  await git("add", "--", ".gitignore", "accept.test.mjs");
  await git("-c", "user.name=Isolated Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture baseline");
  const calls = { ordinary: 0, candidate: 0, tool: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const part of request) body += part;
      const input = JSON.parse(body);
      const messages = input.messages as { role: string; content?: unknown }[];
      const user = JSON.stringify(messages);
      const candidate = user.includes("不整合到原项目");
      let call: object | undefined;
      if (candidate && !messages.some((m) => m.role === "tool")) {
        const tool = input.tools?.find((tool: any) => /write_file$/i.test(tool.function?.name));
        if (!tool) { response.writeHead(422).end(); return; }
        call = { index: 0, id: `test-tool-${++calls.tool}`, type: "function", function: {
          name: tool.function.name, arguments: JSON.stringify({
            path: "answer.txt", text: "accepted-marker\n" + (user.includes("较长写法") ? "另附一行说明\n" : ""),
          }),
        } };
      }
      calls[candidate ? "candidate" : "ordinary"]++;
      const chunk = (delta: object, reason: string | null) => "data: " + JSON.stringify({
        id: `fixture-${calls.ordinary + calls.candidate}`, model: input.model, object: "chat.completion.chunk", created: 0,
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk(call ? { role: "assistant", tool_calls: [call] } : {
        role: "assistant", content: candidate ? "已按本候选写入文件。" : "本回合没有交付文件。",
      }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const hub = new Hub(data);
  const result: Record<string, unknown> = { dir, passed: false, localModelFixture: true };
  try {
    const port = (server.address() as { port: number }).port;
    const cfg = { ...defaults, endpoint: `http://127.0.0.1:${port}/v1`, concurrency: 2,
      checkPath: [dirname(process.execPath)], loopBudget: {
        ...defaults.loopBudget, retries: 0, executorRuns: 4, candidates: 2, wallMinutes: 10,
      } };
    await hub.brain.vaultFor(cfg).save(cfg.endpoint, "ALCOR_TEST_PLACEHOLDER_KEY");
    await hub.request({ op: "settings", value: cfg });
    hub.brain.complete = async () => ({ model: "fixture", usage: null, text: JSON.stringify({
      causes: ["实际检查没有找到交付文件"],
      approaches: [
        { title: "较短写法", plan: "只写检查要求的标记。" },
        { title: "较长写法", plan: "写入标记之后保留一行说明。" },
      ],
    }) });
    hub.verification.review = async () => ({ action: "program", detail: "使用原生 Node 检查" });
    const p = await hub.request({ op: "project.add", name: "候选原生隔离验证", path: project });
    const task = await hub.request({ op: "task.create", requestId: "candidate-native", value: {
      projectId: p.id, goal: "用现有测试验证 answer.txt 包含约定的标记。", advance: "loop", mode: "write",
      loopChecks: [{ kind: "command", name: "accept", program: "node", args: ["--test", "accept.test.mjs"], cwd: "." }],
      criteria: [{ title: "生成通过测试的文件", method: "command", checks: ["accept"] }],
    } });
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      await hub.tick();
      const { loop } = hub.loop.view(hub.getTask(task.id));
      if (["closed", "halted"].includes(loop.phase)) break;
      await delay(100);
    }
    const view = hub.loop.view(hub.getTask(task.id));
    result.outcome = view.loop.report?.outcome;
    result.candidates = view.candidates.map((c) => ({ status: c.status, checks: c.checkRunIds.length, changedLines: c.changedLines, reason: c.reason }));
    result.calls = calls;
    assert.equal(view.loop.report?.outcome, "completed");
    assert.equal(view.candidates.length, 2);
    assert.equal(new Set(view.candidates.map((c) => c.threadId)).size, 2);
    assert.equal(view.candidates.find((c) => c.status === "selected")?.approach, "较短写法");
    assert.ok(view.candidates.some((c) => c.status === "discarded" && c.diff?.includes("另附一行说明")));
    assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "accepted-marker\n");
    assert.equal((await git("diff", "--cached", "--name-only")).stdout, "");
    assert.equal(hub.store.all("approval").length + hub.launches.pending().length, 0);
    result.passed = true;
  } finally {
    await hub.shutdown();
    hub.store.close();
    server.closeAllConnections();
    server.close();
    await rm(join(data, hub.brain.vaultFor(defaults).filename), { force: true });
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
void main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
