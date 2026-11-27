import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { childEnv } from "../src/hub/security";
import { Store } from "../src/hub/store";
import { defaults } from "../src/shared/contracts";

async function main() {
  const [exe, source] = process.argv.slice(2);
  if (!exe || !source) throw new Error("请提供待测 EXE 和本次隔离复验账本");
  const dir = await mkdtemp(resolve("../.dev/desktop-ui/method-ui-"));
  const data = join(dir, "state");
  await mkdir(data);
  const input = new DatabaseSync(resolve(source), { readOnly: true });
  try {
    await backup(input, join(data, "state.sqlite"));
  } finally {
    input.close();
  }
  const store = new Store(data);
  try {
    store.put("settings", {
      id: "global",
      value: { ...defaults, codexPath: join(dir, "offline.exe") },
    });
    assert.equal(store.all("work-method").length, 1);
    assert.equal(store.all("work-method")[0].state, "active");
  } finally {
    store.close();
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
    await page.getByRole("button", { name: "规则记忆", exact: true }).click();
    const rules = page.getByRole("region", { name: "工作方法" });
    await rules.getByText("按环境启用", { exact: true }).waitFor();
    await rules.getByText("查看复验证据").click();
    assert.equal(
      await rules.getByRole("button", { name: "打开复验工作" }).count(),
      2,
    );
    await rules.getByRole("button", { name: "停用方法" }).click();
    await rules.getByRole("button", { name: "启用方法" }).click();
    await rules.getByText("按环境启用", { exact: true }).waitFor();
    await rules.getByRole("button", { name: "要求重新复验" }).click();
    await rules.getByText("需要重验", { exact: true }).waitFor();
    await rules.getByRole("button", { name: "删除方法", exact: true }).click();
    await rules.getByRole("button", { name: "确认删除方法" }).click();
    await rules.waitFor({ state: "hidden" });
    const snap = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(snap.workMethods.length, 0);
    assert.equal(snap.runs.length, 6);
    assert.ok(snap.workIssues.some((item) => item.state === "recovered"));
  } finally {
    await app.close();
  }
  const result = {
    dir,
    passed: true,
    packaged: true,
    restoredEvidence: true,
    managedVerifiedMethod: true,
    additionalCalls: 0,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
