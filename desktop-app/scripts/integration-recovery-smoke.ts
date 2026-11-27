import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { assigned } from "../src/hub/agent-ledger";
import { childEnv } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";
import { integrationVersion, workspaceVersion } from "../src/hub/workspaces";
import {
  defaults,
  type Integration,
  type Run,
  type Task,
} from "../src/shared/contracts";

async function main() {
  const base = resolve("../.dev/desktop-ui");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "integration-recovery-")),
    data = join(dir, "state"),
    path = join(dir, "project"),
    workPath = join(dir, "output");
  await Promise.all([mkdir(path), mkdir(workPath)]);
  const name = "fixture.txt",
    content = "隔离产物版本";
  const target = join(path, name);
  const beforeVersion = (await workspaceVersion(path)).version;
  await writeFile(join(workPath, name), content);
  await writeFile(target, content);
  const project = { ...entity(), path, name: "整合核对验收" };
  const run = {
    ...entity(),
    state: "ended",
    outcome: "completed",
    revision: 1,
    isolation: "output",
    integratedAt: undefined,
    workPath,
    integrationVersion: await integrationVersion(workPath, "output"),
    taskId: "",
    commandId: entity().id,
    response: "已交付可核对文件",
    diff: "",
    startedAt: new Date().toISOString(),
    backend: "codex",
  } satisfies Run;
  const task: Task = {
    ...entity(),
    projectId: project.id,
    title: "隔离产物恢复工作",
    goal: "核对整合中断后的本地效果",
    state: "verifying",
    revision: 1,
    stateVersion: 1,
    runId: run.id,
    constraints: "",
    acceptance: "",
    mode: "write",
    model: defaults.codexModel,
    unread: false,
    archived: false,
    attachments: [],
    dependencies: [],
    attempt: 1,
    isolate: true,
  };
  run.taskId = task.id;
  const receipt = {
    ...entity(),
    taskId: task.id,
    runId: run.id,
    path,
    state: "applying",
    beforeVersion,
  } satisfies Integration;
  const store = new Store(data);
  try {
    store.tx(() => {
      store.put("settings", {
        id: "global",
        value: { ...defaults, codexPath: join(dir, "offline.exe") },
      });
      store.put("project", project);
      store.put("task", task);
      assigned(store, task);
      store.put("run", run);
      store.put("integration", receipt);
    });
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
    await page.locator("nav").getByRole("button", { name: /^工作/ }).click();
    await page
      .getByRole("button", { name: /隔离产物恢复工作/ })
      .first()
      .click();
    await page.getByRole("button", { name: "工作详情与操作" }).click();
    await page
      .getByText("整合结果未知，原工作区仍保留占用。", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "核对基线并整合产物" }).count(),
      0,
    );
    await page.getByRole("button", { name: "只读核对整合结果" }).click();
    await page.getByText("此版本已整合", { exact: true }).waitFor();
    const snapshots = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(snapshots.integrations[0].resolution, "observed");
    assert.equal(snapshots.integrations[0].state, "completed");
    assert.equal(await readFile(target, "utf8"), content);
  } finally {
    await app.close();
  }
  const result = {
    dir,
    packaged: !!executablePath,
    passed: true,
    restoredUnknown: true,
    observedReadOnly: true,
    sourceContentPreserved: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
