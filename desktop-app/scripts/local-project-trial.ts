import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { APP_VERSION, defaults } from "../src/shared/contracts";
import { Store } from "../src/hub/store";

const cmd = promisify(execFile);
async function main() {
  const base = resolve("../.dev/local-projects");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "trial-")),
    state = join(dir, "state");
  const one = join(dir, "位置一"),
    two = join(dir, "位置二"),
    paths = [join(one, "同名样例"), join(two, "同名样例")];
  await mkdir(join(paths[0], "desktop-app"), { recursive: true });
  await mkdir(paths[1], { recursive: true });
  await writeFile(join(paths[1], "README.md"), "第二位置的真实验收标记");
  const store = new Store(state);
  store.put("settings", {
    id: "global",
    value: { ...defaults, codexPath: join(dir, "unavailable.exe") },
  });
  store.close();
  const env = {
    ...process.env,
    ALCOR_DATA_DIR: state,
    ALCOR_BOOTSTRAP_DIR: join(dir, "boot"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      executablePath: resolve(
        "release",
        "alcor-" + APP_VERSION + "-windows-x64",
        "Alcor.exe",
      ),
      args: [],
      env,
      timeout: 30000,
    });
  let app = await launch();
  const errors: string[] = [];
  const instance =
    "Alcor-" +
    createHash("sha256").update(state.toLowerCase()).digest("hex").slice(0, 12);
  const exe = "D:\\apps\\portable\\everything\\Everything.exe";
  let opened = false;
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(10000);
    await page.getByLabel("发送给星引").waitFor();
    const nav = (s: string) =>
      page.locator("nav").getByRole("button", { name: s, exact: true }).click();
    await nav("项目");
    for (const path of [one, two]) {
      await app.evaluate(({ dialog }, p) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [p],
          bookmarks: [],
        })) as typeof dialog.showOpenDialog;
      }, path);
      await page.getByRole("button", { name: "添加查找位置" }).click();
      await page
        .locator(".location-row")
        .getByText(path, { exact: true })
        .waitFor();
    }
    assert.equal(await page.locator(".project-card").count(), 2);
    await nav("对话");
    async function send(t: string) {
      await page.getByLabel("发送给星引").fill(t);
      await page.getByLabel("发送给星引").press("Enter");
    }
    await send("看看同名样例项目的进度");
    await page
      .getByRole("button", { name: "同名样例 · " + paths[1], exact: true })
      .click();
    await page.getByText(/以下为资料摘录/).waitFor();
    assert.ok(
      (await page.locator(".message.assistant").last().innerText()).includes(
        "第二位置的真实验收标记",
      ),
    );
    await send("查找月亮记录项目");
    const ask = page
      .locator(".message.assistant")
      .filter({ hasText: "没有找到能确定匹配的项目" })
      .last();
    await ask.getByRole("button", { name: "新建项目", exact: true }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel("新项目文件夹名").inputValue(),
      "月亮记录",
    );
    await dialog.getByRole("button", { name: "取消" }).click();
    assert.deepEqual(await readdir(one), ["同名样例"]);
    await ask.getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog.getByLabel("新项目父目录").fill(one);
    await dialog.getByRole("button", { name: "创建文件夹" }).click();
    await page
      .getByText("已定位本机项目：" + join(one, "月亮记录"), { exact: true })
      .waitFor();
    assert.deepEqual(await readdir(join(one, "月亮记录")), []);
    await send("在 " + one + " 新建项目「月亮记录」");
    await page
      .getByRole("button", { name: "使用已有目录", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".agent-choices button")
          ?.textContent?.includes("使用已有目录"),
    );
    await nav("项目");
    await page
      .getByRole("heading", { name: "月亮记录", exact: true })
      .waitFor();
    await page.screenshot({ path: join(dir, "projects.png") });
    const facts = await page.evaluate(async () => {
      const s = await window.alcor.request({ op: "snapshot" });
      return {
        projectCount: s.projects.filter((p: any) => !p.removed).length,
        readCount: s.messages.filter((m: any) => m.sources?.length).length,
        roots: s.projectRoots.length,
        tasks: s.tasks.length,
        offline: s.codex.status !== "就绪",
        ids: s.projects.map((p: any) => p.id).sort(),
      };
    });
    assert.equal(facts.projectCount, 3);
    assert.equal(facts.roots, 2);
    assert.equal(facts.tasks, 0);
    assert.equal(facts.readCount, 1);
    assert.equal(facts.offline, true);
    await page.getByRole("button", { name: "在 Everything 中浏览" }).click();
    opened = true;
    const efu = join(state, "everything", "projects.efu");
    let list = "";
    for (let i = 0; i < 30 && !list; i++) {
      list = await readFile(efu, "utf8").catch(() => "");
      if (!list) await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(
      list
        .replace(/^\uFEFF/, "")
        .trimEnd()
        .split(/\r?\n/)
        .slice(1)
        .sort(),
      [...paths, join(one, "月亮记录")]
        .map((p) => '"' + p + '\\",,,,16')
        .sort(),
    );
    // Probe only our instance and its synthetic file list. Its title does not contain the EFU filename.
    const { stdout } = await cmd(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'
    Add-Type -AssemblyName UIAutomationClient
    $bar=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'msctls_statusbar32')
    function StatusCount($label) {
      for($i=0;$i -lt 24;$i++){
        $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,('EVERYTHING_('+$env:ALCOR_TEST_INSTANCE+')'))
        $wins=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
        foreach($win in $wins){ if($win.Current.Name.StartsWith($label)){ $control=$win.FindFirst([System.Windows.Automation.TreeScope]::Children,$bar); if($control -and $control.Current.Name -match '^([0-9]+)'){return [int]$Matches[1]} } }
        Start-Sleep -Milliseconds 120
      }; throw ('window not found for sample: '+$label)
    }
    if((StatusCount '') -lt 3){throw '项目清单尚未加载'}
    foreach($sample in @(@('月亮记录',1),@('同名样例',2),@('desktop-app',0))){
      & $env:ALCOR_TEST_VIEWER -instance $env:ALCOR_TEST_INSTANCE -filelist $env:ALCOR_TEST_EFU -search $sample[0]
      if((StatusCount $sample[0]) -ne $sample[1]){throw '文件夹搜索结果与清单不符'}
    }
    Write-Output 'verified-file-list-window'`,
      ],
      {
        env: {
          ...process.env,
          ALCOR_TEST_VIEWER: exe,
          ALCOR_TEST_INSTANCE: instance,
          ALCOR_TEST_EFU: efu,
        },
        windowsHide: true,
        timeout: 16000,
      },
    );
    assert.ok(stdout.includes("verified-file-list-window"));
    await cmd(exe, ["-instance", instance, "-quit"], {
      windowsHide: true,
      timeout: 5000,
    });
    opened = false;
    await app.close();
    app = await launch();
    const again = await app.firstWindow();
    await again.getByLabel("发送给星引").waitFor({ timeout: 30000 });
    const after = await again.evaluate(async () => {
      const s = await window.alcor.request({ op: "snapshot" });
      return {
        roots: s.projectRoots.length,
        ids: s.projects.map((p: any) => p.id).sort(),
      };
    });
    assert.deepEqual(after, { roots: 2, ids: facts.ids });
    assert.deepEqual(errors, []);
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify(
        {
          version: APP_VERSION,
          projects: facts.projectCount,
          roots: facts.roots,
          tasks: 0,
          readCount: 1,
          offline: true,
          cancelNoWrite: true,
          existingReused: true,
          idsPreserved: true,
          everythingFileList: true,
          everythingWindow: true,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log("桌面隔离试用通过：" + dir);
  } finally {
    if (opened)
      await cmd(exe, ["-instance", instance, "-quit"], {
        windowsHide: true,
        timeout: 5000,
      }).catch(() => {});
    await app.close().catch(() => {});
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
