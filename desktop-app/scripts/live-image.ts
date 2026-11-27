import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault } from "../src/hub/security";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Run } from "../src/shared/contracts";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "image-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const h = new Hub(join(dir, "state"));
  const result: any = { dir };
  try {
    const keyName = "ALCOR_NATIVE_API_KEY";
    await new Vault(join(dir, "state"), "codex-native.dpapi").save(
      `codex:${keyName}`,
      process.env[keyName]!,
    );
    await h.request({
      op: "settings",
      value: {
        ...h.settings(),
        codexPath: process.argv[2],
        codexCredentialEnv: keyName,
        maxMinutes: 2,
      },
    });
    const p = await h.request({
      op: "project.add",
      path: project,
      name: "图像输入验证",
    });
    const a = await h.addAttachment(resolve("assets/alcor.png"));
    const t = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: defaultProfile(h.settings()),
      requestId: "image-input",
      value: {
        projectId: p.id,
        mode: "read",
        goal: "观察本轮附图，用一句话说明主要背景色、前景图形的颜色和形状数量。不要读取其他文件，不用工具、不创建其他智能体。",
        attachments: [a.id],
      },
    });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const task = h.getTask(t.id);
      if (["verifying", "blocked"].includes(task.state)) {
        const r = h.store.get<Run>("run", task.runId!)!;
        result.state = task.state;
        result.description = r.response;
        result.passed =
          task.state === "verifying" &&
          /紫/.test(r.response) &&
          /白/.test(r.response) &&
          /3|三/.test(r.response);
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
