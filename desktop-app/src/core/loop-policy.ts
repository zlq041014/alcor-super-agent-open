import type { Task, Run } from "../shared/contracts";
import type {
  Criterion,
  Loop,
  Check,
  CheckRun,
} from "../shared/loop-contracts";

type Action =
  | {
      kind:
        | "wait"
        | "contract"
        | "run-checks"
        | "check-work"
        | "failed-work"
        | "review"
        | "close";
    }
  | {
      kind: "writer" | "author" | "judge" | "uncheckable" | "diagnose" | "candidates" | "split" | "split-verify" | "advisor";
      criterion: Criterion;
    }
  | { kind: "halt"; reason: NonNullable<Loop["halt"]>["reason"] };

export function loopExpired(loop: Loop, now: number) {
  return (
    now - Date.parse(loop.startedAt) >= loop.budget.limits.wallMinutes * 60000
  );
}

export function decide(
  loop: Loop,
  task: Task,
  criteria: Criterion[],
  checks: Check[],
  run: Run | undefined,
  waitingForCheck: boolean,
  now: number,
): Action {
  if (
    loop.phase === "closed" ||
    loop.phase === "halted" ||
    task.archived ||
    task.state === "paused" ||
    task.state === "cancelled" ||
    waitingForCheck
  )
    return { kind: "wait" };
  if (run?.state === "unknown") return { kind: "halt", reason: "unknown_run" };
  if (run && run.state !== "ended") return { kind: "wait" };
  if (loopExpired(loop, now)) return { kind: "halt", reason: "budget" };
  if (loop.phase === "contracting") return { kind: "contract" };
  if (loop.phase === "reviewing") return { kind: "review" };
  if (loop.step?.kind === "execute") {
    if (!loop.step.runId) {
      if (loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns)
        return { kind: "halt", reason: "budget" };
      return { kind: "wait" };
    }
    return {
      kind: run?.outcome === "completed" ? "check-work" : "failed-work",
    };
  }
  if (
    loop.phase === "baseline" ||
    loop.phase === "closing" ||
    loop.step?.kind === "check"
  )
    return { kind: "run-checks" };
  if (loop.blockedStreak >= 3) return { kind: "halt", reason: "no_progress" };
  const eligible = criteria.filter(
    (c) =>
      ["pending", "stale", "failed"].includes(c.status) &&
      c.verify.method !== "user" &&
      c.dependsOn.every((id) =>
        criteria.some((dep) => dep.id === id && dep.status === "passed"),
      ),
  );
  const current = eligible.find((c) => c.status === "stale") ?? eligible[0];
  if (current) {
    if (current.escalation?.stage === "candidates") return { kind: "candidates", criterion: current };
    if (current.escalation?.stage === "split") return { kind: "split", criterion: current };
    if (current.escalation?.stage === "advisor") return { kind: "advisor", criterion: current };
    if (current.escalation?.stage === "split-parent") return { kind: "split-verify", criterion: current };
    if (current.escalation?.stage === "diagnose")
      return loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns
        ? { kind: "halt", reason: "budget" }
        : { kind: "diagnose", criterion: current };
    if (
      current.author &&
      !current.author.path &&
      !current.author.reason &&
      current.verify.method === "command"
    ) {
      if (loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns)
        return { kind: "halt", reason: "budget" };
      return { kind: "author", criterion: current };
    }
    if (current.verify.method === "judge" && !current.judgedInitial)
      return { kind: "judge", criterion: current };
    if (
      current.verify.method !== "judge" &&
      !checks.some(
        (c) =>
          c.status === "authorized" && current.verify.checkIds.includes(c.id),
      )
    )
      return { kind: "uncheckable", criterion: current };
    if (loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns)
      return { kind: "halt", reason: "budget" };
    return { kind: "writer", criterion: current };
  }
  if (loop.roster.advisor && loop.budget.spent.executorRuns < loop.budget.limits.executorRuns &&
      loop.budget.spent.roleCalls < loop.budget.limits.roleCalls) {
    const split = criteria.find((c) => c.status === "pending" && c.escalation?.stage === "split-parent" &&
      c.escalation.childIds?.some((id) => criteria.some((child) => child.id === id && child.status === "blocked")) &&
      c.dependsOn.every((id) => c.escalation!.childIds!.includes(id) || criteria.some((row) => row.id === id && row.status === "passed")),
    );
    if (split) return { kind: "advisor", criterion: split };
  }
  if (
    loop.mode === "loop-improve" &&
    (loop.reviewedRounds ?? 0) < loop.budget.limits.improveRounds &&
    loop.budget.spent.roleCalls < loop.budget.limits.roleCalls &&
    criteria.some((item) => item.status === "passed") &&
    criteria.every(
      (item) =>
        item.input.necessity !== "required" ||
        item.status === "passed" ||
        item.status === "waived",
    )
  )
    return { kind: "review" };
  return { kind: "close" };
}

export function nextFailure(
  current: Criterion,
  input: { changed: boolean; failure: NonNullable<Criterion["failure"]> },
  retries: number,
): Criterion {
  const noProgress =
    !input.changed || current.failure?.signature === input.failure.signature
      ? current.noProgress + 1
      : 0;
  const attempts = current.attempts + 1;
  const reason =
    noProgress >= 2
      ? "连续两次没有可验证的进展"
      : attempts > retries
        ? "带证据重试已用尽"
        : undefined;
  return {
    ...current,
    attempts,
    noProgress,
    failure: input.failure,
    passed: undefined,
    status: reason ? "blocked" : "failed",
    blockedReason: reason ? reason + "：" + input.failure.detail : undefined,
  };
}

export function evidenceFor(
  criterion: Criterion,
  checks: Check[],
  latest: Map<string, CheckRun>,
) {
  const targets = checks.filter((check) =>
    criterion.verify.checkIds.includes(check.id),
  );
  const results = targets.map((check) => latest.get(check.id));
  const passed =
    targets.length > 0 &&
    results.every(
      (run, i) =>
        targets[i].status === "authorized" && run?.outcome === "passed",
    );
  return {
    passed,
    ids: results.filter((run): run is CheckRun => !!run).map((run) => run.id),
    failed: results.find(
      (run) => run?.outcome === "failed" || run?.outcome === "timeout",
    ),
    missing: targets
      .filter(
        (check, i) =>
          check.status !== "authorized" ||
          !results[i] ||
          ["environment", "unstable"].includes(results[i]?.outcome || ""),
      )
      .map((check) => check.input.name),
  };
}
