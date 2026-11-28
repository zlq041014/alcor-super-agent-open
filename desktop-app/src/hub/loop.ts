import { randomUUID } from "node:crypto";
import { resultBasis } from "./manual-acceptance";
import {
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Hub } from "./service";
import {
  defaultProfile,
  taskAdvance,
  type Project,
  type Run,
  type Settings,
  type Task,
  type TaskInput,
  type DshUsage,
} from "../shared/contracts";
import {
  CriterionInput,
  LoopBudgetSchema,
  type Candidate,
  type Check,
  type CheckRun,
  type Criterion,
  type CriterionChange,
  type Finding,
  type Loop,
  type LoopAddition,
  type LoopReport,
  type LoopStep,
  type LoopView,
  type NativeLoopNode,
} from "../shared/loop-contracts";
import { overlaps } from "../core/policy";
import {
  decide,
  evidenceFor,
  loopExpired,
  nextFailure,
} from "../core/loop-policy";
import {
  bindCheck,
  discoverChecks,
  type DiscoveredCheck,
} from "./check-discovery";
import {
  checkOutputBlob,
  checkPidAlive,
  failureSignature,
  runCheck,
} from "./checks";
import { entity, stamp } from "./store";
import { hash, redact, within } from "./security";
import { snapshotFiles, workspaceVersion } from "./workspaces";
import {
  authorPath,
  cloneForAuthor,
  confirmedAssertion,
  sameSources,
  sourceDigest,
} from "./check-author";
import { pathKey } from "../core/glob";
import type { Assessment } from "./verification";
import { Contracting } from "./contracting";
import { MissingDshReceipt } from "./dsh-work";
import { protectedPaths } from "./protected-paths";
import { assigned, line, workerId } from "./agent-ledger";
import { collectEvidence } from "./evidence";
import type { ReplayDelivery } from "./miss-replay";
import { reviewFindings } from "./review";
import { triage } from "./triage";
import { diagnose } from "./diagnosis";
import { applyCandidateEdits, candidateDiff, selectCandidate } from "./candidates";
import { candidateEdits, preflightCandidate, prepareCandidates, type CandidateEdit } from "./candidate-workspace";
import { planSplit } from "./split-criterion";

type Input = ReturnType<typeof TaskInput.parse>;
export type PreparedLoop = {
  cfg: Settings;
  checks: DiscoveredCheck[];
  protect: string[];
  requestHash: string;
};
type CheckAdoption = {
  id: string;
  loopId: string;
  revision: number;
  file: string;
  source: string;
  contentHash: string;
  resultId: string;
  failureSignature: string;
  attempts: number;
  state: "copying" | "adopted" | "interrupted";
};
type ReconcileAttempt = {
  id: string;
  attempts: number;
  nextAt: number;
  matched?: boolean;
};
const stopDetails: Record<NonNullable<Loop["halt"]>["reason"], string> = {
  budget: "已达到推进循环预算；可追加预算继续",
  no_progress: "连续三个条目受阻，推进已停止",
  unknown_run: "原生回合或检查进程状态未知；保留工作区占用，不会重派",
  all_blocked: "必需条目还缺少可靠的通过证据",
  restored: "从备份恢复；继续前请核对工作区",
  cancelled: "已取消推进循环",
};
export class LoopEngine {
  private driving = new Map<string, Promise<void>>();
  private checking = new Map<
    string,
    { path: string; abort: AbortController }
  >();
  private contracting: Contracting;

  constructor(private hub: Hub) {
    this.contracting = new Contracting(hub);
  }
  get journal() {
    return this.hub.journal;
  }
  private get store() {
    return this.hub.store;
  }
  accountUsage(loopId: string, usage: DshUsage) {
    const loop = this.loadLoop(loopId)!;
    loop.budget.spent.tokensKnown += usage.tokensKnown;
    loop.budget.spent.unknownUsageCalls +=
      usage.requests - usage.knownRequests - 1;
    this.put(loop);
  }
  private rows<T>(kind: string, id: string) {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE kind=? AND json_extract(data,'$.loopId')=? ORDER BY updated,id",
      )
      .all(kind, id)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  private loadLoop(id: string) {
    const loop = this.store.get<Loop>("loop", id);
    if (loop?.nativePlan) {
      const node = this.store.get<NativeLoopNode>("loop-node", loop.nativePlan.nodeId);
      if (!node || node.loopId !== id || node.revision !== loop.contractRevision)
        throw new Error("原生循环缺少匹配修订的成果节点");
      loop.step = node.step;
    }
    return loop;
  }
  forTask(task: Task) {
    return task.loopId ? this.loadLoop(task.loopId) : undefined;
  }
  private criteria(loop: Loop) {
    return this.rows<Criterion>("criterion", loop.id).sort(
      (a, b) => a.order - b.order,
    );
  }
  private checks(loop: Loop) {
    return this.rows<Check>("check", loop.id);
  }
  private put(loop: Loop) {
    loop.updatedAt = stamp();
    if (!loop.nativePlan) {
      this.store.put("loop", loop);
      return;
    }
    const { step, ...parent } = loop;
    const node: NativeLoopNode = {
      id: loop.nativePlan.nodeId,
      loopId: loop.id,
      revision: loop.contractRevision,
      createdAt: loop.createdAt,
      updatedAt: loop.updatedAt,
      step: step!,
    };
    const persist = () => {
      this.store.put("loop", parent);
      this.store.put("loop-node", node);
    };
    if (this.store.db.isTransaction) persist();
    else this.store.tx(persist);
  }
  private step(
    loop: Loop,
    kind: LoopStep["kind"],
    criterion?: Criterion,
    runId?: string,
  ): LoopStep {
    const attempt =
      loop.budget.spent.executorRuns + (kind === "execute" ? 1 : 0);
    return {
      id: hash(
        JSON.stringify([
          loop.id,
          loop.contractRevision,
          kind,
          criterion?.id,
          attempt,
          ...(kind === "review" ? [loop.reviewedRounds ?? 0] : []),
        ]),
      ),
      kind,
      attempt,
      criterionId: criterion?.id,
      runId,
      state: "pending",
    };
  }

  async prepare(
    project: Project,
    input: Input,
    cfg: Settings,
    requestHash: string,
  ): Promise<PreparedLoop> {
    if ((await realpath(project.path)) !== project.path)
      throw new Error("项目目录基线已变化，请重新绑定");
    if (taskAdvance(input, cfg) === "loop-native")
      return { cfg, checks: [], protect: input.protect ?? [], requestHash };
    if ((input.criteria?.length || 0) > cfg.loopBudget.criteria)
      throw new Error("清单超过条目预算");
    if (input.checks.length) throw new Error("循环请使用自己的文件或命令检查");
    const [discovered, user, protect] = await Promise.all([
      discoverChecks(project.path),
      Promise.all(
        (input.loopChecks || []).map((check) =>
          bindCheck(project.path, check, "user"),
        ),
      ),
      protectedPaths(project.path, input.protect || []),
    ]);
    const wanted = input.selectedChecks;
    if (
      wanted?.some(
        (name) =>
          !discovered.some((c) => c.input.name === name && c.policy.allowed),
      )
    )
      throw new Error("有检查入口已变更，请刷新检查列表");
    const checks = [
      ...discovered.filter(
        (c) => !wanted || !c.policy.allowed || wanted.includes(c.input.name),
      ),
      ...user,
    ];
    const names = new Set<string>();
    for (const check of checks) {
      if (names.has(check.input.name))
        throw new Error("检查名称重复：" + check.input.name);
      names.add(check.input.name);
    }
    return { cfg, checks, protect, requestHash };
  }
  create(task: Task, input: Input, prepared: PreparedLoop) {
    const { cfg } = prepared;
    const mode = task.advance as Loop["mode"];
    const native = mode === "loop-native";
    const needsPlanning = !input.criteria?.length && !input.loopChecks?.length;
    const profile = defaultProfile(cfg);
    const loop: Loop = {
      ...entity(),
      id: task.loopId!,
      taskId: task.id,
      projectId: task.projectId,
      mode,
      phase: native ? "advancing" : needsPlanning ? "contracting" : "baseline",
      contractRevision: 1,
      roster: native ? { executor: profile, verifier: profile } : {
        executor: profile,
        verifier: profile,
        planner: profile,
        critic: profile,
        ...(cfg.advisorModel ? { advisor: { ...profile, model: cfg.advisorModel } } : {}),
      },
      closeMode: cfg.loopCloseMode,
      startedAt: stamp(),
      protectedPaths: prepared.protect,
      blockedStreak: 0,
      rejectedWrites: 0,
      assumptions: [],
      ...(native ? {
        nativePlan: { version: 1 as const, nodeId: randomUUID() },
        nativeBrief: {
          criteria: input.criteria ?? [],
          checks: [
            ...(input.loopChecks ?? []),
            ...input.checks.map((check) => ({
              kind: "file" as const, name: check.path, ...check,
            })),
          ],
        },
      } : {}),
      budget: {
        limits: cfg.loopBudget,
        spent: {
          executorRuns: 0,
          roleCalls: 0,
          tokensKnown: 0,
          unknownUsageCalls: 0,
        },
      },
    };
    loop.step = this.step(loop, native ? "execute" : needsPlanning ? "contract" : "baseline");
    const checks: Check[] = prepared.checks.map(
      ({ input, origin, policy, bindingHash }) => ({
        ...entity(),
        loopId: loop.id,
        projectId: task.projectId,
        input,
        origin,
        bindingHash,
        status: policy.allowed ? "authorized" : "rejected",
        policyRule: policy.rule,
      }),
    );
    for (const check of checks) {
      this.store.put("check", check);
      this.store.event("check." + check.status, check.id, {
        loopId: loop.id,
        rule: check.policyRule,
      });
    }
    const entries = native || needsPlanning
      ? []
      : input.criteria?.length
        ? input.criteria
        : [
            CriterionInput.parse({
              title: "完成用户目标",
              detail: input.acceptance,
            }),
          ];
    entries.forEach((entry, index) =>
      this.store.put(
        "criterion",
        this.makeCriterion(
          loop,
          entry,
          checks,
          index,
          undefined,
          !input.criteria?.length,
        ),
      ),
    );
    this.put(loop);
    this.store.event("loop.created", loop.id, {
      taskId: task.id,
      mode: loop.mode,
    });
  }
  private makeCriterion(
    loop: Loop,
    input: CriterionInput,
    checks: Check[],
    order: number,
    id?: string,
    implicit = false,
  ): Criterion {
    if (
      input.checks.some(
        (name) => !checks.some((check) => check.input.name === name),
      )
    )
      throw new Error("清单引用了不存在的检查：" + input.title);
    const method = input.method;
    const checkIds =
      method === "judge" || method === "user"
        ? checks
            .filter(
              (check) =>
                method === "judge" &&
                input.checks.includes(check.input.name) &&
                check.status === "authorized",
            )
            .map((check) => check.id)
        : checks
            .filter((c) =>
              input.checks.length
                ? input.checks.includes(c.input.name)
                : c.status === "authorized" &&
                  (implicit || c.input.kind === method),
            )
            .map((c) => c.id);
    return {
      ...entity(),
      ...(id ? { id } : {}),
      loopId: loop.id,
      order,
      input,
      verify: { method, checkIds },
      dependsOn: [],
      definitionHash: hash(JSON.stringify([input, checkIds])),
      status: "pending",
      attempts: 0,
      noProgress: 0,
      ...(input.needsAuthoredCheck ? { author: { attempts: 0 } } : {}),
      ...(implicit ? { implicit: true } : {}),
    };
  }

