import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication } from "playwright";
import { childEnv } from "../src/hub/security";
import { LEDGER_VERSION } from "../src/hub/store";

async function main() {
  const [oldExe, candidateExe, sourceVersion = "2"] = process.argv.slice(2);
  if (!oldExe || !candidateExe) throw new Error("请提供旧包和待测包的 EXE");
  const previousSchema = Number(sourceVersion);
  assert.ok([2, 3, 4, 5, 6, 7].includes(previousSchema));
  const base = resolve("../.dev/desktop-release");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "upgrade-rollback-")),
    data = join(dir, "state"),
    separate = join(dir, "restored"),
    imported = join(dir, "imported"),
    draft = "升级前隔离草稿",
    newDraft = "升级后的隔离草稿",
    rule = "升级前保存的验收规则";
  const schema = (path: string) => {
    const db = new DatabaseSync(join(path, "state.sqlite"), { readOnly: true });
    try {
      return db.prepare("PRAGMA user_version").get()?.user_version;
    } finally {
      db.close();
    }
  };
  const launch = (exe: string, at: string) =>
    electron.launch({
      executablePath: resolve(exe),
      args: [],
      timeout: 30000,
      env: {
        ...childEnv(),
        CODEX_HOME: join(dir, "native"),
        ALCOR_DATA_DIR: at,
        ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
      },
    });
  const restore = async (app: ElectronApplication, source: string) => {
    const window = await app.firstWindow();
    await window.getByLabel("发送给星引").waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, source);
    return window.evaluate(async () => {
      await globalThis.window.alcor.restore();
      return globalThis.window.alcor.request({ op: "snapshot" });
    });
  };
  let app: ElectronApplication | undefined;
  try {
    app = await launch(oldExe, data);
    const original = await app.firstWindow();
    await original.getByLabel("发送给星引").waitFor();
    await original.evaluate(
      async ({ text, rule, offline }) => {
        const value = (await window.alcor.request({ op: "snapshot" })).settings;
        await window.alcor.request({
          op: "settings",
          value: { ...value, codexPath: offline },
        });
        await window.alcor.request({ op: "draft", text });
        await window.alcor.request({
          op: "memory.save",
          text: rule,
          projectId: "",
          enabled: true,
        });
        await window.alcor.request({
          op: "agent.configure",
          agentId: "chief",
          profile: { model: "rollback-fixture", effort: "high" },
        });
      },
      { text: draft, rule, offline: join(dir, "offline.exe") },
    );
    await app.close();
    assert.equal(schema(data), previousSchema);

    app = await launch(candidateExe, data);
    const upgraded = await app.firstWindow();
    await upgraded.getByLabel("发送给星引").waitFor();
    const after = await upgraded.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(after.draft, draft);
    assert.ok(after.memories.some((m: any) => m.text === rule));
    assert.equal(schema(data), LEDGER_VERSION);
    const backups = join(data, "backups");
    const saved = (await readdir(backups)).filter((name) =>
      name.startsWith(["pre-loop-", "pre-native-plan-", "pre-outcomes-", "pre-research-", "pre-observation-", "pre-native-agents-"][previousSchema - 2]),
    );
    assert.equal(saved.length, 1);
    const before = join(backups, saved[0]);
    assert.equal(schema(before), previousSchema);
    await upgraded.evaluate(
      (text) => window.alcor.request({ op: "draft", text }),
      newDraft,
    );
    await app.close();

    const oldHub = fork(
      join(
        dirname(resolve(oldExe)),
        "resources",
        "app.asar",
        "dist",
        "hub-entry.cjs",
      ),
      [data],
      {
        execPath: resolve(oldExe),
        windowsHide: true,
        env: {
          ...childEnv(),
          CODEX_HOME: join(dir, "native"),
          ELECTRON_RUN_AS_NODE: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    oldHub.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    let fatal = "";
    oldHub.on("message", (message: any) => {
      if (message?.event === "fatal") fatal = String(message.error);
    });
    const rejected = await Promise.race([once(oldHub, "close"), delay(5000)]);
    if (!rejected) {
      oldHub.kill();
      throw new Error("旧版 Hub 没有拒绝打开较新版账本");
    }
    assert.ok(rejected[0] === 1 || rejected[0] === 2);
    assert.ok(
      (fatal + stderr).includes("数据版本较新"),
      "旧版 Hub 必须因账本版本拒绝启动",
    );
    assert.equal(schema(data), LEDGER_VERSION);

    app = await launch(candidateExe, imported);
    const importedSnapshot = await restore(app, before);
    assert.equal(importedSnapshot.settings.model, "rollback-fixture");
    await app.close();
    const importedDb = new DatabaseSync(join(imported, "state.sqlite"), { readOnly: true });
    try {
      assert.equal(importedDb.prepare(
        "SELECT json_extract(metadata,'$.model') AS model FROM events WHERE kind='agent.profile-updated' AND object_id='chief'",
      ).get()?.model, "rollback-fixture");
    } finally {
      importedDb.close();
    }

    app = await launch(oldExe, separate);
    const restored = await restore(app, before);
    assert.equal(restored.draft, draft);
    assert.ok(restored.memories.some((m: any) => m.text === rule));
    assert.equal(schema(separate), previousSchema);
    const preserved = new DatabaseSync(join(data, "state.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        preserved
          .prepare(
            "SELECT json_extract(data,'$.text') AS text FROM records WHERE kind='draft' AND id='main'",
          )
          .get()?.text,
        newDraft,
      );
    } finally {
      preserved.close();
    }
  } finally {
    if (app && app.process().exitCode === null) await app.close();
  }
  const result = {
    dir,
    passed: true,
    previousSchema,
    upgradedSchema: LEDGER_VERSION,
    oldHubRefusedUpgradeInPlace: true,
    restoredToSeparateDirectory: true,
    bothDraftsPreserved: true,
    importedLegacyAuditEvent: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
