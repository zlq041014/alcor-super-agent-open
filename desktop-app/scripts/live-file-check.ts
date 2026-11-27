import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault } from "../src/hub/security";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "file-check-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const h = new Hub(join(dir, "state"));
  const result: any = { dir };
  try {
    const name = "ALCOR_NATIVE_API_KEY";
    await new Vault(join(dir, "state"), "codex-native.dpapi").save(
      `codex:${name}`,
      process.env[name]!,
    );
    await h.request({
      op: "settings",
      value: {
        ...h.settings(),
        codexPath: process.argv[2],
        codexCredentialEnv: name,
        maxMinutes: 2,
      },
    });
    const p = await h.request({
      op: "project.add",
      path: project,
      name: "自动验收验证",
    });
    const t = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: defaultProfile(h.settings()),
      requestId: "declared-check",
      value: {
        projectId: p.id,
        mode: "write",
        access: "project",
        goal: "只创建当前目录 result.txt，写入 ALCOR-CHECKED 换行并读取核对。不修改其他文件、不联网、不创建其他智能体。",
        checks: [{ path: "result.txt", contains: "ALCOR-CHECKED" }],
      },
    });
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const current = h.getTask(t.id);
      if (["done", "blocked"].includes(current.state)) {
        result.state = current.state;
        result.method = h.store.all("acceptance")[0]?.method;
        result.passed =
          current.state === "done" && result.method === "declared-file-checks";
        break;
      }
    }
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await h.shutdown();
    h.store.close();
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
}
void main();