  view(task: Task): LoopView {
    const loop = this.forTask(task);
    if (!loop) throw new Error("该任务没有推进循环");
    return {
      loop,
      checks: this.checks(loop),
      criteria: this.criteria(loop),
      checkRuns: this.rows<CheckRun>("check-run", loop.id).slice(-300),
      findings: this.rows<Finding>("finding", loop.id),
      candidates: this.rows<Candidate>("candidate", loop.id),
    };
  }
  async output(id: string) {
    const run = this.store.get<CheckRun>("check-run", id);
    if (!run || !run.outputRef || !/^[a-f0-9]{64}$/.test(run.outputRef))
      throw new Error("该检查没有可读的输出");
    return readFile(join(this.hub.dir, "blobs", run.outputRef), "utf8");
  }
  private unresolvedChecks() {
    return this.store
      .all<CheckRun>("check-run")
      .filter(
        (r) =>
          r.state === "unknown" &&
          this.store.get<Check>("check", r.checkId)?.input.kind === "command" &&
          (r.guarded
            ? r.pid !== undefined && checkPidAlive(r.pid)
            : process.platform === "win32" ||
              r.pid === undefined ||
              checkPidAlive(r.pid)),
      );
  }
  busyPaths() {
    const unresolved = this.unresolvedChecks()
      .map((r) => {
        const loop = this.store.get<Loop>("loop", r.loopId);
        return loop
          ? this.store.get<Project>("project", loop.projectId)?.path
          : undefined;
      })
      .filter((path): path is string => !!path);
    return [...this.checking.values()].map((c) => c.path).concat(unresolved);
  }
  busy(task?: Task) {
    return task
      ? !!task.loopId &&
          (this.checking.has(task.loopId) ||
            this.unresolvedChecks().some((run) => run.loopId === task.loopId))
      : this.checking.size > 0 || this.unresolvedChecks().length > 0;
  }
  private releaseCheckWorkspace(loop: Loop, task: Task) {
    this.checking.delete(loop.id);
    const current = this.hub.getTask(task.id);
    if (
      current.state === "paused" &&
      current.control === "pause_requested" &&
      !this.busy(current)
    )
      this.hub.saveTask({ ...current, control: "confirmed" });
    this.hub.changed();
  }
  recover() {
    for (const data of this.store.all<CheckRun>("check-run"))
      if (data.state === "running")
        this.store.put("check-run", {
          ...data,
          updatedAt: stamp(),
          state: "unknown",
        });
    for (const candidate of this.store.all<Candidate>("candidate"))
      if (candidate.status === "running" || candidate.status === "integrating")
        this.store.put("candidate", { ...candidate, status: "unknown", reason: "候选或整合的回执中断，未自动重派", updatedAt: stamp() });
  }
  tick() {
    for (const loop of this.store.all<Loop>("loop")) {
      if (loop.phase === "halted" || loop.phase === "closed") continue;
      const task = this.hub.getTask(loop.taskId);
      const run = task.runId
        ? this.store.get<Run>("run", task.runId)
        : undefined;
      if (
        loopExpired(loop, Date.now()) &&
        run &&
        run.state !== "unknown" &&
        run.state !== "ended"
      ) {
        if (task.state === "active" && !task.control?.endsWith("_requested"))
          void this.hub.stopLoopRun(task, run).catch((e) => this.fault(e));
      }
      this.advance(loop.id);
    }
  }
  private fault(e: unknown) {
    this.hub.fault(
      "推进循环保存或恢复失败：" + redact((e as Error).message).slice(0, 250),
    );
  }
  advance(id: string) {
    if (this.driving.has(id) || this.hub.shuttingDown) return;
    const job = this.drive(id)
      .catch((e) => this.fault(e))
      .finally(() => this.driving.delete(id));
    this.driving.set(id, job);
  }
  wantsWriter(task: Task) {
    const loop = this.forTask(task);
    return (
      loop?.phase === "advancing" &&
      loop.step?.kind === "execute" &&
      loop.step.state === "pending" &&
      loop.budget.spent.executorRuns < loop.budget.limits.executorRuns &&
      !loopExpired(loop, Date.now())
    );
  }
  writerStarted(task: Task, run: Run) {
    const loop = this.forTask(task)!;
    if (!this.wantsWriter(task)) throw new Error("写入步骤已变化");
    loop.step = { ...loop.step!, runId: run.id, state: "running" };
    if (loop.mode === "loop-native") {
      loop.step.supplementsAtStart = loop.step.supplements?.length ?? 0;
      if (loop.step.review) run.loopRole = "reviewer";
      if (loop.nativePlan)
        run.nativeAttempt = { nodeId: loop.nativePlan.nodeId, stepId: loop.step.id };
    }
    if (loop.step.fresh) {
      const criterion = this.store.get<Criterion>("criterion", loop.step.criterionId!)!;
      this.store.put("criterion", {
        ...criterion, escalation: { ...criterion.escalation,
          stage: criterion.escalation?.stage === "advisor-ready" ? "advisor-attempted" : "attempted",
        }, updatedAt: stamp(),
      });
    }
    loop.budget.spent.executorRuns++;
    loop.budget.spent.unknownUsageCalls++;
    this.put(loop);
  }
  // Used by startup recovery inside the transaction that voids a prepared command.
  recoverUnsent(task: Task, run: Run) {
    if (!run.nativeAttempt) return false;
    const loop = this.forTask(task)!;
    loop.budget.spent.executorRuns--;
    loop.budget.spent.unknownUsageCalls--;
    if (this.ownsNativeRun(loop, run)) {
      loop.step = {
        ...loop.step!,
        state: "pending",
        runId: undefined,
        supplementsAtStart: undefined,
      };
    }
    this.put(loop);
    this.store.event("loop.unsent-recovered", run.id, {
      nodeId: run.nativeAttempt.nodeId,
      stepId: run.nativeAttempt.stepId,
    });
    return task.state === "active" && task.runId === run.id;
  }
  private ownsNativeRun(loop: Loop, run: Run) {
    return loop.step?.runId === run.id &&
      (!loop.nativePlan || (run.nativeAttempt?.nodeId === loop.nativePlan.nodeId &&
        run.nativeAttempt.stepId === loop.step.id));
  }
  recoveredNativeReceipt(task: Task, run: Run) {
    if (!run.nativeAttempt || task.runId !== run.id ||
        task.state === "paused" || task.state === "cancelled") return;
    const loop = this.forTask(task)!;
    if (loop.halt?.reason !== "unknown_run") return;
    loop.halt = undefined;
    loop.report = undefined;
    loop.phase = "advancing";
    this.put(loop);
  }
  writerOptions(task: Task, run: Run) {
    const loop = this.forTask(task)!;
    if (loop.mode === "loop-native") return { fresh: loop.step?.review === true };
    return {
      fresh: loop.step?.fresh === true,
      paths: { protect: loop.protectedPaths, lockPackageScripts: true },
      journal: {
        ...this.journal.sink(run, loop.id, loop.step!.criterionId!, () => {
          if (
            !this.writerActive(task, run) ||
            this.hub.getTask(task.id).state !== "active" ||
            this.hub.shuttingDown
          )
            throw new Error("执行回合已停止，未写入工作区");
        }),
        rejected: (path: string, reason: string) => {
          const current = this.forTask(task)!;
          current.rejectedWrites++;
          this.put(current);
          const id = entity().id;
          this.store.event("write.rejected", loop.id, {
            runId: run.id,
            path: redact(path),
            reason,
          });
          line(
            this.store,
            workerId(task.id),
            "tool",
            "拒绝修改验收依据",
            redact(path) + " · " + reason,
            {
              groupId: run.id,
              runId: run.id,
              work: {
                id,
                at: stamp(),
                title: "拒绝修改验收依据",
                kind: "file",
                state: "failed",
                detail: redact(path) + " · " + reason,
              },
            },
          );
          this.hub.changed();
        },
      },
    };
  }
  writerActive(task: Task, run: Run) {
    const loop = this.forTask(task);
    return (
      loop?.step?.kind === "execute" &&
      this.ownsNativeRun(loop, run) &&
      loop.phase === "advancing" &&
      this.hub.getTask(task.id).control !== "pause_requested"
    );
  }
  async writerSection(task: Task) {
    const loop = this.forTask(task)!;
    if (loop.mode === "loop-native") {
      const step = loop.step!;
      const previous = step.previousRunId ? this.store.get<Run>("run", step.previousRunId) : undefined;
      return {
        role: step.review ? "独立复核" : "执行",
        instruction: step.review
          ? "在项目中实际检查交付，对照用户目标和验收要求给出证据、遗留问题及下一步。可使用原生工具。可自由叙述；最后一行若明确，写「建议收口」「建议继续」或「建议人工验收」。只有实际核对并符合目标才建议收口。"
          : "直接推进用户目标，自主选择做法和原生工具。若有上一轮复核，处理其中与目标有关的问题。交代实际交付、验证和剩余问题，可用自然语言。",
        authorization: "按用户要求操作。未获明确授权不得发布、推送或写入项目之外；勿改动用户要求保护的路径。",
        protected: loop.protectedPaths,
        guidance: loop.nativeBrief,
        supplements: step.supplements,
        previous: previous?.response,
        failure: undefined,
      };
    }
    const criteria = this.criteria(loop);
    const c = criteria.find((row) => row.id === loop.step?.criterionId)!;
    const failure = c.failure;
    const result = failure?.checkRunId
      ? this.store.get<CheckRun>("check-run", failure.checkRunId)
      : undefined;
    return {
      criterion: {
        title: c.input.title,
        detail: c.input.detail,
        attempt: c.attempts + 1,
      },
      checks: this.checks(loop)
        .filter((check) => c.verify.checkIds.includes(check.id))
        .map((check) => this.describe(check.input)),
      passed: criteria
        .filter((x) => x.status === "passed")
        .slice(-15)
        .map((x) => x.input.title),
      protected: [
        ...loop.protectedPaths.slice(0, 30),
        "package.json 的 scripts",
      ],
      authoredTest: c.author?.path,
      supplements: loop.step?.supplements,
      ...(loop.step?.fresh ? {
        diagnosis: c.escalation?.stage === "advisor-attempted" ? c.escalation.advisor : c.escalation?.diagnosis?.approaches[0],
      } : {}),
      failure: failure
        ? {
            detail: failure.detail,
            exitCode: result?.exitCode,
            outputTail: result?.outputRef
              ? (await this.output(result.id)).slice(-3600)
              : undefined,
          }
        : undefined,
      rules: [
        "只实现当前条目，不处理其他条目。保留已有验收检查。",
        "如认为检查有误，请在最终答复中另起一行，以“检查异议：”开头说明理由。",
        "不要声称已通过检查；检查由系统运行。",
      ],
    };
  }
  supplement(task: Task, text: string) {
    const loop = this.forTask(task)!;
    if (loop.mode === "loop-native" && loop.step && loop.phase === "advancing") {
      loop.step.supplements = [...(loop.step.supplements ?? []), redact(text)];
      this.put(loop);
      return;
    }
    if (!loop.step?.criterionId || ["closed", "halted"].includes(loop.phase))
      throw new Error("当前没有执行条目，可在循环清单更改要求");
    loop.step.supplements = [
      ...(loop.step.supplements || []),
      redact(text).slice(0, 1200),
    ].slice(-3);
    const c = this.store.get<Criterion>("criterion", loop.step.criterionId)!;
    this.store.put("criterion", { ...c, supplements: loop.step.supplements });
    this.put(loop);
  }
  control(task: Task, action: "pause" | "cancel" | "resume") {
    const loop = this.forTask(task)!;
    if (action !== "resume") this.checking.get(loop.id)?.abort.abort();
    const run = task.runId ? this.store.get<Run>("run", task.runId) : undefined;
    if (
      action === "cancel" &&
      !this.busy(task) &&
      (!run || run.state === "ended")
    )
      this.finish(loop, task, "cancelled");
    if (action === "resume") {
      this.store.tx(() => this.resumeState(task));
      this.advance(loop.id);
    }
  }
  resumeState(task: Task) {
    const loop = this.forTask(task)!;
    const priorHalt = loop.halt?.reason;
    if (loop.halt) {
      const reason = loop.halt.reason;
      loop.halt = undefined;
      loop.report = undefined;
      loop.phase =
        loop.step?.kind === "contract"
          ? "contracting"
          : loop.step?.kind === "baseline"
            ? "baseline"
            : "advancing";
      if (reason !== "unknown_run" && reason !== "budget") {
        for (const c of this.criteria(loop).filter((c) => c.status === "blocked"))
          this.store.put("criterion", {
            ...c,
            ...this.clearSplit(c),
            status: "pending",
            attempts: 0,
            noProgress: 0,
            failedAttempts: undefined,
            escalation: undefined,
            blockedReason: undefined,
          });
        loop.blockedStreak = 0;
      }
    }
    if (
      loop.step?.kind === "execute" &&
      loop.step.runId &&
      (this.store.get<Run>("run", loop.step.runId)?.outcome === "interrupted" ||
        (loop.mode === "loop-native" && priorHalt === "all_blocked"))
    ) {
      if (loop.mode === "loop-native") {
        this.queueNative(loop, task, loop.step.review, loop.step.previousRunId);
        return;
      }
      const c = this.store.get<Criterion>("criterion", loop.step.criterionId!)!;
      this.store.put("criterion", { ...c, status: "pending" });
      loop.step = undefined;
    }
    this.put(loop);
  }
  async shutdown() {
    for (const c of this.checking.values()) c.abort.abort();
    await Promise.all(this.driving.values());
  }

