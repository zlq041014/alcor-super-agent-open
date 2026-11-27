import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { APP_VERSION, CHIEF, defaults } from "../src/shared/contracts";
import { childEnv } from "../src/hub/security";
import { Store, entity } from "../src/hub/store";
import { tree } from "./loop-score";

const discussionId = "discussion:performance";

async function measure(
  tasks: number,
  messages: number,
  executablePath?: string,
) {
  const root = resolve("../.dev/desktop-release");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "performance-"));
  const state = join(dir, "state");
  const projects = Array.from({ length: 5 }, (_, i) => ({
    ...entity(),
    name: `合成项目 ${i}`,
    path: join(dir, "project-" + i),
  }));
  await Promise.all(projects.map(({ path }) => mkdir(path)));
  const store = new Store(state);
  try {
    store.tx(() => {
      store.put("settings", {
        id: "global",
        value: { ...defaults, codexPath: join(dir, "offline-codex.exe") },
      });
      for (const project of projects) store.put("project", project);
      store.put("agent", {
        ...entity(),
        id: discussionId,
        kind: "discussion",
        parentAgentId: CHIEF,
        projectId: projects[0].id,
        title: "容量验证讨论",
      });
      for (let i = 0; i < tasks; i++) {
        const project = projects[i % projects.length];
        const task = entity(),
          run = entity();
        store.put("task", {
          ...task,
          title: `合成任务 ${i}`,
          goal: `合成验证目标 ${i}`,
          constraints: "只读",
          acceptance: "交付核对结果",
          projectId: project.id,
          runId: run.id,
          state: "done",
          revision: 1,
          stateVersion: 1,
          mode: "read",
          model: "deepseek-flash",
          archived: false,
          unread: false,
          attempt: 1,
          dependencies: [],
          attachments: [],
        });
        store.put("run", {
          ...run,
          taskId: task.id,
          commandId: entity().id,
          revision: 1,
          state: "ended",
          outcome: "completed",
          backend: "dsh",
          response: "这是本地性能检查使用的合成工作结果。".repeat(10),
          diff: "",
          workPath: project.path,
          startedAt: run.createdAt,
          endedAt: run.updatedAt,
          workRecordVersion: 1,
        });
      }
      for (let i = 0; i < messages; i++) {
        const message = {
          ...entity(),
          role: i % 2 ? ("assistant" as const) : ("user" as const),
          text:
            (i === 0 ? "最旧检索标记。" : "") +
            `本地性能检索样本 ${i}。` +
            "这是非敏感的合成数据。".repeat(20),
        };
        store.put("message", message);
        store.put("agent-line", {
          ...message,
          id: "line:" + message.id,
          agentId: discussionId,
          kind: message.role,
          label: i % 2 ? "星引" : "用户",
        });
      }
    });
  } finally {
    store.close();
  }
  const start = performance.now();
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: state,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
    timeout: 30000,
  });
  const measured = await (async () => {
    const actual = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
    }));
    assert.equal(actual.packaged, !!executablePath);
    assert.equal(actual.version, APP_VERSION);
    const page = await app.firstWindow();
    await page.getByLabel("发送给星引").waitFor({ timeout: 30000 });
    await page.waitForFunction(
      async () => {
        try {
          return !!(await window.alcor.request({ op: "snapshot" })).hub;
        } catch (e) {
          if (!(e as Error).message.includes("Hub 正在启动")) throw e;
          return false;
        }
      },
      undefined,
      { polling: 50, timeout: 30000 },
    );
    const coldStartMs = performance.now() - start;
    const measures = await page.evaluate(async (agentId) => {
      const times = {
        snapshot: [] as number[],
        search: [] as number[],
        latest: [] as number[],
        previous: [] as number[],
      };
      for (let i = 0; i < 5; i++) {
        let at = performance.now();
        const snapshot = await window.alcor.request({ op: "snapshot" });
        times.snapshot.push(performance.now() - at);
        at = performance.now();
        const result = await window.alcor.request({
          op: "search",
          text: "最旧检索标记",
        });
        times.search.push(performance.now() - at);
        at = performance.now();
        const recent = await window.alcor.request({
          op: "agent.view",
          agentId,
        });
        times.latest.push(performance.now() - at);
        at = performance.now();
        const previous = await window.alcor.request({
          op: "agent.view",
          agentId,
          before: recent.lines[0].id,
        });
        times.previous.push(performance.now() - at);
        if (
          snapshot.messages.length !== 250 ||
          result.messages.length !== 2 ||
          !result.messages.some(
            (m: { agentId?: string }) => m.agentId === agentId,
          ) ||
          recent.lines.length !== 120 ||
          previous.lines.length !== 120 ||
          new Set(
            [...recent.lines, ...previous.lines].map(
              (line: { id: string }) => line.id,
            ),
          ).size !== 240
        )
          throw new Error("历史窗口、搜索或分页结果不符");
      }
      return times;
    }, discussionId);
    const memory = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((p) => ({ type: p.type, workingSetKB: p.memory.workingSetSize })),
    );
    const electronWorkingSetMB =
      memory.reduce((sum, p) => sum + p.workingSetKB, 0) / 1024;
    const mainPid = await app.evaluate(() => process.pid);
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${mainPid}' | Where-Object { $_.CommandLine -like '*hub-entry.cjs*' } | Select-Object -ExpandProperty WorkingSetSize`,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const hubWorkingSetMB = Number(stdout.trim()) / 1024 ** 2;
    assert.ok(hubWorkingSetMB > 0, "未取得独立 Hub 的工作集");
    const maximumRequestMs = Object.fromEntries(
      Object.entries(measures).map(([name, times]) => [
        name,
        Math.max(...times),
      ]),
    );
    await page.getByRole("button", { name: "历史搜索", exact: true }).click();
    await page.getByLabel("搜索本地历史").fill("最旧检索标记");
    await page.getByLabel("历史所属项目").selectOption(projects[0].id);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const match = page
      .locator(".search-result")
      .filter({ hasText: "最旧检索标记" });
    await match.waitFor();
    assert.equal(await match.count(), 1);
    await match.getByRole("button", { name: "打开对话" }).click();
    await page.getByLabel("发送给讨论 Agent", { exact: true }).waitFor();
    return {
      coldStartMs,
      maximumRequestMs,
      electronWorkingSetMB,
      hubWorkingSetMB,
      scopedHistoryOpensDiscussion: true,
      passed:
        coldStartMs <= 3000 &&
        Object.values(maximumRequestMs).every((value) => value <= 300) &&
        electronWorkingSetMB <= 800,
    };
  })().finally(() => app.close());
  const files = await tree(state);
  const sizes = await Promise.all(files.map((file) => stat(join(state, file))));
  const result = {
    version: APP_VERSION,
    packaged: !!executablePath,
    tasks,
    messages,
    projects: projects.length,
    dir,
    ...measured,
    dataBytes: sizes.reduce((sum, info) => sum + info.size, 0),
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const option = process.argv.indexOf("--package");
  const executable =
    option >= 0
      ? resolve(
          process.argv[option + 1] ??
            `release/alcor-${APP_VERSION}-windows-x64/Alcor.exe`,
        )
      : undefined;
  for (const [tasks, messages] of [
    [100, 1000],
    [1000, 10000],
  ]) {
    const result = await measure(tasks, messages, executable);
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
