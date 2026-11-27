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
  const root = resolve("../.dev/advance-loop/standard-first-20261123");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "ui-"));
  const data = join(dir, "state"), project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "brief.txt"), "规则：场景按质量标准交付");
  const card = "# 质量标准\n夹具达标线：场景文件写明已交付";
  const calls = { standard: 0, cardReview: 0, main: 0, mainReview: 0, final: 0 };
  const errors: string[] = [];
  let counter = 0;
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
      const prompt = messages.filter((m) => m.role === "user")
        .map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      const tools = (input.tools ?? []).map((tool: any) => String(tool.function?.name));
      assert.ok(tools.includes("pwsh") && tools.includes("read"), "成果 Agent 缺少 DSH 原生工具");
      const execution = tools.some((name: string) => /submit_delivery$/i.test(name));
      const role = execution ? (prompt.includes("制定质量标准卡，只交付") ? "standard" : "main")
        : prompt.includes("这是本任务组合后的交付") ? "final"
          : prompt.includes("核对这份质量标准卡") ? "cardReview" : "mainReview";
      calls[role]++;
      const toolMessages = messages.filter((m) => m.role === "tool");
      const count = toolMessages.length;
      const file = role === "standard" || role === "cardReview" ? "quality-standard.md" : "scene.txt";
      if (role === "standard") assert.match(prompt, /只发送通用的类型和技法关键词/);
      else if (role !== "cardReview") assert.match(prompt, /夹具达标线/, role + " 没有收到标准卡");
      if (role === "main") assert.match(prompt, /逐维度写出自评档位/);
      if (role === "mainReview") assert.match(prompt, /逐个维度给出档位和证据/);
      if (role === "final") assert.match(prompt, /建议人工验收/);
      let action: [string, object] | undefined;
      let content = "";
      if (execution && count === 0)
        action = ["write_file", { path: file, text: role === "standard" ? card : "场景夹具已交付" }];
      else if (execution && count === 1)
        action = ["submit_delivery", { value: JSON.stringify({ paths: [file] }) }];
      else if (execution) {
        assert.match(JSON.stringify(toolMessages.at(-1)), /交付已登记/);
        content = "已提交实际文件。";
      } else {
        assert.ok(!tools.some((name: string) => /(?:write_file|edit_file|suggest_branches)$/i.test(name)),
          "复核回合出现写入工具");
        if (count === 0) action = ["read_file", { path: file }];
        else {
          assert.match(JSON.stringify(toolMessages), role === "cardReview" ? /夹具达标线/ : /场景夹具已交付/);
          content = "读取并核对了实际交付文件，各维度达标。\n建议收口";
        }
      }
      let delta: object = { role: "assistant", content };
      if (action) {
        const name = tools.find((name: string) => name.endsWith(action![0]));
        assert.ok(name, "缺少受控工作区工具：" + action[0]);
        delta = { role: "assistant", tool_calls: [{
          index: 0, id: "standard-tool-" + ++counter, type: "function",
          function: { name, arguments: JSON.stringify(action[1]) },
        }] };
      }
      const chunk = (delta: object, reason: string | null) => "data: " + JSON.stringify({
        id: "standard-fixture-" + counter, model: input.model, object: "chat.completion.chunk", created: 0,
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
      concurrency: 2, loopBudget: { ...defaults.loopBudget, executorRuns: 6 } };
    const state = new Store(data);
    try {
      state.put("settings", { id: "global", value: cfg });
      state.put("project", { ...entity(), name: "质量标准夹具", path: await realpath(project) });
    } finally { state.close(); }
    await new Vault(data).save(cfg.endpoint, "ALCOR_STANDARD_TEST_PLACEHOLDER");
    app = await electron.launch({ executablePath: resolve(executable), args: [], env: {
      ...childEnv(), CODEX_HOME: join(dir, "isolated-native"),
      ALCOR_DATA_DIR: data, ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    }, timeout: 30_000 });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: /新建工作/ }).first().click();
    await page.getByLabel("工作目标").fill("制作场景夹具，并按质量标准核对");
    await page.getByLabel("推进模式").selectOption("loop-native");
    await page.getByRole("checkbox", { name: "按成果并行（预览）" }).check();
    await page.getByLabel("授权读取的项目文本（可选，每行一个相对路径）").fill("brief.txt");
    await page.getByRole("checkbox", { name: "开工前制定质量标准" }).check();
    await page.getByRole("button", { name: "创建并推进" }).click();
    await page.getByRole("button", { name: "工作详情与操作" }).click({ timeout: 25_000 });
    const panel = page.getByRole("region", { name: "成果调度" });
    await panel.getByText("最终复核已通过", { exact: true }).waitFor({ timeout: 90_000 });
    assert.equal(await panel.getByText(/已独立验收/).count(), 2);
    assert.equal(await panel.getByText(/质量标准 · 已独立验收/).count(), 1);
    await panel.getByText("查看标准卡", { exact: true }).click();
    await panel.getByText(/夹具达标线：场景文件写明已交付/).waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(dir, "standard-card.png") });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const snap: Snapshot = await page.evaluate(() => window.alcor.request({ op: "snapshot" }));
    const task = snap.tasks.find((task) => task.graph)!;
    assert.equal(task.state, "done");
    const view: GraphView = await page.evaluate((id) => window.alcor.request({ op: "graph.view", id }), task.id);
    assert.equal(view.spent, 5);
    assert.equal(view.nodes.find((node) => node.key === "standard")?.standard?.card, card);
    assert.deepEqual(view.nodes.find((node) => node.key === "main")?.dependencies, ["standard"]);
    await page.getByRole("button", { name: "结果", exact: true }).click();
    await page.getByRole("button", { name: "核对基线并整合产物" }).click();
    await page.getByText("此版本已整合", { exact: true }).waitFor();
    assert.equal(await readFile(join(project, "scene.txt"), "utf8"), "场景夹具已交付");
    await assert.rejects(readFile(join(project, "quality-standard.md")), { code: "ENOENT" });
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, { standard: 3, cardReview: 2, main: 3, mainReview: 2, final: 2 });
    Object.assign(result, { passed: true, schemaVersion: LEDGER_VERSION, nativeRuns: 5,
      standardBeforeMain: true, cardShownInDetails: true, cardNotIntegrated: true });
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
