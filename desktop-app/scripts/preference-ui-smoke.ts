import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { defaults } from "../src/shared/contracts";
import { childEnv } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";

async function main() {
  const exe = process.argv[2];
  if (!exe) throw new Error("请提供待测 Windows 候选 EXE");
  const base = resolve("../.dev/desktop-ui");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "reply-preference-"));
  const data = join(dir, "state");
  const seed = new Store(data);
  try {
    seed.put("settings", {
      id: "global",
      value: { ...defaults, codexPath: join(dir, "offline.exe") },
    });
    for (let i = 1; i <= 2; i++) {
      const request = {
        ...entity(),
        role: "user",
        status: "answered",
        text: "案例问题 " + i,
      };
      seed.put("message", request);
      seed.put("message", {
        ...entity(),
        role: "assistant",
        workRequestId: request.id,
        text: "案例答复 " + i,
      });
    }
  } finally {
    seed.close();
  }
  const app = await electron.launch({
    executablePath: resolve(exe),
    args: [],
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: data,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByLabel("发送给星引").waitFor();
    const rules = page.getByRole("button", { name: "规则记忆", exact: true });
    await rules.click();
    await page.getByLabel(/学习总管答复详略/).click();
    await page.getByRole("checkbox", { name: /学习总管答复详略/, checked: true }).waitFor();
    await page.getByRole("button", { name: "对话", exact: true }).click();
    for (let i = 1; i <= 2; i++) {
      const card = page
        .locator(".message.assistant")
        .filter({ hasText: "案例答复 " + i });
      await card.getByText("评价答复详略", { exact: true }).click();
      await card.getByRole("button", { name: "更简洁" }).click();
      await card
        .getByRole("button", { name: "更简洁", pressed: true })
        .waitFor();
    }
    await rules.click();
    const preferences = page.getByRole("region", { name: "答复偏好" });
    await preferences.getByText("待启用", { exact: true }).waitFor();
    await preferences.getByText("查看反馈证据").click();
    await preferences
      .getByRole("button", { name: "查看原答复" })
      .first()
      .click();
    await preferences.getByText(/^案例答复 /).waitFor();
    await preferences.getByRole("button", { name: "启用偏好" }).click();
    await preferences.getByText("生效中", { exact: true }).waitFor();
    await preferences.getByRole("button", { name: "停用偏好" }).click();
    await preferences.getByText("待启用", { exact: true }).waitFor();
    await preferences
      .getByRole("button", { name: "删除偏好", exact: true })
      .click();
    await preferences
      .getByRole("button", { name: "确认删除偏好及证据" })
      .click();
    await preferences
      .getByText("答复更简洁", { exact: true })
      .waitFor({ state: "hidden" });
    const snapshot = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(snapshot.replyPreferences.length, 0);
    assert.equal(snapshot.messages.length, 4);
    assert.equal(snapshot.invocations.length, 0);
  } finally {
    await app.close();
  }
  const result = {
    dir,
    passed: true,
    packaged: true,
    feedbackAndSource: true,
    enablePauseDelete: true,
    modelCalls: 0,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
