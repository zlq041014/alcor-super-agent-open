import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault, hash } from "../src/hub/security";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task, Run } from "../src/shared/contracts";
async function wait(h: Hub, id: string, states: string[], ms = 150000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    const t = h.getTask(id);
    if (states.includes(t.state)) return t;
  }
  throw new Error("live workflow timeout");
}
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "workflow-"));
  const path = join(dir, "project");
  await mkdir(path);
  await writeFile(join(path, "note.txt"), "alpha\n");
  const h = new Hub(join(dir, "state"));
  const results: any = { dir, checks: [] };
  try {
    const env = "ALCOR_NATIVE_API_KEY";
    await new Vault(join(dir, "state"), "codex-native.dpapi").save(
      `codex:${env}`,
      process.env[env]!,
    );
    await h.request({
      op: "settings",
      value: {
        ...h.settings(),
        codexPath: process.argv[2],
        codexCredentialEnv: env,
        maxMinutes: 2,
        maxRuns: 4,
      },
    });
    const p = await h.request({
      op: "project.add",
      path,
      name: "写入及续接验证",
    });
    const t = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: defaultProfile(h.settings()),
      requestId: "write-1",
      value: {
        projectId: p.id,
        mode: "write",
        access: "project",
        goal: "只将当前目录 note.txt 内容改成 beta 换行，随后读取文件验证。不得修改其他文件，不联网，不创建其他智能体。",
        acceptance: "note.txt 内容严格等于 beta 加一个换行；有实际读取验证。",
      },
    });
    let current = await wait(h, t.id, ["verifying", "blocked"]);
    if (current.state === "blocked") throw new Error(current.reason);
    if ((await readFile(join(path, "note.txt"), "utf8")).trim() !== "beta")
      throw new Error("file mismatch");
    let run = h.store.get<Run>("run", current.runId!)!;
    results.checks.push({
      name: "workspace-write",
      passed: true,
      threadId: run.threadId,
      artifacts: h.store.all("artifact").length,
    });
    await h.control(
      t.id,
      "accept",
      current.revision,
      hash(run.response + run.diff),
    );
    await h.request({
      op: "task.revise",
      id: t.id,
      revision: 1,
      goal: "在同一工作上继续：只将 note.txt 改成 gamma 换行并读取验证。不联网，不改其他文件。",
      constraints: "只修改 note.txt",
      acceptance: "文件内容是 gamma",
      model: "",
    });
    current = await wait(h, t.id, ["verifying", "blocked"]);
    if (current.state === "blocked") throw new Error(current.reason);
    const next = h.store.get<Run>("run", current.runId!)!;
    if (next.threadId !== run.threadId)
      throw new Error("managed resume did not retain native identity");
    if ((await readFile(join(path, "note.txt"), "utf8")).trim() !== "gamma")
      throw new Error("resume file mismatch");
    results.checks.push({ name: "same-native-thread-resume", passed: true });
    const stopTask = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: defaultProfile(h.settings()),
      requestId: "stop-1",
      value: {
        projectId: p.id,
        mode: "read",
        goal: "在只读权限内，用命令等待 40 秒，然后读取 note.txt。不要修改文件，不联网。",
        acceptance: "用于停止测试",
      },
    });
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const v = h.getTask(stopTask.id);
      const r = h.store.get<Run>("run", v.runId!);
      if (r?.state === "running" && r.turnId) break;
    }
    await h.control(stopTask.id, "pause", 1);
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (h.getTask(stopTask.id).control === "confirmed") break;
    }
    const stopped = h.getTask(stopTask.id);
    results.checks.push({
      name: "native-stop-confirmation",
      passed: stopped.state === "paused" && stopped.control === "confirmed",
      control: stopped.control,
    });
    if (stopped.control !== "confirmed")
      throw new Error("native stop unconfirmed");
    results.passed = true;
    console.log(JSON.stringify(results));
  } catch (e) {
    results.passed = false;
    results.error = (e as Error).message;
    console.log(JSON.stringify(results));
    process.exitCode = 1;
  } finally {
    await h.shutdown();
    await writeFile(join(dir, "result.json"), JSON.stringify(results, null, 2));
    h.store.close();
  }
}
void main();
