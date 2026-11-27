import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Run } from "../src/shared/contracts";
import { Vault } from "../src/hub/security";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "codex-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  await writeFile(
    join(project, "README.txt"),
    "Alcor verification marker: ALCOR-LOCAL-OK\n",
  );
  const hub = new Hub(join(dir, "state"));
  try {
    const name = "ALCOR_NATIVE_API_KEY";
    if (process.env[name])
      await new Vault(join(dir, "state"), "codex-native.dpapi").save(
        `codex:${name}`,
        process.env[name]!,
      );
    await hub.request({
      op: "settings",
      value: {
        ...hub.settings(),
        codexPath: process.argv[2],
        codexCredentialEnv: process.env[name] ? name : "",
        maxMinutes: 2,
      },
    });
    const p = await hub.request({
      op: "project.add",
      path: project,
      name: "Alcor 隔离验证",
    });
    const t = await submitAgentForm(hub.request.bind(hub), {
      op: "task.create",
      profile: defaultProfile(hub.settings()),
      requestId: "live-read-1",
      value: {
        projectId: p.id,
        mode: "read",
        goal: "仅用读取文件工具读取当前目录 README.txt，返回其中验证标识，并说明文件是否包含任何版本号。不要写文件，不联网，不创建其他智能体。",
        acceptance: "答复包含文件内的标识；明确版本号是否存在。",
      },
    });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const current = hub.getTask(t.id);
      if (["blocked", "verifying"].includes(current.state)) {
        const r = hub.store.get<Run>("run", current.runId!);
        const result = {
          taskState: current.state,
          runState: r?.state,
          outcome: r?.outcome,
          version: hub.codex.version,
          reason: current.reason,
          markerFound: r?.response.includes("ALCOR-LOCAL-OK"),
          nativeThread: r?.threadId,
          artifacts: hub.store.all("artifact").length,
          evidenceCount: hub.store.all("evidence").length,
          dir,
        };
        await writeFile(
          join(dir, "result.json"),
          JSON.stringify(result, null, 2),
        );
        console.log(JSON.stringify(result));
        if (current.state !== "verifying") process.exitCode = 1;
        return;
      }
    }
    console.log(JSON.stringify({ status: "deadline", dir }));
    process.exitCode = 1;
  } finally {
    await hub.shutdown();
    hub.store.close();
  }
}
main().catch((e) => {
  console.log(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
});