  async revise(task: Task, revision: number, changes: CriterionChange[]) {
    const loop = this.forTask(task);
    if (!loop || task.archived || task.state === "cancelled")
      throw new Error("该任务的循环不能再修订");
    if (loop.mode === "loop-native")
      throw new Error("原生循环请通过「修改要求」更新目标和验收要求");
    if (revision !== loop.contractRevision)
      throw new Error("清单已更新，刷新后再修改");
    const criteria = this.criteria(loop),
      checks = this.checks(loop);
    let order = criteria.at(-1)?.order ?? -1;
    const touched = new Set<string>();
    this.store.tx(() => {
      for (const change of changes) {
        if (change.action === "add") {
          if (++order >= loop.budget.limits.criteria)
            throw new Error("清单条目预算已用尽");
          const c = this.makeCriterion(loop, change.value, checks, order);
          this.store.put("criterion", c);
          touched.add(c.id);
          continue;
        }
        const old = this.store.get<Criterion>("criterion", change.id);
        if (!old || old.loopId !== loop.id || touched.has(old.id))
          throw new Error("条目不存在或重复修订");
        const dependencies = this.clearSplit(old).dependsOn;
        const c =
          change.action === "edit"
            ? {
                ...this.makeCriterion(
                  loop,
                  change.value,
                  checks,
                  old.order,
                  old.id,
                ),
                createdAt: old.createdAt,
                dependsOn: dependencies,
                splitFrom: old.splitFrom,
                findingIds: old.findingIds,
              }
            : {
                ...old,
                dependsOn: dependencies,
                status: change.action === "waive" ? "waived" : "pending",
                attempts: 0,
                noProgress: 0,
                failure: undefined,
                failedAttempts: undefined,
                escalation: undefined,
                passed: undefined,
                blockedReason: undefined,
              };
        touched.add(old.id);
        this.store.put("criterion", c);
        if (change.action === "waive")
          for (const id of old.findingIds ?? []) {
            const finding = this.store.get<Finding>("finding", id)!;
            this.store.put("finding", {
              ...finding,
              status: "declined",
              reason: "用户豁免了对应条目",
              updatedAt: stamp(),
            });
          }
      }
      for (const c of criteria) {
        if (
          !touched.has(c.id) &&
          (c.status === "in_progress" ||
            c.dependsOn.some((id) => touched.has(id)))
        ) {
          touched.add(c.id);
          this.store.put("criterion", {
            ...c,
            status: "stale",
            passed: undefined,
          });
        }
      }
      this.revisionChanged(loop, task);
    });
    await this.afterRevision(task);
    return this.view(this.hub.getTask(task.id));
  }
  private revisionChanged(loop: Loop, task: Task) {
    loop.contractRevision++;
    if (loop.mode === "loop-native") {
      loop.phase = "advancing";
      loop.step = this.step(loop, "execute");
    } else if (loop.phase === "contracting" || loop.step?.kind === "contract") {
      loop.phase = this.criteria(loop).length ? "baseline" : "contracting";
      loop.step = this.step(
        loop,
        loop.phase === "baseline" ? "baseline" : "contract",
      );
    } else if (loop.phase === "baseline" || loop.step?.kind === "baseline") {
      loop.phase = "baseline";
      loop.step = this.step(loop, "baseline");
    } else {
      loop.phase = "advancing";
      loop.step = undefined;
    }
    loop.report = undefined;
    loop.halt = undefined;
    loop.blockedStreak = 0;
    this.put(loop);
    this.store.event("loop.revised", loop.id, {
      revision: loop.contractRevision,
    });
    this.hub.saveTask(
      { ...task, reason: "清单已更新" },
      ["active", "paused"].includes(task.state)
        ? undefined
        : task.state === "draft"
          ? "draft"
          : "ready",
    );
  }
  private clearSplit(criterion: Criterion) {
    const children = criterion.escalation?.childIds ?? [];
    for (const id of children) {
      const child = this.store.get<Criterion>("criterion", id)!;
      this.store.put("criterion", { ...child, status: "waived", updatedAt: stamp() });
    }
    return { dependsOn: criterion.dependsOn.filter((id) => !children.includes(id)) };
  }
  intentChanged(task: Task) {
    const loop = this.forTask(task)!;
    for (const c of this.criteria(loop)) {
      if (c.status === "waived" || c.splitFrom) continue;
      const input = c.implicit
        ? { ...c.input, detail: task.acceptance }
        : c.input;
      this.store.put("criterion", {
        ...c,
        ...this.clearSplit(c),
        status: "pending",
        passed: undefined,
        failure: undefined,
        failedAttempts: undefined,
        escalation: undefined,
        blockedReason: undefined,
        attempts: 0,
        noProgress: 0,
        input,
        definitionHash: hash(JSON.stringify([input, c.verify.checkIds])),
      });
    }
    this.revisionChanged(loop, task);
  }
  async afterRevision(task: Task) {
    this.checking.get(task.loopId!)?.abort.abort();
    const run = task.runId ? this.store.get<Run>("run", task.runId) : undefined;
    if (run && run.state !== "ended" && run.state !== "unknown")
      await this.hub.stopLoopRun(this.hub.getTask(task.id), run);
    this.hub.changed();
    this.advance(task.loopId!);
  }
  addBudget(task: Task, add: LoopAddition) {
    const loop = this.forTask(task);
    if (
      !loop ||
      task.archived ||
      task.state === "cancelled" ||
      loop.phase === "closed"
    )
      throw new Error("不能追加此任务的预算");
    loop.budget.limits = LoopBudgetSchema.parse({
      ...loop.budget.limits,
      executorRuns: loop.budget.limits.executorRuns + (add.executorRuns || 0),
      wallMinutes: loop.budget.limits.wallMinutes + (add.wallMinutes || 0),
    });
    this.put(loop);
    if (
      loop.halt?.reason === "budget" &&
      task.state === "blocked" &&
      !loopExpired(loop, Date.now())
    ) {
      this.hub.saveTask(task, "ready");
      this.control(task, "resume");
    }
    this.hub.changed();
    return this.view(this.hub.getTask(task.id));
  }

  private queueNative(loop: Loop, task: Task, review?: boolean, previousRunId?: string) {
    loop.step = {
      ...this.step(loop, "execute"),
      review,
      previousRunId,
      supplements: loop.step?.supplements,
    };
    const persist = () => {
      this.put(loop);
      this.hub.saveTask({
        ...task,
        reason: review ? "等待启动独立复核 Agent" : "等待启动执行 Agent",
      }, "ready");
    };
    if (this.store.db.isTransaction) persist();
    else this.store.tx(persist);
    this.hub.changed();
  }

  private async driveNative(loop: Loop, task: Task, run: Run | undefined) {
    if (loop.phase !== "advancing" || task.state === "paused") return;
    if (task.state === "cancelled") {
      if (!run || run.state === "ended") this.finish(loop, task, "cancelled");
      return;
    }
    if (run?.state === "unknown") {
      const receipt = run.threadId ? await this.reconcileUnknown(task, run) : "exhausted";
      if (receipt === "exhausted") {
        const current = this.hub.getTask(task.id);
        if (!this.hub.shuttingDown && current.state !== "paused" && current.state !== "cancelled")
          this.finish(this.forTask(current)!, current, "unknown_run");
      }
      return;
    }
    if (run && run.state !== "ended") return;
    const step = loop.step!;
    if (step.state === "pending") {
      if (loopExpired(loop, Date.now()) || loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns)
        this.finish(loop, task, "budget");
      else if (loop.nativePlan && task.state === "blocked" && run && run.revision !== task.revision) {
        this.hub.saveTask({ ...task, reason: "旧回合已核对，等待按新要求推进" }, "ready");
        this.hub.changed();
      }
      return;
    }
    if (!run || !this.ownsNativeRun(loop, run)) throw new Error("原生循环缺少当前节点的回合记录");
    if (run.outcome !== "completed") {
      this.finish(loop, task, "all_blocked", undefined, task.reason || "原生回合未正常结束，已保留工作记录");
      return;
    }
    const decision = run.response.trim().split(/\r?\n/).at(-1)
      ?.replaceAll("**", "").replace(/^[\s>\-]+|[。.!！\s]+$/g, "");
    if (step.review && (step.supplements?.length ?? 0) === step.supplementsAtStart &&
        (decision === "建议收口" || decision === "建议人工验收")) {
      const manual = decision === "建议人工验收" || loop.closeMode === "review-judged";
      const workspace = manual ? await workspaceVersion(run.workPath) : undefined;
      const current = this.hub.getTask(task.id);
      const saved = this.forTask(current)!;
      if (!this.hub.shuttingDown && saved.phase === "advancing" &&
          this.ownsNativeRun(saved, run) && current.state === "verifying" &&
          (saved.step!.supplements?.length ?? 0) === step.supplementsAtStart)
        this.finish(saved, current, undefined, workspace && { version: workspace.version, limited: workspace.truncated }, undefined, false, false, undefined, manual);
      return;
    }
    this.queueNative(loop, task, !step.review, run.id);
  }

