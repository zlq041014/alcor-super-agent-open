import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve("../.dev/desktop-ui");
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, "smoke-"));
const project = join(dir, "project");
await mkdir(project);
const env = {
  ...process.env,
  ALCOR_DATA_DIR: join(dir, "state"),
  ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
};
delete env.ELECTRON_RUN_AS_NODE;
const started = Date.now();
const open = () => electron.launch({
  args: ["."],
  cwd: process.cwd(),
  env,
  timeout: 30000,
});
const errors = [];
let app = await open();
const firstWindow = async () => {
  const window = await app.firstWindow();
  window.on("pageerror", (e) => errors.push(e.message));
  return window;
};
let page = await firstWindow();
try {
  await page
    .getByRole("heading", { name: "把目标交给星引。" })
    .waitFor({ timeout: 30000 });
  const coldStart = Date.now() - started;
  await page.screenshot({ path: join(dir, "01-home.png") });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .getByRole("button", { name: "添加项目", exact: true })
    .last()
    .click();
  await page.getByLabel("项目目录", { exact: true }).fill(project);
  await page.getByLabel("项目名称", { exact: true }).fill("界面验证项目");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加项目", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "界面验证项目", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "规则记忆", exact: true }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("规则内容").fill("所有验证结果使用中文说明。");
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await page.getByText("所有验证结果使用中文说明。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByLabel("发送给星引").fill("重启后仍保留的草稿");
  await page.waitForTimeout(400);
  const snap = await page.evaluate(() =>
    window.alcor.request({ op: "snapshot" }),
  );
  assert.equal(snap.projects.filter((p) => p.path === project).length, 1);
  assert.equal(snap.memories.length, 1);
  assert.equal(snap.draft, "重启后仍保留的草稿");
  await app.close();
  app = await open();
  page = await firstWindow();
  await page.getByLabel("发送给星引").waitFor();
  const reopened = await page.evaluate(() =>
    window.alcor.request({ op: "snapshot" }),
  );
  assert.equal(reopened.projects.filter((p) => p.path === project).length, 1);
  assert.equal(reopened.memories.length, 1);
  assert.equal(reopened.draft, snap.draft);
  await page
    .getByRole("button", { name: "切换明暗主题" })
    .click()
    .catch(() => page.getByTitle("切换明暗主题").click());
  await page.screenshot({ path: join(dir, "02-dark-reopened.png") });
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.screenshot({ path: join(dir, "03-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(dir, "result.json"),
    JSON.stringify(
      {
        passed: true,
        coldStartMs: coldStart,
        viewport: [1440, 940],
        compact: [1000, 720],
        checks: [
          "project creation",
          "memory persistence",
          "draft persistence",
          "restore project, rule and draft after restart",
          "dark theme",
          "compact layout",
          "no renderer errors",
        ],
        dir,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, coldStartMs: coldStart, dir }));
} finally {
  await app.close();
}
