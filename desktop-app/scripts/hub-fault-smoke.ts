import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { defaults } from "../src/shared/contracts";
import { childEnv } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";

async function main() {
  const base = resolve("../.dev/desktop-ui");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "hub-fault-")),
    data = join(dir, "state"),
    path = join(dir, "project"),
    project = { ...entity(), name: "账本故障验收", path };
  await mkdir(path);
  const store = new Store(data);
  try {
    store.put("project", project);
    store.put("settings", {
      id: "global",
      value: {
        ...defaults,
        executorBackend: "codex",
        defaultAdvance: "single",
        codexPath: join(dir, "offline.exe"),
      },
    });
    store.db.exec(`CREATE TRIGGER abort_run_index BEFORE INSERT ON records
      WHEN NEW.kind='run' BEGIN SELECT RAISE(ABORT,'fixture cannot save run'); END;`);
  } finally {
    store.close();
  }
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    timeout: 30000,
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: data,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByText("本地 Hub 在线").waitFor();
    const task = await page.evaluate(async (projectId) => {
      const proposed = await window.alcor.request({
        op: "task.create",
        requestId: "hub-fault-fixture",
        value: { projectId, mode: "read", goal: "试验无法保存新回合" },
      });
      return window.alcor.request({
        op: "agent.launch.confirm",
        id: proposed.launchId,
        profile: { model: "fixture", effort: "high" },
      });
    }, project.id);
    const banner = page.locator(".hub-alert");
    await banner.waitFor();
    assert.match(await banner.innerText(), /任务调度持久化失败/);
    await page.getByTitle("切换明暗主题").click();
    await page.locator('html[data-theme="dark"]').waitFor();
    assert.equal(await banner.isVisible(), true);
    assert.equal(await page.getByText("本地 Hub 在线").count(), 0);
    const saved = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(saved.runs.length, 0);
    assert.equal(
      saved.tasks.find((t: any) => t.id === task.id)?.state,
      "ready",
    );

    const mainPid = await app.evaluate(() => process.pid);
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${mainPid}' | Where-Object { $_.CommandLine -like '*hub-entry.cjs*' -and $_.CommandLine.Contains('${data.replaceAll("'", "''")}') } | Select-Object -ExpandProperty ProcessId`,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const pid = Number(stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "未找到隔离试验的 Hub 子进程");
    const lock = new DatabaseSync(join(data, "state.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      let resolved = false;
      const request = page
        .evaluate(async () => {
          try {
            await window.alcor.request({
              op: "draft",
              text: "未落盘的故障试验草稿",
            });
            return "unexpected-success";
          } catch (error) {
            return (error as Error).message;
          }
        })
        .then((answer) => {
          resolved = true;
          return answer;
        });
      await delay(250);
      assert.equal(resolved, false, "要验证的请求必须仍在等待 Hub");
      process.kill(pid, "SIGKILL");
      const failure = await Promise.race([request, delay(3000, "late")]);
      assert.match(failure, /任务调度持久化失败|Hub.*(退出|中断)/);
    } finally {
      lock.close();
    }
  } finally {
    await app.close();
  }
  const result = {
    dir,
    packaged: !!executablePath,
    passed: true,
    faultRemainedVisibleAfterRefresh: true,
    previouslyAcceptedTaskRetained: true,
    noRunDispatched: true,
    forcedHubExitReleasedPendingRequest: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
