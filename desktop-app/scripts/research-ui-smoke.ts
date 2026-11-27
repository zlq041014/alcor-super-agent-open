import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";
import { childEnv, Vault } from "../src/hub/security";
import { entity, Store, LEDGER_VERSION } from "../src/hub/store";
import { defaults, type Snapshot } from "../src/shared/contracts";
import type { GraphView } from "../src/shared/native-graph";

const source = "https://www.w3.org/TR/WCAG22/";
async function main() {
  const exe = process.argv[2];
  if (!exe) throw new Error("请提供已封包的 Alcor.exe");
  const area = resolve("../.dev/advance-loop/P2");
  await mkdir(area, { recursive: true });
  const dir = await mkdtemp(join(area, "ui-"));
  const data = join(dir, "state"), project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "trial.txt"), "WCAG 2.2\nkeyboard=passed-native\n");
  const result: Record<string, unknown> = { dir, passed: false, localModelFixture: true };
  const errors: string[] = [];
  let reportFailure!: (reason: string) => void;
  const fixtureFailure = new Promise<string>((resolve) => { reportFailure = resolve; });
  let calls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end(); return;
      }
      let body = "";
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      const messages = input.messages as { role: string; content?: unknown }[];
      const prompt = messages.filter((m) => m.role === "user").flatMap(({ content }) =>
        typeof content === "string" ? [content] :
          Array.isArray(content) ? content.flatMap((part) => typeof part?.text === "string" ? [part.text] : []) : [],
      ).join("\n");
      const tools = (input.tools ?? []).map((item: any) => String(item.function.name)) as string[];
      const step = messages.filter((m) => m.role === "tool").length;
      assert.ok(tools.includes("pwsh") && tools.includes("web_fetch"));
      let tool: [string, object] | undefined;
      let done = "实际核对交付文件。\n建议收口";
      assert.ok(tools.includes("todo_write"), "保留 DSH 原生任务清单");
      if (tools.some((name) => name.endsWith("submit_research"))) {
        assert.ok(!tools.some((name) => name.endsWith("submit_delivery")), "研究不代为验收执行产物");
        const start = prompt.indexOf('{"决定":');
        assert.ok(start >= 0, "研究回合缺少取证材料");
        const end = prompt.indexOf("\n", start);
        const packet = JSON.parse(prompt.slice(start, end < 0 ? undefined : end));
        const official = packet["公开资料"].find((item: any) => item.source.url === source);
        assert.equal(official?.source.outcome, "matched");
        assert.equal(packet["小样核对"].route, "route-a");
        if (!step) {
          const excerpt: string = official.excerpt;
          const at = Math.max(0, excerpt.search(/keyboard/i) - 20);
          const quote = excerpt.slice(at, at + 100).trim();
          tool = ["submit_research", { value: JSON.stringify({
            route: "route-a", recommendation: "采用键盘可用的标准控件",
            conditions: "只用于 WCAG 2.2 键盘操作决定", fact: "W3C 发布了目标版本标准",
            unresolved: "未运行完整无障碍验收", citations: [{ id: official.source.id, quote }],
          }) }];
        } else done = "提交了单个技术决定的证据。";
      } else if (tools.some((name) => name.endsWith("write_file"))) {
        assert.match(prompt, /采用键盘可用的标准控件/);
        if (step === 0) tool = ["record_research_use", { value: JSON.stringify({
          key: "research-main", disposition: "adopted", reason: "本地小样支持键盘可用的标准控件",
        }) }];
        if (step === 1) tool = ["write_file", { path: "output.txt", text: "使用键盘可用的标准控件。" }];
        if (step === 2) tool = ["submit_delivery", { value: JSON.stringify({ paths: ["output.txt"] }) }];
        done = "已交付实际文件。";
      } else if (!step) tool = ["read_file", { path: "output.txt" }];
      else assert.match(JSON.stringify(messages.filter((row) => row.role === "tool")), /标准控件/);
      calls++;
      const name = tool && tools.find((item) => item.endsWith(tool![0]));
      if (tool) assert.ok(name, "所需工具不可用：" + tool[0]);
      const delta = tool ? { role: "assistant", tool_calls: [{
        index: 0, id: "fixture-tool-" + calls, type: "function",
        function: { name, arguments: JSON.stringify(tool[1]) },
      }] } : { role: "assistant", content: done };
      const chunk = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({
        id: "research-fixture-" + calls, model: input.model, object: "chat.completion.chunk", created: 0,
        choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    })().catch((error: Error) => {
      errors.push(error.message.split("\n")[0]);
      reportFailure(errors.at(-1)!);
      if (!res.headersSent) res.writeHead(422).end(); else res.destroy();
    });
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  let app: ElectronApplication | undefined;
  try {
    const port = (server.address() as { port: number }).port;
    const cfg = { ...defaults, codexPath: join(dir, "offline"), endpoint: `http://127.0.0.1:${port}/v1`,
      loopBudget: { ...defaults.loopBudget, executorRuns: 4 } };
    const state = new Store(data);
    try {
      state.put("settings", { id: "global", value: cfg });
      state.put("project", { ...entity(), name: "按需研究验收", path: await realpath(project) });
    } finally { state.close(); }
    await new Vault(data).save(cfg.endpoint, "ALCOR_RESEARCH_TEST_PLACEHOLDER");
    app = await electron.launch({ executablePath: resolve(exe), args: [], env: {
      ...childEnv(), CODEX_HOME: join(dir, "isolated-native"),
      ALCOR_DATA_DIR: data, ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    }, timeout: 30_000 });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message.split("\n")[0]));
    await page.getByRole("button", { name: /新建工作/ }).first().click();
    await page.getByLabel("工作目标").fill("交付键盘可用的控件方案");
    await page.getByLabel("推进模式").selectOption("loop-native");
    await page.getByRole("checkbox", { name: "按成果并行（预览）" }).check();
    await page.getByRole("checkbox", { name: "为主成果登记研究决定" }).check();
    await page.getByLabel("目标版本", { exact: true }).fill("2.2");
    await page.getByLabel("要决定的问题").fill("WCAG Keyboard interaction route");
    await page.getByLabel("已冻结的小样文件").fill("trial.txt");
    await page.getByLabel("路线 A 的小样标记").fill("keyboard=passed-native");
    await page.getByLabel("路线 B 的小样标记").fill("keyboard=passed-custom");
    await page.getByLabel("公开资料地址 1", { exact: true }).fill(source);
    await page.getByRole("button", { name: "创建并推进" }).click();
    await page.getByRole("button", { name: "工作详情与操作" }).click({ timeout: 25_000 });
    const panel = page.getByRole("region", { name: "成果调度" });
    await Promise.race([
      panel.getByText("最终复核已通过", { exact: true }).waitFor({ timeout: 65_000 }),
      fixtureFailure.then((reason) => { throw new Error(reason); }),
    ]);
    await panel.getByText(/已声明采纳/).waitFor();
    const snap: Snapshot = await page.evaluate(() => window.alcor.request({ op: "snapshot" }));
    const task = snap.tasks.find((row) => row.graph)!;
    const view: GraphView = await page.evaluate((id) => window.alcor.request({ op: "graph.view", id }), task.id);
    const research = view.nodes.find((node) => node.research)?.research;
    assert.equal(task.state, "done");
    assert.equal(view.spent, 4);
    assert.equal(research?.evidence?.sources[0].url, source);
    assert.ok(research?.evidence?.sources[0].viewedAt);
    assert.equal(research?.evidence?.sample.route, "route-a");
    assert.equal(research?.use?.disposition, "adopted");
    assert.equal(snap.runs.filter((r) => r.graphAttempt?.role === "research" && !!r.turnId).length, 1);
    assert.deepEqual(errors, []);
    Object.assign(result, { passed: true, publicSource: source, publicVersion: "2.2", schemaVersion: LEDGER_VERSION,
      researchRun: 1, totalRuns: 4, localSamplePassed: true, decisionAdopted: true });
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