  private async drive(id: string) {
    while (!this.hub.shuttingDown) {
      const loop = this.loadLoop(id)!;
      const task = this.hub.getTask(loop.taskId);
      const run = task.runId
        ? this.store.get<Run>("run", task.runId)
        : undefined;
      if (loop.mode === "loop-native") return this.driveNative(loop, task, run);
      const criteria = this.criteria(loop),
        checks = this.checks(loop);
      const c = criteria.find((item) => item.id === loop.step?.criterionId);
      const unknownCheck = this.unresolvedChecks().some(
        (row) => row.loopId === id,
      );
      if (
        unknownCheck &&
        loop.phase !== "halted" &&
        loop.phase !== "closed" &&
        task.state !== "paused"
      ) {
        if (task.state === "cancelled" || loopExpired(loop, Date.now()))
          this.finish(
            loop,
            task,
            task.state === "cancelled" ? "cancelled" : "unknown_run",
          );
        return;
      }
      if (
        task.state === "cancelled" &&
        loop.phase !== "halted" &&
        (!run || run.state === "ended")
      ) {
        this.finish(loop, task, "cancelled");
        return;
      }
      const pending = criteria.find((item) => item.rollbackPending);
      if (
        pending &&
        (!run || run.state === "ended") &&
        task.state !== "paused" &&
        !unknownCheck
      ) {
        if (!this.rollbackCriterion(loop, task, pending.id)) return;
        this.store.put("criterion", { ...pending, rollbackPending: false });
        continue;
      }
      const action = decide(
        loop,
        task,
        criteria,
        checks,
        run,
        false,
        Date.now(),
      );
      if (action.kind === "wait") return;
      if (action.kind === "halt") {
        if (
          action.reason === "unknown_run" &&
          run?.backend === "dsh" &&
          run.state === "unknown" &&
          run.threadId
        ) {
          const receipt = await this.reconcileUnknown(task, run);
          if (receipt === "matched") continue;
          if (receipt === "waiting") return;
          const recent = this.hub.getTask(task.id);
          if (
            recent.state === "paused" ||
            recent.state === "cancelled" ||
            this.hub.shuttingDown
          )
            return;
          this.finish(
            this.store.get<Loop>("loop", loop.id)!,
            recent,
            "unknown_run",
            undefined,
            "自动核对三次仍没有匹配的 DSH 结束记录；继续保留工作区占用，不重派。",
          );
          return;
        }
        if (
          action.reason === "budget" &&
          (!run || run.state === "ended") &&
          !unknownCheck &&
          this.journal.unrestored(loop.id).length &&
          !this.rollbackCriterion(loop, task)
        )
          return;
        this.finish(loop, task, action.reason);
        return;
      }
      if (
        action.kind === "uncheckable" &&
        (await this.hub.verification.available())
      ) {
        const current = this.store.get<Loop>("loop", loop.id)!;
        if (
          current.contractRevision !== loop.contractRevision ||
          ["paused", "cancelled"].includes(this.hub.getTask(task.id).state)
        )
          return;
        this.store.put("criterion", {
          ...action.criterion,
          verify: { method: "judge", checkIds: [] },
          failure: {
            signature: "no-check",
            detail: "缺少可执行的程序检查，转独立评审",
          },
        });
        continue;
      }
      if (
        action.kind === "run-checks" ||
        action.kind === "contract" ||
        action.kind === "author" ||
        action.kind === "judge" ||
        action.kind === "diagnose" ||
        action.kind === "advisor" ||
        action.kind === "candidates" ||
        action.kind === "split" ||
        action.kind === "review"
      ) {
        if (
          !task.dependencies.every(
            (id) => this.hub.getTask(id).state === "done",
          )
        )
          return;
        const project = this.store.get<Project>("project", loop.projectId);
        if (!project || project.removed) {
          this.finish(
            loop,
            task,
            "all_blocked",
            undefined,
            "项目已移除，循环未继续",
          );
          return;
        }
        const taken = this.store
          .all<Run>("run")
          .filter((r) => r.state !== "ended")
          .map((r) => r.workPath);
        if (
          [...taken, ...this.busyPaths(), ...this.hub.workspaceHolds()].some((path) =>
            overlaps(path, project.path),
          )
        )
          return;
        const progressed =
          action.kind === "contract"
            ? await this.establishContract(loop, task, project, checks)
            : action.kind === "review"
              ? await this.improve(loop, task, project, criteria, checks)
              : action.kind === "judge"
                ? await this.judgeFirst(loop, task, project, action.criterion)
                : action.kind === "diagnose" || action.kind === "advisor"
                  ? await this.diagnoseCriterion(loop, task, project, action.criterion, action.kind === "advisor")
                  : action.kind === "candidates"
                    ? await this.tryCandidates(loop, task, project, action.criterion, checks)
                    : action.kind === "split"
                      ? await this.splitCriterion(loop, task, project, action.criterion, checks)
                      : action.kind === "author"
                        ? await this.authorCheck(loop, task, project, action.criterion, checks)
                        : await this.batch(loop, task, project, checks, criteria);
        if (!progressed) return;
        continue;
      }
      this.store.tx(() => {
        if (action.kind === "writer") {
          loop.step = this.step(loop, "execute", action.criterion);
          if (["fresh", "advisor-ready"].includes(action.criterion.escalation?.stage || "")) loop.step.fresh = true;
          loop.step.supplements = action.criterion.supplements;
          this.store.put("criterion", {
            ...action.criterion,
            status: "in_progress",
          });
          const schedulable =
            task.state === "active" ? this.hub.saveTask(task, "blocked") : task;
          this.hub.saveTask(
            {
              ...schedulable,
              reason: "正在等待条目执行：" + action.criterion.input.title,
            },
            "ready",
          );
        } else if (action.kind === "split-verify") {
          loop.step = this.step(loop, "check", action.criterion);
          this.store.put("criterion", { ...action.criterion, status: "in_progress" });
          this.hub.saveTask({ ...task, reason: "正在重新验收原条目：" + action.criterion.input.title }, "verifying");
        } else if (action.kind === "check-work") {
          loop.step = this.step(loop, "check", c, run!.id);
          this.hub.saveTask(
            { ...task, reason: "正在检查：" + c!.input.title },
            "verifying",
          );
        } else if (action.kind === "failed-work") {
          this.fail(loop, c!, run, {
            signature:
              "executor:" + failureSignature(task.reason || "interrupted"),
            detail: (task.reason || "执行回合没有正常结束").slice(0, 1000),
          });
          loop.step = undefined;
        } else if (action.kind === "uncheckable") {
          this.block(
            loop,
            action.criterion,
            action.criterion.verify.method === "judge"
              ? "L0 尚无独立评审判定"
              : "条目没有可用的程序检查",
          );
        } else if (action.kind === "close") {
          loop.phase = "closing";
          loop.step = this.step(loop, "close");
        }
        this.put(loop);
      });
      this.hub.changed();
      if (action.kind === "writer") return;
    }
  }
  private rollbackCriterion(loop: Loop, task: Task, criterionId?: string) {
    const project = this.store.get<Project>("project", loop.projectId);
    if (!project || project.removed) return true;
    const paths = [
      ...this.busyPaths(),
      ...this.hub.workspaceHolds(),
      ...this.store
        .all<Run>("run")
        .filter((run) => run.state !== "ended")
        .map((run) => run.workPath),
    ];
    if (paths.some((path) => overlaps(path, project.path))) return false;
    const result = this.journal.rollback(loop.id, project.path, criterionId);
    const id = entity().id;
    if (result.restored || result.skipped.length) {
      line(
        this.store,
        workerId(task.id),
        "tool",
        "回退在途改动",
        "已恢复 " + result.restored + " 项",
        {
          work: {
            id,
            at: stamp(),
            kind: "file",
            title: "回退在途改动",
            state: result.skipped.length ? "failed" : "done",
            detail:
              "已恢复 " +
              result.restored +
              " 项。" +
              (result.skipped.length
                ? " 保留未能安全回退的文件：" + result.skipped.join("、")
                : ""),
          },
        },
      );
      this.hub.changed();
    }
    return true;
  }
  private async reconcileUnknown(
    task: Task,
    run: Run,
  ): Promise<"matched" | "waiting" | "exhausted"> {
    const old = this.store.get<ReconcileAttempt>("run-reconcile", run.id);
    if (old && old.attempts >= 3) return "exhausted";
    if (old && old.nextAt > Date.now()) return "waiting";
    const attempts = (old?.attempts ?? 0) + 1;
    const record = {
      id: run.id,
      attempts,
      nextAt: Date.now() + (attempts === 1 ? 750 : 2200),
    };
    this.store.put("run-reconcile", record);
    this.hub.saveTask({
      ...task,
      reason: "正在核对未知的 DSH 回合（" + attempts + "/3）",
    });
    this.hub.changed();
    try {
      await this.hub.dsh.reconcile(run);
    } catch (e) {
      if (!(e instanceof MissingDshReceipt)) throw e;
    }
    const matched = this.store.get<Run>("run", run.id)?.state === "ended";
    this.store.put("run-reconcile", { ...record, matched });
    this.store.event("run.reconcile-attempt", run.id, { attempts, matched });
    if (matched) return "matched";
    return attempts >= 3 ? "exhausted" : "waiting";
  }
  private describe(input: Check["input"]) {
    return input.kind === "command"
      ? {
          name: input.name,
          command: [input.program, ...input.args].join(" "),
          cwd: input.cwd,
        }
      : { name: input.name, file: input.path };
  }
  private block(loop: Loop, c: Criterion, reason: string, rollbackPending = this.journal.unrestored(loop.id, c.id).length > 0) {
    this.store.put("criterion", {
      ...c,
      status: "blocked",
      rollbackPending,
      blockedReason: reason,
      passed: undefined,
      updatedAt: stamp(),
    });
    this.store.event("criterion.blocked", c.id, { loopId: loop.id });
    loop.blockedStreak++;
  }
  private fail(
    loop: Loop,
    c: Criterion,
    run: Run | undefined,
    failure: NonNullable<Criterion["failure"]>,
  ) {
    const files = run ? this.store.get("file-check", run.id) : undefined;
    const updated = nextFailure(
      c,
      {
        failure,
        changed: Boolean(files?.changed?.length || files?.deleted?.length),
      },
      loop.budget.limits.retries,
    );
    if (run)
      updated.failedAttempts = [...(c.failedAttempts ?? []), {
        runId: run.id, detail: failure.detail, checkRunId: failure.checkRunId, review: c.review?.detail,
      }].slice(-8);
    if (updated.status === "blocked" && run && !c.escalation &&
        loop.budget.spent.executorRuns < loop.budget.limits.executorRuns) {
      this.store.put("criterion", {
        ...updated, status: "failed", blockedReason: undefined,
        escalation: { stage: "diagnose" }, updatedAt: stamp(),
      });
      this.store.event("criterion.retry-exhausted", c.id, { loopId: loop.id, runId: run.id });
    } else if (c.escalation?.stage === "attempted") {
      if (c.escalation.diagnosis && loop.budget.limits.executorRuns - loop.budget.spent.executorRuns >= 2) {
        this.store.put("criterion", {
          ...updated, status: "failed", blockedReason: undefined,
          escalation: { ...c.escalation, stage: "candidates" }, updatedAt: stamp(),
        });
      } else this.splitOrBlock(loop, updated, "诊断后的新会话仍未通过：" + failure.detail);
    } else if (c.escalation?.stage === "candidate-applied")
      this.splitOrBlock(loop, updated, "整合后复验未通过：" + failure.detail);
    else if (c.escalation?.stage === "split-parent")
      this.adviseOrBlock(loop, updated, "子条目已通过，原条目的检查仍失败：" + failure.detail);
    else if (c.escalation?.stage === "advisor-attempted")
      this.block(loop, updated, "顾问提出的办法仍未通过验收：" + failure.detail);
    else if (updated.status === "blocked") this.block(loop, updated, updated.blockedReason!);
    else {
      this.store.put("criterion", { ...updated, updatedAt: stamp() });
      this.store.event("criterion.failed", c.id, {
        loopId: loop.id,
        attempt: updated.attempts,
      });
    }
  }
  private async diagnoseCriterion(loop: Loop, task: Task, project: Project, criterion: Criterion, advisor = false) {
    if (!this.rollbackCriterion(loop, task, criterion.id)) return false;
    if (this.journal.unrestored(loop.id, criterion.id).length) {
      this.store.tx(() => {
        this.block(loop, criterion, "部分在途改动未能安全回退，未派发新会话", false);
        loop.step = undefined;
        this.put(loop);
      });
      this.hub.changed();
      return true;
    }
    const abort = new AbortController();
    const step = { ...this.step(loop, advisor ? "advisor" : "diagnose", criterion), state: "running" as const };
    this.checking.set(loop.id, { path: project.path, abort });
    this.store.tx(() => {
      loop.step = step;
      this.put(loop);
      this.hub.saveTask({ ...task, reason: (advisor ? "正在请顾问核对条目：" : "正在诊断已用尽重试的条目：") + criterion.input.title });
    });
    this.hub.changed();
    try {
      const before = await workspaceVersion(project.path);
      const result = (await this.hub.verification.available())
        ? await diagnose(this.hub, loop, step, criterion, abort.signal, advisor ? "advisor" : "diagnoser")
        : { status: "budget" as const, reason: "未配置可用的诊断模型" };
      const after = await workspaceVersion(project.path);
      const current = this.store.get<Loop>("loop", loop.id)!;
      const live = this.hub.getTask(task.id);
      if (abort.signal.aborted || this.hub.shuttingDown ||
          current.contractRevision !== loop.contractRevision || current.step?.id !== step.id ||
          current.phase !== "advancing" || ["paused", "cancelled"].includes(live.state) ||
          result.status === "cancelled") return false;
      const skip = before.version !== after.version
        ? "诊断期间工作区变化，未派发新会话"
        : advisor && result.status !== "completed" ? "顾问未提供可用做法：" + result.reason
          : result.status === "budget" ? "普通重试已用尽，且诊断不可用：" + result.reason : undefined;
      if (skip) {
        this.store.tx(() => {
          this.block(current, criterion, skip);
          current.step = undefined;
          this.put(current);
        });
        return true;
      }
      const escalation: NonNullable<Criterion["escalation"]> = result.status === "completed"
        ? advisor ? { ...criterion.escalation, stage: "advisor-ready", childIds: undefined, advisor: {
          ...result.data.approaches[0], invocationId: result.invocationId,
          actualModel: this.store.get("invocation", result.invocationId)?.actualModel,
        } }
          : { stage: "fresh", diagnosis: result.data, invocationId: result.invocationId }
        : { stage: "fresh", fallback: result.reason };
      this.store.tx(() => {
        this.store.put("criterion", { ...criterion, ...(advisor ? this.clearSplit(criterion) : {}),
          status: "failed", escalation, updatedAt: stamp() });
        current.step = undefined;
        this.put(current);
        this.store.event(advisor ? "criterion.advised" : "criterion.diagnosed", criterion.id, {
          loopId: loop.id, invocationId: advisor ? escalation.advisor?.invocationId : escalation.invocationId, fallback: !!escalation.fallback,
        });
      });
      return true;
    } finally {
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private async tryCandidates(loop: Loop, task: Task, project: Project, criterion: Criterion, checks: Check[]) {
    const step = this.step(loop, "candidates", criterion);
    const markBlocked = (reason: string, canSplit = true) => {
      const current = this.store.get<Loop>("loop", loop.id)!;
      this.store.tx(() => {
        if (canSplit) this.splitOrBlock(current, criterion, reason);
        else this.block(current, criterion, reason);
        current.step = undefined;
        this.put(current);
      });
      this.hub.changed();
      return true;
    };
    if (this.rows<Candidate>("candidate", loop.id).some((c) => c.stepId === step.id) ||
        (loop.step?.kind === "candidates" && this.rows<Candidate>("candidate", loop.id).some((c) => c.stepId === loop.step!.id)))
      return markBlocked("并行候选曾中断，保留记录并且不自动重派", false);
    const cfg = this.hub.settings();
    const choices = criterion.escalation!.diagnosis!.approaches.slice(0, Math.min(
      cfg.concurrency, loop.budget.limits.candidates, loop.budget.limits.executorRuns - loop.budget.spent.executorRuns,
    ));
    if (choices.length < 2) return markBlocked("并行候选至少需要两个执行槽和两份预算");
    const suite = checks.filter((check) => check.status === "authorized");
    if (!criterion.verify.checkIds.length || !criterion.verify.checkIds.every((id) => suite.some((check) => check.id === id)))
      return markBlocked("并行候选需要可执行的条目检查");
    const freeSlots = () => cfg.concurrency - this.store.all<Run>("run")
      .filter((r) => r.state === "running" || r.state === "starting").length -
      this.store.all<Candidate>("candidate").filter((c) => c.status === "running").length;
    if (freeSlots() < choices.length || !this.rollbackCriterion(loop, task, criterion.id)) return false;
    if (this.journal.unrestored(loop.id, criterion.id).length)
      return markBlocked("未能安全回退上个回合，未派发并行候选", false);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1,
      Date.parse(loop.startedAt) + loop.budget.limits.wallMinutes * 60000 - Date.now(),
    ))]);
    const valid = () => {
      const current = this.store.get<Loop>("loop", loop.id)!;
      const bound = this.store.get<Project>("project", project.id);
      return !signal.aborted && !this.hub.shuttingDown && current.phase === "advancing" &&
        current.contractRevision === loop.contractRevision &&
        !["paused", "cancelled"].includes(this.hub.getTask(task.id).state) &&
        !!bound && !bound.removed && bound.path === project.path;
    };
    this.checking.set(loop.id, { path: project.path, abort });
    let prepared: Awaited<ReturnType<typeof prepareCandidates>> | undefined;
    try {
      try {
        prepared = await prepareCandidates(project.path, join(this.hub.dir, "candidates"), choices.length);
      } catch (e) {
        return valid() ? markBlocked(redact((e as Error).message)) : false;
      }
      if (!valid() || freeSlots() < choices.length) return false;
      const work = prepared;
      const rows: Candidate[] = choices.map((a) => ({
        ...entity(), loopId: loop.id, criterionId: criterion.id, stepId: step.id, approach: a.title,
        status: "running", checkRunIds: [],
      }));
      this.store.tx(() => {
        const current = this.store.get<Loop>("loop", loop.id)!;
        current.step = { ...step, state: "running" };
        current.budget.spent.executorRuns += rows.length;
        current.budget.spent.unknownUsageCalls += rows.length;
        for (const row of rows) this.store.put("candidate", row);
        this.put(current);
        this.hub.saveTask({ ...this.hub.getTask(task.id), reason: "正在隔离验证 " + rows.length + " 个候选" });
      });
      this.hub.changed();
      const evaluated = await Promise.allSettled(rows.map(async (row, i) => {
        const path = work.paths[i];
        const output = await this.hub.candidateWriter.write(loop, task, criterion, row, path, choices[i], signal, (name, reason) => {
          const current = this.store.get<Loop>("loop", loop.id)!;
          current.rejectedWrites++;
          this.put(current);
          this.store.event("write.rejected", loop.id, { candidateId: row.id, path: redact(name), reason });
        });
        row.threadId = output.threadId;
        if (output.usage) this.accountUsage(loop.id, output.usage);
        if (!valid() || output.reason !== "end_turn" || !output.accepted)
          throw new Error("候选没有正常结束的原生回执");
        const edits = await candidateEdits(path, work.files, output.touched);
        if (!edits.length) throw new Error("候选没有可核对的改动");
        const patch = candidateDiff(edits);
        row.diff = patch.diff;
        row.changedLines = patch.changedLines;
        const before = await workspaceVersion(path);
        if (before.truncated) throw new Error("候选文件超出可核对范围");
        for (const check of suite) {
          if (!valid()) throw new Error("候选验证已停止");
          const bound = await bindCheck(path, check.input, check.origin === "existing" ? "existing" : "user");
          if (!bound.policy.allowed || bound.bindingHash !== check.bindingHash)
            throw new Error("候选改变了已授权检查的入口：" + check.input.name);
          const receipt = await this.executeCheck(loop, task, check, step, "candidate", before.version, path, signal);
          row.checkRunIds.push(receipt.id);
        }
        if (!(row.checkRunIds.every((id) => this.store.get<CheckRun>("check-run", id)!.outcome === "passed")))
          throw new Error("候选的检查未全部通过");
        const after = await candidateEdits(path, work.files, output.touched);
        if (after.length !== edits.length || after.some((edit, index) =>
          edit.name !== edits[index].name || !edit.after.equals(edits[index].after),
        )) throw new Error("检查运行期间候选的交付发生变化");
        return edits;
      }));
      const accepted = new Map<string, CandidateEdit[]>();
      for (const [i, result] of evaluated.entries()) {
        const row = rows[i];
        row.updatedAt = stamp();
        if (result.status === "fulfilled") {
          row.status = "passed";
          accepted.set(row.id, result.value);
        } else {
          row.status = "rejected";
          row.reason = redact((result.reason as Error).message).slice(0, 400);
        }
        this.store.put("candidate", row);
      }
      if (!valid()) return false;
      const winner = await selectCandidate(this.hub, loop, step, rows.filter((row) => row.status === "passed"), signal);
      if (!valid()) return false;
      if (!winner) return markBlocked("没有候选的所有检查通过");
      const edits = accepted.get(winner.id)!;
      try {
        await preflightCandidate(project.path, work.baseVersion, edits);
        if (!valid()) return false;
        this.store.put("candidate", { ...winner, status: "integrating", updatedAt: stamp() });
        await applyCandidateEdits(project.path, edits, loop.protectedPaths, {
          ...this.journal.sink({ id: winner.id, workPath: project.path }, loop.id, criterion.id, () => {
            if (!valid()) throw new Error("候选授权已变化，停止整合");
          }),
          rejected: (_name, reason) => this.store.event("candidate.merge-rejected", winner.id, { reason }),
        });
        if (!valid()) throw new Error("候选授权已变化，回退本次整合");
      } catch (e) {
        this.store.put("candidate", { ...winner, status: "rejected", reason: redact((e as Error).message), updatedAt: stamp() });
        this.journal.rollback(loop.id, project.path, criterion.id);
        return valid() ? markBlocked("候选未整合：" + redact((e as Error).message), false) : false;
      }
      const live = this.store.get<Loop>("loop", loop.id)!;
      this.store.tx(() => {
        for (const row of rows.filter((c) => c.status === "passed"))
          this.store.put("candidate", { ...row, status: row.id === winner.id ? "selected" : "discarded", updatedAt: stamp() });
        this.store.put("criterion", {
          ...criterion, status: "in_progress", escalation: { ...criterion.escalation, stage: "candidate-applied" }, updatedAt: stamp(),
        });
        live.step = this.step(live, "check", criterion);
        this.put(live);
        this.hub.saveTask({ ...this.hub.getTask(task.id), reason: "已整合通过检查的候选，正在原目录复验" }, "verifying");
      });
      return true;
    } finally {
      try {
        if (!this.unresolvedChecks().some((r) => r.loopId === loop.id)) await prepared?.clean();
      } finally {
        this.releaseCheckWorkspace(loop, task);
      }
    }
  }
  private splitOrBlock(loop: Loop, criterion: Criterion, reason: string) {
    if (criterion.splitFrom || !criterion.verify.checkIds.length ||
        loop.budget.limits.executorRuns - loop.budget.spent.executorRuns < 2 ||
        loop.budget.spent.roleCalls >= loop.budget.limits.roleCalls) {
      this.adviseOrBlock(loop, criterion, reason);
      return;
    }
    this.store.put("criterion", {
      ...criterion, status: "failed", blockedReason: undefined, updatedAt: stamp(),
      escalation: { ...criterion.escalation, stage: "split", previousLevel: reason },
    });
  }
  private adviseOrBlock(loop: Loop, criterion: Criterion, reason: string) {
    if (!loop.roster.advisor || loop.budget.spent.executorRuns >= loop.budget.limits.executorRuns ||
        loop.budget.spent.roleCalls >= loop.budget.limits.roleCalls) {
      this.block(loop, criterion, reason);
      return;
    }
    this.store.put("criterion", {
      ...criterion, status: "failed", blockedReason: undefined, updatedAt: stamp(),
      escalation: { ...criterion.escalation, stage: "advisor", previousLevel: reason },
    });
  }
  private async splitCriterion(loop: Loop, task: Task, project: Project, parent: Criterion, checks: Check[]) {
    const eligible = checks.filter((c) => c.status === "authorized");
    const maxItems = Math.min(3, loop.budget.limits.criteria - this.criteria(loop).length,
      loop.budget.limits.executorRuns - loop.budget.spent.executorRuns);
    const decline = (reason: string, canAdvise = true) => {
      const current = this.store.get<Loop>("loop", loop.id)!;
      this.store.tx(() => {
        const detail = [parent.escalation?.previousLevel, "未拆分：" + reason].filter(Boolean).join("；");
        if (canAdvise) this.adviseOrBlock(current, parent, detail);
        else this.block(current, parent, detail);
        current.step = undefined;
        this.put(current);
      });
      this.hub.changed();
      return true;
    };
    if (!this.rollbackCriterion(loop, task, parent.id)) return false;
    if (this.journal.unrestored(loop.id, parent.id).length) return decline("在途文件不能安全回退", false);
    if (eligible.length < 2 || maxItems < 2) return decline("没有足够的独立授权检查或清单容量");
    const abort = new AbortController();
    const step = { ...this.step(loop, "split", parent), state: "running" as const };
    this.checking.set(loop.id, { path: project.path, abort });
    loop.step = step;
    this.put(loop);
    this.hub.changed();
    try {
      const result = await planSplit(this.hub, loop, task, step, parent, eligible, maxItems, abort.signal);
      const current = this.store.get<Loop>("loop", loop.id)!;
      const live = this.hub.getTask(task.id);
      if (abort.signal.aborted || this.hub.shuttingDown || current.contractRevision !== loop.contractRevision ||
          current.step?.id !== step.id || current.phase !== "advancing" || ["paused", "cancelled"].includes(live.state) ||
          result.status === "cancelled") return false;
      if (result.status !== "completed") return decline(result.reason);
      if (!result.data.items.length) return decline("规划者没有找到可以独立验收的子条目");
      const firstOrder = this.criteria(current).at(-1)!.order + 1;
      const children = result.data.items.map((item, i) => {
        const input = CriterionInput.parse({ ...item, necessity: parent.input.necessity,
          method: eligible.some((c) => item.checks.includes(c.input.name) && c.input.kind === "command") ? "command" : "file",
        });
        return { ...this.makeCriterion(current, input, eligible, firstOrder + i), splitFrom: parent.id, dependsOn: parent.dependsOn };
      });
      this.store.tx(() => {
        for (const child of children) this.store.put("criterion", child);
        this.store.put("criterion", {
          ...parent, status: "pending", updatedAt: stamp(), dependsOn: [...parent.dependsOn, ...children.map((row) => row.id)],
          escalation: { ...parent.escalation, stage: "split-parent", childIds: children.map((row) => row.id) },
        });
        current.step = undefined;
        this.put(current);
        this.store.event("criterion.split", parent.id, { loopId: loop.id, children: children.map((row) => row.id), invocationId: result.invocationId });
      });
      return true;
    } finally {
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private pass(
    loop: Loop,
    c: Criterion,
    ids: string[],
    workspaceVersion: string,
    baseline = false,
    review?: Assessment,
  ) {
    this.store.put("criterion", {
      ...c,
      status: "passed",
      attempts: c.attempts + (c.status === "in_progress" ? 1 : 0),
      passed: {
        grade: review?.action === "judged" ? "judged" : "program",
        checkRunIds: ids,
        workspaceVersion,
        at: stamp(),
        invocationId: review?.invocationId,
      },
      review: review && {
        detail: review.detail,
        invocationId: review.invocationId,
      },
      baselinePass: baseline || c.baselinePass,
      blockedReason: undefined,
      updatedAt: stamp(),
    });
    if (!baseline || c.status !== "passed")
      this.store.event("criterion.passed", c.id, { loopId: loop.id, baseline });
    this.journal.checkpoint(loop.id, c.id, workspaceVersion, loop.step?.runId);
    for (const id of c.findingIds ?? []) {
      const finding = this.store.get<Finding>("finding", id)!;
      this.store.put("finding", {
        ...finding,
        status: "fixed",
        updatedAt: stamp(),
      });
    }
    loop.blockedStreak = 0;
  }
  private async improve(
    loop: Loop,
    task: Task,
    project: Project,
    criteria: Criterion[],
    checks: Check[],
  ) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Date.parse(loop.startedAt) +
            loop.budget.limits.wallMinutes * 60000 -
            Date.now(),
        ),
      ),
    ]);
    const round = (loop.reviewedRounds ?? 0) + 1;
    const learnedVersion = this.hub.misses.version(project.id);
    const step = { ...this.step(loop, "review"), state: "running" as const };
    loop.phase = "reviewing";
    loop.step = step;
    this.checking.set(loop.id, { path: project.path, abort: controller });
    this.store.tx(() => {
      this.put(loop);
      this.hub.saveTask({ ...task, reason: "正在评审与分诊" }, "verifying");
    });
    this.hub.changed();
    try {
      const configured = await this.hub.brain.configured(this.hub.settings());
      const evidence = configured
        ? await collectEvidence(this.hub, loop, task, project, criteria, signal)
        : undefined;
      const materialStep = evidence
        ? { ...step, id: step.id + ":" + evidence.workspace.version }
        : step;
      const reviews = evidence
        ? await reviewFindings(
            this.hub,
            loop,
            materialStep,
            round,
            task,
            criteria,
            evidence,
            signal,
          )
        : { findings: [], unavailable: [] };
      const { findings } = reviews;
      const candidates = evidence
        ? await triage(
            this.hub,
            loop,
            materialStep,
            task,
            criteria,
            evidence,
            findings,
            signal,
          )
        : [];
      const version = await workspaceVersion(project.path);
      const current = this.store.get<Loop>("loop", loop.id)!;
      const live = this.hub.getTask(task.id);
      if (
        signal.aborted ||
        this.hub.shuttingDown ||
        current.contractRevision !== loop.contractRevision ||
        live.state === "paused" ||
        live.state === "cancelled"
      )
        return false;
      if (this.hub.misses.version(project.id) !== learnedVersion) return false;
      if (evidence && version.version !== evidence.workspace.version) {
        this.store.event("loop.review-invalidated", loop.id, {
          reason: "workspace-changed",
        });
        return false;
      }
      const selected = new Set<string>();
      const revisited = new Set<string>();
      let order = criteria.at(-1)?.order ?? -1;
      this.store.tx(() => {
        for (const item of candidates) {
          let c =
            item.scope === "reopen"
              ? criteria.find((entry) => entry.id === item.criterionId)
              : undefined;
          const cap =
            selected.size >= current.budget.limits.findingsPerRound ||
            current.budget.spent.executorRuns >=
              current.budget.limits.executorRuns;
          const point = (item.title + "：" + item.claim)
            .replace(/\s+/g, " ")
            .slice(0, 300);
          if (
            cap ||
            (c && revisited.has(c.id)) ||
            (!c && order + 1 >= current.budget.limits.criteria)
          ) {
            item.status = "deferred";
            item.reason = cap
              ? "本轮修复项或执行预算已满"
              : c
                ? "同一条目已为另一发现重开"
                : "清单条目预算已满";
            continue;
          }
          if (c) {
            const oldPoints = c.input.points || c.input.detail || c.input.title;
            const points = oldPoints
              .split(/\r?\n|；/)
              .map((value) => value.trim())
              .filter(Boolean);
            if (
              points.length >= 12 ||
              points.some((value) => value.length > 300)
            ) {
              item.status = "deferred";
              item.reason = "无法在保留原验收要点的情况下重开，留待核对";
              continue;
            }
            revisited.add(c.id);
            const input = {
              ...c.input,
              method: "judge" as const,
              points: [...new Set([...points, point])].join("\n"),
            };
            c = {
              ...c,
              input,
              verify: { method: "judge", checkIds: c.verify.checkIds },
              definitionHash: hash(JSON.stringify([input, c.verify.checkIds])),
              status: "stale",
              attempts: 0,
              noProgress: 0,
              judgedInitial: true,
              baselinePass: false,
              passed: undefined,
              blockedReason: undefined,
            };
          } else {
            c = this.makeCriterion(
              current,
              CriterionInput.parse({
                title: item.title,
                detail: item.claim,
                method: "judge",
                points: point,
              }),
              checks,
              ++order,
            );
            c.sourceQuote = item.sourceQuote;
          }
          const failure = {
            signature: "finding:" + item.id,
            detail: "已核实发现：" + item.claim,
          };
          this.store.put("criterion", {
            ...c,
            findingIds: [...(c.findingIds ?? []), item.id],
            failure,
            updatedAt: stamp(),
          });
          item.criterionId = c.id;
          item.status = "queued";
          selected.add(item.id);
        }
        for (const item of findings) this.store.put("finding", item);
        current.reviewedRounds = round;
        if (!configured)
          current.assumptions.push("未找问题：没有可用的评审模型");
        else if (reviews.unavailable.length)
          current.assumptions.push(
            "第 " +
              round +
              " 轮未取得以下视角的有效结论：" +
              reviews.unavailable.join("、"),
          );
        current.phase = selected.size ? "advancing" : "closing";
        current.step = selected.size ? undefined : this.step(current, "close");
        this.put(current);
        this.store.put("loop-review", {
          id: step.id,
          loopId: current.id,
          round,
          workspaceVersion: version.version,
          checkOutputRefs: evidence?.checkOutputRefs ?? [],
          diffRunIds: evidence?.diffRunIds ?? [],
          limited: evidence?.limited ?? false,
        });
        this.store.event("loop.reviewed", current.id, {
          round,
          findings: findings.length,
          queued: selected.size,
        });
      });
      return true;
    } catch (e) {
      if (signal.aborted) return false;
      throw e;
    } finally {
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private async establishContract(
    loop: Loop,
    task: Task,
    project: Project,
    checks: Check[],
  ) {
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      Math.max(
        1,
        Date.parse(loop.startedAt) +
          loop.budget.limits.wallMinutes * 60000 -
          Date.now(),
      ),
    );
    const step = { ...this.step(loop, "contract"), state: "running" as const };
    this.checking.set(loop.id, { path: project.path, abort });
    loop.step = step;
    this.put(loop);
    this.hub.saveTask({ ...task, reason: "正在整理验收清单" });
    this.hub.changed();
    try {
      const learnedVersion = this.hub.misses.version(project.id);
      const receipt = await this.contracting.plan(
        loop,
        task,
        project,
        step,
        checks,
        abort.signal,
      );
      const saved = this.store.get<Loop>("loop", loop.id)!;
      const current = this.hub.getTask(task.id);
      if (
        abort.signal.aborted ||
        this.hub.shuttingDown ||
        saved.phase !== "contracting" ||
        saved.contractRevision !== loop.contractRevision ||
        current.state === "paused" ||
        current.state === "cancelled"
      )
        return false;
      if (this.hub.misses.version(project.id) !== learnedVersion) return false;
      const accepted = receipt.items.map((item, i) => {
        const c = this.makeCriterion(saved, item.input, checks, i);
        return {
          ...c,
          assumption: item.assumption,
          sourceQuote: item.sourceQuote,
          ...(item.blockedReason
            ? { status: "blocked" as const, blockedReason: item.blockedReason }
            : {}),
        };
      });
      this.store.tx(() => {
        for (const [i, c] of accepted.entries())
          this.store.put("criterion", {
            ...c,
            dependsOn: receipt.items[i].dependencies.map((j) => accepted[j].id),
          });
        saved.contract = receipt.summary;
        saved.assumptions.push(...receipt.assumptions);
        saved.phase = "baseline";
        saved.step = this.step(saved, "baseline");
        this.put(saved);
        this.store.event("loop.contract-established", saved.id, {
          revision: saved.contractRevision,
          criteria: accepted.length,
          fallback: !!receipt.summary.fallback,
        });
        this.hub.saveTask({ ...current, reason: "清单已定约，正在建立基线" });
      });
      return true;
    } finally {
      clearTimeout(timeout);
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private async judgeFirst(
    loop: Loop,
    task: Task,
    project: Project,
    criterion: Criterion,
  ) {
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(
        1,
        Date.parse(loop.startedAt) +
          loop.budget.limits.wallMinutes * 60000 -
          Date.now(),
      ),
    );
    const step = this.step(loop, "judge", criterion);
    this.checking.set(loop.id, { path: project.path, abort });
    loop.step = { ...step, state: "running" };
    this.put(loop);
    this.hub.changed();
    try {
      const version = await workspaceVersion(project.path);
      const available = await this.hub.verification.available();
      const result =
        available && !criterion.verify.checkIds.length
          ? await this.hub.verification.review({
              loop,
              task,
              project,
              criterion,
              step,
              checks: [],
              machinePassed: false,
              signal: abort.signal,
            })
          : available
            ? {
                action: "fail" as const,
                detail: "还需完成指定的程序检查和独立评审",
              }
            : {
                action: "block" as const,
                detail: "独立评审不可用，未将条目判为通过",
              };
      const final = await workspaceVersion(project.path);
      const current = this.store.get<Loop>("loop", loop.id)!;
      const live = this.hub.getTask(task.id);
      if (
        abort.signal.aborted ||
        this.hub.shuttingDown ||
        current.contractRevision !== loop.contractRevision ||
        live.state === "paused" ||
        live.state === "cancelled" ||
        version.version !== final.version
      )
        return false;
      this.store.tx(() => {
        if (result.action === "judged")
          this.pass(current, criterion, [], final.version, false, result);
        else if (result.action === "block")
          this.block(current, criterion, result.detail);
        else
          this.store.put("criterion", {
            ...criterion,
            judgedInitial: true,
            review: result,
            failure: {
              signature: "judge:" + hash(result.detail),
              detail: result.detail,
            },
          });
        current.step = undefined;
        this.put(current);
      });
      return true;
    } finally {
      clearTimeout(timer);
      this.releaseCheckWorkspace(loop, task);
    }
  }

  private async batch(
    loop: Loop,
    task: Task,
    project: Project,
    checks: Check[],
    criteria: Criterion[],
  ) {
    const step = loop.step!;
    const aborted = new AbortController();
    this.checking.set(loop.id, { path: project.path, abort: aborted });
    const remain =
      Date.parse(loop.startedAt) +
      loop.budget.limits.wallMinutes * 60000 -
      Date.now();
    const deadline = setTimeout(() => aborted.abort(), Math.max(0, remain));
    step.state = "running";
    this.put(loop);
    try {
      if (
        (await realpath(project.path)).toLowerCase() !==
        project.path.toLowerCase()
      ) {
        this.finish(loop, task, "all_blocked", undefined, "项目目录基线已变化");
        return false;
      }
      let c = criteria.find((x) => x.id === step.criterionId);
      const before = await workspaceVersion(project.path);
      let version = before.version,
        limited = before.truncated;
      const latest = new Map<string, CheckRun>();
      const regressions = new Set(
        checks
          .filter(
            (check) =>
              check.baseline === "passed" ||
              criteria.some(
                (entry) =>
                  entry.status === "passed" &&
                  entry.verify.checkIds.includes(check.id),
              ),
          )
          .map((check) => check.id),
      );
      for (const check of checks) {
        if (aborted.signal.aborted || this.hub.shuttingDown) break;
        if (check.status !== "authorized") continue;
        const own = c?.verify.checkIds.includes(check.id);
        if (step.kind === "check" && !own && !regressions.has(check.id))
          continue;
        const purpose =
          step.kind === "baseline"
            ? "baseline"
            : step.kind === "close"
              ? "final"
              : own
                ? "criterion"
                : "regression";
        const base = await bindCheck(
          project.path,
          check.input,
          check.origin === "user" ? "user" : "existing",
        );
        if (!base.policy.allowed) {
          check.status = "rejected";
          check.policyRule = base.policy.rule;
          this.store.put("check", check);
          this.store.event("check.rejected", check.id, {
            loopId: loop.id,
            rule: check.policyRule,
          });
          continue;
        }
        if (base.bindingHash !== check.bindingHash) {
          check.bindingHash = base.bindingHash;
          check.policyRule = base.policy.rule;
          this.store.put("check", check);
          this.store.event("check.authorized", check.id, {
            loopId: loop.id,
            reason: "binding-changed",
          });
        }
        let data = await this.executeCheck(
          loop,
          task,
          check,
          step,
          purpose,
          version,
          project.path,
          aborted.signal,
        );
        if (
          data.outcome === "environment" &&
          purpose !== "baseline" &&
          !aborted.signal.aborted
        )
          data = await this.executeCheck(
            loop,
            task,
            check,
            step,
            purpose,
            version,
            project.path,
            aborted.signal,
          );
        latest.set(check.id, data);
        if (data.state === "unknown" || aborted.signal.aborted) break;
        if (check.input.kind === "command") {
          const after = await workspaceVersion(project.path);
          limited ||= after.truncated;
          if (version !== after.version) {
            data.outcome = "environment";
            data.outputRef = await checkOutputBlob(
              this.hub.dir,
              "检查改变了工作区，不能作为验收依据。",
            );
            this.store.put("check-run", data);
            version = after.version;
            for (const previous of latest.values()) {
              if (previous.id === data.id) continue;
              latest.delete(previous.checkId);
            }
          }
        }
        if (
          ["environment", "unstable"].includes(data.outcome || "") ||
          (purpose === "baseline" && data.outcome === "timeout")
        ) {
          check.status = "unavailable";
          check.policyRule =
            data.outcome === "unstable"
              ? "同一工作区版本的检查结果不稳定"
              : "检查环境不可用或改变了工作区";
        }
        if (purpose === "baseline")
          check.baseline =
            data.outcome === "passed"
              ? "passed"
              : check.status !== "authorized"
                ? "unavailable"
                : "failed";
        this.store.put("check", { ...check, updatedAt: stamp() });
        this.traceCheck(
          task,
          check,
          data,
          data.outputRef ? await this.output(data.id) : "",
        );
      }
      if (
        !aborted.signal.aborted &&
        latest.size &&
        [...latest.values()].every((r) => r.state === "ended")
      ) {
        const final = await workspaceVersion(project.path);
        limited ||= final.truncated;
        if (final.version !== version) {
          this.store.event("loop.checks-invalidated", loop.id, {
            reason: "workspace-changed",
          });
          return false;
        }
      }
      let current = this.store.get<Loop>("loop", loop.id)!;
      let live = this.hub.getTask(task.id);
      if (live.state === "cancelled") {
        this.finish(current, live, "cancelled");
        return false;
      }
      if (live.state === "paused") return false;
      if (
        current.contractRevision !== loop.contractRevision ||
        this.hub.shuttingDown
      )
        return false;
      if ([...latest.values()].some((r) => r.state === "unknown")) return true;
      if (aborted.signal.aborted) {
        if (loopExpired(current, Date.now()))
          this.finish(current, live, "budget");
        return false;
      }
      const downgraded =
        c &&
        c.verify.method !== "user" &&
        c.verify.checkIds.length > 0 &&
        !checks.some(
          (check) =>
            c!.verify.checkIds.includes(check.id) &&
            check.status === "authorized",
        )
          ? {
              ...c,
              verify: { method: "judge" as const, checkIds: [] },
              judgedInitial: true,
            }
          : undefined;
      if (downgraded) {
        c = downgraded;
        criteria = criteria.map((item) =>
          item.id === downgraded.id ? downgraded : item,
        );
      }
      for (const check of checks) {
        if (check.status !== "authorized") regressions.delete(check.id);
      }
      const reviews = new Map<string, Assessment>();
      const reviewTargets =
        step.kind === "baseline"
          ? criteria.filter(
              (item) =>
                item.status === "pending" &&
                item.verify.method === "command" &&
                evidenceFor(item, checks, latest).passed,
            )
          : step.kind === "close"
            ? criteria.filter(
                (item) =>
                  item.status === "passed" &&
                  item.passed?.grade === "judged" &&
                  item.passed.workspaceVersion !== version,
              )
            : c
              ? [c]
              : [];
      if (reviewTargets.length && (await this.hub.verification.available())) {
        const run = step.runId
          ? this.store.get<Run>("run", step.runId)
          : undefined;
        for (const criterion of reviewTargets) {
          if (aborted.signal.aborted || this.hub.shuttingDown) return false;
          const chosen = [...latest.values()].sort(
            (a, b) =>
              Number(criterion.verify.checkIds.includes(b.checkId)) -
              Number(criterion.verify.checkIds.includes(a.checkId)),
          );
          const passed =
            evidenceFor(criterion, checks, latest).passed &&
            [...regressions].every(
              (id) => latest.get(id)?.outcome === "passed",
            );
          const result = await this.hub.verification.review({
            loop: current,
            task: live,
            project,
            step,
            criterion,
            checks: chosen,
            machinePassed: passed,
            run,
            signal: aborted.signal,
          });
          reviews.set(criterion.id, result);
        }
        const sealed = await workspaceVersion(project.path);
        current = this.store.get<Loop>("loop", loop.id)!;
        live = this.hub.getTask(task.id);
        if (
          aborted.signal.aborted ||
          this.hub.shuttingDown ||
          current.contractRevision !== loop.contractRevision ||
          live.state === "paused" ||
          live.state === "cancelled"
        )
          return false;
        if (sealed.version !== version) {
          this.store.event("loop.checks-invalidated", loop.id, {
            reason: "workspace-changed-during-review",
          });
          return false;
        }
      }
      if (
        limited &&
        !current.assumptions.includes(
          "工作区扫描有边界，无法证明检查没有修改未扫描的文件",
        )
      )
        current.assumptions.push(
          "工作区扫描有边界，无法证明检查没有修改未扫描的文件",
        );
      const objection = c ? reviews.get(c.id) : undefined;
      if (c && objection?.action === "rewrite-check") {
        if (this.rewriteAuthored(current, c, objection)) return true;
        reviews.set(c.id, {
          ...objection,
          action: "block",
          detail: "检查异议成立，但原检查不可自动修订：" + objection.detail,
        });
      }
      if (downgraded && !reviews.has(downgraded.id))
        reviews.set(downgraded.id, {
          action: "block",
          detail: "程序检查全部不可用，未取得独立评审证据",
        });
      const delivery = step.kind === "close"
        ? await this.hub.misses.delivery(live, current, project, criteria, checks,
          [...latest.values()], version, aborted.signal)
        : undefined;
      if (step.kind === "close") {
        if (!aborted.signal.aborted && (await workspaceVersion(project.path)).version !== version) {
          this.store.event("loop.checks-invalidated", loop.id, { reason: "workspace-changed-during-archive" });
          return false;
        }
        current = this.store.get<Loop>("loop", loop.id)!;
        live = this.hub.getTask(task.id);
        if (aborted.signal.aborted || this.hub.shuttingDown ||
            current.contractRevision !== loop.contractRevision ||
            live.state === "paused" || live.state === "cancelled") return false;
      }
      this.store.tx(() => {
        if (downgraded) {
          this.store.event("check.review-fallback", downgraded.id, {
            loopId: loop.id,
            reason: "检查全部不可用",
          });
        }
        this.applyBatch(
          current,
          live,
          criteria,
          checks,
          latest,
          version,
          limited,
          regressions,
          reviews,
          delivery,
        );
      });
      return true;
    } finally {
      clearTimeout(deadline);
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private async executeCheck(
    loop: Loop,
    task: Task,
    check: Check,
    step: LoopStep,
    purpose: CheckRun["purpose"],
    version: string,
    root: string,
    signal: AbortSignal,
  ) {
    const data: CheckRun = {
      ...entity(),
      checkId: check.id,
      loopId: loop.id,
      stepId: step.id,
      runId: step.runId,
      criterionIds: this.criteria(loop)
        .filter((c) => c.verify.checkIds.includes(check.id))
        .map((c) => c.id),
      purpose,
      workspaceVersion: version,
      state: "running",
      guarded: process.platform === "win32" && check.input.kind === "command",
    };
    this.store.put("check-run", data);
    this.traceCheck(task, check, data, "");
    let result = await runCheck(check.input, {
      root,
      checkPath: this.hub.settings().checkPath,
      signal,
      timeoutMs:
        (check.input.kind === "command"
          ? (check.input.timeoutSec ?? loop.budget.limits.checkTimeoutSec)
          : loop.budget.limits.checkTimeoutSec) * 1000,
      started: (pid) => {
        data.pid = pid;
        this.store.put("check-run", data);
      },
    });
    if (
      !signal.aborted &&
      (result.outcome === "passed" || result.outcome === "failed") &&
      this.rows<CheckRun>("check-run", loop.id).some(
        (old) =>
          old.checkId === check.id &&
          old.workspaceVersion === version &&
          (old.outcome === "passed" || old.outcome === "failed") &&
          old.outcome !== result.outcome,
      )
    )
      result = {
        ...result,
        outcome: "unstable",
        output: "同一工作区版本结果不一致。\n" + result.output,
      };
    const ref = await checkOutputBlob(this.hub.dir, result.output);
    Object.assign(data, {
      updatedAt: stamp(),
      state: result.state,
      outcome: result.outcome,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputRef: ref,
      failureSignature: failureSignature(result.output),
    });
    this.store.put("check-run", data);
    this.traceCheck(task, check, data, result.output);
    return data;
  }
  private traceCheck(task: Task, check: Check, row: CheckRun, output: string) {
    const description = this.describe(check.input);
    const detail = [
      "command" in description ? description.command : description.file,
      output.slice(-4200),
    ]
      .filter(Boolean)
      .join("\n");
    const old = this.store.get("agent-line", "work:" + row.id);
    this.store.put("agent-line", {
      ...entity(),
      ...old,
      id: "work:" + row.id,
      agentId: workerId(task.id),
      kind: "tool",
      label: check.input.name,
      text: detail,
      groupId: row.stepId,
      runId: row.runId,
      work: {
        id: row.id,
        at: row.createdAt,
        kind: "command",
        title: redact(check.input.name),
        state:
          row.state === "running"
            ? "running"
            : row.state === "unknown"
              ? "unknown"
              : row.outcome === "passed"
                ? "done"
                : row.outcome
                  ? "failed"
                  : "stopped",
        detail: redact(detail),
        exitCode: row.exitCode,
        durationMs: row.durationMs,
      },
    });
    this.hub.changed();
  }
  private finishAdoption(
    loop: Loop,
    task: Task,
    criterion: Criterion,
    proof: CheckAdoption,
  ) {
    this.store.tx(() => {
      this.store.put("check-adoption", { ...proof, state: "adopted" });
      this.store.put("criterion", {
        ...criterion,
        author: {
          ...criterion.author,
          attempts: proof.attempts,
          path: proof.file,
          beforeFail: proof.resultId,
          reason: undefined,
          replacement: undefined,
        },
        failure: {
          signature: "authored:" + proof.failureSignature,
          detail: "新增检查在实现前失败，请依据实际输出实现条目",
          checkRunId: proof.resultId,
        },
      });
      loop.step = undefined;
      this.put(loop);
      this.store.event("check.authored", criterion.id, {
        checkRunId: proof.resultId,
        path: proof.file,
        appliedToRevision: proof.revision,
      });
      line(
        this.store,
        workerId(task.id),
        "system",
        "已采纳验收检查",
        proof.file,
      );
    });
  }
  private rewriteAuthored(
    loop: Loop,
    criterion: Criterion,
    review: Assessment,
  ) {
    const accepted = this.store.get<CheckAdoption>(
      "check-adoption",
      criterion.id,
    );
    if (
      !criterion.author?.path ||
      criterion.author.rewrites ||
      accepted?.state !== "adopted" ||
      accepted.file !== criterion.author.path ||
      accepted.revision !== loop.contractRevision
    )
      return false;
    this.store.tx(() => {
      this.store.put("criterion", {
        ...criterion,
        status: "pending",
        passed: undefined,
        author: {
          attempts: 0,
          rewrites: 1,
          replacement: { file: accepted.file, hash: accepted.contentHash },
        },
        review,
        failure: {
          signature: "objection:" + hash(review.detail),
          detail: review.detail,
        },
      });
      loop.step = undefined;
      this.put(loop);
      this.store.event("check.rewrite-requested", criterion.id, {
        invocationId: review.invocationId,
        file: accepted.file,
      });
    });
    return true;
  }
  private async authorCheck(
    loop: Loop,
    task: Task,
    project: Project,
    criterion: Criterion,
    checks: Check[],
  ) {
    const aborted = new AbortController();
    const remain =
      Date.parse(loop.startedAt) +
      loop.budget.limits.wallMinutes * 60000 -
      Date.now();
    const timer = setTimeout(() => aborted.abort(), Math.max(1, remain));
    this.checking.set(loop.id, { path: project.path, abort: aborted });
    const step = this.step(loop, "author", criterion);
    step.state = "running";
    loop.step = step;
    this.put(loop);
    this.hub.changed();
    const current = () => this.store.get<Loop>("loop", loop.id)!;
    const isCurrent = () =>
      !aborted.signal.aborted &&
      !this.hub.shuttingDown &&
      current().contractRevision === loop.contractRevision &&
      !["paused", "cancelled"].includes(this.hub.getTask(task.id).state);
    let attempts = criterion.author!.attempts;
    let reason = "没有可在隔离副本中证明的原生 Node 测试入口";
    const degrade = () => {
      const fresh = current();
      const required = checks
        .filter(
          (check) =>
            check.status === "authorized" &&
            criterion.verify.checkIds.includes(check.id) &&
            criterion.input.checks.includes(check.input.name),
        )
        .map((check) => check.id);
      this.store.tx(() => {
        this.store.put("criterion", {
          ...criterion,
          verify: { method: "judge", checkIds: required },
          author: { ...criterion.author, attempts, reason },
        });
        fresh.step = undefined;
        this.put(fresh);
        this.store.event("check.author-fallback", criterion.id, {
          attempts,
          reason,
        });
      });
    };
    try {
      const original = await snapshotFiles(project.path);
      if (!isCurrent()) return false;
      const prior = this.store.get<CheckAdoption>(
        "check-adoption",
        criterion.id,
      );
      if (
        prior?.state === "copying" &&
        prior.revision === loop.contractRevision
      ) {
        const name = relative(project.path, join(project.path, prior.file));
        if (
          !original.truncated &&
          original.files[name]?.hash === prior.contentHash &&
          sourceDigest(original, name) === prior.source
        ) {
          this.finishAdoption(current(), task, criterion, prior);
          return true;
        }
        this.store.put("check-adoption", { ...prior, state: "interrupted" });
        reason = "中断的检查采纳无法复核，已保留当前文件";
        degrade();
        return true;
      }
      const replacement = criterion.author?.replacement;
      const source = { ...original, files: { ...original.files } };
      if (replacement) {
        const name = relative(
          project.path,
          join(project.path, replacement.file),
        );
        if (source.files[name]?.hash !== replacement.hash) {
          reason = "待修订的检查已由外部变更，保留原文件";
          degrade();
          return true;
        }
        delete source.files[name];
      }
      let choice: { check: Check; file: string } | undefined;
      if (!source.truncated)
        for (const check of checks) {
          if (
            !criterion.verify.checkIds.includes(check.id) ||
            check.baseline !== "passed"
          )
            continue;
          const authorized = await bindCheck(
            project.path,
            check.input,
            check.origin === "user" ? "user" : "existing",
          );
          if (
            !authorized.policy.allowed ||
            authorized.bindingHash !== check.bindingHash
          )
            continue;
          const path = await authorPath(
            check,
            project.path,
            criterion.id,
            source,
          );
          if (
            path &&
            (!replacement || pathKey(path) === pathKey(replacement.file)) &&
            !Object.keys(source.files).some((p) => pathKey(p) === pathKey(path))
          ) {
            choice = { check, file: path };
            break;
          }
        }
      if (!isCurrent()) return false;
      if (!choice) {
        degrade();
        return true;
      }
      const { check, file } = choice;
      const cfg = this.hub.settings();
      for (; attempts < (replacement ? 1 : 2); ) {
        if (!isCurrent()) return false;
        const live = current();
        if (live.budget.spent.executorRuns >= live.budget.limits.executorRuns) {
          reason = "检查编写预算已用尽";
          degrade();
          return true;
        }
        const { dir, work } = await cloneForAuthor(
          project.path,
          this.hub.dir,
          source,
          file,
        );
        if (!sameSources(source, await snapshotFiles(work))) {
          reason = "复制时源文件发生变化";
          break;
        }
        const version = (await workspaceVersion(work)).version;
        const before = await this.executeCheck(
          live,
          task,
          check,
          step,
          "author-before",
          version,
          work,
          aborted.signal,
        );
        if (!isCurrent() || before.state === "unknown") return false;
        if (
          before.outcome !== "passed" ||
          !sameSources(source, await snapshotFiles(work))
        ) {
          reason = "测试入口在未改动的隔离副本中不能稳定通过";
          break;
        }
        if (!isCurrent()) return false;
        const invocation = {
          ...entity(),
          loopId: live.id,
          stepId: step.id,
          role: "check-author",
          status: "calling",
          profile: live.roster.executor,
          path: file,
          checkId: check.id,
          baselineRef: before.id,
        };
        const latest = current();
        if (
          latest.budget.spent.executorRuns >= latest.budget.limits.executorRuns
        ) {
          reason = "检查编写预算已用尽";
          break;
        }
        attempts++;
        this.store.tx(() => {
          latest.budget.spent.executorRuns++;
          latest.budget.spent.unknownUsageCalls++;
          this.put(latest);
          this.store.put("criterion", {
            ...criterion,
            author: { ...criterion.author, attempts },
          });
          this.store.put("invocation", invocation);
        });
        let reply;
        try {
          reply = await this.hub.checkAuthor.write(
            dir,
            work,
            file,
            cfg,
            latest,
            task,
            criterion,
            attempts > 1 ? reason : criterion.review?.detail,
            aborted.signal,
          );
        } catch (e) {
          reason =
            "检查编写者未正常结束：" +
            redact((e as Error).message).slice(0, 200);
          this.store.put("invocation", {
            ...invocation,
            status: isCurrent() ? "failed" : "cancelled",
            error: reason,
            updatedAt: stamp(),
          });
          if (!isCurrent()) return false;
          continue;
        }
        const currentAttempt = isCurrent();
        this.store.tx(() => {
          if (reply?.usage) this.accountUsage(loop.id, reply.usage);
          this.store.put("invocation", {
            ...invocation,
            status: !currentAttempt
              ? "cancelled"
              : reply?.accepted
                ? "completed"
                : "failed",
            usage: reply?.usage,
            updatedAt: stamp(),
          });
        });
        if (!currentAttempt) return false;
        const staged = await snapshotFiles(work);
        const localName = relative(work, join(work, file));
        if (!reply?.accepted || !sameSources(source, staged, localName)) {
          reason = "未产生唯一、可核对的新增测试";
          continue;
        }
        const afterVersion = (await workspaceVersion(work)).version;
        const result = await this.executeCheck(
          live,
          task,
          check,
          step,
          "author-after",
          afterVersion,
          work,
          aborted.signal,
        );
        if (!isCurrent() || result.state === "unknown") return false;
        if (
          result.outcome !== "failed" ||
          !result.outputRef ||
          !confirmedAssertion(await this.output(result.id), file) ||
          !sameSources(staged, await snapshotFiles(work))
        ) {
          reason = "新测试未触发断言失败，或测试改变了副本";
          continue;
        }
        if (!sameSources(original, await snapshotFiles(project.path))) {
          reason = "原项目已变化，未采纳旧版本上的测试";
          break;
        }
        const target = join(project.path, file);
        const parent = await within(project.path, dirname(target));
        if (pathKey(parent) !== pathKey(dirname(target))) {
          reason = "原项目测试目录已重定向";
          break;
        }
        if (!isCurrent()) return false;
        const protectedLoop = current();
        const proof: CheckAdoption = {
          id: criterion.id,
          loopId: loop.id,
          revision: loop.contractRevision,
          file,
          source: sourceDigest(source),
          contentHash: staged.files[localName].hash,
          resultId: result.id,
          failureSignature: result.failureSignature!,
          attempts,
          state: "copying",
        };
        this.store.tx(() => {
          protectedLoop.protectedPaths = [
            ...new Set([...protectedLoop.protectedPaths, pathKey(file)]),
          ];
          this.put(protectedLoop);
          this.store.put("check-adoption", proof);
        });
        try {
          if (!replacement) {
            copyFileSync(join(work, file), target, constants.COPYFILE_EXCL);
          } else {
            const info = lstatSync(target);
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              pathKey(realpathSync(target)) !== pathKey(target) ||
              hash(readFileSync(target)) !== replacement.hash
            ) {
              this.store.put("check-adoption", {
                ...proof,
                state: "interrupted",
              });
              reason = "候选检查待采纳时原文件变化，未覆盖";
              break;
            }
            const temp = join(parent, ".alcor-check-" + randomUUID());
            copyFileSync(join(work, file), temp, constants.COPYFILE_EXCL);
            try {
              renameSync(temp, target);
            } finally {
              try {
                unlinkSync(temp);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              }
            }
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          this.store.put("check-adoption", { ...proof, state: "interrupted" });
          reason = "原项目出现同名文件，未覆盖";
          break;
        }
        this.finishAdoption(protectedLoop, task, criterion, proof);
        return true;
      }
      if (!isCurrent()) return false;
      degrade();
      return true;
    } finally {
      clearTimeout(timer);
      this.releaseCheckWorkspace(loop, task);
    }
  }
  private applyBatch(
    loop: Loop,
    task: Task,
    criteria: Criterion[],
    checks: Check[],
    latest: Map<string, CheckRun>,
    version: string,
    limited: boolean,
    previousPasses: Set<string>,
    reviews: Map<string, Assessment>,
    delivery?: ReplayDelivery,
  ) {
    const step = loop.step!;
    const regressions = checks.filter(
      (check) =>
        previousPasses.has(check.id) &&
        latest.get(check.id)?.outcome !== "passed",
    );
    const active = criteria.find((c) => c.id === step.criterionId);
    const failedCheck = (check: Check) => {
      const result = latest.get(check.id);
      return {
        signature: check.id + ":" + (result?.failureSignature || check.status),
        detail:
          "检查未通过：" +
          check.input.name +
          (result?.outcome ? " · " + result.outcome : " · 无有效结果"),
        checkRunId: result?.id,
      };
    };
    for (const c of criteria) {
      if (
        c.status === "passed" &&
        ((c.verify.method !== "user" &&
          c.verify.checkIds.length > 0 &&
          !evidenceFor(c, checks, latest).passed) ||
          (step.kind === "close" &&
            c.verify.method === "judge" &&
            c.passed?.workspaceVersion !== version &&
            reviews.get(c.id)?.action !== "judged"))
      ) {
        if (c.verify.method === "judge") {
          const detail =
            reviews.get(c.id)?.detail || "工作区版本变化，旧评审证据已失效";
          this.store.put("criterion", {
            ...c,
            status: "stale",
            judgedInitial: false,
            passed: undefined,
            failure: { signature: "judge:" + hash(detail), detail },
            updatedAt: stamp(),
          });
          continue;
        }
        const broken = checks.find((check) =>
          c.verify.checkIds.includes(check.id),
        );
        if (!broken) throw new Error("已通过条目缺少检查绑定");
        const failed =
          regressions.find((check) => c.verify.checkIds.includes(check.id)) ||
          broken;
        this.store.put("criterion", {
          ...c,
          status: "stale",
          passed: undefined,
          failure: failedCheck(failed),
          updatedAt: stamp(),
        });
        this.store.event("criterion.failed", c.id, {
          loopId: loop.id,
          regression: true,
        });
      }
    }
    for (const check of regressions) {
      if (check.baseline !== "passed") continue;
      if (
        criteria.some(
          (c) =>
            c.input.necessity === "required" &&
            c.status !== "waived" &&
            c.verify.checkIds.includes(check.id),
        )
      )
        continue;
      if (this.criteria(loop).length >= loop.budget.limits.criteria) {
        this.finish(
          loop,
          task,
          "all_blocked",
          { version, limited },
          "检测到回归，但已达到清单条目上限",
          true,
        );
        return;
      }
      const recovery = this.makeCriterion(
        loop,
        CriterionInput.parse({
          title: "恢复回归：" + check.input.name,
          method: check.input.kind,
          checks: [check.input.name],
        }),
        checks,
        (this.criteria(loop).at(-1)?.order ?? -1) + 1,
      );
      this.store.put("criterion", {
        ...recovery,
        status: "stale",
        failure: failedCheck(check),
      });
    }
    if (step.kind === "baseline") {
      for (let c of criteria) {
        if (c.implicit) {
          const ids = checks
            .filter((check) => check.status === "authorized")
            .map((check) => check.id);
          c = {
            ...c,
            verify: { ...c.verify, checkIds: ids },
            definitionHash: hash(JSON.stringify([c.input, ids])),
          };
          this.store.put("criterion", c);
        }
        if (
          !["command", "file"].includes(c.verify.method) ||
          c.status === "waived" ||
          (c.dependsOn.length &&
            !c.dependsOn.every(
              (id) =>
                this.store.get<Criterion>("criterion", id)?.status === "passed",
            ))
        )
          continue;
        const ev = evidenceFor(c, checks, latest);
        if (ev.passed && !regressions.length) {
          const review = reviews.get(c.id);
          if (c.verify.method === "command" && c.author && !c.author.path) {
            if (review?.action === "program" && review.invocationId)
              this.pass(
                loop,
                { ...c, author: undefined },
                ev.ids,
                version,
                true,
                review,
              );
            else
              this.store.put("criterion", { ...c, baselinePass: true, review });
          } else if (
            review?.action === "fail" ||
            (c.verify.method === "command" &&
              !review?.invocationId &&
              c.verify.checkIds.some((id) =>
                checks.some(
                  (entry) =>
                    entry.id === id &&
                    entry.origin === "existing" &&
                    entry.input.kind === "command",
                ),
              ))
          ) {
            const detail =
              review?.detail || "通过既有命令，尚未取得此次目标的验收证据";
            this.store.put("criterion", {
              ...c,
              status: "pending",
              review,
              author:
                c.verify.method === "command" ? { attempts: 0 } : c.author,
              failure: { signature: "validity:" + hash(detail), detail },
            });
          } else this.pass(loop, c, ev.ids, version, true, review);
        }
      }
      loop.phase = "advancing";
    } else if (active) {
      const ev = evidenceFor(active, checks, latest);
      const review = reviews.get(active.id);
      const run = step.runId
        ? this.store.get<Run>("run", step.runId)
        : undefined;
      if (review?.action === "block")
        this.block(loop, { ...active, review }, review.detail);
      else if (
        review?.action === "fail" &&
        (!active.verify.checkIds.length || (ev.passed && !regressions.length))
      )
        this.fail(loop, { ...active, review }, run, {
          signature: "review:" + hash(review.detail),
          detail: review.detail,
        });
      else if (
        !regressions.length &&
        (active.verify.method === "judge"
          ? review?.action === "judged" &&
            (ev.passed || !active.verify.checkIds.length)
          : ev.passed)
      )
        this.pass(loop, active, ev.ids, version, false, review);
      else if (ev.missing.length && !ev.failed && !regressions.length)
        this.block(loop, active, "检查没有可靠结果：" + ev.missing.join("、"));
      else {
        const bad =
          regressions[0] ||
          checks.find((check) => check.id === ev.failed?.checkId);
        const failure = bad
          ? failedCheck(bad)
          : { signature: "missing-result", detail: "没有取得通过证据" };
        this.fail(loop, active, run, failure);
      }
    } else if (step.kind === "close") {
      const current = this.criteria(loop);
      if (current.some((c) => c.status === "stale")) {
        loop.phase = "advancing";
      } else {
        for (const c of current) {
          if (c.status !== "passed" || c.verify.method === "user") continue;
          const review = reviews.get(c.id);
          if (review?.action === "judged") {
            this.pass(
              loop,
              c,
              evidenceFor(c, checks, latest).ids,
              version,
              false,
              review,
            );
            continue;
          }
          const ev = evidenceFor(c, checks, latest);
          if (ev.passed)
            this.store.put("criterion", {
              ...c,
              passed: {
                ...c.passed!,
                checkRunIds: ev.ids,
                workspaceVersion: version,
                at: stamp(),
              },
            });
        }
        this.finish(
          loop,
          task,
          undefined,
          { version, limited },
          undefined,
          true,
          false,
          delivery,
        );
        return;
      }
    }
    loop.step = undefined;
    this.put(loop);
  }

  private finish(
    loop: Loop,
    task: Task,
    reason?: NonNullable<Loop["halt"]>["reason"],
    workspace?: { version: string; limited: boolean },
    detail?: string,
    inTransaction = false,
    userConfirmed = false,
    delivery?: ReplayDelivery,
    nativeAwaitUser = false,
  ) {
    const criteria = this.criteria(loop);
    const missing = criteria.filter(
      (c) =>
        c.input.necessity === "required" &&
        !["passed", "waived"].includes(c.status),
    );
    if (!reason && missing.some((c) => c.verify.method !== "user"))
      reason = "all_blocked";
    const reviewNeeded =
      !userConfirmed &&
      (nativeAwaitUser || (loop.closeMode === "review-judged" &&
        criteria.some(
          (c) => c.input.necessity === "required" && c.passed?.grade === "judged",
        )));
    const outcome = reason
      ? "halted"
      : missing.length || reviewNeeded
        ? "awaiting_user"
        : "completed";
    const usage = new Map<
      string,
      NonNullable<LoopReport["roleUsage"]>[number]
    >();
    const count = (role: string, native?: DshUsage, tokens?: number | null) => {
      const row = usage.get(role) ?? {
        role,
        calls: 0,
        tokensKnown: 0,
        unknown: 0,
      };
      row.calls++;
      if (native) {
        row.tokensKnown += native.tokensKnown;
        row.unknown += native.requests - native.knownRequests;
      } else if (typeof tokens === "number") row.tokensKnown += tokens;
      else row.unknown++;
      usage.set(role, row);
    };
    for (const run of this.store.all<Run>("run"))
      if (run.taskId === task.id &&
          !(run.nativeAttempt && this.store.get("command", run.commandId)?.state === "voided"))
        count(run.loopRole ?? "executor", run.usage as DshUsage | undefined);
    for (const call of this.rows<{
      role: string;
      tokens?: number | null;
      usage?: DshUsage;
    }>("invocation", loop.id))
      count(call.role, call.usage, call.tokens);
    const report: LoopReport = {
      outcome,
      blockedRequired: missing.map((c) => ({
        criterionId: c.id,
        reason:
          c.verify.method === "user"
            ? "需要用户判断"
            : c.blockedReason || c.failure?.detail || "尚无通过证据",
      })),
      preexistingPasses: criteria
        .filter((c) => c.baselinePass)
        .map((c) => c.id),
      workspaceVersion: workspace?.version,
      scopeLimited: workspace?.limited,
      judgedOnly: criteria
        .filter(
          (c) => c.passed?.grade === "judged" && !c.passed.checkRunIds.length,
        )
        .map((c) => c.input.title),
      assumptions: [...loop.assumptions],
      deferredFindings: this.rows<Finding>("finding", loop.id)
        .filter(
          (item) => item.status === "deferred" || item.status === "unverified",
        )
        .map((item) => item.id),
      rejectedWrites: loop.rejectedWrites,
      unavailableChecks: this.checks(loop)
        .filter((c) => c.status !== "authorized")
        .map((c) => c.input.name),
      unrestoredFiles: this.journal.unrestored(loop.id),
      usage: {
        ...loop.budget.spent,
        wallMs: Date.now() - Date.parse(loop.startedAt),
      },
      roleUsage: [...usage.values()],
    };
    loop.phase = reason ? "halted" : "closed";
    loop.halt = reason
      ? { reason, detail: detail || stopDetails[reason] }
      : undefined;
    loop.report = report;
    if (loop.step && !reason) loop.step.state = "done";
    const text =
      loop.halt?.detail ||
      (loop.mode === "loop-native"
        ? outcome === "completed" ? userConfirmed ? "用户已验收交付" : "独立复核已确认交付" : "独立复核已返回，请查看结果并验收"
        : outcome === "completed"
        ? "必需条目的最终检查已通过"
        : "程序检查已完成，剩余条目需要用户判断");
    const key =
      "loop-result:" + loop.id + ":" + loop.contractRevision + ":" + (reason || outcome);
    const persist = () => {
      this.put(loop);
      if (outcome === "completed" && delivery)
        this.hub.misses.sealDelivery({ ...delivery, criteria });
      const t = { ...task, reason: text, unread: true };
      if (t.state === "cancelled")
        this.hub.saveTask({
          ...t,
          control: this.unresolvedChecks().some((r) => r.loopId === loop.id)
            ? t.control
            : "confirmed",
        });
      else if (reason) this.hub.saveTask(t, "blocked");
      else {
        const verifying = this.hub.saveTask(t, "verifying");
        if (outcome === "completed") {
          this.store.put("acceptance", {
            ...entity(),
            taskId: t.id,
            runId: t.runId,
            revision: t.revision,
            method: "loop-contract",
            ...(userConfirmed ? { reviewedBy: "user", ...resultBasis(this.store, t, t.runId ? this.store.get<Run>("run", t.runId) : undefined) } : {}),
            contractRevision: loop.contractRevision,
            ...(loop.nativePlan && { nodeId: loop.nativePlan.nodeId }),
            evidence: criteria
              .filter((c) => c.passed)
              .map((c) => ({ criterionId: c.id, ...c.passed })),
          });
          this.hub.saveTask(verifying, "done");
        }
      }
      const agent = assigned(this.store, t);
      this.hub.desk.note(t.title + "：" + text, agent, key, { taskId: t.id });
      if (agent.parentAgentId !== "chief")
        line(this.store, agent.parentAgentId, "system", "循环回报", text, {
          id: key + ":parent",
          linkAgentId: agent.id,
        });
      this.store.event(
        reason ? "loop.halted" : "loop.closed",
        loop.id,
        {
          outcome,
          reason,
          contractRevision: loop.contractRevision,
          usage: report.usage,
        },
        key,
      );
    };
    if (inTransaction) persist();
    else this.store.tx(persist);
    this.hub.changed();
    this.hub.emit("result", { taskId: task.id, loopEvent: key });
  }
  async accept(task: Task) {
    const loop = this.forTask(task);
    if (
      !loop ||
      task.state !== "verifying" ||
      loop.report?.outcome !== "awaiting_user"
    )
      throw new Error("只有等待用户判定的循环结果可以验收");
    const project = this.hub.project(task.projectId);
    const current = await workspaceVersion(project.path);
    if (current.version !== loop.report.workspaceVersion)
      throw new Error("工作区已变化，请重开清单条目再核对");
    const { checks, checkRuns, criteria } = this.view(task);
    const delivery = await this.hub.misses.delivery(task, loop, project, criteria, checks, checkRuns,
      current.version, AbortSignal.timeout(30000));
    if ((await workspaceVersion(project.path)).version !== current.version)
      throw new Error("工作区在保存交付材料期间变化，请重新核对");
    if (
      this.hub.getTask(task.id).stateVersion !== task.stateVersion ||
      this.forTask(task)?.contractRevision !== loop.contractRevision
    )
      throw new Error("循环在核对期间已变化，请刷新");
    this.store.tx(() => {
      for (const c of this.criteria(loop)) {
        if (
          c.verify.method === "user" &&
          !["waived", "passed"].includes(c.status)
        )
          this.store.put("criterion", {
            ...c,
            status: "passed",
            passed: {
              grade: "user",
              at: stamp(),
              workspaceVersion: current.version,
              checkRunIds: [],
            },
          });
      }
      this.finish(
        loop,
        task,
        undefined,
        { version: current.version, limited: current.truncated },
        undefined,
        true,
        true,
        delivery,
      );
    });
    return true;
  }
}
