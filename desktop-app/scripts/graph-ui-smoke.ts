import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";
import { childEnv, Vault } from "../src/hub/security";
import { entity, LEDGER_VERSION, Store } from "../src/hub/store";
import { defaults, type Snapshot } from "../src/shared/contracts";
import type { GraphView } from "../src/shared/native-graph";

async function main() {
  const executable = process.argv[2];
  if (!executable) throw new Error("请提供已封包的 Alcor.exe");
  const root = resolve("../.dev/advance-loop/P1");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "ui-"));
  const data = join(dir, "state"), project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "brief.txt"), "规则：场景与网页分开交付");
  const calls = { main: 0, web: 0, branchReviews: 0, final: 0 };
  const errors: string[] = [];
  let webStarted!: () => void, overlapped = false, counter = 0;
  const webStartedPromise = new Promise<void>((resolve) => { webStarted = resolve; });
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
      const prompt = JSON.stringify(messages.filter((m) => m.role === "user"));
      const tools = (input.tools ?? []).map((tool: any) => String(tool.function?.name));
      assert.ok(tools.includes("pwsh") && tools.includes("read"), "成果 Agent 缺少 DSH 原生工具");
      assert.notEqual(input.max_tokens, defaults.maxOutputTokens, "总管上限不应覆盖 DSH 的输出");
      const execution = tools.some((name: string) => /submit_delivery$/i.test(name));
      const final = prompt.includes("这是本任务组合后的交付");
      const web = prompt.includes("制作网页夹具");
      const role = execution ? (web ? "web" : "main") : final ? "final" : "branchReviews";
      calls[role]++;
      if (role === "web") webStarted();
      const toolMessages = messages.filter((m) => m.role === "tool");
      const count = toolMessages.length;
      const file = web ? "web/index.html" : "scene.txt";
      const contents = web ? "<main>网页夹具已交付</main>" : "场景夹具已交付";
      let action: [string, object] | undefined;
      let content = "";
      if (execution && !web && count === 0) {
        action = ["suggest_branches", { value: JSON.stringify({ nodes: [{
          key: "web", title: "网页成果", goal: "制作网页夹具",
          acceptance: "文件包含网页夹具标记", outputs: ["web/index.html"],
          dependencies: [], resources: [], required: true,
        }] }) }];
      } else if (execution && count === (web ? 0 : 1)) {
        if (!web) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("网页分支未在场景回合结束前开始")), 9000);
            void webStartedPromise.then(() => { clearTimeout(timer); resolve(); });
          });
          overlapped = true;
        }
        action = ["write_file", { path: file, text: contents }];
      } else if (execution && count === (web ? 1 : 2)) {
        action = ["submit_delivery", { value: JSON.stringify({ paths: [file] }) }];
      } else if (execution) {
        assert.match(JSON.stringify(toolMessages.at(-1)), /交付已登记/);
        content = "已提交实际文件。";
      } else {
        assert.ok(!tools.some((name: string) => /(?:write_file|edit_file|suggest_branches)$/i.test(name)),
          "复核回合出现写入工具");
        const files = final ? ["scene.txt", "web/index.html"] : [file];
        if (count < files.length) action = ["read_file", { path: files[count] }];
        else {
          for (const path of files)
            assert.match(JSON.stringify(toolMessages), path === "scene.txt" ? /场景夹具已交付/ : /网页夹具已交付/);
          content = "读取并核对了对应的实际交付文件。\n建议收口";
        }
      }
      let delta: object = { role: "assistant", content };
      if (action) {
        const name = tools.find((name: string) => name.endsWith(action![0]));
        assert.ok(name, "缺少受控工作区工具：" + action[0]);
        delta = { role: "assistant", tool_calls: [{
          index: 0, id: "graph-tool-" + ++counter, type: "function",
          function: { name, arguments: JSON.stringify(action[1]) },
        }] };
      }
      const chunk = (delta: object, reason: string | null) => "data: " + JSON.stringify({
        id: "graph-fixture-" + (calls.main + calls.web + calls.branchReviews + calls.final),
        model: input.model, object: "chat.completion.chunk", created: 0,
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    })().catch((error: Error) => {
      errors.push(error.message.split("\n")[0]);
      if (!response.headersSent) response.writeHead(422).end();
      else response.destroy();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const result: Record<string, unknown> = { dir, passed: false, localModelFixture: true };
  let app: ElectronApplication | undefined;
  try {
    const port = (server.address() as { port: number }).port;
    const cfg = { ...defaults, endpoint: `http://127.0.0.1:${port}/v1`, codexPath: join(dir, "offline"),
      concurrency: 2, loopBudget: { ...defaults.loopBudget, executorRuns: 5 } };
    const state = new Store(data);
    try {
      state.put("settings", { id: "global", value: cfg });
      state.put("project", { ...entity(), name: "成果调度夹具", path: await realpath(project) });
    } finally { state.close(); }
    await new Vault(data).save(cfg.endpoint, "ALCOR_GRAPH_TEST_PLACEHOLDER");
    app = await electron.launch({ executablePath: resolve(executable), args: [], env: {
      ...childEnv(), CODEX_HOME: join(dir, "isolated-native"),
      ALCOR_DATA_DIR: data, ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    }, timeout: 30_000 });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: /新建工作/ }).first().click();
    await page.getByLabel("工作目标").fill("制作场景夹具和独立网页夹具，并验证组合");
    await page.getByLabel("推进模式").selectOption("loop-native");
    await page.getByRole("checkbox", { name: "按成果并行（预览）" }).check();
    await page.getByLabel("授权读取的项目文本（可选，每行一个相对路径）").fill("brief.txt");
    await page.getByRole("button", { name: "创建并推进" }).click();
    await page.getByRole("button", { name: "工作详情与操作" }).click({ timeout: 25_000 });
    const panel = page.getByRole("region", { name: "成果调度" });
    await panel.getByText("最终复核已通过", { exact: true }).waitFor({ timeout: 75_000 });
    assert.equal(await panel.getByText(/已独立验收/).count(), 2);
    assert.ok(overlapped);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const snap: Snapshot = await page.evaluate(() => window.alcor.request({ op: "snapshot" }));
    const task = snap.tasks.find((task) => task.graph)!;
    assert.equal(task.state, "done");
    const view: GraphView = await page.evaluate((id) => window.alcor.request({ op: "graph.view", id }), task.id);
    assert.equal(view.spent, 5);
    assert.equal(snap.runs.filter((r) => r.graphAttempt && !!r.turnId).length, 5);
    assert.ok(snap.runs.filter((r) => r.graphAttempt).every((r) => r.actualSandbox !== "danger-full-access"));
    await assert.rejects(readFile(join(project, "scene.txt")), { code: "ENOENT" });
    await page.getByRole("button", { name: "结果", exact: true }).click();
    await page.getByRole("button", { name: "核对基线并整合产物" }).click();
    await page.getByText("此版本已整合", { exact: true }).waitFor();
    assert.equal(await readFile(join(project, "scene.txt"), "utf8"), "场景夹具已交付");
    assert.match(await readFile(join(project, "web/index.html"), "utf8"), /网页夹具已交付/);
    assert.deepEqual(errors, []);
    Object.assign(result, { passed: true, schemaVersion: LEDGER_VERSION, overlapped, nativeRuns: 5,
      scopedTools: true, bothBranchesReviewed: true, manualIntegration: true });
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    server.close();
    await rm(join(data, "api-key.dpapi"), { force: true });
    await writeFile(join(dir, "result.json"), JSON.stringify({ ...result, calls, errors }, null, 2));
    console.log(JSON.stringify({ ...result, calls, errors }));
  }
}
void main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
