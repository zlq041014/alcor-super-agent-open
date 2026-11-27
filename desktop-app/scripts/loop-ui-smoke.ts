import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { childEnv } from "../src/hub/security";
import { defaults, type Snapshot } from "../src/shared/contracts";
import { entity, Store } from "../src/hub/store";
import { checkOutputBlob } from "../src/hub/checks";

async function main() {
  const improve = process.argv.includes("--improve");
  const escalation = process.argv.includes("--escalation");
  const notifications = process.argv.includes("--notifications");
  const miss = process.argv.includes("--miss");
  const packageOption = process.argv.indexOf("--package");
  const executablePath =
    packageOption >= 0 ? resolve(process.argv[packageOption + 1]) : undefined;
  const base = resolve(
    improve ? "../.dev/advance-loop/L2" : "../.dev/advance-loop/L0",
  );
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "ui-"));
  const root = join(dir, "project"),
    state = join(dir, "state");
  const dsh = join(dir, "fixture-harness", "DeepSeek Harness.exe");
  const cli = join(
    dirname(dsh),
    "resources",
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-desktop-host",
    "lib",
    "cli.js",
  );
  await mkdir(dirname(cli), { recursive: true });
  await copyFile(process.execPath, dsh);
  await writeFile(
    cli,
    [
      "if(process.argv.includes('--version')) { console.log('0.2.2-rc.5'); process.exit(0); }",
      "const {createInterface} = require('node:readline');",
      "const opts = [{id:'model',currentValue:JSON.stringify(['alcor-api','deepseek-flash'])},{id:'reasoning_effort',currentValue:'max'}];",
      "createInterface({input:process.stdin}).on('line', line => {",
      "  const req = JSON.parse(line);",
      "  const result = req.method === 'initialize' ? {protocolVersion:1,agentInfo:{name:'deepseek-harness-acp'}}",
      "    : req.method === 'session/new' ? {sessionId:'fixture',configOptions:opts} : null;",
      "  if (!result) process.exit(2);",
      "  console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));",
      "});",
    ].join("\n"),
  );
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "node test.cjs", start: "node inert.cjs" },
    }),
  );
  await writeFile(
    join(root, "test.cjs"),
    "console.log('LOOP_UI_CHECK_PASSED');",
  );
  const isolated = new Store(state);
  try {
    isolated.put("settings", {
      id: "global",
      value: {
        ...defaults,
        notifications,
        dshPath: dsh,
        codexPath: join(dir, "disabled"),
        checkPath: [dirname(process.execPath)],
      },
    });
    if (executablePath) isolated.db.exec("PRAGMA user_version=2;");
  } finally {
    isolated.close();
  }
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    timeout: 30_000,
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: state,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    if (notifications) assert.equal(await app.evaluate(({ Notification }) => Notification.isSupported()), true);
    page.on("pageerror", (e) => errors.push(e.message));
    const request = (input: object) =>
      page.evaluate(
        (value) =>
          (
            window as unknown as {
              alcor: { request: (input: object) => Promise<any> };
            }
          ).alcor.request(value),
        input,
      );
    await page.getByRole("heading", { name: "把目标交给星引。" }).waitFor();
    await request({ op: "project.add", name: "循环验收项目", path: root });
    await page
      .getByRole("button", { name: /新建工作/ })
      .first()
      .click();
    await page
      .getByLabel("工作项目")
      .selectOption({ label: "循环验收项目 · " + root });
    await page.getByLabel("工作目标").fill("确认项目现有检查已经通过");
    await page
      .getByLabel("推进模式", { exact: true })
      .selectOption(improve ? "loop-improve" : "loop");
    const visible = page.getByRole("checkbox", { name: "test", exact: true });
    await visible.waitFor();
    assert.equal(await visible.isChecked(), true);
    await visible.uncheck();
    await page.getByLabel("自填检查命令").fill("npm run test");
    assert.equal(
      await page.getByRole("checkbox", { name: /^start/ }).isDisabled(),
      true,
    );
    await page.getByLabel("验收清单（每行一项）").fill("检查项目基线");
    await page.getByRole("button", { name: "创建并推进" }).click();
    await page
      .getByRole("button", { name: "工作详情与操作" })
      .waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "工作详情与操作" }).click();
    await page
      .getByRole("heading", { name: "收口报告" })
      .waitFor({ timeout: 20_000 });
    const criterion = page
      .locator(".loop-criterion")
      .filter({ hasText: "检查项目基线" });
    await criterion.getByText("自填命令 · 通过", { exact: true }).click();
    await criterion
      .getByText("LOOP_UI_CHECK_PASSED", { exact: false })
      .waitFor();
    const snap: Snapshot = await request({ op: "snapshot" });
    let migrated = false;
    if (executablePath) {
      assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
      const db = new DatabaseSync(join(state, "state.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 3);
      } finally {
        db.close();
      }
      const backups = await readdir(join(state, "backups"), {
        withFileTypes: true,
      });
      const previous = backups.find(
        (entry) => entry.isDirectory() && entry.name.startsWith("pre-loop-"),
      );
      assert.ok(previous, "没有升级前快照");
      const old = new DatabaseSync(
        join(state, "backups", previous.name, "state.sqlite"),
        { readOnly: true },
      );
      try {
        assert.equal(old.prepare("PRAGMA user_version").get()!.user_version, 2);
      } finally {
        old.close();
      }
      migrated = true;
    }
    assert.equal(snap.loops.length, 1);
    assert.equal(snap.loops[0].report?.outcome, "completed");
    assert.equal(snap.launches.length, 0);
    assert.equal(snap.runs.length, 0);
    if (miss) {
      await page.getByText("漏检反馈", { exact: true }).click();
      const reminder = "收口没有核对说明文件的异常分支";
      await page.getByLabel("漏检提醒").fill(reminder);
      await page.getByRole("button", { name: "登记漏检" }).click();
      await page.getByText("漏检反馈 · 1", { exact: true }).waitFor({ timeout: 20000 });
      await page.locator(".loop-check-info").getByText(reminder, { exact: true }).waitFor();
      const saved = await request({ op: "miss.list", id: snap.tasks[0].id });
      assert.equal(saved.length, 1);
      assert.equal(saved[0].text, reminder);
      assert.notEqual(saved[0].materialStatus, "unavailable");
      assert.equal((await request({ op: "snapshot" })).runs.length, 0);
      await page.getByText("归因待继续", { exact: true }).waitFor();
      const offline = await request({ op: "miss.list", id: snap.tasks[0].id });
      assert.equal(offline[0].attribution.state, "paused");
      assert.match(offline[0].attribution.reason, /未配置模型/);
    }
    if (notifications) {
      const db = new DatabaseSync(join(state, "state.sqlite"), { readOnly: true });
      try {
        const notices = db.prepare("SELECT count(*) AS total FROM events WHERE kind='notification.claimed' AND object_id=?");
        let total = 0;
        for (let i = 0; i < 80; i++) {
          total = Number(notices.get(snap.tasks[0].id)?.total);
          if (total) break;
          await page.waitForTimeout(50);
        }
        assert.equal(total, 1);
      } finally {
        db.close();
      }
    }
    assert.deepEqual(
      snap.projects.map((p) => p.name),
      ["循环验收项目"],
    );
    const final = snap.checkRuns.find((row) =>
      snap.criteria[0].passed?.checkRunIds.includes(row.id),
    );
    assert.ok(final && final.outcome === "passed");
    const beforeFail = {
      ...final,
      ...entity(),
      purpose: "author-after" as const,
      outcome: "failed" as const,
      exitCode: 1,
      outputRef: await checkOutputBlob(
        state,
        "CHECK_AUTHOR_FAILED_BEFORE_ADOPTION",
      ),
    };
    const ledger = new Store(state);
    try {
      ledger.tx(() => {
        ledger.put("check-run", beforeFail);
        ledger.put("criterion", {
          ...snap.criteria[0],
          author: {
            attempts: 1,
            path: "tests/alcor-fixture.test.mjs",
            beforeFail: beforeFail.id,
          },
          ...(escalation ? { escalation: { stage: "candidate-applied", diagnosis: {
            causes: ["测试记录的真实形状"], approaches: [
              { title: "验证做法甲", plan: "保留目录与检查" },
              { title: "验证做法乙", plan: "只改交付文件" },
            ],
          } } } : {}),
        });
        ledger.put("invocation", {
          ...entity(),
          loopId: snap.loops[0].id,
          role: "verifier",
          purpose: "validity",
          status: "completed",
          profile: { model: "fixture-verifier", effort: "low" },
        });
        if (escalation) {
          ledger.put("candidate", {
            ...entity(), loopId: snap.loops[0].id, criterionId: snap.criteria[0].id,
            stepId: "fixture-candidate", approach: "候选小改动", status: "selected",
            checkRunIds: [final.id], diff: "+通过后选中的示例行", changedLines: 1,
          });
        }
        if (improve) {
          const loop = snap.loops[0];
          const item = {
            ...entity(),
            loopId: loop.id,
            round: 1,
            lens: "完整性",
            title: "界面样本：范围外建议",
            claim: "建议调整无关主题",
            impact: "与本次验收无关",
            severity: "major",
            status: "deferred",
            scope: "beyond-goal",
            reason: "超出用户目标",
            workspaceVersion: loop.report?.workspaceVersion,
            evidence: [
              { kind: "file", path: "test.cjs", quote: "LOOP_UI_CHECK_PASSED" },
            ],
          };
          ledger.put("finding", item);
          ledger.put("loop", {
            ...loop,
            report: { ...loop.report, deferredFindings: [item.id] },
          });
        }
      });
    } finally {
      ledger.close();
    }
    await request({ op: "settings", value: snap.settings });
    await criterion
      .getByText("已保护的验收检查：tests/alcor-fixture.test.mjs", {
        exact: true,
      })
      .waitFor();
    await criterion
      .getByText("采纳前的失败检查 · 未通过", { exact: true })
      .click();
    await criterion
      .getByText("CHECK_AUTHOR_FAILED_BEFORE_ADOPTION", { exact: true })
      .waitFor();
    assert.equal(
      await criterion.getByText("自填命令 · 通过", { exact: true }).filter({ visible: true }).count(),
      1,
    );
    const role = page
      .locator("details.tree-role")
      .filter({ hasText: "独立验证 · 1 次" });
    await role.waitFor();
    assert.equal(await role.getAttribute("open"), null);
    await role.locator("summary").click();
    await role.getByText(/fixture-verifier/).waitFor();
    if (escalation) {
      await criterion.getByText("诊断与备选做法", { exact: true }).click();
      await criterion.getByText("保留目录与检查", { exact: false }).waitFor();
      await criterion.getByText("候选小改动 · 已整合", { exact: true }).click();
      await criterion.getByText("+通过后选中的示例行", { exact: true }).waitFor();
    }
    if (improve) {
      assert.equal(snap.loops[0].mode, "loop-improve");
      const findings = page.getByRole("region", { name: "改进发现" });
      await findings
        .locator("summary")
        .filter({ hasText: "界面样本：范围外建议" })
        .click();
      await findings
        .getByText("LOOP_UI_CHECK_PASSED", { exact: true })
        .waitFor();
      await findings.getByText("超出用户目标", { exact: true }).waitFor();
    }
    await page.screenshot({ path: join(dir, "01-light.png") });
    await page.getByTitle("切换明暗主题").click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await page.setViewportSize({ width: 1000, height: 720 });
    await criterion.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, "02-dark-compact.png") });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await criterion.getByRole("button", { name: "编辑条目" }).click();
    await criterion.getByLabel("条目名称").fill("已更新的验收条目");
    await criterion.getByRole("button", { name: "保存条目" }).click();
    await page.getByText("已更新的验收条目", { exact: true }).first().waitFor();
    const changed: Snapshot = await request({ op: "snapshot" });
    assert.equal(
      changed.loops[0].contractRevision,
      snap.loops[0].contractRevision + 1,
    );
    assert.equal(changed.launches.length, 0);
    if (miss) {
      const seeded = new Store(state);
      const label = "界面夹具：已验证的项目检查";
      try {
        const [sample] = seeded.all("miss");
        seeded.put("miss", { ...sample, replay: { state: "passed", reason: "留出交付未引入误报" },
          attribution: { revision: 1, state: "derived", category: "review", candidate: label },
          derived: { kind: "review-item", lens: "正确性与边界", text: label } });
      } finally {
        seeded.close();
      }
      await page.getByRole("button", { name: "规则记忆", exact: true }).click();
      const rules = page.getByRole("region", { name: "漏检检查" });
      await rules.getByText(label, { exact: true }).waitFor();
      await rules.getByText("漏检来源", { exact: true }).click();
      await rules.getByText("收口没有核对说明文件的异常分支", { exact: true }).waitFor();
      await rules.getByRole("button", { name: "停用检查" }).click();
      await rules.getByText("已停用", { exact: true }).waitFor();
      await rules.getByRole("button", { name: "启用检查" }).click();
      await rules.getByText("生效中", { exact: true }).waitFor();
      await rules.getByRole("button", { name: "编辑检查" }).click();
      await rules.getByLabel("项目检查提示").fill("界面夹具：编辑后需要重验");
      await rules.getByRole("button", { name: "保存并重跑回放" }).click();
      await rules.getByText("缺少历史材料", { exact: true }).waitFor();
      await rules.locator("p").getByText("界面夹具：编辑后需要重验", { exact: true }).waitFor();
      assert.equal((await request({ op: "snapshot" })).learnedChecks[0].enabled, false);
      await rules.getByRole("button", { name: "删除检查", exact: true }).click();
      await rules.getByRole("button", { name: "确认删除检查与提醒" }).click();
      await rules.waitFor({ state: "hidden" });
    }
    if (escalation) {
      await page.locator(".sidebar-bottom").getByRole("button", { name: /设置/ }).click();
      const advisor = page.getByRole("textbox", { name: /顾问模型/ });
      await advisor.fill("fixture-advisor-model");
      await page.getByRole("button", { name: "保存设置" }).click();
      await page.getByText(/设置已保存/).waitFor();
      const settings = (await request({ op: "snapshot" })).settings;
      assert.equal(settings.advisorModel, "fixture-advisor-model");
    }
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          width: 1000,
          height: 720,
          realModel: false,
          packaged: !!executablePath,
          schemaTwoMigrated: migrated,
          loopCreated: true,
          report: true,
          output: true,
          distinctAuthorProof: true,
          escalation,
          notificationClaimed: notifications,
          collapsedRole: true,
          immediateCriterionEdit: true,
          ...(improve ? { findingEvidenceExpanded: true } : {}),
          ...(miss ? { missRecordedFromReport: true, offlineAttributionPaused: true, learnedRuleManagement: true } : {}),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir }));
  } finally {
    await app.close();
    await rm(dsh, { force: true });
  }
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
