import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  writeFile,
  copyFile,
  rm,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Store, entity, stamp } from "../src/hub/store";
import {
  APP_VERSION,
  CHIEF_MODEL,
  MEMBER_MODEL,
} from "../src/shared/contracts";
async function main() {
  const root = "D:/data/alcor/desktop",
    base = join(root, "validation");
  await mkdir(base, { recursive: true });
  let profile = join(root, "default");
  try {
    profile =
      JSON.parse(await readFile(join(root, "location.json"), "utf8")).dataDir ||
      profile;
  } catch {}
  const dir = await mkdtemp(join(base, "profiles-")),
    state = join(dir, "state"),
    workspace = join(dir, "workspace");
  await mkdir(workspace);
  const source = new DatabaseSync(join(profile, "state.sqlite"), {
    readOnly: true,
  });
  const cfg = JSON.parse(
    String(
      source
        .prepare(
          "SELECT data FROM records WHERE id='global' AND kind='settings'",
        )
        .get()?.data,
    ),
  );
  source.close();
  const db = new Store(state);
  db.put("settings", {
    id: "global",
    value: {
      ...cfg.value,
      profileVersion: 1,
      model: CHIEF_MODEL,
      codexModel: MEMBER_MODEL,
      reasoningEffort: "max",
      memberEffort: "max",
      toolApproval: "never",
    },
  });
  db.put("project", { ...entity(), name: "试用模型项目", path: workspace });
  db.put("catalog", {
    id: "codex",
    status: "ready",
    count: 1,
    checkedAt: stamp(),
  });
  db.close();
  const env = {
    ...process.env,
    ALCOR_DATA_DIR: state,
    ALCOR_BOOTSTRAP_DIR: join(dir, "boot"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const start = () =>
    electron.launch({
      ...(process.argv[2]
        ? { executablePath: resolve(process.argv[2]), args: [] }
        : { args: ["."], cwd: process.cwd() }),
      env,
      timeout: 30000,
    });
  let app: Awaited<ReturnType<typeof start>> | undefined,
    stage = "setup";
  const facts: Record<string, unknown> = {
    version: APP_VERSION,
    packaged: !!process.argv[2],
  };
  const until = async (check: () => Promise<boolean>, ms = 30000) => {
    const t = Date.now() + ms;
    while (Date.now() < t) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 160));
    }
    throw Error("condition timed out");
  };
  try {
    for (const n of ["api-key.dpapi", "codex-native.dpapi"])
      await copyFile(join(profile, n), join(state, n));
    app = await start();
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on("pageerror", () => errors.push("renderer"));
    const request = (r: any) =>
      page.evaluate((r) => window.alcor.request(r), r);
    const main = page.getByLabel("发送给星引"),
      send = async (text: string) => {
        await main.fill(text);
        await main.press("Enter");
      };
    await main.waitFor({ timeout: 30000 });
    stage = "chief selection";
    await page.getByLabel("配置总管模型").click();
    let dlg = page.getByRole("dialog");
    assert.equal(await dlg.getByLabel("Agent 模型").inputValue(), CHIEF_MODEL);
    assert.equal(await dlg.getByLabel("思考强度").inputValue(), "max");
    await dlg.getByRole("button", { name: "取消", exact: true }).click();
    stage = "available models";
    const native = await request({ op: "agent.models", backend: "codex" }),
      api = await request({ op: "agent.models", backend: "api" });
    facts.bothAdvertised = [CHIEF_MODEL, MEMBER_MODEL].every(
      (id) =>
        api.some((x: any) => x.id === id) &&
        native.some((x: any) => x.id === id && x.efforts.includes("max")),
    );
    assert.ok(facts.bothAdvertised);
    stage = "cancel before creation";
    await send("给试用模型项目新开「测试」讨论");
    dlg = page.getByRole("dialog", { name: "确认创建 Agent" });
    await dlg.waitFor();
    assert.equal((await request({ op: "snapshot" })).agents.length, 0);
    await dlg.getByRole("button", { name: "取消创建" }).click();
    await dlg.waitFor({ state: "hidden" });
    stage = "confirm changed discussion model";
    await send("给试用模型项目新开「模型选择」需求讨论");
    await dlg.waitFor();
    assert.equal(await dlg.getByLabel("Agent 模型").inputValue(), MEMBER_MODEL);
    assert.equal(await dlg.getByLabel("思考强度").inputValue(), "max");
    const out = resolve("../.dev/profile-ui");
    await mkdir(out, { recursive: true });
    await dlg.screenshot({ path: join(out, "create-agent.png") });
    await dlg.getByLabel("Agent 模型").selectOption(CHIEF_MODEL);
    await dlg.getByLabel("思考强度").selectOption("high");
    await dlg.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByLabel("发送给讨论 Agent", { exact: true }).waitFor();
    const a = (await request({ op: "snapshot" })).agents.find(
      (a: any) => a.kind === "discussion",
    );
    assert.deepEqual(a.profile, { model: CHIEF_MODEL, effort: "high" });
    facts.cancelAndOverride = true;
    stage = "edit existing node";
    await page.getByLabel("配置当前 Agent 模型").click();
    dlg = page.getByRole("dialog", { name: "配置 Agent 模型" });
    await dlg.getByLabel("Agent 模型").selectOption(MEMBER_MODEL);
    await dlg.getByLabel("思考强度").selectOption("max");
    await dlg.getByRole("button", { name: "保存模型配置" }).click();
    await until(
      async () =>
        (await request({ op: "snapshot" })).agents[0].profile.effort === "max",
    );
    await page.getByRole("button", { name: "回到总管", exact: true }).click();
    stage = "real chief API";
    try {
      const verified = await request({ op: "model.test" });
      facts.chiefAPI = verified.model === CHIEF_MODEL;
    } catch {
      facts.chiefAPI = false;
    }
    stage = "confirm default executor";
    await page
      .getByRole("button", { name: /新建工作/ })
      .first()
      .click();
    dlg = page.getByRole("dialog", { name: "创建一项工作" });
    assert.equal(await dlg.getByLabel("Agent 模型").inputValue(), MEMBER_MODEL);
    assert.equal(await dlg.getByLabel("思考强度").inputValue(), "max");
    assert.equal(await dlg.getByLabel("执行范围").inputValue(), "codex");
    await dlg
      .getByLabel("工作目标")
      .fill(
        "只用文字回复 PROFILE-OK。不运行工具，不读写任何文件，不访问网络。",
      );
    await dlg.getByRole("button", { name: "创建并开始" }).click();
    const sRun = async () => (await request({ op: "snapshot" })).runs[0];
    await until(async () => !!(await sRun())?.turnId, 90000);
    let run = await sRun();
    facts.native = {
      model: run.model,
      effort: run.actualEffort,
      approval: run.toolApproval,
      sandbox: run.actualSandbox,
    };
    assert.equal(run.model, MEMBER_MODEL);
    assert.equal(run.actualEffort, "max");
    assert.equal(run.toolApproval, "never");
    assert.equal(run.actualSandbox, "dangerFullAccess");
    stage = "real completion";
    try {
      await until(async () => (await sRun())?.state === "ended", 95000);
    } catch {}
    run = await sRun();
    facts.nativeCompleted = run.outcome === "completed";
    facts.returnedMarker = run.response.includes("PROFILE-OK");
    facts.askedToolApproval = (
      await request({ op: "snapshot" })
    ).approvals.some((x: any) => x.method !== "item/tool/requestUserInput");
    assert.equal(facts.askedToolApproval, false);
    stage = "restart";
    await app.close();
    app = await start();
    const second = await app.firstWindow();
    await second.getByLabel("发送给星引").waitFor({ timeout: 30000 });
    const fresh = await second.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.equal(fresh.agents.length, 2);
    assert.deepEqual(fresh.agents.find((x: any) => x.id === a.id).profile, {
      model: MEMBER_MODEL,
      effort: "max",
    });
    assert.equal(fresh.runs.length, 1);
    assert.equal(errors.length, 0);
    facts.restart = true;
    await writeFile(join(out, "checks.json"), JSON.stringify(facts, null, 2));
    console.log(JSON.stringify(facts));
  } catch (e) {
    console.error(
      "Profile trial failed at " + stage + " (" + (e as Error).name + ")",
    );
    process.exitCode = 1;
  } finally {
    try {
      await app?.close();
    } finally {
      for (const n of ["api-key.dpapi", "codex-native.dpapi"])
        await rm(join(state, n), { force: true });
    }
  }
}
main().catch(() => {
  console.error("Profile trial initialization failed");
  process.exitCode = 1;
});
