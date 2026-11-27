import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { childEnv, hash, Vault } from "../src/hub/security";
import { entity, Store, LEDGER_VERSION } from "../src/hub/store";
import { defaults, type Snapshot } from "../src/shared/contracts";
import type { GraphView } from "../src/shared/native-graph";

async function main() {
  const exe = process.argv[2];
  if (!exe) throw new Error("请提供已封包的 Alcor.exe");
  const area = resolve("../.dev/advance-loop/P3");
  await mkdir(area, { recursive: true });
  const dir = await mkdtemp(join(area, "ui-"));
  const data = join(dir, "state"), project = join(dir, "project");
  await mkdir(project);
  const video = join(project, "demo.mp4");
  await promisify(execFile)("D:/dev/ffmpeg/package/ffmpeg.exe", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc=size=128x96:rate=16:duration=4", "-pix_fmt", "yuv420p", "-c:v", "mpeg4", video,
  ], { windowsHide: true, env: childEnv(), timeout: 12_000 });
  const sourceHash = hash(await readFile(video));
  const result: Record<string, unknown> = { dir, passed: false, localModelFixture: true };
  const errors: string[] = [];
  let reportFailure!: (reason: string) => void;
  const fixtureFailure = new Promise<string>((resolve) => { reportFailure = resolve; });
  let calls = 0, handoffs = 0, reviews = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end(); return;
      }
      let body = "";
      for await (const part of req) body += part;
      const input = JSON.parse(body);
      const messages = input.messages as { role: string; content?: unknown }[];
      const tools = (input.tools ?? []).map((item: any) => String(item.function.name)) as string[];
      assert.ok(tools.includes("pwsh") && tools.includes("read"));
      const responses = messages.filter((m) => m.role === "tool");
      let tool: [string, object] | undefined;
      let done: string;
      if (tools.some((name) => name.endsWith("start_preview"))) {
        if (!responses.length) { tool = ["start_preview", { value: "{}" }]; handoffs++; }
        else assert.match(JSON.stringify(responses), /已登记预览作业/);
        done = "已完成登记并移交，结束执行回合。";
      } else {
        assert.ok(!tools.some((name) => name.endsWith("write_file")));
        if (!responses.length) tool = ["read_file", { path: "preview-frames/index.txt" }];
        else {
          assert.match(JSON.stringify(responses), /6 张连续 PNG/);
          reviews++;
        }
        done = "已核对实际预览清单。\n建议收口";
      }
      calls++;
      const name = tool && tools.find((item) => item.endsWith(tool![0]));
      if (tool) assert.ok(name);
      const delta = tool ? { role: "assistant", tool_calls: [{
        index: 0, id: "fixture-tool-" + calls, type: "function",
        function: { name, arguments: JSON.stringify(tool[1]) },
      }] } : { role: "assistant", content: done };
      const chunk = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({
        id: "preview-fixture-" + calls, model: input.model, object: "chat.completion.chunk", created: 0,
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
      concurrency: 1, loopBudget: { ...defaults.loopBudget, executorRuns: 3 } };
    const state = new Store(data);
    try {
      state.put("settings", { id: "global", value: cfg });
      state.put("project", { ...entity(), name: "视频预览验收", path: await realpath(project) });
    } finally { state.close(); }
    await new Vault(data).save(cfg.endpoint, "ALCOR_PREVIEW_TEST_PLACEHOLDER");
    app = await electron.launch({ executablePath: resolve(exe), args: [], env: {
      ...childEnv(), CODEX_HOME: join(dir, "isolated-native"),
      ALCOR_DATA_DIR: data, ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    }, timeout: 30_000 });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message.split("\n")[0]));
    await page.getByRole("button", { name: /新建工作/ }).first().click();
    await page.getByLabel("工作目标").fill("交付六张可复核的视频预览帧");
    await page.getByLabel("推进模式").selectOption("loop-native");
    await page.getByRole("checkbox", { name: "按成果并行（预览）" }).check();
    await page.getByRole("checkbox", { name: "主成果是独立视频预览" }).check();
    await page.getByLabel("本地 MP4 视频（项目内相对路径）").fill("demo.mp4");
    await page.getByLabel("预览帧数").fill("6");
    await page.getByRole("checkbox", { name: "有可核对进展时延长观察" }).check();
    await page.getByLabel("进展检查间隔（分钟）").fill("1");
    await page.getByLabel("单回合硬截止（分钟）").fill("3");
    await page.getByRole("button", { name: "创建并推进" }).click();
    await page.getByRole("button", { name: "工作详情与操作" }).click({ timeout: 25_000 });
    const panel = page.getByRole("region", { name: "成果调度" });
    await Promise.race([
      panel.getByText("最终复核已通过", { exact: true }).waitFor({ timeout: 65_000 }),
      fixtureFailure.then((reason) => { throw new Error(reason); }),
    ]);
    await panel.getByRole("region", { name: "视频预览作业" }).getByText(/6 \/ 6 帧/).waitFor();
    const snap: Snapshot = await page.evaluate(() => window.alcor.request({ op: "snapshot" }));
    const task = snap.tasks.find((row) => row.graph)!;
    const view: GraphView = await page.evaluate((id) => window.alcor.request({ op: "graph.view", id }), task.id);
    const job = view.nodes.find((node) => node.preview)?.preview;
    assert.equal(task.state, "done");
    assert.equal(view.spent, 3);
    assert.equal(job?.state, "completed");
    assert.equal(job?.frames, 6);
    assert.equal(handoffs, 1);
    assert.equal(reviews, 2);
    assert.equal(snap.artifacts.filter((a) => a.taskId === task.id && a.kind === "image").length, 6);
    assert.equal(hash(await readFile(video)), sourceHash);
    await assert.rejects(readFile(join(project, "preview-frames/index.txt")), { code: "ENOENT" });
    assert.deepEqual(errors, []);
    Object.assign(result, { passed: true, realFfmpeg: true, schemaVersion: LEDGER_VERSION,
      agentRuns: view.spent, frames: 6, fullReview: true, sourceUntouched: true });
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
