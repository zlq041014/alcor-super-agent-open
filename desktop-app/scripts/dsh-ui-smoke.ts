import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import {
  APP_VERSION,
  CUSTOM_ENDPOINT,
  OFFICIAL_ENDPOINT,
} from "../src/shared/contracts";
import { childEnv } from "../src/hub/security";

async function main() {
  const parent = resolve(".test-data");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "dsh-ui-"));
  const packaged = process.argv.includes("--package");
  const app = await _electron.launch({
    ...(packaged
      ? {
          executablePath: resolve(
            "release",
            `alcor-${APP_VERSION}-windows-x64`,
            "Alcor.exe",
          ),
          args: [],
        }
      : { args: ["."] }),
    env: {
      ...childEnv(),
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
      ALCOR_DATA_DIR: join(dir, "state"),
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("renderer error"));
    await page.getByRole("button", { name: /设置.*v0/ }).click();
    const source = page.getByLabel("API 来源"),
      backend = page.getByLabel("新工作的执行端"),
      endpoint = page.getByLabel("API 基础地址");
    const save = () => page.getByRole("button", { name: "保存设置" }).click();
    assert.equal(await source.inputValue(), "custom");
    assert.equal(await backend.inputValue(), "dsh");
    assert.equal(await endpoint.inputValue(), CUSTOM_ENDPOINT);
    assert.deepEqual(
      await page
        .getByLabel("Agent 模型", { exact: true })
        .evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).value)),
      ["deepseek-flash", "deepseek-flash"],
    );
    assert.deepEqual(
      await page
        .getByLabel("思考强度", { exact: true })
        .evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).value)),
      ["max", "max"],
    );
    await page.getByRole("button", { name: "检测 DSH 连接" }).click();
    await page.getByText("ACP 就绪 · 0.2.2-rc.5", { exact: true }).waitFor();
    await endpoint.fill("https://example.invalid/v1");
    await source.selectOption("deepseek");
    assert.equal(await endpoint.inputValue(), OFFICIAL_ENDPOINT);
    assert.equal(await endpoint.isEditable(), false);
    const modal = app.waitForEvent("window");
    await page.getByRole("button", { name: "录入 DeepSeek 官方 Key" }).click();
    const secure = await modal;
    await secure.locator("#target").waitFor();
    assert.match(await secure.locator("#target").innerText(), /DeepSeek 官方/);
    await secure.locator("#key").fill("OFFICIAL-TEST-PLACEHOLDER");
    await secure.getByRole("button", { name: "加密保存" }).click();
    await page.getByText("密钥已加密保存", { exact: true }).waitFor();
    await source.selectOption("custom");
    assert.equal(await endpoint.inputValue(), "https://example.invalid/v1");
    await backend.selectOption("codex");
    await save();
    await page.getByText("尚未配置密钥", { exact: true }).waitFor();
    await page.getByLabel("Codex 路径").waitFor();
    const snap = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(snap.settings.executorBackend, "codex");
    assert.equal(snap.keyConfigured, false);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        packaged,
        version: APP_VERSION,
        sourceSwitch: true,
        secureDialog: true,
        codexSelectable: true,
        dshHandshake: true,
      }),
    );
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "界面验证失败");
  process.exitCode = 1;
});
