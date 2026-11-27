import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault } from "../src/hub/security";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Approval } from "../src/shared/contracts";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "approval-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const h = new Hub(join(dir, "state"));
  const result: any = { dir, cases: [] };
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
        toolApproval: "on-request",
        codexPath: process.argv[2],
        codexCredentialEnv: keyName,
        maxMinutes: 2,
      },
    });
    const p = await h.request({
      op: "project.add",
      path: project,
      name: "原生审批验证",
    });
    for (const allow of [true, false]) {
      let answered = false;
      const t = await submitAgentForm(h.request.bind(h), {
        op: "task.create",
        profile: defaultProfile(h.settings()),
        requestId: `approval-${allow}`,
        value: {
          projectId: p.id,
          mode: "read",
          goal: "这是应用原生审批通道测试。仅请求一次以 require_escalated 权限执行 PowerShell 命令 Write-Output ALCOR-APPROVAL-FIXTURE，理由为验证单次审批。这条命令只输出固定字符串，不读取文件、不写入、不联网、不创建智能体。需要审批时等待；被拒绝后立即结束，不重试、不换方案。",
          acceptance: "报告命令实际执行或被拒绝的状态",
        },
      });
      const deadline = Date.now() + 100000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        for (const a of h.store
          .all<Approval>("approval")
          .filter((a) => a.taskId === t.id && a.state === "pending")) {
          const detail = JSON.parse(a.detail);
          const command = String(detail.command || "").replace(/\\+/g, "\\");
          const expected = `"${join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")}" -Command 'Write-Output ALCOR-APPROVAL-FIXTURE'`;
          const safe =
            command.replace(" -NoProfile", "").toLowerCase() ===
            expected.toLowerCase();
          await h.answerApproval(a.id, a.revision, allow && safe);
          answered = true;
        }
        const task = h.getTask(t.id);
        if (["verifying", "blocked"].includes(task.state)) {
          const evidence = h.store
            .all("evidence")
            .filter((e) => e.taskId === t.id);
          result.cases.push({
            decision: allow ? "allow" : "deny",
            approvalObserved: answered,
            taskState: task.state,
            commandSucceeded: evidence.some(
              (e) =>
                e.exitCode === 0 && e.output.includes("ALCOR-APPROVAL-FIXTURE"),
            ),
          });
          break;
        }
      }
      if (!answered) break;
    }
    result.passed =
      result.cases.length === 2 &&
      result.cases.every((c: any) => c.approvalObserved) &&
      result.cases[0].commandSucceeded &&
      !result.cases[1].commandSucceeded;
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await h.shutdown();
    h.store.close();
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
}
void main();
