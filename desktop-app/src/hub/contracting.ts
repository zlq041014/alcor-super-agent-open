import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Project, Task } from "../shared/contracts";
import {
  CriterionInput,
  type Check,
  type Loop,
  type LoopStep,
} from "../shared/loop-contracts";
import type { Hub } from "./service";
import type { RoleMaterial } from "./roles";
import { hash, redact, within } from "./security";
import { sensitive } from "./native-work";
import type { Store } from "./store";
import { currentPromptHistory } from "./project-decisions";

const text = (length: number) => z.string().max(length);
const row = z
  .object({
    title: z.string().trim().min(1).max(300),
    detail: text(2000),
    necessity: z.enum(["required", "optional"]),
    assumption: z.boolean(),
    sourceQuote: text(300),
    method: z.enum(["command", "file", "judge", "user"]),
    checks: z.array(text(80)).max(10),
    needsAuthoredCheck: z.boolean(),
    checkIntent: text(600),
    points: text(2000),
    dependsOn: z.array(z.number().int().nonnegative()).max(10),
  })
  .strict();
export const PlannerDraft = z
  .object({
    understanding: text(1200),
    outOfScope: z.array(text(300)).max(10),
    assumptions: z.array(text(300)).max(10),
    criteria: z.array(row).max(100),
  })
  .strict();
export function plannerPrompt(limit: number) {
  return "用用户可观察的行为或交付物起草可核对清单，不提问。一个测试能核对的相关行为合为一项，优先一至五项。上限 " +
    limit +
    ' 项。返回 {"understanding":"","outOfScope":[],"assumptions":[],"criteria":[{"title":"","detail":"","necessity":"required","assumption":false,"sourceQuote":"","method":"command","checks":[],"needsAuthoredCheck":false,"checkIntent":"","points":"","dependsOn":[]}]}。sourceQuote 原样引用用户目标；没有原话就留空并标假设。' +
    "引用取 originalRequest；goal 是目标，constraints 是实施边界，不单独拆成条目。necessity 只能填 required 或 optional。method 只能填 command（命令）、file（已授权的文件检查）、judge（独立评审）或 user（用户本人才能判断的体验）。" +
    "检查名称只取 availableChecks，已有对应测试时不重写；使用 judge 时逐行给出可核对要点。dependsOn 只用前面条目的零基索引。项目检查提示仅作参考，只在原目标明确支持时采用。不要扩展目标。";
}
const index = z.number().int().nonnegative();
export const ContractCritique = z
  .object({
    missing: z
      .array(
        z
          .object({
            sourceQuote: z.string().min(1).max(300),
            suggestion: text(400),
          })
          .strict(),
      )
      .max(10),
    unverifiable: z
      .array(
        z.object({ index, reason: text(300), suggestion: text(400) }).strict(),
      )
      .max(10),
    beyondGoal: z
      .array(z.object({ index, reason: text(300) }).strict())
      .max(10),
  })
  .strict();

export type ContractItem = {
  input: CriterionInput;
  assumption: boolean;
  sourceQuote: string;
  dependencies: number[];
  blockedReason?: string;
};
export type ContractPlan = {
  summary: NonNullable<Loop["contract"]>;
  assumptions: string[];
  items: ContractItem[];
};
export function userRequest(store: Store, task: Task) {
  const bridge = store.get("agent-bridge", task.id);
  return bridge
    ? [
        bridge.authorization,
        ...currentPromptHistory<{ id: string; role: string; text: string }>(
          store, bridge.discussion || [],
        )
          .filter((m: any) => m.role === "user")
          .map((m: any) => m.text),
      ]
        .filter((x): x is string => typeof x === "string" && !!x)
        .join("\n")
    : task.goal;
}
function compactPoints(...values: string[]) {
  return values
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n|(?<=[。；;])/)
    .map((x) => x.trim())
    .filter(Boolean);
}
const validPoints = (points: string[]) =>
  !!points.length &&
  points.length <= 12 &&
  points.every((x) => x.length <= 300);

