import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, type Page } from "playwright";
import { Store, entity } from "../src/hub/store";
import { Vault } from "../src/hub/security";
import { APP_VERSION, defaults, defaultProfile } from "../src/shared/contracts";

// Real Electron, IPC and SQLite, with synthetic conversations and a manually held loopback model.
// Holding the database writer proves the user can see the message even before the Hub accepts it.
async function main() {
  const base = resolve("../.dev/chat-delivery");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "trial-")),
    state = join(dir, "state");
  let reply: ServerResponse | undefined,
    calls = 0;
  const model = createServer((req, res) => {
    req.on("error", () => {});
    req.resume();
    req.on("end", () => {
      calls++;
      reply = res;
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const ep =
    "http://127.0.0.1:" + (model.address() as { port: number }).port + "/v1";
  const textReply = (text: string, status = 200) => {
    assert.ok(reply);
    reply!.writeHead(status, { "Content-Type": "application/json" });
    reply!.end(
      JSON.stringify(
        status === 200
          ? { model: "fixture", choices: [{ message: { content: text } }] }
          : { error: { message: "fixture failure" } },
      ),
    );
    reply = undefined;
  };
  const db = new Store(state);
  db.put("settings", {
    id: "global",
    value: { ...defaults, endpoint: ep, protocol: "chat", theme: "light" },
  });
  db.put("catalog", {
    id: "codex",
    count: 1,
    status: "ready",
    checkedAt: new Date().toISOString(),
  });
  const p = { ...entity(), name: "版式试用项目", path: dir };
  db.put("project", p);
  const a = {
    ...entity(),
    kind: "discussion",
    parentAgentId: "chief",
    projectId: p.id,
    title: "界面讨论",
    profile: defaultProfile(defaults),
    activity: "等待讨论",
  };
  db.put("agent", a);
  db.put("agent-line", {
    ...entity(),
    agentId: a.id,
    kind: "system",
    label: "来自总管",
    text: "确认消息反馈",
  });
  db.put("message", { ...entity(), role: "system", text: "已打开试用工作区" });
  db.close();
  const vault = new Vault(state);
  await vault.save(ep, "local-fixture-only");
  const env = {
    ...process.env,
    ALCOR_BOOTSTRAP_DIR: join(dir, "boot"),
    ALCOR_DATA_DIR: state,
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
  const until = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("condition timed out");
  };
  let app: Awaited<ReturnType<typeof start>> | undefined,
    sql: DatabaseSync | undefined,
    locked = false,
    stage = "startup";
  const facts: Record<string, unknown> = {
    version: APP_VERSION,
    packaged: !!process.argv[2],
  };
  const placement = async (
    page: Page,
    user: string,
    left: string,
    lane: string,
  ) => {
    const sizes = await page.evaluate(
      ({ user, left, lane }) => {
        const u = document.querySelector(user)!.getBoundingClientRect(),
          a = document.querySelector(left)!.getBoundingClientRect(),
          parent = document.querySelector(lane)!,
          p = parent.getBoundingClientRect(),
          style = getComputedStyle(parent);
        return {
          right: p.right - parseFloat(style.paddingRight) - u.right,
          left: a.left - (p.left + parseFloat(style.paddingLeft)),
          gap: u.left - a.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      },
      { user, left, lane },
    );
    assert.ok(
      Math.abs(sizes.right) <= 3 &&
        Math.abs(sizes.left) <= 3 &&
        sizes.gap > 30 &&
        !sizes.overflow,
      "conversation alignment",
    );
  };
  try {
    app = await start();
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("renderer"));
    const root = page.getByLabel("发送给星引", { exact: true }),
      branch = page.getByLabel("发送给讨论 Agent", { exact: true });
    await root.waitFor();
    await page.locator(".tree-node").filter({ hasText: "界面讨论" }).waitFor();
    sql = new DatabaseSync(join(state, "state.sqlite"));
    sql.exec("PRAGMA busy_timeout=1500");
    const lock = () => {
        sql!.exec("BEGIN IMMEDIATE");
        locked = true;
      },
      unlock = () => {
        sql!.exec("ROLLBACK");
        locked = false;
      };
    const sendLocked = async (type: "root" | "branch", text: string) => {
      const input = type === "root" ? root : branch,
        sel = type === "root" ? ".message.user" : ".line-user",
        send = type === "root" ? "发送消息" : "发送给当前 Agent";
      await input.fill(text);
      await page.waitForTimeout(350);
      lock();
      const startAt = Date.now();
      try {
        if (type === "root")
          await page.getByRole("button", { name: send, exact: true }).click();
        else await input.press("Enter");
        const echo = page.locator(sel).filter({ hasText: text }).last();
        await echo.waitFor({ timeout: 1300 });
        assert.equal(await input.inputValue(), "");
        assert.ok(Date.now() - startAt < 1500);
        const id = await echo.getAttribute("data-message-id");
        assert.ok(id);
        assert.equal(
          sql!
            .prepare("SELECT count(*) AS n FROM records WHERE kind=? AND id=?")
            .get(type === "root" ? "message" : "agent-line", id)!.n,
          0,
        );
        facts[type + "LocalEchoMs"] = Date.now() - startAt;
      } finally {
        unlock();
      }
    };
    stage = "chief local echo";
    const rootText = "先核对总管消息的位置。";
    await sendLocked("root", rootText);
    await until(() => calls === 1);
    await root.fill(rootText);
    await page.waitForTimeout(350);
    textReply(JSON.stringify({ reply: "已核对总管位置。", proposal: null }));
    await page
      .locator(".message.assistant")
      .filter({ hasText: "已核对总管位置。" })
      .waitFor();
    assert.equal(await root.inputValue(), rootText);
    assert.equal(
      await page.locator(".message.user").filter({ hasText: rootText }).count(),
      1,
    );
    await placement(page, ".message.user", ".message.assistant", ".messages");
    facts.rootDraftPreserved = true;
    stage = "branch local echo";
    await page.locator(".tree-node").filter({ hasText: "界面讨论" }).click();
    await branch.waitFor();
    const branchText = "请核对讨论消息。";
    await sendLocked("branch", branchText);
    await until(() => calls === 2);
    await branch.fill("下一条讨论草稿");
    await page.waitForTimeout(260);
    await page.getByRole("button", { name: "回到总管", exact: true }).click();
    assert.equal(await root.inputValue(), rootText);
    assert.equal(
      await page
        .locator(".messages")
        .getByText(branchText, { exact: true })
        .count(),
      0,
    );
    await page.locator(".tree-node").filter({ hasText: "界面讨论" }).click();
    await branch.waitFor();
    await page.locator(".line-user").filter({ hasText: branchText }).waitFor();
    assert.equal(await branch.inputValue(), "下一条讨论草稿");
    textReply("讨论页核对完成。");
    await page
      .locator(".line-assistant")
      .filter({ hasText: "讨论页核对完成。" })
      .waitFor();
    assert.equal(
      await page.locator(".line-user").filter({ hasText: branchText }).count(),
      1,
    );
    await placement(
      page,
      ".line-user",
      ".line-assistant",
      ".conversation-lane",
    );
    await placement(page, ".line-user", ".line-system", ".conversation-lane");
    facts.branchSwitchAndDraft = true;
    stage = "compact dark layout";
    await page.getByTitle("切换明暗主题").click();
    await page.setViewportSize({ width: 1000, height: 720 });
    await placement(
      page,
      ".line-user",
      ".line-assistant",
      ".conversation-lane",
    );
    await page
      .locator(".agent-stream")
      .screenshot({ path: join(dir, "discussion.png") });
    await page.getByRole("button", { name: "回到总管", exact: true }).click();
    await placement(page, ".message.user", ".message.assistant", ".messages");
    stage = "failed reply";
    await root.fill("演示失败的回复。");
    await root.press("Enter");
    await until(() => calls === 3);
    await root.fill("不会被覆盖的草稿");
    textReply("", 503);
    await page
      .locator(".message.user")
      .filter({ hasText: "演示失败的回复。" })
      .getByText("消息已保存，处理未完成")
      .waitFor();
    assert.equal(await root.inputValue(), "不会被覆盖的草稿");
    assert.equal(calls, 3);
    await page.waitForTimeout(400);
    stage = "restart";
    await app.close();
    app = await start();
    page = await app.firstWindow();
    const reopened = page.getByLabel("发送给星引", { exact: true });
    await reopened.waitFor();
    assert.equal(await reopened.inputValue(), "不会被覆盖的草稿");
    assert.equal(await page.locator(".message.user").count(), 2);
    await page.locator(".tree-node").filter({ hasText: "界面讨论" }).click();
    await page.locator(".line-user").filter({ hasText: branchText }).waitFor();
    assert.equal(
      await page.getByLabel("发送给讨论 Agent", { exact: true }).inputValue(),
      "下一条讨论草稿",
    );
    assert.equal(calls, 3);
    assert.equal(errors.length, 0);
    Object.assign(facts, {
      modelCalls: calls,
      restart: true,
      normalAndCompactLayout: true,
      rendererErrors: errors.length,
      passed: true,
    });
    await writeFile(join(dir, "checks.json"), JSON.stringify(facts, null, 2));
    console.log(JSON.stringify({ ...facts, dir }));
  } catch (e) {
    console.error(
      "Chat delivery check failed: " + stage + " (" + (e as Error).name + ")",
    );
    process.exitCode = 1;
  } finally {
    if (locked) sql?.exec("ROLLBACK");
    sql?.close();
    if (reply && !reply.writableEnded) reply.end();
    await app?.close();
    model.closeAllConnections();
    model.close();
    await rm(join(state, "api-key.dpapi"), { force: true });
  }
}
main().catch(() => {
  console.error("Could not initialize isolated chat delivery check");
  process.exitCode = 1;
});
