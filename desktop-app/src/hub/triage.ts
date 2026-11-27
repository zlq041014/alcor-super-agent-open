import { z } from "zod";
import { pathKey } from "../core/glob";
import type { Task } from "../shared/contracts";
import type {
  Criterion,
  Finding,
  FindingReference,
  Loop,
  LoopStep,
} from "../shared/loop-contracts";
import type { EvidenceBundle } from "./evidence";
import { EvidenceOutput, evidenceInstructions, references } from "./review";
import type { RoleMaterial } from "./roles";
import type { Hub } from "./service";

const text = (value: string) => value.replace(/\r\n?/g, "\n").trim();
const severity = { blocker: 0, major: 1, minor: 2 };
export function cite(
  item: FindingReference,
  packet: Pick<EvidenceBundle, "materials">,
  criteria: Criterion[],
) {
  if (item.kind === "criterion")
    return criteria.some((entry) => entry.id === item.id);
  if (item.kind === "steps") return false;
  const material = packet.materials.find((m) =>
    item.kind === "file"
      ? m.kind === "file" && pathKey(m.title) === pathKey(item.path)
      : m.kind === "check-output" && m.id === "check:" + item.id,
  );
  const excerpt = text(item.kind === "file" ? item.quote : item.excerpt);
  return (
    !!material &&
    excerpt.length >= 12 &&
    text(material.content).includes(excerpt)
  );
}

function locations(finding: Finding, packet: EvidenceBundle) {
  return finding.evidence.flatMap(
    (ref): Array<{ key: string; line: number }> => {
      if (ref.kind === "criterion" || ref.kind === "check-run")
        return [{ key: ref.kind + ":" + ref.id, line: 0 }];
      if (ref.kind === "steps") return [];
      const file = packet.materials.find(
        (material) =>
          material.kind === "file" &&
          pathKey(material.title) === pathKey(ref.path),
      )!;
      const source = text(file.content);
      const line = source
        .slice(0, source.indexOf(text(ref.quote)))
        .split("\n").length;
      return [{ key: "file:" + pathKey(ref.path), line }];
    },
  );
}

export function clusters(findings: Finding[], packet: EvidenceBundle) {
  const positions = new Map(
    findings.map((item) => [item.id, locations(item, packet)]),
  );
  const groups: Finding[][] = [];
  const adjacent = (a: Finding, b: Finding) =>
    positions
      .get(a.id)!
      .some((x) =>
        positions
          .get(b.id)!
          .some((y) => x.key === y.key && Math.abs(x.line - y.line) <= 5),
      );
  for (const item of findings) {
    const same = groups.filter((group) =>
      group.some((peer) => adjacent(item, peer)),
    );
    if (!same.length) groups.push([item]);
    else {
      same[0].push(item);
      for (const group of same.slice(1)) {
        same[0].push(...group);
        groups.splice(groups.indexOf(group), 1);
      }
    }
  }
  return groups.filter((group) => group.length > 1);
}

export function preference(
  a: "A" | "B" | "equal",
  reverse: "A" | "B" | "equal",
) {
  if (a === "A" && reverse === "B") return 1;
  if (a === "B" && reverse === "A") return -1;
  return 0;
}
const Merge = z
  .object({ groups: z.array(z.array(z.string()).min(2).max(8)).max(20) })
  .strict();
const Refute = z
  .object({
    verdict: z.enum(["holds", "refuted", "uncertain"]),
    reason: z.string().max(600),
    evidence: z.array(EvidenceOutput).max(4),
  })
  .strict();
const Rank = z
  .object({ higher: z.enum(["A", "B", "equal"]), reason: z.string().max(200) })
  .strict();
const Scope = z
  .object({
    scope: z.enum(["reopen", "in-goal", "beyond-goal"]),
    criterionIndex: z.number().int().nonnegative().nullable(),
    sourceQuote: z.string().max(300),
    reason: z.string().max(300),
  })
  .strict();
type Role = "triager" | "refuter" | "ranker";
type Purpose = "merge" | "refute" | "compare" | "scope";
const summary = ({ id, title, claim, impact, severity }: Finding) => ({
  id,
  title,
  claim,
  impact,
  severity,
});