export function normalizeContract(
  task: Task,
  draft: z.infer<typeof PlannerDraft>,
  checks: Check[],
  limit: number,
  beyond: Set<string>,
  original = task.goal,
  requireSourceQuote = false,
) {
  const allowed = new Map(
    checks
      .filter((check) => check.status === "authorized")
      .map((check) => [check.input.name, check]),
  );
  const items: ContractItem[] = [];
  const mapped = new Map<number, number>();
  const titles = new Set<string>();
  const assumptions = draft.assumptions.slice();
  for (const [offset, planned] of draft.criteria.slice(0, limit).entries()) {
    if (titles.has(planned.title)) continue;
    titles.add(planned.title);
    const sourceQuote =
      planned.sourceQuote.trim() &&
      original.includes(planned.sourceQuote.trim())
        ? planned.sourceQuote.trim()
        : "";
    const assumption = planned.assumption || !sourceQuote;
    if (requireSourceQuote && !sourceQuote) continue;
    const outside = assumption && beyond.has(planned.title);
    const necessity = outside ? "optional" : planned.necessity;
    let method = planned.method;
    let names = [...new Set(planned.checks)].filter(
      (name) => allowed.get(name)?.input.kind === method,
    );
    if (method === "command" && !names.length && planned.needsAuthoredCheck) {
      const suite = [...allowed.values()].find(
        (check) =>
          check.input.kind === "command" &&
          (check.input.name === "test" || check.input.name.endsWith(":test")),
      );
      if (suite) names = [suite.input.name];
    }
    if ((method === "command" || method === "file") && !names.length)
      method = "judge";
    const points =
      method === "judge"
        ? compactPoints(planned.points || planned.detail || planned.title)
        : [];
    const notice =
      method === "judge" && !validPoints(points)
        ? "评审要点过长或无法逐项验证"
        : undefined;
    if (assumption && !sourceQuote)
      assumptions.push(
        "「" + planned.title + "」没有可核对的原话引用，已标为假设。",
      );
    const dependencies = [...new Set(planned.dependsOn)]
      .filter((i) => i < offset && mapped.has(i))
      .map((i) => mapped.get(i)!);
    mapped.set(offset, items.length);
    items.push({
      input: CriterionInput.parse({
        title: planned.title,
        detail: planned.detail,
        necessity,
        method,
        checks: names,
        needsAuthoredCheck: method === "command" && planned.needsAuthoredCheck,
        checkIntent: planned.checkIntent,
        points: notice ? "" : points.join("\n"),
      }),
      assumption,
      sourceQuote,
      dependencies,
      blockedReason: outside ? "审查认定超出目标，仅保留为建议" : notice,
    });
  }
  if (draft.criteria.length > limit)
    assumptions.push("清单超过条目上限，只保留前 " + limit + " 项。");
  return { items, assumptions };
}

function fallback(task: Task, reason: string): ContractPlan {
  const points = compactPoints(task.goal);
  const readable = validPoints(points);
  return {
    summary: {
      understanding: "按用户原话完成目标",
      outOfScope: [],
      fallback: reason,
    },
    assumptions: ["未能生成可靠清单，退化为一个独立评审条目；基线把关仍保留。"],
    items: [
      {
        input: CriterionInput.parse({
          title: "完成用户目标",
          method: "judge",
          points: readable ? points.join("\n") : "",
        }),
        sourceQuote: "",
        assumption: true,
        dependencies: [],
        blockedReason: readable
          ? undefined
          : "目标过长，无法无遗漏地列出评审要点",
      },
    ],
  };
}

export class Contracting {
  constructor(private readonly hub: Hub) {}

