import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  copyFile,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { Store, entity, stamp } from "../src/hub/store";
import { APP_VERSION } from "../src/shared/contracts";
// Explicit opt-in: uses the user's already configured provider only on two synthetic workspaces.
// All outputs are counts, booleans, stage names and (optionally) a cropped synthetic screenshot.
async function main() {
  const details = process.env.ALCOR_TRIAL_DETAILS === "1";
  const base = resolve("../.dev/agent-trial");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "live-"));
  const configRoot = "D:/data/alcor/desktop";
  let profile = join(configRoot, "default");
  try {
    profile =
      JSON.parse(await readFile(join(configRoot, "location.json"), "utf8"))
        .dataDir || profile;
  } catch {}
  const source = new DatabaseSync(join(profile, "state.sqlite"), {
    readOnly: true,
  });
  const cfg = JSON.parse(
    String(
      source
        .prepare(
          "SELECT data FROM records WHERE kind='settings' AND id='global'",
        )
        .get()?.data,
    ),
  );
  source.close();
  const state = join(dir, "state");
  const st = new Store(state);
  for (const name of ["试用甲项目", "试用乙项目"]) {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(
      join(path, "README.md"),
      "# Trial\nFixture check: ALCOR-TREE-CHECK\n",
    );
    st.put("project", { ...entity(), name, path, origin: "manual" });
    if (details) await writeFile(join(path, "TRACE.txt"), "before\n");
  }
  st.put(
    "settings",
    details ? { ...cfg, value: { ...cfg.value, theme: "dark" } } : cfg,
  );
  st.put("catalog", {
    id: "codex",
    status: "ready",
    checkedAt: stamp(),
    count: 2,
  });
  st.close();
  const env = {
    ...process.env,
    ALCOR_DATA_DIR: state,
    ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
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
  const until = async (check: () => Promise<boolean>, ms: number) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 160));
    }
    throw new Error("condition timed out");
  };
  let app: Awaited<ReturnType<typeof start>> | undefined;
  let stage = "setup";
  const errors: string[] = [];
  try {
    for (const name of ["api-key.dpapi", "codex-native.dpapi"])
      await copyFile(join(profile, name), join(state, name));
    app = await start();
    const page = await app.firstWindow();
    page.on("pageerror", () => errors.push("renderer"));
    const root = page.getByLabel("发送给星引"),
      branch = page.getByLabel("发送给讨论 Agent", { exact: true });
    const type = async (input: typeof root, text: string) => {
      await input.fill(text);
      await input.press("Enter");
    };
    const back = () =>
      page.getByRole("button", { name: "回到总管", exact: true }).click();
    const confirmNode = async () => {
      const dialog = page.getByRole("dialog", { name: "确认创建 Agent" });
      await dialog.waitFor({ timeout: 120000 });
      await dialog
        .getByRole("button", { name: "确认创建", exact: true })
        .click();
    };
    stage = "open discussion A";
    await root.waitFor({ timeout: 35000 });
    await type(root, "为试用甲项目新开「入口验收」需求讨论");
    await confirmNode();
    await branch.waitFor({ timeout: 30000 });
    stage = "discuss only";
    await type(
      branch,
      details
        ? "我们先讨论，不开工。验收方案：仅在本测试项目，用 apply_patch 将 TRACE.txt 里唯一一行 before 替换成两行 after 和 verified；再用 PowerShell 运行 Get-Content -LiteralPath README.md，把文件中的校验标识放进回复。请用一句话复述方案。"
        : "我们只讨论，不开工。要验收的方案是只读执行一条 PowerShell 命令：Start-Sleep -Seconds 12; Get-Content -LiteralPath README.md，回复文件里的校验标识，不修改任何文件。请简洁复述方案。",
    );
    await page.locator(".line-assistant").first().waitFor({ timeout: 110000 });
    assert.equal(
      await page.evaluate(
        async () =>
          (await window.alcor.request({ op: "snapshot" })).tasks.length,
      ),
      0,
    );
    console.log("discussion verified");
    if (details) {
      stage = "discussion group click";
      const w = page
        .locator(".agent-stream .work-record")
        .filter({ has: page.locator(".kind-model") })
        .first();
      await w.locator(":scope > summary").click();
      stage = "discussion group open";
      await w
        .locator(".kind-model > summary")
        .waitFor({ state: "visible", timeout: 6000 });
      stage = "discussion read click";
      await w.locator(".kind-read > summary").first().click();
      stage = "discussion read open";
      await w
        .locator(".kind-read .work-info")
        .first()
        .waitFor({ state: "visible", timeout: 6000 });
    }
    await back();
    if (details) {
      stage = "chief real project lookup";
      await type(root, "查看试用乙项目进度和证据");
      await page
        .locator(".message.assistant .message-sources")
        .first()
        .waitFor({ timeout: 120000 });
      const w = page
        .locator(".chief-work .work-record")
        .filter({
          has: page
            .locator(".kind-read > summary")
            .filter({ hasText: "README.md" }),
        })
        .last();
      await w.locator(":scope > summary").click();
      await w
        .locator(".kind-read > summary")
        .filter({ hasText: "README.md" })
        .first()
        .click();
      await w
        .getByText(/已读取.*字节/)
        .first()
        .waitFor({ state: "visible" });
      await page
        .locator(".main-content")
        .screenshot({ path: join(dir, "chief-work.png") });
    }
    stage = "cross-project drafts";
    await type(root, "为试用乙项目新开「交付格式」需求讨论");
    await confirmNode();
    await branch.waitFor();
    await branch.fill("试用乙草稿");
    await back();
    await type(root, "继续昨天试用甲项目的入口验收讨论");
    await branch.waitFor();
    assert.equal(await branch.inputValue(), "");
    stage = "handoff";
    await type(
      branch,
      details
        ? "按刚才确定的方案执行，仅修改测试项目的 TRACE.txt，再读取 README.md 核对。"
        : "按刚才确定的方案执行，只读核对，不改文件。",
    );
    await confirmNode();
    await page
      .locator(".agent-stream")
      .getByRole("button", { name: "打开执行 Agent" })
      .first()
      .waitFor({ timeout: 115000 });
    await page
      .locator(".agent-stream")
      .getByRole("button", { name: "打开执行 Agent" })
      .first()
      .click();
    stage = "open worker in main";
    const win = page.getByLabel("发送给执行 Agent", { exact: true });
    await win.waitFor();
    stage = "wait for visible live composer";
    await win.fill("补充：最终回复也要包含 ALCOR-STEER-ACCEPTED。");
    await until(
      async () =>
        (await page
          .getByRole("button", { name: "发送给当前 Agent" })
          .isEnabled()) &&
        (await page.evaluate(async () =>
          (await window.alcor.request({ op: "snapshot" })).runs.some(
            (r: any) => r.state === "running" && !!r.turnId,
          ),
        )),
      100000,
    );
    stage = "steer receipt";
    await win.press("Enter");
    await page
      .locator(".agent-line.line-user")
      .filter({ hasText: "已接收" })
      .first()
      .waitFor({ timeout: 60000 });
    console.log("native steering acknowledged");
    stage = "other project while worker active";
    await back();
    await type(root, "继续试用乙项目的交付格式讨论");
    await branch.waitFor();
    assert.equal(await branch.inputValue(), "试用乙草稿");
    stage = "return result";
    await until(
      () =>
        page.evaluate(async () => {
          const s = await window.alcor.request({ op: "snapshot" });
          return s.messages.some((m: any) => m.id.startsWith("result:"));
        }),
      details ? 240000 : 160000,
    );
    const facts = await page.evaluate(async () => {
      const s = await window.alcor.request({ op: "snapshot" });
      const a = s.agents.find((a: any) => a.kind === "executor"),
        w = await window.alcor.request({ op: "agent.view", agentId: a.id });
      const parent = await window.alcor.request({
        op: "agent.view",
        agentId: a.parentAgentId,
      });
      return {
        agents: s.agents.length,
        tasks: s.tasks.length,
        verified: s.tasks[0].state === "verifying",
        nativeTurn: !!s.runs[0].turnId,
        marker: s.runs[0].response.includes("ALCOR-TREE-CHECK"),
        steerMarker: s.runs[0].response.includes("ALCOR-STEER-ACCEPTED"),
        tools: w.lines.filter((l: any) => l.kind === "tool").length,
        summary: w.lines.filter((l: any) => l.kind === "summary").length,
        files: w.lines
          .flatMap((l: any) => l.work?.files || [])
          .map((f: any) => ({
            fixture: f.path === "TRACE.txt",
            added: f.added,
            removed: f.removed,
            hasPatch: !!f.patch,
          }))
          .filter((f: any) => f.fixture),
        commandExit: w.lines.some(
          (l: any) => l.work?.kind === "command" && l.work.exitCode === 0,
        ),
        chiefRecords: s.messages.some((m: any) =>
          m.work?.some((w: any) => w.kind === "read"),
        ),
        discussionRecords: parent.lines.some(
          (l: any) => l.work?.kind === "model",
        ),
        rootReceipt: s.messages.some(
          (m: any) => m.id.startsWith("result:") && m.linkAgentId === a.id,
        ),
        originReceipt: parent.lines.some((l: any) => l.label === "执行回报"),
        crossProjectDraft:
          (
            await window.alcor.request({
              op: "agent.view",
              agentId: s.agents.find((x: any) => x.title === "交付格式").id,
            })
          ).draft === "试用乙草稿",
      };
    });
    console.log(JSON.stringify(facts));
    assert.equal(facts.agents, 3);
    assert.equal(facts.tasks, 1);
    assert.ok(
      facts.verified &&
        facts.nativeTurn &&
        facts.marker &&
        facts.steerMarker &&
        facts.tools > 0 &&
        facts.rootReceipt &&
        facts.originReceipt &&
        facts.crossProjectDraft,
    );
    await back();
    await page
      .locator(".tree-node")
      .filter({ hasText: "执行 Agent" })
      .first()
      .click();
    await win.waitFor();
    await page.locator(".line-assistant").first().waitFor();
    if (details) {
      stage = "expanded worker evidence";
      assert.ok(
        facts.commandExit && facts.chiefRecords && facts.discussionRecords,
      );
      assert.equal(
        (await readFile(join(dir, "试用甲项目", "TRACE.txt"), "utf8"))
          .trim()
          .replaceAll("\r\n", "\n"),
        "after\nverified",
      );
      const record = page
        .locator(".agent-stream .work-record")
        .filter({ has: page.locator(".work-file") })
        .first();
      await record.locator(":scope > summary").click();
      const file = record
        .locator(".work-file")
        .filter({ hasText: "TRACE.txt" })
        .first();
      await file.locator(":scope > summary").click();
      await file.locator(":scope > summary").waitFor({ state: "visible" });
      const command = page
        .locator(".agent-stream .work-record")
        .filter({ has: page.locator(".kind-command") })
        .last();
      if ((await command.getAttribute("open")) === null)
        await command.locator(":scope > summary").click();
      await command.locator(".kind-command > summary").last().click();
      await command
        .locator(".kind-command[open] .work-info")
        .last()
        .waitFor({ state: "visible" });
      await record.screenshot({ path: join(dir, "expanded-work-record.png") });
    }
    await page
      .locator(".workspace-body")
      .screenshot({ path: join(dir, "agent-workspace.png") });
    await page.setViewportSize({ width: 1000, height: 720 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    stage = "restart";
    await app.close();
    app = await start();
    const again = await app.firstWindow();
    await again.getByLabel("发送给星引").waitFor({ timeout: 35000 });
    const n = await again.evaluate(async () => {
      const s = await window.alcor.request({ op: "snapshot" });
      return [s.agents.length, s.runs.length, s.tasks.length];
    });
    assert.deepEqual(n, [3, 1, 1]);
    assert.equal(errors.length, 0);
    await writeFile(
      join(dir, "checks.json"),
      JSON.stringify(
        {
          version: APP_VERSION,
          passed: true,
          packaged: !!process.argv[2],
          restart: true,
          ...facts,
          rendererErrors: errors.length,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir }));
  } catch (e) {
    try {
      const page = app?.windows()[0];
      if (page) {
        const state = await page.locator(".agent-stream").evaluateAll((els) =>
          els.map((el) => ({
            top: el.scrollTop,
            client: el.clientHeight,
            height: el.scrollHeight,
            records: [...el.querySelectorAll(".work-record")].map((d) => ({
              open: d.hasAttribute("open"),
              items: [...d.querySelectorAll(".work-item")].map((x) => [
                x.className,
                x.hasAttribute("open"),
              ]),
            })),
          })),
        );
        console.log("UI state:", JSON.stringify(state));
      }
    } catch {}
    console.error(
      "Agent trial failed at: " + stage + " (" + (e as Error).name + ")",
    );
    process.exitCode = 1;
  } finally {
    try {
      await app?.close();
    } finally {
      for (const name of ["api-key.dpapi", "codex-native.dpapi"])
        await rm(join(state, name), { force: true });
    }
  }
}
main().catch(() => {
  console.error("Unable to initialize isolated agent trial");
  process.exitCode = 1;
});
