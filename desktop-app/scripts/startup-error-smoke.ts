import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { childEnv } from "../src/hub/security";
import { LEDGER_VERSION } from "../src/hub/store";

async function main() {
  const root = resolve("../.dev/desktop-release");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "startup-error-"));
  const data = join(dir, "state");
  await mkdir(data);
  const ledger = join(data, "state.sqlite");
  const db = new DatabaseSync(ledger);
  db.exec(`PRAGMA user_version=${LEDGER_VERSION + 1};`);
  db.close();
  const original = await readFile(ledger);
  const packaged = process.argv[2];
  const app = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged) } : {}),
    args: packaged ? [] : ["."],
    cwd: process.cwd(),
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: data,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("alert")
      .getByText(/星引账本未打开：数据版本较新，请使用匹配的星引版本/)
      .waitFor();
    assert.equal(await page.getByText("正在打开你的工作空间…").count(), 0);
    const error = await page.evaluate(async () => {
      try {
        await window.alcor.request({ op: "snapshot" });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    assert.match(error, /数据版本较新/);
  } finally {
    await app.close();
  }
  assert.deepEqual(await readFile(ledger), original);
  const result = {
    dir,
    packaged: !!packaged,
    ledgerUntouched: true,
    specificErrorVisible: true,
    passed: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
