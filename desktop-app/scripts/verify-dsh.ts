// Opt-in: one real, synthetic workspace task through the existing custom gateway.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub } from "../src/hub/service";
import {
  APP_VERSION,
  defaults,
  defaultProfile,
  type Run,
} from "../src/shared/contracts";
import { Brain } from "../src/hub/brain";
import { Vault, childEnv } from "../src/hub/security";
import { _electron, type ElectronApplication } from "playwright";

async function main() {
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw Error("缺少本机自定义网关环境凭据");
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "dsh-live-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const marker = "alcor-" + randomBytes(8).toString("hex");
  await writeFile(join(cwd, "sample.txt"), marker);
  const state = join(dir, "state"),
    packaged = process.argv.includes("--package");
  const packagePath = packaged ? process.argv[process.argv.indexOf("--package") + 1] : undefined;
  const hub = packaged ? undefined : new Hub(state);
  let app: ElectronApplication | undefined;
  const vault = new Brain(new Vault(state)).vaultFor(defaults);
  let request: (r: any) => Promise<any>;
  try {
    if (packaged) {
      await vault.save(defaults.endpoint, key);
      app = await _electron.launch({
        executablePath: packagePath ? resolve(packagePath) :
          resolve("release", `alcor-${APP_VERSION}-windows-x64`, "Alcor.exe"),
        args: [],
        env: {
          ...childEnv(),
          ALCOR_DATA_DIR: state,
          ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
        },
      });
      const page = await app.firstWindow();
      await page.getByRole("button", { name: /设置.*v0/ }).waitFor();
      request = (r) => page.evaluate((value) => window.alcor.request(value), r);
    } else {
      hub!.brain.key = async () => key;
      request = hub!.request.bind(hub);
    }
    const cfg = (await request({ op: "snapshot" })).settings;
    assert.equal(cfg.apiSource, "custom");
    assert.equal(cfg.executorBackend, "dsh");
    const p = await request({
      op: "project.add",
      path: cwd,
      name: "DSH 兼容样例",
    });
    const launch = await request({
      op: "task.create",
      requestId: "sample",
      value: {
        projectId: p.id,
        mode: "write",
        goal: "使用 workspace 项目文件工具读取 sample.txt，将其完整内容原样写入新文件 result.txt，然后用一句话说明结果。",
        checks: [{ path: "result.txt", contains: marker }],
      },
    });
    const task = await request({
      op: "agent.launch.confirm",
      id: launch.launchId,
      profile: defaultProfile(cfg),
    });
    const deadline = Date.now() + 120000;
    let r: Run | undefined;
    do {
      const runs: Run[] = (await request({ op: "snapshot" })).runs;
      r = runs.findLast((x) => x.taskId === task.id);
      if (r && ["ended", "unknown"].includes(r.state)) break;
      await new Promise((done) => setTimeout(done, 150));
    } while (Date.now() < deadline);
    const result = {
        dir,
        backend: r?.backend,
        model: r?.model,
        effort: r?.actualEffort,
        run: r?.state,
        outcome: r?.outcome,
        packaged,
        task: (await request({ op: "snapshot" })).tasks.find(
          (t: any) => t.id === task.id,
        )?.state,
    };
    assert.equal(r?.outcome, "completed");
    assert.equal(
      (await readFile(join(cwd, "result.txt"), "utf8")).trim(),
      marker,
    );
    assert.equal(result.task, "done");
    await writeFile(join(dir, "result.json"), JSON.stringify({ ...result, passed: true }, null, 2));
    console.log(JSON.stringify({ ...result, passed: true }));
    console.log("真实 DSH 工具读取和项目内写入已核对");
  } finally {
    if (hub) {
      await hub.shutdown();
      hub.store.close();
    }
    if (app) await app.close();
    if (packaged) await unlink(join(state, vault.filename)).catch(() => {});
  }
}
main().catch(() => {
  console.error("DSH 样例未通过；不输出任务或服务响应。");
  process.exitCode = 1;
});
