import { _electron as electron } from "playwright";
import { backup, DatabaseSync } from "node:sqlite";
import { join, resolve, relative, isAbsolute } from "node:path";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { APP_VERSION } from "../src/shared/contracts";
// Read only an isolated, previously completed agent-trial sample. No credentials, network or new work.
async function main() {
  const base = await realpath(resolve("../.dev/agent-trial")),
    sample = await realpath(resolve(process.argv[2])),
    rel = relative(base, sample);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("Expected an isolated trial");
  const dir = await mkdtemp(join(base, "replay-")),
    state = join(dir, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(sample, "state/state.sqlite"), {
    readOnly: true,
  });
  await backup(source, join(state, "state.sqlite"));
  source.close();
  const db = new DatabaseSync(join(state, "state.sqlite"));
  const cfg = JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM records WHERE kind='settings' AND id='global'",
        )
        .get()?.data,
    ),
  );
  cfg.value = {
    ...cfg.value,
    endpoint: "",
    codexPath: "",
    codexCredentialEnv: "",
    theme: "dark",
  };
  db.prepare(
    "UPDATE records SET data=? WHERE kind='settings' AND id='global'",
  ).run(JSON.stringify(cfg));
  db.close();
  const env = {
    ...process.env,
    ALCOR_DATA_DIR: state,
    ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: resolve(
      "release/alcor-" + APP_VERSION + "-windows-x64/Alcor.exe",
    ),
    args: [],
    env,
  });
  let stage = "launch";
  try {
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on("pageerror", () => errors.push("renderer"));
    await page.getByLabel("发送给星引").waitFor({ timeout: 30000 });
    const chief = page
      .locator(".chief-work .work-record")
      .filter({
        has: page.locator(".kind-read").filter({ hasText: "README.md" }),
      })
      .first();
    stage = "chief";
    await chief.locator(":scope > summary").click();
    const rd = chief
      .locator(".kind-read")
      .filter({ hasText: "README.md" })
      .first();
    await rd.locator(":scope > summary").click();
    await rd.locator(".work-info").waitFor({ state: "visible" });
    await chief.screenshot({ path: join(dir, "chief-work.png") });
    stage = "discussion";
    await page
      .locator(".tree-node")
      .filter({ hasText: "讨论 Agent" })
      .filter({ hasText: "入口验收" })
      .first()
      .click();
    const discussion = page
      .locator(".agent-stream .work-record")
      .filter({ has: page.locator(".kind-model") })
      .first();
    await discussion.locator(":scope>summary").click();
    await discussion.locator(".kind-model>summary").first().click();
    await discussion
      .locator(".kind-model .work-info")
      .first()
      .waitFor({ state: "visible" });
    stage = "worker";
    await page
      .locator(".tree-node")
      .filter({ hasText: "执行 Agent" })
      .first()
      .click();
    const file = page
      .locator(".agent-stream .work-file")
      .filter({ hasText: "TRACE.txt" })
      .first();
    const record = page
      .locator(".agent-stream .work-record")
      .filter({
        has: page.locator(".work-file").filter({ hasText: "TRACE.txt" }),
      })
      .first();
    await record.locator(":scope>summary").click();
    await file.locator(":scope>summary").click();
    await file.locator(".work-patch").waitFor();
    assert.equal(await file.locator(".added").innerText(), "+2");
    assert.equal(await file.locator(".removed").innerText(), "−1");
    assert.ok(
      (await file.locator(".work-patch").innerText()).includes("+verified"),
    );
    const commandGroup = page
      .locator(".agent-stream .work-record")
      .filter({ has: page.locator(".kind-command") })
      .last();
    if ((await commandGroup.getAttribute("open")) === null)
      await commandGroup.locator(":scope>summary").click();
    const cmd = commandGroup.locator(".kind-command").last();
    await cmd.locator(":scope>summary").click();
    await cmd.locator(".work-info").waitFor();
    assert.ok(
      (await cmd.locator(".work-info").innerText()).includes("退出码 0"),
    );
    await record.screenshot({ path: join(dir, "expanded-work-record.png") });
    const summaryGroup = page
      .locator(".agent-stream .work-record")
      .filter({ has: page.locator(".kind-summary") })
      .first();
    if ((await summaryGroup.getAttribute("open")) === null)
      await summaryGroup.locator(":scope>summary").click();
    const reason = summaryGroup.locator(".kind-summary").first();
    await reason.locator(":scope>summary").click();
    await reason.locator(".work-info pre").waitFor();
    assert.ok((await reason.locator(".work-info pre").innerText()).length > 0);
    const facts = await page.evaluate(async () => {
      const s = await window.alcor.request({ op: "snapshot" });
      return {
        agents: s.agents.length,
        runs: s.runs.length,
        tasks: s.tasks.length,
      };
    });
    assert.equal(facts.runs, 1);
    assert.equal(errors.length, 0);
    await writeFile(
      join(dir, "checks.json"),
      JSON.stringify(
        {
          version: APP_VERSION,
          passed: true,
          packaged: true,
          source: "completed real sample",
          chief: true,
          discussion: true,
          worker: true,
          patch: [2, 1],
          commandExit: 0,
          publicSummary: true,
          ...facts,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir, ...facts }));
  } catch (e) {
    console.error(
      "Trace replay failed at " + stage + " (" + (e as Error).name + ")",
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
main().catch(() => {
  console.error("Unable to read trial evidence");
  process.exitCode = 1;
});
