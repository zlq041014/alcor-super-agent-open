import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Project, Run, Task } from "../shared/contracts";
import {
  LoopRelativePath,
  type CheckRun,
  type Criterion,
  type Loop,
  type LoopStep,
} from "../shared/loop-contracts";
import { pathKey } from "../core/glob";
import { hash, redact, within } from "./security";
import { snapshotFiles } from "./workspaces";
import type { Hub } from "./service";
import type { RoleMaterial } from "./roles";

const text = (n: number) => z.string().max(n);
const Citation = z
  .object({ path: LoopRelativePath, quote: z.string().min(12).max(300) })
  .strict();
type Citation = z.infer<typeof Citation>;
const CheckCitation = z
  .object({
    checkRun: z.string().min(1).max(200),
    excerpt: z.string().min(12).max(300),
  })
  .strict();
const Validity = z
  .object({
    verdict: z.enum(["sound", "suspect"]),
    reasons: z.array(text(400)).max(6),
    evidence: z.array(Citation).max(6),
    concerns: z.array(text(300)).max(6),
  })
  .strict();
const Judgement = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    points: z
      .array(
        z
          .object({
            point: text(300),
            met: z.boolean(),
            evidence: z.union([Citation, CheckCitation]).nullable(),
            note: text(300),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
const Objection = z
  .object({
    fault: z.enum(["implementation", "check", "criterion"]),
    reason: text(600),
    evidence: z.array(Citation).max(4),
  })
  .strict();

export type Assessment = {
  action: "program" | "judged" | "fail" | "rewrite-check" | "block";
  detail: string;
  invocationId?: string;
};
function quote(s: string) {
  return s.replace(/\r\n?/g, "\n").trim();
}
export function checkObjection(answer: string) {
  const line = answer
    .split(/\r?\n/)
    .find((line) => /^\s*(?:[-*]\s*)?检查异议[：:]/.test(line));
  const detail = line
    ?.replace(/^\s*(?:[-*]\s*)?检查异议[：:]\s*/, "")
    .trim()
    .replace(/[。.!！]+$/, "");
  return detail &&
    !/^(?:无|没有|无异议|没有异议|不适用|none|n\/a)$/i.test(detail)
    ? detail.slice(0, 760)
    : undefined;
}
export function cited(citation: Citation, material: RoleMaterial[]) {
  return material.some(
    (entry) =>
      entry.kind === "file" &&
      pathKey(entry.title) === pathKey(citation.path) &&
      quote(citation.quote).length >= 12 &&
      quote(entry.content).includes(quote(citation.quote)),
  );
}
const sourceType =
  /\.(?:[cm]?[jt]sx?|py|go|rs|cs|json|md|txt|html|css|vue|yaml|yml|toml)$/i;
export class Verification {
  constructor(private readonly hub: Hub) {}
  available() {
    return this.hub.brain.configured(this.hub.settings());
  }

  async review(spec: {
    loop: Loop;
    task: Task;
    project: Project;
    step: LoopStep;
    criterion: Criterion;
    checks: CheckRun[];
    run?: Run;
    machinePassed: boolean;
    signal: AbortSignal;
  }): Promise<Assessment> {
    const { loop, task, project, step, criterion, run, signal, machinePassed } =
      spec;
    if (signal.aborted) return { action: "fail", detail: "验证已停止" };
    const files = await snapshotFiles(project.path);
    const found = run ? this.hub.store.get("file-check", run.id) : undefined;
    const changed: string[] = found?.changed ?? [];
    const names = [
      ...new Set(
        [
          criterion.author?.path,
          ...changed,
          ...Object.keys(files.files),
        ].filter((x): x is string => !!x),
      ),
    ];
    const preferred = names.filter((name) => sourceType.test(name));
    const byPath = new Map(
      Object.keys(files.files).map((name) => [pathKey(name), name]),
    );
    const materials: RoleMaterial[] = [];
    let remaining = 33000;
    for (const proposed of preferred.slice(0, 24)) {
      if (signal.aborted) return { action: "fail", detail: "验证已停止" };
      const name = byPath.get(pathKey(proposed));
      if (!name || remaining <= 0 || files.files[name].size > 100_000) continue;
      const actual = await within(project.path, join(project.path, name));
      const raw = await readFile(actual, "utf8");
      if (
        hash(Buffer.from(raw)) !== files.files[name].hash ||
        raw.includes("\0")
      )
        continue;
      const content = redact(raw).slice(0, Math.min(remaining, 5500));
      remaining -= content.length;
      materials.push({
        id: "file:" + pathKey(name),
        kind: "file",
        title: name.replaceAll("\\", "/"),
        content,
        sourceVersion: files.files[name].hash,
        truncated: content.length < raw.length,
      });
    }
    if (run?.diff && /^(?:diff --git|@@ )/m.test(run.diff)) {
      materials.push({
        id: "diff:" + run.id,
        kind: "diff",
        title: "执行回合补丁",
        content: run.diff.slice(0, 12000),
        sourceVersion: run.id,
        truncated: run.diff.length > 12000,
      });
    } else if (changed.length || found?.deleted?.length) {
      materials.push({
        id: "changes:" + run?.id,
        kind: "note",
        title: "实际变化路径",
        content: JSON.stringify({
          changed: changed.slice(0, 50),
          deleted: found?.deleted?.slice(0, 50),
          hasPatch: false,
        }),
        sourceVersion: run?.id ?? step.id,
        truncated: !!found?.truncated || changed.length > 50,
      });
    }
    for (const check of spec.checks.filter((r) => r.outputRef).slice(0, 10)) {
      const raw = await this.hub.loop.output(check.id);
      materials.push({
        id: "check:" + check.id,
        kind: "check-output",
        title: check.purpose + " · " + (check.outcome ?? check.state),
        content: raw.slice(-1400),
        truncated: raw.length > 1400,
        sourceVersion: check.workspaceVersion,
      });
    }
    if (run) {
      const denied = this.hub.store.db
        .prepare(
          "SELECT metadata FROM events WHERE kind='write.rejected' AND object_id=? AND json_extract(metadata,'$.runId')=? ORDER BY seq LIMIT 10",
        )
        .all(loop.id, run.id);
      if (denied.length)
        materials.push({
          id: "denied:" + run.id,
          kind: "note",
          title: "工作区拒绝的写入",
          sourceVersion: run.id,
          content: denied
            .map((row) => String(row.metadata))
            .join("\n")
            .slice(0, 1600),
        });
    }
    const call = <T>(
      purpose: "validity" | "judgement" | "objection",
      schema: z.ZodType<T>,
      instructions: string,
      extra?: object,
    ) =>
      this.hub.roles.call({
        loopId: loop.id,
        revision: loop.contractRevision,
        stepId: step.id + ":" + criterion.id,
        role: "verifier",
        purpose,
        promptVersion: 6,
        schema,
        instructions:
          instructions +
          "\npath 从文件材料的 title 原样复制，不加盘符、行号或其他标记。quote 直接摘录 12 到 300 个字符，只引用足以证明结论的最短一段。说明尽量简短。",
        materials,
        input: {
          goal: task.goal,
          constraints: task.constraints,
          criterion: criterion.input,
          baselineOnly: !run,
          ...extra,
        },
        signal,
        timeoutMs: 120000,
        maxOutputTokens: 8000,
      });
    const objection = run && checkObjection(run.response);
    if (objection) {
      const decision = await call(
        "objection",
        Objection,
        '只裁决这条异议。返回 {"fault":"implementation|check|criterion","reason":"中文","evidence":[{"path":"文件","quote":"原文"}]}。以用户目标为基准，不能凭异议文字认定有错。',
        { objection },
      );
      if (
        decision.status === "completed" &&
        decision.data.evidence.some((e) => cited(e, materials))
      ) {
        if (decision.data.fault === "criterion")
          return {
            action: "block",
            detail: decision.data.reason,
            invocationId: decision.invocationId,
          };
        if (
          decision.data.fault === "check" &&
          decision.data.evidence.some(
            (e) =>
              cited(e, materials) &&
              (pathKey(e.path) === pathKey(criterion.author?.path ?? "") ||
                /(?:^|[\\/])tests?[\\/]|[._](?:test|spec)\./i.test(e.path)),
          )
        )
          return {
            action: "rewrite-check",
            detail: decision.data.reason,
            invocationId: decision.invocationId,
          };
      }
    }
    if (criterion.verify.method === "judge" || (!run && machinePassed)) {
      const allowCheckEvidence =
        criterion.verify.method === "command" && !run && machinePassed;
      const points = (
        criterion.input.points ||
        criterion.input.checkIntent ||
        criterion.input.title
      )
        .split(/\r?\n|；/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (
        !points.length ||
        points.length > 12 ||
        points.some((x) => x.length > 300) ||
        new Set(points).size !== points.length
      )
        return { action: "fail", detail: "评审要点不能逐项核对" };
      const citedCheck = (evidence: z.infer<typeof CheckCitation>) =>
        allowCheckEvidence &&
        spec.checks.some(
          (check) =>
            check.id === evidence.checkRun &&
            check.outcome === "passed" &&
            criterion.verify.checkIds.includes(check.checkId),
        ) &&
        materials.some(
          (material) =>
            material.id === "check:" + evidence.checkRun &&
            quote(evidence.excerpt).length >= 12 &&
            quote(material.content).includes(quote(evidence.excerpt)),
        );
      const schema = Judgement.superRefine((value, ctx) => {
        if (!allowCheckEvidence || value.verdict !== "pass") return;
        for (const [i, item] of value.points.entries()) {
          if (
            item.met &&
            item.evidence &&
            !("path" in item.evidence) &&
            !citedCheck(item.evidence)
          )
            ctx.addIssue({
              code: "custom",
              path: ["points", i, "evidence"],
              message:
                "检查回执必须属于本条目，excerpt 要引用输出中连续、未经省略的一小段",
            });
        }
      });
      const result = await call(
        "judgement",
        schema,
        '逐项核对验收要点；照抄 point。返回 {"verdict":"pass","points":[{"point":"原要点","met":true,"evidence":{"path":"文件","quote":"原文"},"note":""}]}。文件证据对象只含 path、quote。找不到依据时用 met=false、evidence=null，整体 verdict 为 fail。' +
          (allowCheckEvidence
            ? '如果检查输出已直接证明要点，可用 {"checkRun":"材料 id 去掉 check: 前缀","excerpt":"证明要点的一行输出原文，12 至 300 字符"}。例如只摘录测试名称，不附前后其他行，不拼接或略去中间任何字。一般的通过计数不能证明具体行为。'
            : "只引用文件原文，不能引用检查输出。"),
        { points },
      );
      if (result.status !== "completed")
        return { action: "fail", detail: "独立评审未通过：" + result.reason };
      const verdicts = result.data.points;
      const missing = points.filter((point) => {
        const matching = verdicts.filter((v) => v.point.trim() === point);
        const evidence = matching[0]?.evidence;
        return (
          matching.length !== 1 ||
          !matching[0].met ||
          !evidence ||
          ("path" in evidence
            ? !cited(evidence, materials)
            : !citedCheck(evidence))
        );
      });
      if (
        result.data.verdict !== "pass" ||
        missing.length ||
        verdicts.length !== points.length
      )
        return {
          action: "fail",
          detail:
            "以下要点缺少满足证据：" + (missing.join("；") || "评审未确认通过"),
          invocationId: result.invocationId,
        };
      return {
        action: criterion.verify.method === "judge" ? "judged" : "program",
        detail: "各评审要点均有可核对证据",
        invocationId: result.invocationId,
      };
    }
    if (!machinePassed) return { action: "fail", detail: "程序检查未通过" };
    const result = await call(
      "validity",
      Validity,
      '实际检查已通过，请判断现有代码是否真正满足条目、是否只迎合用例或完全未覆盖目标。基线没有改动时请核对目标是否已存在。返回 {"verdict":"sound|suspect","reasons":["中文"],"evidence":[{"path":"文件","quote":"原文"}],"concerns":[]}。只有真实文件证据才能判 suspect。',
    );
    if (result.status !== "completed")
      return {
        action: "program",
        detail: "未完成有效性复核：" + result.reason,
      };
    if (
      result.data.verdict === "suspect" &&
      result.data.evidence.some((e) => cited(e, materials))
    )
      return {
        action: "fail",
        detail: "独立验证存疑：" + result.data.reasons.join("；"),
        invocationId: result.invocationId,
      };
    return {
      action: "program",
      detail:
        result.data.verdict === "suspect"
          ? "复核疑虑没有可核对的引用"
          : "未发现程序证据失效",
      invocationId: result.invocationId,
    };
  }
}
