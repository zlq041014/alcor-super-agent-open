import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { Hub } from "../src/hub/service";
import { MobileDesk } from "../src/hub/mobile";

const [adbPath, port, serial] = process.argv.slice(2);
const component = "app.alcor.mobile/.MainActivity";
const app = "app.alcor.mobile";
const fixtureKey = "ALCOR_EMULATOR_FIXTURE_KEY";
const exec = promisify(execFile);
if (!adbPath || !/^\d+$/.test(port) || !/^emulator-\d+$/.test(serial))
  throw new Error("需要指定 ADB、服务器端口和独立模拟器序列号");
const adb = async (...args: string[]) => (await exec(adbPath, ["-P", port, "-s", serial, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 15000,
})).stdout.trim();

async function until<T>(read: () => Promise<T | undefined>, because: string) {
  for (let i = 0; i < 80; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(150);
  }
  throw new Error(because);
}

async function main() {
  assert.equal(await adb("shell", "getprop", "ro.kernel.qemu"), "1");
  const parent = resolve("../.dev/mobile-v1/android-runtime");
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, "smoke-"));
  const workspace = join(output, "project");
  await mkdir(workspace);
  const hub = new Hub(join(output, "hub"));
  let desk: MobileDesk | undefined = new MobileDesk(hub, 0, true);
  let browser: Browser | undefined;
  let cdp: string | undefined, desktopPort: string | undefined;
  async function connect() {
    if (cdp) await adb("forward", "--remove", "tcp:" + cdp);
    const pid = await until(async () => {
      const value = await adb("shell", "pidof", app);
      return (await adb("shell", "cat", "/proc/net/unix")).includes("@webview_devtools_remote_" + value) ? value : undefined;
    }, "没有发现 APK 的 WebView");
    cdp = await adb("forward", "tcp:0", "localabstract:webview_devtools_remote_" + pid);
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdp, { noDefaults: true });
    const page = browser.contexts().flatMap((ctx) => ctx.pages()).find((tab) => tab.url().startsWith("https://appassets.androidplatform.net/"));
    if (!page) throw new Error("没有找到星引的本地页面");
    page.setDefaultTimeout(12000);
    return page;
  }
  async function screenshot(file: string) {
    const { stdout } = await exec(adbPath, ["-P", port, "-s", serial, "exec-out", "screencap", "-p"], {
      encoding: "buffer", windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    await writeFile(join(output, file), stdout);
  }
  try {
    hub.ensureCodex = async () => { throw new Error("隔离验证不连接原生账户"); };
    await adb("shell", "am", "start", "-W", "-n", component);
    let page = await connect();
    const tap = (name: string) => page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("heading", { name: "星引", exact: true }).waitFor();
    await screenshot("01-android-home.png");
    const startHeight = await page.evaluate(() => innerHeight);
    await page.locator("#composer").click();
    await page.waitForFunction((height) => innerHeight < height - 70, startHeight);
    await screenshot("02-android-keyboard.png");
    await adb("shell", "input", "keyevent", "4");
    await page.waitForFunction((height) => Math.abs(innerHeight - height) < 10, startHeight);

    await tap("接入 DeepSeek");
    await page.locator("input[name=key]").fill(fixtureKey);
    await tap("保存并开始");
    await page.getByText("DeepSeek · 手机直连", { exact: true }).waitFor();
    const encryptedModel = await adb("shell", "run-as", app, "cat", "shared_prefs/credentials.xml");
    assert.ok(encryptedModel.includes('name="model"') && !encryptedModel.includes(fixtureKey));
    await tap("电脑");
    await adb("shell", "input", "keyevent", "4");
    await page.getByRole("dialog", { name: "电脑" }).waitFor({ state: "detached" });

    const project = await hub.request({ op: "project.add", path: workspace, name: "模拟器隔离项目" });
    const discussion = hub.desk.open(project, "登录页讨论");
    const invite = await desk.local({
      action: "invite", address: "127.0.0.1", projects: [project.id], name: "隔离模拟器",
    }) as { code: string };
    const invitation = JSON.parse(Buffer.from(invite.code.slice(7), "base64url").toString("utf8"));
    desktopPort = new URL(invitation.url).port;
    await adb("reverse", "tcp:" + desktopPort, "tcp:" + desktopPort);
    await tap("电脑");
    await tap("配对一台电脑");
    const field = page.locator("textarea[name=code]");
    const submit = page.getByRole("dialog", { name: "配对一台电脑" }).getByRole("button", { name: "配对", exact: true });
    const bad = { ...invitation, pin: Buffer.alloc(32).toString("base64url") };
    await field.fill("ALCOR1." + Buffer.from(JSON.stringify(bad)).toString("base64url"));
    await submit.click();
    await page.getByText(/安全连接未建立/).waitFor();
    await field.fill(invite.code);
    await submit.click();
    await page.getByRole("dialog", { name: "电脑" }).waitFor();
    await tap("关闭");
    await tap("找会话");
    await page.getByRole("button", { name: /登录页讨论/ }).click();
    await page.getByRole("heading", { name: discussion.title }).waitFor();
    await desk.close();
    desk = undefined;
    await page.evaluate(() => window.alcorForeground());
    await page.waitForFunction(() => document.querySelector(".topbar")?.textContent?.includes("0/1"));
    const composer = page.locator("#composer");
    await composer.fill("就用继续");
    await composer.press("Enter");
    await page.getByText("已记下决定：继续", { exact: false }).waitFor();
    assert.equal(hub.store.all("mobile-decision").length, 0);
    await screenshot("03-android-local-decision.png");
    await adb("shell", "am", "force-stop", app);
    await browser.close();
    browser = undefined;
    await adb("shell", "am", "start", "-W", "-n", component);
    page = await connect();
    await page.getByRole("button", { name: /继续上次讨论.*登录页讨论/ }).click();
    await page.getByText("已记下决定：继续", { exact: false }).waitFor();
    await screenshot("04-android-after-restart.png");
    desk = new MobileDesk(hub, Number(desktopPort), true);
    await desk.startSaved();
    await page.evaluate(() => window.alcorForeground());
    await until(async () => hub.store.all("mobile-decision")[0]?.discussion === discussion.id ? true : undefined, "手机决定未送回原讨论");
    assert.equal(hub.store.all("task").length, 0);
    await writeFile(join(output, "result.json"), JSON.stringify({
      android: await adb("shell", "getprop", "ro.build.version.sdk"), project: project.name, originalDiscussion: discussion.id,
      results: ["launch", "keyboard", "back", "encrypted-settings", "pin-rejection", "paired-catalog", "offline-save", "restart-recovery", "reconnect-decision"],
    }, null, 2));
    console.log("Android native WebView smoke passed: " + output);
  } finally {
    await browser?.close();
    if (cdp) await adb("forward", "--remove", "tcp:" + cdp);
    if (desktopPort) await adb("reverse", "--remove", "tcp:" + desktopPort);
    await desk?.close();
    hub.store.close();
  }
}

declare global { interface Window { alcorForeground: () => void; } }
main().catch((error) => { console.error(error); process.exitCode = 1; });