  async plan(
    loop: Loop,
    task: Task,
    project: Project,
    step: LoopStep,
    checks: Check[],
    signal: AbortSignal,
  ): Promise<ContractPlan> {
    if (!(await this.hub.brain.configured(this.hub.settings())))
      return fallback(task, "未配置规划模型凭据");
    const scope = checks
      .filter((entry) => entry.status === "authorized")
      .map((entry) => entry.input);
    const materials: RoleMaterial[] = [];
    const tests = new Set(
      scope.some((check) => check.kind === "command")
        ? loop.protectedPaths
            .filter(
              (name) =>
                !sensitive(name) &&
                /(?:^|\/)tests?\/|[._](?:test|spec)\./i.test(name) &&
                /\.(?:[cm]?[jt]sx?|py|go|rs|cs)$/i.test(name),
            )
            .slice(0, 6)
        : [],
    );
    for (const name of [
      "README.md",
      "AGENTS.md",
      "docs/README.md",
      "docs/architecture.md",
      ...tests,
    ]) {
      if (signal.aborted) return fallback(task, "已停止定约");
      const candidate = join(project.path, name);
      const info = await lstat(candidate).catch((e) => {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
        return undefined;
      });
      if (!info?.isFile() || info.nlink > 1) continue;
      const path = await within(project.path, candidate);
      const handle = await open(path, "r");
      try {
        const contents = Buffer.alloc(tests.has(name) ? 2600 : 5000);
        const { bytesRead } = await handle.read(
          contents,
          0,
          contents.length,
          0,
        );
        const value = contents.subarray(0, bytesRead);
        if (value.includes(0)) continue;
        materials.push({
          id: (tests.has(name) ? "file:" : "doc:") + name,
          kind: tests.has(name) ? "file" : "doc",
          title: name,
          content: redact(value.toString("utf8")),
          sourceVersion: hash(value),
          truncated: info.size > bytesRead,
        });
      } finally {
        await handle.close();
      }
    }
    for (const rule of this.hub.rules(project.id).slice(0, 8)) {
      materials.push({
        id: "rule:" + rule.id,
        kind: "rule",
        title: "有效规则",
        content: rule.text.slice(0, 1000),
        sourceVersion: String(rule.revision),
        truncated: rule.text.length > 1000,
      });
    }
    const original = userRequest(this.hub.store, task);
    const learned = this.hub.misses.hints(project.id, checks);
    const input = {
      goal: task.goal,
      originalRequest: original,
      constraints: task.constraints,
      acceptance: task.acceptance,
      availableChecks: scope,
      ...(learned.length ? { projectCheckHints: learned } : {}),
    };
    const limit = Math.min(loop.budget.limits.criteria, 40);
    const instructions = plannerPrompt(limit);
    const common = {
      loopId: loop.id,
      revision: loop.contractRevision,
      stepId: step.id,
      promptVersion: 5,
      signal,
    };
    const plan = (purpose: "plan" | "revision", revised?: unknown) =>
      this.hub.roles.call({
        ...common,
        role: "planner",
        purpose,
        schema: PlannerDraft,
        instructions:
          instructions +
          (revised ? "先按审查意见修订一次，删除超出目标的内容。" : ""),
        input: { ...input, ...(revised ? { revision: revised } : {}) },
        materials,
        timeoutMs: 180_000,
        maxOutputTokens: 12000,
      });
    const first = await plan("plan");
    if (first.status !== "completed" || !first.data.criteria.length)
      return fallback(
        task,
        first.status === "completed" ? "规划没有产生条目" : first.reason,
      );
    const critic = await this.hub.roles.call({
      ...common,
      role: "critic",
      purpose: "critique",
      schema: ContractCritique,
      instructions:
        '只按原话定位遗漏、不可验证或超范围，不重写。返回 {"missing":[{"sourceQuote":"","suggestion":""}],"unverifiable":[{"index":0,"reason":"","suggestion":""}],"beyondGoal":[{"index":0,"reason":""}]}，没有问题的数组留空，索引从零开始。',
      input: { ...input, plan: first.data },
      materials: materials.filter((m) => m.kind === "file"),
      timeoutMs: 150_000,
      maxOutputTokens: 8000,
    });
    let draft = first.data,
      plannedBy = first.invocationId;
    let reviewedBy: string | undefined;
    const beyond = new Set<string>(),
      reviewNotes: string[] = [];
    if (critic.status === "completed") {
      reviewedBy = critic.invocationId;
      const issues = {
        missing: critic.data.missing.filter(
          (issue) =>
            issue.sourceQuote.trim() && original.includes(issue.sourceQuote),
        ),
        unverifiable: critic.data.unverifiable.filter(
          (issue) => issue.index < first.data.criteria.length,
        ),
        beyondGoal: critic.data.beyondGoal.filter(
          (issue) => issue.index < first.data.criteria.length,
        ),
      };
      for (const issue of issues.beyondGoal)
        beyond.add(first.data.criteria[issue.index].title);
      if (
        issues.missing.length ||
        issues.unverifiable.length ||
        issues.beyondGoal.length
      ) {
        const updated = await plan("revision", {
          previous: first.data,
          issues,
        });
        if (updated.status === "completed" && updated.data.criteria.length) {
          draft = updated.data;
          plannedBy = updated.invocationId;
        } else return fallback(task, "审查后没有取得可校验的修订清单");
      }
    } else reviewNotes.push("未取得可校验的审查意见，使用经程序核对的首稿。");
    const normalized = normalizeContract(
      task,
      draft,
      checks,
      limit,
      beyond,
      original,
      learned.length > 0,
    );
    if (!normalized.items.length) return fallback(task, "清单经程序核对后为空");
    return {
      ...normalized,
      assumptions: [...normalized.assumptions, ...reviewNotes],
      summary: {
        understanding: draft.understanding,
        outOfScope: draft.outOfScope,
        plannedBy,
        reviewedBy,
      },
    };
  }
}
