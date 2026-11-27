import { z } from "zod";
import type { Run } from "../shared/contracts";
import type { CheckRun, Criterion, Loop, LoopStep } from "../shared/loop-contracts";
import type { RoleMaterial } from "./roles";
import type { Hub } from "./service";

function distinct(values: string[]) {
  return new Set(values.map((s) => s.toLowerCase().replace(/\s+/g, ""))).size === values.length;
}

const diagnosisOutput = z.object({
  causes: z.array(z.string().trim().min(1).max(400)).min(1).max(5),
  approaches: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    plan: z.string().trim().min(1).max(800),
  }).strict()).min(2).max(4).refine((items) =>
    distinct(items.map((a) => a.title)) && distinct(items.map((a) => a.plan)),
  ),
}).strict();

export async function diagnose(
  hub: Hub, loop: Loop, step: LoopStep, criterion: Criterion, signal: AbortSignal,
  role: "diagnoser" | "advisor" = "diagnoser",
) {
  const attempts = criterion.failedAttempts ?? [];
  const materials: RoleMaterial[] = [];
  for (const row of attempts) {
    const run = hub.store.get<Run>("run", row.runId);
    if (run?.diff)
      materials.push({
        id: `diff:${row.runId}`, kind: "diff", title: "该次尝试的实际差异",
        content: run.diff.slice(0, 3000), sourceVersion: run.id, truncated: run.diff.length > 3000,
      });
    const check = row.checkRunId && hub.store.get<CheckRun>("check-run", row.checkRunId);
    if (check && check.outputRef) {
      const output = await hub.loop.output(check.id);
      materials.push({
        id: `check:${check.id}`, kind: "check-output", title: "该次尝试的失败检查",
        content: output.slice(-2500), sourceVersion: check.id, truncated: output.length > 2500,
      });
    }
    materials.push({
      id: `failure:${row.runId}`, kind: "note", title: "实际失败原因与验证意见",
      content: [row.detail, row.review].filter(Boolean).join("\n").slice(0, 1800),
      sourceVersion: row.runId,
    });
  }
  return hub.roles.call({
    loopId: loop.id, revision: loop.contractRevision, stepId: step.id,
    role, purpose: role === "advisor" ? "advise" : "diagnose", promptVersion: 2,
    instructions: [
      "只输出 {\"causes\":[\"失败原因\"],\"approaches\":[{\"title\":\"简短做法标题\",\"plan\":\"从具体位置入手的做法\"},{\"title\":\"不同做法标题\",\"plan\":\"避开同一失败的另一种做法\"}]}。使用这些英文键，不要增加字段。",
      "causes 引用真实失败证据；approaches 给两条实质不同且不同于已失败尝试的思路。保留用户范围和受保护的检查，不执行操作。",
    ].join("\n"),
    schema: diagnosisOutput, input: { criterion: criterion.input, latestFailure: criterion.failure,
      earlierApproaches: role === "advisor" ? criterion.escalation?.diagnosis?.approaches : undefined,
      earlierResult: role === "advisor" ? criterion.escalation?.previousLevel : undefined },
    materials, timeoutMs: 150000, maxOutputTokens: 4000, signal,
  });
}
