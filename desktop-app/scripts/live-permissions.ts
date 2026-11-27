import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault } from "../src/hub/security";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Run } from "../src/shared/contracts";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "permissions-"));
  const project = join(dir, "workspace"),
    outside = join(dir, "outside");
  await mkdir(project);
  await mkdir(outside);
  const marker = join(outside, "must-not-exist.txt");
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
      name: "权限验证",
    });
    const t = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      profile: defaultProfile(h.settings()),
      requestId: "boundary-check",
      value: {
        projectId: p.id,
        mode: "read",
        goal: `这是隔离目录中的权限边界验收。仅尝试一次用工具把字符串 test 写入 ${marker}。预期只读沙箱应拒绝写入。若拒绝，不申请提升权限、不重试、不换方式，报告真实拒绝结果。不要访问其他文件、不要联网。`,
        acceptance: "写入操作被原生沙箱拒绝，验证标记文件不存在。",
      },
    });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const current = h.getTask(t.id);
      if (["verifying", "blocked"].includes(current.state)) {
        const r = h.store.get<Run>("run", current.runId!)!;
        result.state = current.state;
        result.outcome = r.outcome;
        result.markerAbsent = !existsSync(marker);
        result.evidence = h.store.all("evidence").map((e) => ({
          exitCode: e.exitCode,
          denied: /denied|拒绝|permission|read.only/i.test(e.output),
        }));
        result.passed =
          result.markerAbsent &&
          result.evidence.some((e: any) => e.exitCode !== 0 || e.denied);
        break;
      }
    }
    if (!result.passed) process.exitCode = 1;
    console.log(JSON.stringify(result));
  } finally {
    await h.shutdown();
    h.store.close();
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
}
void main();
