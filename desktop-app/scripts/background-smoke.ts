import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { CHIEF, defaults, type Task } from "../src/shared/contracts";
import { childEnv } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";

async function main() {
  const exe = process.argv[2];
  const verifyWake = process.argv.includes("--wake");
  if (!exe) throw new Error("请提供待验证的便携包 EXE");
  const base = resolve("../.dev/desktop-ui");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "background-")),
    data = join(dir, "state"),
    draft = "后台关闭后仍在的验证草稿";
  const project = { ...entity(), path: join(dir, "project"), name: "隔离预约" };
  const task: Task = {
    ...entity(), projectId: project.id, title: "隔离预约继续", goal: "验证已授权任务的预约",
    revision: 1, stateVersion: 1, backend: "codex", mode: "read",
    constraints: "", acceptance: "", model: "", state: "paused", control: "confirmed",
    archived: false, unread: false, attempt: 0, dependencies: [], attachments: [],
  };
  const store = new Store(data);
  try {
    store.put("settings", {
      id: "global",
      value: {
        ...defaults,
        background: true,
        codexPath: join(dir, "offline.exe"),
      },
    });
    if (verifyWake) {
      await mkdir(project.path);
      store.put("project", project);
      store.put("task", task);
      store.put("agent", { ...entity(), id: "exec:" + task.id, kind: "executor",
        title: task.title, projectId: project.id, parentAgentId: CHIEF, taskId: task.id });
    }
  } finally {
    store.close();
  }
  const env = {
    ...childEnv(),
    CODEX_HOME: join(dir, "native"),
    ALCOR_DATA_DIR: data,
    ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
  };
  const launch = () =>
    electron.launch({
      executablePath: resolve(exe),
      args: [],
      env,
      timeout: 30000,
    });
  const visible = (app: Awaited<ReturnType<typeof launch>>) =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
  const waitVisible = async (
    app: Awaited<ReturnType<typeof launch>>,
    desired: boolean,
  ) => {
    const limit = Date.now() + 6000;
    do {
      if ((await visible(app)) === desired) return;
      await delay(50);
    } while (Date.now() < limit);
    throw new Error("窗口可见状态没有切换");
  };
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.getByLabel("发送给星引").waitFor();
    const generation = await page.evaluate(async (text) => {
      await window.alcor.request({ op: "draft", text });
      return (await window.alcor.request({ op: "snapshot" })).hub.generation;
    }, draft);
    if (verifyWake) {
      await page.evaluate(async (id) => {
        const { tasks } = await window.alcor.request({ op: "snapshot" });
        const current = tasks.find((item) => item.id === id)!;
        await window.alcor.request({
          op: "task.wake.schedule", id, revision: current.revision, stateVersion: current.stateVersion,
          at: new Date(Date.now() + 6000).toISOString(),
        });
      }, task.id);
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await waitVisible(app, false);
    if (verifyWake) {
      const ledger = new DatabaseSync(join(data, "state.sqlite"), { readOnly: true });
      try {
        const lookup = ledger.prepare("SELECT 1 FROM events WHERE kind='task.wake.released' AND object_id=?");
        assert.equal(lookup.get(task.id), undefined);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !lookup.get(task.id)) await delay(150);
        assert.ok(lookup.get(task.id), "窗口隐藏期间 Hub 应领取预约");
        assert.equal(await visible(app), false);
      } finally {
        ledger.close();
      }
    }
    const reopen = spawn(resolve(exe), [], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    const exit = await Promise.race([once(reopen, "exit"), delay(6000)]);
    if (!exit) {
      reopen.kill();
      throw new Error("第二实例未把请求交给后台主窗口");
    }
    assert.equal(exit[0], 0);
    await waitVisible(app, true);
    const kept = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(kept.hub.generation, generation);
    assert.equal(kept.draft, draft);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(
      () => !!document.querySelector("textarea")?.value,
    );
    assert.equal(await reopened.getByLabel("发送给星引").inputValue(), draft);
    const clean = await reopened.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(clean.hub.generation, generation + 1);
    if (verifyWake) {
      assert.equal(clean.taskWakes.find((item) => item.taskId === task.id)?.state, "released");
      assert.equal(clean.runs.filter((item) => item.taskId === task.id).length, 1);
    }
  } finally {
    await app.close();
  }
  const result = {
    dir,
    packaged: true,
    passed: true,
    sameHubWhenReopened: true,
    draftSurvivedCompleteExit: true,
    ...(verifyWake ? { wakeReleasedWhileHidden: true, noDuplicateAfterRestart: true } : {}),
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
