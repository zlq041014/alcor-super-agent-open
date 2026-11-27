import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { childEnv } from "../src/hub/security";
import { entity, Store } from "../src/hub/store";
import { CHIEF, defaults } from "../src/shared/contracts";

async function main() {
  const base = resolve("../.dev/desktop-ui");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "project-decisions-"));
  const data = join(dir, "state");
  const path = join(dir, "project");
  await mkdir(path);
  const project = { ...entity(), path, name: "规则验收项目" };
  const agent = {
    ...entity(),
    kind: "discussion",
    projectId: project.id,
    parentAgentId: CHIEF,
    title: "来源讨论",
  };
  const original = "项目决定：仅核对合成标题。";
  const updated = "项目决定：仅核对合成标题和编号。";
  const source = {
    ...entity(),
    agentId: agent.id,
    kind: "user",
    label: "你",
    text: original,
  };
  const store = new Store(data);
  try {
    store.tx(() => {
      store.put("settings", {
        id: "global",
        value: { ...defaults, codexPath: join(dir, "offline.exe") },
      });
      store.put("project", project);
      store.put("agent", agent);
      store.put("agent-line", source);
      store.put("agent-decision", {
        ...entity(),
        agentId: agent.id,
        projectId: project.id,
        sourceLineId: source.id,
        text: original,
      });
    });
  } finally {
    store.close();
  }
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    timeout: 30000,
    env: {
      ...childEnv(),
      CODEX_HOME: join(dir, "native"),
      ALCOR_DATA_DIR: data,
      ALCOR_BOOTSTRAP_DIR: join(dir, "bootstrap"),
    },
  });
  try {
    const page = await app.firstWindow();
    const rules = page.getByRole("button", { name: "规则记忆", exact: true });
    await rules.click();
    const card = page.locator(".memory-card");
    await card.getByText(original, { exact: true }).waitFor();
    await card.getByRole("button", { name: "查看来源讨论" }).click();
    await page.getByRole("textbox", { name: "发送给讨论 Agent" }).waitFor();
    await page.getByText(original, { exact: true }).waitFor();
    await rules.click();
    await card.getByRole("button", { name: "停用", exact: true }).click();
    await card.getByText("已停用", { exact: true }).waitFor();
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑明确规则" });
    await edit.getByLabel("规则内容").fill(updated);
    await edit.getByRole("button", { name: "保存规则" }).click();
    await card.getByText(updated, { exact: true }).waitFor();
    await card.getByRole("button", { name: "启用", exact: true }).click();
    await card.getByText("生效中", { exact: true }).waitFor();
    await card.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除" })
      .click();
    await card.waitFor({ state: "hidden" });
    const snapshot = await page.evaluate(() =>
      window.alcor.request({ op: "snapshot" }),
    );
    assert.deepEqual(snapshot.memories, []);
    const history = await page.evaluate(
      (agentId) => window.alcor.request({ op: "agent.view", agentId }),
      agent.id,
    );
    assert.ok(
      history.lines.some((line: { id: string }) => line.id === source.id),
    );
  } finally {
    await app.close();
  }
  const result = {
    dir,
    passed: true,
    oldDecisionMigrated: true,
    packaged: !!executablePath,
    originalDiscussionPreserved: true,
    managedInRulesPage: true,
    noExternalModel: true,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