export async function triage(
  hub: Hub,
  loop: Loop,
  step: LoopStep,
  task: Task,
  criteria: Criterion[],
  packet: EvidenceBundle,
  findings: Finding[],
  signal: AbortSignal,
) {
  const original = packet.original;
  const checklist = criteria.map(({ id, input, status }) => ({
    id,
    title: input.title,
    status,
  }));
  const call = <T>(
    role: Role,
    purpose: Purpose,
    key: string,
    schema: z.ZodType<T>,
    instructions: string,
    input: Record<string, unknown>,
    materials: RoleMaterial[] = [],
  ) =>
    hub.roles.call({
      loopId: loop.id,
      revision: loop.contractRevision,
      stepId: step.id + ":" + key,
      promptVersion: 1,
      role,
      purpose,
      schema,
      instructions,
      input,
      materials,
      timeoutMs: role === "ranker" ? 60000 : 120000,
      maxOutputTokens: role === "ranker" ? 1800 : 5000,
      signal,
    });
  const change = (item: Finding, status: Finding["status"], reason: string) => {
    item.status = status;
    item.reason = reason;
  };
  for (const item of findings) {
    item.evidence = item.evidence.filter(
      (ref) => ref.kind === "steps" || cite(ref, packet, criteria),
    );
    if (!item.evidence.length)
      change(item, "invalid_evidence", "引用与当前材料不符");
  }
  const proposed = () => findings.filter((row) => row.status === "proposed");
  const groups = clusters(proposed(), packet);
  if (groups.length) {
    const output = await call(
      "triager",
      "merge",
      "merge",
      Merge,
      '只把同组内确实是同一个问题的发现合并，拿不准留空。返回 {"groups":[["发现 id","发现 id"]]}。',
      { candidates: groups.map((group) => group.map(summary)) },
    );
    if (output.status === "completed") {
      for (const ids of output.data.groups) {
        const unique = [...new Set(ids)];
        const pool = groups.find((group) =>
          unique.every((id) =>
            group.some((x) => x.id === id && x.status === "proposed"),
          ),
        );
        if (!pool || unique.length < 2) continue;
        const keep = pool
          .filter((item) => unique.includes(item.id))
          .sort(
            (a, b) =>
              b.evidence.filter((e) => e.kind !== "steps").length -
                a.evidence.filter((e) => e.kind !== "steps").length ||
              severity[a.severity] - severity[b.severity],
          );
        for (const duplicate of keep.slice(1)) {
          duplicate.duplicateOf = keep[0].id;
          change(duplicate, "duplicate", "与另一发现指向同一问题");
        }
      }
    }
  }
  const queue = proposed().sort(
    (a, b) => severity[a.severity] - severity[b.severity],
  );
  const { refutationsPerRound, comparisonsPerRound } = loop.budget.limits;
  for (const item of queue.slice(refutationsPerRound))
    change(item, "unverified", "本轮反驳预算已用尽");
  const checked = await Promise.allSettled(
    queue.slice(0, refutationsPerRound).map(async (item) => {
      const nearby = packet.materials.filter((m) =>
        item.evidence.some((ref) =>
          ref.kind === "file"
            ? m.kind === "file" && pathKey(m.title) === pathKey(ref.path)
            : ref.kind === "check-run" && m.id === "check:" + ref.id,
        ),
      );
      const samples = [
        ...new Map(
          [...nearby, ...packet.materials.slice(0, 8)].map((m) => [m.id, m]),
        ).values(),
      ];
      const result = await call(
        "refuter",
        "refute",
        "refute:" + item.id,
        Refute,
        '独立尝试推翻结论：在别处处理了吗？引用误读了吗？证据充分支持时判 holds；找到反证判 refuted 并引用；材料不足判 uncertain。返回 {"verdict":"holds","reason":"","evidence":[]}。' +
          evidenceInstructions,
        { goal: task.goal, original, checklist, finding: item },
        samples,
      );
      if (result.status !== "completed") {
        change(item, "unverified", result.reason);
        return;
      }
      const proof = references(result.data.evidence, criteria).filter((ref) =>
        cite(ref, packet, criteria),
      );
      if (result.data.verdict === "refuted" && proof.length)
        change(item, "refuted", result.data.reason);
      else if (
        result.data.verdict === "holds" &&
        (proof.length || item.evidence.some((x) => cite(x, packet, criteria)))
      ) {
        item.evidence = [
          ...new Map(
            [...item.evidence, ...proof]
              .filter((x) => x.kind !== "steps")
              .map((x) => [JSON.stringify(x), x]),
          ).values(),
        ];
        change(item, "confirmed", result.data.reason);
      } else
        change(
          item,
          "unverified",
          result.data.reason || "没有可核对的反驳结论",
        );
    }),
  );
  for (const done of checked) if (done.status === "rejected") throw done.reason;

  const confirmed = findings
    .filter((item) => item.status === "confirmed")
    .sort((a, b) => severity[a.severity] - severity[b.severity]);
  const points = new Map<string, number>(),
    compared = new Set<string>();
  const remainingForComparison = () => {
    const { budget } = hub.store.get<Loop>("loop", loop.id)!;
    return budget.limits.roleCalls - budget.spent.roleCalls - confirmed.length;
  };
  let pairs = 0;
  for (
    let a = 0;
    confirmed.length > 2 &&
    a < confirmed.length - 1 &&
    pairs < comparisonsPerRound &&
    remainingForComparison() >= 2;
    a++
  ) {
    for (
      let b = a + 1;
      b < confirmed.length &&
      pairs < comparisonsPerRound &&
      remainingForComparison() >= 2;
      b++, pairs++
    ) {
      signal.throwIfAborted();
      const [left, right] = [confirmed[a], confirmed[b]];
      const ask = (A: Finding, B: Finding) =>
        call(
          "ranker",
          "compare",
          A.id + ":" + B.id,
          Rank,
          '哪一项更影响用户当前目标？区分不明显选 equal。只返回 {"higher":"A","reason":""}；higher 只能是 A、B、equal。',
          { goal: task.goal, A: summary(A), B: summary(B) },
        );
      const first = await ask(left, right),
        second = await ask(right, left);
      compared.add(left.id);
      compared.add(right.id);
      if (first.status !== "completed" || second.status !== "completed")
        continue;
      const delta = preference(first.data.higher, second.data.higher);
      points.set(left.id, (points.get(left.id) ?? 0) + delta);
      points.set(right.id, (points.get(right.id) ?? 0) - delta);
    }
  }
  confirmed.sort(
    (a, b) =>
      Number(compared.has(b.id)) - Number(compared.has(a.id)) ||
      (points.get(b.id) ?? 0) - (points.get(a.id) ?? 0) ||
      severity[a.severity] - severity[b.severity],
  );
  for (const [index, item] of confirmed.entries()) {
    signal.throwIfAborted();
    item.rank = index + 1;
    if (item.severity === "minor") {
      change(item, "deferred", "未达到本轮修复的严重程度");
      continue;
    }
    const bound = await call(
      "triager",
      "scope",
      "scope:" + item.id,
      Scope,
      '判断是否允许修改：reopen 指向已通过且实际没满足的条目下标；发现未引用该条目时也要摘录用户原话。in-goal 必须摘录本次目标中直接授权该修改的原话；越界或无法确认均 beyond-goal。返回 {"scope":"beyond-goal","criterionIndex":null,"sourceQuote":"","reason":""}。',
      {
        goal: task.goal,
        constraints: task.constraints,
        originalRequest: original,
        checklist,
        finding: item,
      },
    );
    if (bound.status !== "completed") {
      item.scope = "beyond-goal";
      change(item, "deferred", "没有取得可核对的范围判断");
      continue;
    }
    const { scope, criterionIndex, sourceQuote, reason } = bound.data;
    const quote = sourceQuote.trim();
    const referenced =
      criterionIndex === null ? undefined : criteria[criterionIndex];
    if (scope === "in-goal" && quote && original.includes(quote)) {
      item.scope = scope;
      item.sourceQuote = quote;
      item.reason = reason;
    } else if (
      scope === "reopen" &&
      referenced?.status === "passed" &&
      referenced.verify.method !== "user" &&
      ((quote && original.includes(quote)) ||
        item.evidence.some(
          (ref) => ref.kind === "criterion" && ref.id === referenced.id,
        ))
    ) {
      item.scope = scope;
      item.criterionId = referenced.id;
      item.reason = reason;
    } else {
      item.scope = "beyond-goal";
      change(item, "deferred", reason || "未取得本次目标授权");
    }
  }
  return confirmed.filter((item) => item.status === "confirmed");
}
