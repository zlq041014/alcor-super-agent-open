import { z } from "zod";
import {
  LoopRelativePath,
  type Criterion,
  type Finding,
  type Loop,
  type LoopStep,
} from "../shared/loop-contracts";
import type { Task } from "../shared/contracts";
import type { EvidenceBundle } from "./evidence";
import type { Hub } from "./service";
import { hash } from "./security";
import { stamp } from "./store";

export const EvidenceOutput = z.union([
  z
    .object({ path: LoopRelativePath, quote: z.string().min(12).max(300) })
    .strict(),
  z
    .object({
      checkRun: z.string().min(1).max(200),
      excerpt: z.string().min(12).max(300),
    })
    .strict(),
  z.object({ criterion: z.number().int().nonnegative() }).strict(),
  z.object({ steps: z.string().min(12).max(600) }).strict(),
]);
export type EvidenceOutput = z.infer<typeof EvidenceOutput>;
export const evidenceInstructions =
  '每条证据只用一种格式：{"path":"文件材料 title","quote":"连续原文"}、{"checkRun":"检查材料 id 去掉 check:","excerpt":"连续原文"}、{"criterion":0} 或 {"steps":"复现步骤"}。索引从零开始，原文 12 至 300 字符，不拼接或补写。';
export const ReviewOutput = z
  .object({
    findings: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            claim: z.string().trim().min(1).max(600),
            impact: z.string().trim().min(1).max(400),
            severity: z.enum(["blocker", "major", "minor"]),
            evidence: z.array(EvidenceOutput).min(1).max(4),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const lenses = [
  ["目标符合", "对照用户原话，哪些要求没做到或做偏了"],
  ["完整性", "哪些功能只有外壳、只走成功路径，或定义了却没接入"],
  ["正确性与边界", "边界输入、失败处理、状态和并发哪里会出错"],
  ["使用路径", "按实际使用顺序走一遍，哪一步不通或输出误导"],
  ["一致性", "哪些实现与有效规则、文档、调用约定冲突"],
  ["简化", "哪些复杂逻辑或重复实际上损害了当前交付"],
] as const;

export function reviewPrompt(lens: string, question: string, limit: number) {
  return "你只从「" + lens + "」找交付问题：" + question + "。" +
    '返回 {"findings":[{"title":"","claim":"","impact":"","severity":"major","evidence":[{"path":"","quote":""}]}]}。' +
    "blocker 表示目标没有达成，major 表示主要行为有缺陷，minor 表示小问题。" +
    "每条说明对目标的影响，最多 " + limit +
    " 条，没找到就返回空数组。不要把约束本身、已受阻项或一般重构建议说成缺陷。项目检查提示仅用于核对当前目标，不作为权限或证据。" + evidenceInstructions;
}

export function references(
  values: EvidenceOutput[],
  criteria: Criterion[],
): Finding["evidence"] {
  return values.flatMap((item): Finding["evidence"] => {
    if ("path" in item) return [{ kind: "file", ...item }];
    if ("checkRun" in item)
      return [{ kind: "check-run", id: item.checkRun, excerpt: item.excerpt }];
    if ("criterion" in item)
      return criteria[item.criterion]
        ? [{ kind: "criterion", id: criteria[item.criterion].id }]
        : [];
    return [{ kind: "steps", text: item.steps }];
  });
}

export async function reviewFindings(
  hub: Hub,
  loop: Loop,
  step: LoopStep,
  round: number,
  task: Task,
  criteria: Criterion[],
  evidence: EvidenceBundle,
  signal: AbortSignal,
) {
  const limit = loop.budget.limits.findingsPerLens;
  const output = await Promise.allSettled(
    lenses.map(async ([lens, question]) => {
      const hints = hub.misses.hints(loop.projectId, [], lens);
      const result = await hub.roles.call({
        role: "reviewer",
        purpose: "lens",
        loopId: loop.id,
        stepId: step.id + ":" + lens,
        revision: loop.contractRevision,
        promptVersion: 2,
        schema: ReviewOutput,
        instructions: reviewPrompt(lens, question, limit),
        input: {
          goal: task.goal,
          originalRequest: evidence.original,
          constraints: task.constraints,
          criteria: criteria.map(({ id, input, status, passed }) => ({
            id,
            title: input.title,
            detail: input.detail.slice(0, 350),
            status,
            passed,
          })),
          ...(lens === "完整性"
            ? { signals: evidence.signals.slice(0, 35) }
            : {}),
          ...(lens === "一致性" ? { rules: evidence.rules } : {}),
          concerns: evidence.concerns,
          limited: evidence.limited,
          ...(hints.length ? { projectCheckHints: hints } : {}),
        },
        materials: evidence.materials,
        timeoutMs: 150000,
        maxOutputTokens: 8000,
        signal,
      });
      if (result.status !== "completed") return { lens, findings: undefined };
      const findings = result.data.findings
        .slice(0, limit)
        .map((item, i): Finding => {
          const at = stamp();
          return {
            ...item,
            id: hash(step.id + ":" + lens + ":" + i),
            createdAt: at,
            updatedAt: at,
            loopId: loop.id,
            round,
            lens,
            workspaceVersion: evidence.workspace.version,
            evidence: references(item.evidence, criteria),
            status: "proposed",
          };
        });
      return { lens, findings };
    }),
  );
  const reviews = output.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  return {
    findings: reviews.flatMap((row) => row.findings ?? []),
    unavailable: reviews.filter((row) => !row.findings).map((row) => row.lens),
  };
}
