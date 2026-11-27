import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { Hub } from "../src/hub/service";
import { childEnv } from "../src/hub/security";
import { entity } from "../src/hub/store";

async function main() {
  const root = resolve("../.dev/desktop-ui");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "native-history-")),
    state = join(dir, "state"),
    path = join(dir, "project"),
    other = join(dir, "other");
  await Promise.all([mkdir(path), mkdir(other)]);
  const title = "已保存的原生讨论",
    content = "这条公开回复已保存在本机。",
    thread = {
      id: entity().id,
      name: title,
      cwd: path,
      turns: [
        {
          id: "fixture-running",
          status: "inProgress",
          items: [{ id: "fixture-reply", type: "agentMessage", text: content }],
        },
      ],
    };
  const seed = new Hub(state);
  let projectId: string, otherId: string;
  try {
    projectId = (
      await seed.request({ op: "project.add", name: "历史项目", path })
    ).id;
    otherId = (
      await seed.request({ op: "project.add", name: "未缓存项目", path: other })
    ).id;
    seed.ensureCodex = async () => {};
    seed.owner.owner = async () => "fixture-owner";
    seed.codex.call = async (method) =>
      method === "thread/list" ? { data: [thread] } : { thread };
    await seed.request({ op: "sessions", projectId });
    await seed.request({ op: "session.read", projectId, threadId: thread.id });
    seed.store.put("native-action", {
      ...entity(),
      projectId,
      threadId: thread.id,
      turnId: "fixture-running",
      kind: "owner-stop",
      state: "unknown",
    });
    seed.store.put("settings", {
      id: "global",
      value: { ...seed.settings(), codexPath: join(dir, "offline.exe") },
    });
  } finally {
    seed.store.close();
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
      ALCOR_DATA_DIR: state,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page
      .locator("nav")
      .getByRole("button", { name: /^原生会话/ })
      .click();
    const project = page.getByRole("combobox", { name: "原生会话项目" });
    const load = page.getByRole("button", { name: "读取会话" });
    await project.selectOption(projectId);
    await load.click();
    await page.getByText(/会话列表为本地副本，保存于/).waitFor();
    await page.getByRole("button", { name: new RegExp(title) }).click();
    const dialog = page.getByRole("dialog", { name: "原生会话 · 离线只读" });
    await dialog.getByText(content).waitFor();
    await dialog.getByText(/副本保存于/).waitFor();
    await dialog.getByText(/停止回执尚未核对/).waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "引用到新的星引讨论" })
        .isDisabled(),
      true,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: /发送到原生会话|停止此回合/ })
        .count(),
      0,
    );
    await dialog.getByRole("button", { name: "核对最新历史" }).click();
    assert.equal(await dialog.getByText(content).isVisible(), true);
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    await project.selectOption(otherId);
    await load.click();
    await page.getByText(/此项目还没有已保存的会话列表/).waitFor();
    assert.equal(await page.getByText(title, { exact: true }).count(), 0);
    assert.equal(await page.getByText("这个目录下没有已列出的会话").count(), 0);
    await page.locator("nav").getByRole("button", { name: /^历史/ }).click();
    await page.getByRole("textbox", { name: "搜索本地历史" }).fill("公开回复");
    await page
      .getByRole("combobox", { name: "历史所属项目" })
      .selectOption(projectId);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText(/原生历史副本.*保存于/).waitFor();
    await page.getByRole("button", { name: "查看原会话" }).click();
    await dialog.getByText(content).waitFor();
  } finally {
    await app.close();
  }
  const result = {
    dir,
    passed: true,
    packaged: !!executablePath,
    isolatedProtocolSeed: true,
    savedHistoryAfterRestart: true,
    offlineControlsDisabled: true,
    unknownStopVisible: true,
    uncachedProjectDistinguished: true,
    nativeExcerptSearchableOffline: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
