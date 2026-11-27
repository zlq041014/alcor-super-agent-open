import { join } from "node:path";
import {
  acceptedGraphVersion, affectedGraphNodes, assertDisjointOutputs, assertGraph, planGraph,
  sameGraphVersions, validateProposal, type GraphJob,
} from "../core/native-graph";
import type { Command, ModelProfile, Run, Task } from "../shared/contracts";
import {
  GraphHandoff, GraphProposal,
  type GraphFile, type GraphNode, type GraphPlan, type GraphVersion,
} from "../shared/native-graph";
import { ResearchUse, type ResearchEvidence, type ResearchSpec } from "../shared/research";
import { buildGraphWorkspace, checkGraphFiles, verifyGraphWorkspace } from "./graph-workspace";
import { hash, redact } from "./security";
import { GraphProgress } from "./graph-progress";
import { standardNode } from "./graph-standard";
import { PreviewJobLedger, type PreviewJob } from "./preview-job-ledger";
import { previewFrameName } from "./preview-job-process";
import { entity, stamp, type Store } from "./store";

export class GraphLedger {
  constructor(private store: Store, private dir: string) {}
  get progress() { return new GraphProgress(this.store); }
  get previewJobs() { return new PreviewJobLedger(this.store); }
  get(id: string) { return this.store.get<GraphPlan>("native-graph", id)!; }
  nodes(id: string) {
    return this.store.db.prepare(`SELECT data FROM records
      WHERE kind='graph-node' AND json_extract(data,'$.loopId')=?
      ORDER BY json_extract(data,'$.key')`)
      .all(id).map((row) => JSON.parse(String(row.data)) as GraphNode);
  }
  node(id: string) { return this.store.get<GraphNode>("graph-node", id)!; }
  standard(id: string) { return this.nodes(id).find((node) => node.kind === "standard"); }
  private task(plan: GraphPlan) { return this.store.get<Task>("task", plan.taskId)!; }
  private put(plan: GraphPlan) { this.store.put("native-graph", { ...plan, updatedAt: stamp() }); }
  private putNode(node: GraphNode) { this.store.put("graph-node", { ...node, updatedAt: stamp() }); }
  private runs() { return this.store.all<Run>("run").filter((run) => run.graphAttempt); }
  initialize(task: Task, inputs: GraphFile[], limits: GraphPlan["limits"], reviewByUser = false,
    timing?: GraphPlan["timing"], preview?: GraphPlan["preview"], nativeTools = false, standard = false) {
    const outputs = preview ? ["preview-frames/index.txt", ...Array.from({ length: preview.frames },
      (_, index) => "preview-frames/" + previewFrameName(index + 1))] : [];
    const card: GraphNode | undefined = standard ? {
      ...entity(), ...standardNode(), loopId: task.loopId!,
      dependencies: [], resources: [], revision: 1, attempts: 0,
    } : undefined;
    assertDisjointOutputs([...inputs.map((file) => file.path), ...outputs, ...(card?.outputs ?? [])]);
    const root: GraphNode = {
      ...entity(), loopId: task.loopId!, key: "main", title: task.title,
      goal: task.goal, acceptance: task.acceptance, required: true,
      outputs, dependencies: card ? [card.key] : [], resources: [], revision: 1, attempts: 0,
    };
    const plan: GraphPlan = {
      ...entity(), id: task.loopId!, version: 3, nativeTools, taskId: task.id,
      projectId: task.projectId, rootNodeId: root.id, inputs, limits, spent: 0, reviewByUser, timing, preview,
    };
    this.put(plan);
    this.putNode(root);
    if (card) this.putNode(card);
    this.store.event("graph.created", plan.id, { nodeId: root.id, taskId: task.id });
  }
  registerResearch(task: Task, spec: ResearchSpec, evidence?: ResearchEvidence, expected?: number) {
    const plan = this.get(task.loopId!);
    const nodes = this.nodes(plan.id);
    const consumer = nodes.find((node) => node.key === spec.consumer);
    if (!consumer || consumer.research) throw new Error("研究须绑定现有的交付成果");
    const previous = nodes.find((node) => node.key === spec.key);
    if (previous ? !previous.research || previous.revision !== expected ||
      previous.research.spec.consumer !== spec.consumer : expected !== undefined)
      throw new Error("研究决定编号、修订或所绑定成果已变化");
    if (!previous && nodes.filter((node) => node.research).length >= 4)
      throw new Error("这个任务的研究决定已达上限");
    const node: GraphNode = {
      ...entity(), loopId: plan.id, key: spec.key, title: spec.question,
      goal: spec.question, acceptance: "核对目标版本的来源和本地小样",
      outputs: [], dependencies: [], resources: [], required: false, attempts: 0, revision: 1,
      ...(previous && { id: previous.id, createdAt: previous.createdAt,
        revision: previous.revision + 1, activeRunId: previous.activeRunId }),
      research: { spec, evidence },
      ...(evidence?.status === "local" && { accepted: {
        runId: "local:" + spec.key, reviewRunId: "local:" + spec.key, files: [], inputs: [],
      } }),
      ...(evidence && evidence.status !== "local" && { blocked: evidence.detail }),
    };
    const linked = spec.mode === "before";
    const wasLinked = previous?.research?.spec.mode === "before";
    const dependencies = consumer.dependencies.filter((key) => key !== spec.key);
    if (linked) dependencies.push(spec.key);
    assertGraph([...nodes.filter((item) => item.id !== previous?.id)
      .map((item) => item.id === consumer.id ? { ...item, dependencies } : item), node]);
    const affected = previous ? this.invalidate(plan.id, previous.key) : [];
    if (linked && !wasLinked) affected.push(...this.invalidate(plan.id, consumer.key));
    if (linked || wasLinked) this.putNode({ ...this.node(consumer.id), dependencies });
    this.putNode(node);
    this.store.event(previous ? "graph.research-revised" : "graph.research-registered", node.id, {
      loopId: plan.id, consumerId: consumer.id, mode: spec.mode,
    });
    return affected;
  }

  private evaluate(plan: GraphPlan, nodes: GraphNode[], now: number) {
    const task = this.task(plan);
    const open = this.runs().filter((run) => run.state !== "ended");
    const runs = new Map(open.map((run) => [run.id, { ...run.graphAttempt!, state: run.state }]));
    const held = new Set([
      ...open.flatMap((run) => run.graphAttempt!.resources),
      ...this.previewJobs.held().flatMap((job) => job.resources),
    ]);
    return planGraph(plan, nodes, runs, held, {
      paused: !["ready", "active", "blocked"].includes(task.state) ||
        task.control === "pause_requested" || task.control === "cancel_requested" ||
        task.dependencies.some((id) => this.store.get<Task>("task", id)?.state !== "done"),
      expired: this.expired(plan, now),
      remaining: plan.limits.runs - plan.spent,
      ...(plan.preview && { previews: new Map(this.previewJobs.pending(task.id).map((job) => [job.id, job.state])) }),
    });
  }
  expired(plan: GraphPlan, now = Date.now()) {
    return now >= Date.parse(plan.createdAt) + plan.limits.wallMinutes * 60_000;
  }
  runDeadline(plan: GraphPlan, run: Run) {
    const end = Date.parse(plan.createdAt) + plan.limits.wallMinutes * 60000;
    return plan.version === 3 && !plan.timing ? end :
      Math.min(end, Date.parse(run.startedAt) + plan.limits.runMinutes * 60000);
  }
  evaluatePlan(id: string, now = Date.now()) {
    const plan = this.get(id);
    return this.evaluate(plan, this.nodes(id), now);
  }
  private binding(run: Run, plan: GraphPlan) {
    const bound = run.graphAttempt!;
    return bound.role === "final"
      ? plan.finalRunId === run.id && plan.assembled?.path === run.workPath && !plan.assembled.stale
      : this.node(bound.nodeId).activeRunId === run.id &&
        this.node(bound.nodeId).revision === bound.nodeRevision;
  }
  active(run: Run, now = Date.now()) {
    const task = this.store.get<Task>("task", run.taskId)!;
    const plan = this.get(task.loopId!);
    const state = this.store.get<Run>("run", run.id)?.state;
    const progress = plan.timing ? this.progress.get(run.id)! : undefined;
    return (state === "starting" || state === "running") &&
      task.revision === run.revision && this.binding(run, plan) &&
      ["ready", "active", "blocked"].includes(task.state) &&
      !task.control?.endsWith("_requested") && !this.expired(plan, now) &&
      !progress?.stop && now < (progress?.hardAt ?? this.runDeadline(plan, run));
  }

  previewAuthorized(plan: GraphPlan, run: Run) {
    return !!plan.preview && run.graphAttempt?.role === "execute" && run.graphAttempt.nodeId === plan.rootNodeId;
  }
  tool(run: Run, request: string | number, action: "suggest_branches" | "submit_delivery" | "record_research_use" | "start_preview", value: unknown) {
    const task = this.store.get<Task>("task", run.taskId)!;
    const id = "graph:" + hash(JSON.stringify([run.id, request]));
    const digest = hash(JSON.stringify([action, value]));
    return this.store.tx(() => {
      const prior = this.store.db.prepare("SELECT hash,result FROM inbox WHERE id=?").get(id);
      if (prior) {
        if (prior.hash !== digest) throw new Error("成果请求编号已用于其他内容");
        return String(prior.result);
      }
      if (run.graphAttempt!.role !== "execute" || !this.active(run))
        throw new Error("该回合已失效或不允许提交成果");
      const plan = this.get(task.loopId!), node = this.node(run.graphAttempt!.nodeId);
      const nodes = this.nodes(plan.id);
      let result: string;
      if (action === "suggest_branches") {
        if (node.kind === "standard") throw new Error("质量标准节点只交付标准卡，不提议分支");
        const standard = nodes.find((n) => n.kind === "standard");
        const proposed = GraphProposal.parse(value).nodes.map((n) =>
          standard && !n.dependencies.includes(standard.key)
            ? { ...n, dependencies: [...n.dependencies, standard.key] } : n);
        checkGraphFiles(proposed.flatMap((n) => n.outputs));
        validateProposal(nodes, proposed, plan.inputs.map((file) => file.path));
        const added = proposed.map<GraphNode>((n) => ({
          ...entity(), ...n, loopId: plan.id, revision: 1, attempts: 0,
        }));
        if (this.evaluate(plan, [...nodes, ...added], Date.now()).minimum > plan.limits.runs - plan.spent)
          throw new Error("新增必需成果会挤占独立复核和收尾预算");
        for (const addedNode of added) this.putNode(addedNode);
        this.store.event("graph.branches-accepted", plan.id, {
          proposerRunId: run.id, nodes: added.map((n) => n.id),
        });
        result = "已登记成果：" + added.map((n) => n.key).join("、");
      } else if (action === "submit_delivery") {
        if (this.previewAuthorized(plan, run)) throw new Error("主成果须用已授权的视频预览作业交付");
        const { paths } = GraphHandoff.parse(value);
        checkGraphFiles(paths);
        assertDisjointOutputs([
          ...plan.inputs.map((file) => file.path),
          ...nodes.filter((n) => n.id !== node.id).flatMap((n) => n.outputs),
          ...paths,
        ]);
        if (node.id !== plan.rootNodeId &&
            (paths.length !== node.outputs.length || paths.some((p) => !node.outputs.includes(p))))
          throw new Error("交付路径必须与该成果声明的文件一致");
        if (node.id === plan.rootNodeId) this.putNode({ ...node, outputs: paths });
        this.store.put("graph-handoff", { id: run.id, paths });
        this.store.event("graph.delivery-submitted", run.id, { nodeId: node.id });
        result = "交付已登记；回合结束后冻结文件，由另一个 Agent 独立复核。";
      } else if (action === "start_preview") {
        const preview = plan.preview;
        if (!preview || !this.previewAuthorized(plan, run) ||
            !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)
          throw new Error("只能移交本任务已授权的预览作业，不接受额外参数");
        const id = entity().id;
        const time = this.progress.get(run.id);
        const hardAt = time?.hardAt ?? this.runDeadline(plan, run);
        const job = this.previewJobs.queue(task, run, {
          id, receiptKey: entity().id, sourceHash: preview.blob.slice(0, 64),
          ffmpeg: preview.ffmpeg, frames: preview.frames, hardAt, intervalMs: time?.intervalMs,
        }, join(this.dir, "graph-previews", id), ["render:preview"]);
        this.putNode({ ...node, previewJobId: job.id });
        result = "已登记预览作业 " + job.id + "。正常结束回合后，星引将独立运行并核对帧文件，无需等候。";
      } else {
        const use = ResearchUse.parse(value);
        const linked = this.researchFor(run).find((citation) => citation.spec.key === use.key);
        if (!linked) throw new Error("当前回合没有这项可采纳的研究证据");
        this.store.put("graph-research-use", {
          id: run.id + ":" + use.key, runId: run.id, nodeRevision: node.revision,
          evidenceRunId: linked.version.reviewRunId, evidenceRevision: linked.version.revision, use,
        });
        result = "已记录这个决定的采纳情况。";
      }
      this.store.db.prepare("INSERT INTO inbox VALUES(?,?,?)").run(id, digest, result);
      return result;
    });
  }
  handoff(run: Run) {
    return this.store.get<{ paths: string[] }>("graph-handoff", run.id)?.paths;
  }

  claim(id: string, choice: GraphJob, profile: ModelProfile, now = Date.now()) {
    return this.store.tx(() => {
      const plan = this.get(id), task = this.task(plan);
      const job = this.evaluatePlan(id, now).jobs.find((current) =>
        current.role === choice.role &&
        (!("node" in current) || ("node" in choice && current.node.id === choice.node.id &&
          current.node.revision === choice.node.revision)) &&
        sameGraphVersions(current.inputs, choice.inputs));
      if (!job || job.role === "assemble") return;
      const node = "node" in job ? job.node : this.node(plan.rootNodeId);
      const researchInputs = job.role === "review" && node.draft
        ? this.store.get<Run>("run", node.draft.runId)?.graphAttempt?.researchInputs ?? []
        : job.role === "execute"
          ? this.nodes(id).filter((r) => r.research?.spec.consumer === node.key && r.accepted)
            .map(acceptedGraphVersion)
          : [];
      const commandId = entity().id;
      const run: Run = {
        ...entity(), workRecordVersion: 1, taskId: task.id, revision: task.revision, commandId,
        workPath: "", startedAt: new Date(now).toISOString(),
        state: "starting", backend: "dsh", profile, response: "", diff: "",
        loopRole: job.role === "review" || job.role === "final" ? "reviewer" : undefined,
        graphAttempt: {
          nodeId: node.id, nodeRevision: node.revision, role: job.role,
          inputs: job.inputs, resources: "node" in job ? node.resources : [],
          ...(researchInputs.length && { researchInputs }),
        },
      };
      run.workPath = job.role === "final" ? plan.assembled!.path : join(this.dir, "graph-workspaces", run.id);
      if (job.role === "final") run.isolation = "output";
      const command: Command = {
        ...entity(), id: commandId, taskId: task.id, runId: run.id,
        revision: task.revision, kind: "start", state: "prepared", payloadHash: "",
      };
      plan.spent++;
      plan.lastClaimAt = stamp();
      if (job.role === "final") plan.finalRunId = run.id;
      else this.putNode({
        ...node, activeRunId: run.id,
        attempts: node.attempts + Number(job.role === "execute" || job.role === "research"),
      });
      this.put(plan);
      this.store.put("run", run);
      this.store.put("command", command);
      if (plan.timing) this.progress.start(run.id, now, plan.timing.observeMinutes * 60_000,
        Math.min(now + plan.timing.hardMinutes * 60_000, Date.parse(plan.createdAt) + plan.limits.wallMinutes * 60_000));
      this.store.event("graph.claimed", run.id, {
        loopId: plan.id, nodeId: node.id, role: job.role, revision: node.revision, spent: plan.spent,
      });
      return { run, command };
    });
  }

  // Called inside recovery, or after a stop that happened before the sending intent was committed.
  voidPrepared(run: Run, command: Command, failure?: string) {
    if (command.state !== "prepared" || run.state === "ended") return false;
    const plan = this.get(this.store.get<Task>("task", run.taskId)!.loopId!);
    const { role, nodeId, nodeRevision } = run.graphAttempt!;
    plan.spent--;
    if (role === "final") {
      if (plan.finalRunId === run.id) {
        plan.finalRunId = undefined;
        if (failure && plan.assembled?.path === run.workPath && !plan.assembled.stale)
          plan.finalFailure = failure;
      }
    } else {
      const node = this.node(nodeId);
      if (node.activeRunId === run.id)
        this.putNode({
          ...node, activeRunId: undefined,
          attempts: node.attempts - Number((role === "execute" || role === "research") && nodeRevision === node.revision),
          ...(failure && nodeRevision === node.revision ? { blocked: failure } : {}),
        });
    }
    this.put(plan);
    this.store.put("run", {
      ...run, state: "ended", outcome: failure ? "failed" : "interrupted", endedAt: stamp(),
      ...(failure ? { response: failure } : {}),
    });
    this.store.put("command", { ...command, state: "voided" });
    this.store.event("graph.unsent", run.id, { loopId: plan.id, nodeId });
    return true;
  }
  recover() {
    this.previewJobs.recover();
    for (const run of this.runs().filter((r) => r.state !== "ended")) {
      const command = this.store.get<Command>("command", run.commandId)!;
      if (this.voidPrepared(run, command)) continue;
      this.store.put("run", { ...run, state: "unknown" });
      if (command.state === "dispatching") this.store.put("command", { ...command, state: "unknown" });
    }
    for (const plan of this.store.all<GraphPlan>("native-graph"))
      if (plan.assembled?.state === "applying")
        this.put({ ...plan, assembled: { ...plan.assembled, state: "unknown" } });
  }

  filesFor(plan: GraphPlan, versions: GraphVersion[]) {
    return versions.flatMap((reference) => {
      const node = this.node(reference.nodeId);
      if (node.loopId !== plan.id || !node.accepted || !sameGraphVersions([reference], [acceptedGraphVersion(node)]))
        throw new Error("上游成果已变化，请按新版本继续");
      return node.accepted.files;
    });
  }
  researchFor(run: Run) {
    return (run.graphAttempt!.researchInputs ?? []).flatMap((version) => {
      const node = this.node(version.nodeId);
      if (!node.research?.evidence || !node.accepted ||
          !sameGraphVersions([version], [acceptedGraphVersion(node)])) return [];
      return [{ version, spec: node.research.spec, evidence: node.research.evidence }];
    });
  }
  researchUse(planId: string, research: GraphNode) {
    const consumer = this.nodes(planId).find((node) => node.key === research.research!.spec.consumer)!;
    const runId = consumer.accepted?.runId ?? consumer.draft?.runId;
    const record = runId && this.store.get<{ evidenceRunId: string; evidenceRevision: number; use: ResearchUse }>(
      "graph-research-use", runId + ":" + research.key,
    );
    return record && record.evidenceRunId === research.accepted?.reviewRunId &&
      record.evidenceRevision === research.revision ? record.use : undefined;
  }
  saveResearch(run: Run, evidence: ResearchEvidence) {
    this.store.tx(() => {
      if (run.graphAttempt!.role !== "research" || !this.active(run))
        throw new Error("研究回合已变化，未保存旧资料");
      const node = this.node(run.graphAttempt!.nodeId);
      this.putNode({ ...node, research: { ...node.research!, evidence } });
      this.store.put("graph-research-attempt", { id: run.id, nodeId: node.id, revision: node.revision, evidence });
    });
  }
  claimAssembly(id: string, versions: GraphVersion[], now = Date.now()) {
    return this.store.tx(() => {
      const plan = this.get(id);
      const job = this.evaluatePlan(id, now).jobs.find((item) =>
        item.role === "assemble" && sameGraphVersions(versions, item.inputs));
      if (!job) return;
      const assemblyId = entity().id;
      const assembly = {
        id: assemblyId, path: join(this.dir, "graph-workspaces", assemblyId),
        versions: job.inputs, files: this.filesFor(plan, job.inputs), state: "applying" as const,
      };
      this.put({ ...plan, assembled: assembly });
      this.store.event("graph.assembly-claimed", assemblyId, { loopId: id });
      return assembly;
    });
  }
  finishAssembly(id: string, assemblyId: string, failure?: string) {
    return this.store.tx(() => {
      const plan = this.get(id);
      if (plan.assembled?.id !== assemblyId || !["applying", "unknown"].includes(plan.assembled.state))
        return false;
      this.put({
        ...plan, assembled: plan.assembled.stale ? undefined : {
          ...plan.assembled, state: failure ? "failed" : "ready", failure,
        },
      });
      this.store.event(failure ? "graph.assembly-failed" : "graph.assembly-resolved", assemblyId, { loopId: id });
      return true;
    });
  }
  async assemble(plan: GraphPlan, assembly: NonNullable<GraphPlan["assembled"]>) {
    try {
      await buildGraphWorkspace(assembly.path, join(this.dir, "blobs"), assembly.files);
      await verifyGraphWorkspace(assembly.path, assembly.files);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      const detail = cause.code ?? redact(cause.message);
      this.finishAssembly(plan.id, assembly.id, "组合失败：" + detail);
      return;
    }
    this.finishAssembly(plan.id, assembly.id);
  }
  async reconcileAssembly(id: string) {
    const plan = this.get(id);
    const assembly = plan.assembled;
    if (assembly?.state !== "unknown") throw new Error("没有待核对的组合结果");
    try {
      await verifyGraphWorkspace(assembly.path, assembly.files);
    } catch (error) {
      throw new Error("未取得与已验收成果匹配的组合版本，保留未知并保留现有文件", { cause: error });
    }
    return this.finishAssembly(id, assembly.id);
  }

  // Persisted in the same transaction as the shared Run and Command terminal records.
  settle(run: Run, result: { files?: GraphFile[]; failure?: string; limited?: boolean }) {
    const task = this.store.get<Task>("task", run.taskId)!;
    const plan = this.get(task.loopId!);
    const bound = run.graphAttempt!, node = this.node(bound.nodeId);
    const final = bound.role === "final";
    if (final ? plan.finalRunId !== run.id : node.activeRunId !== run.id) return;
    const record = this.store.get<Run>("run", run.id)!;
    if (record.state !== "ended") throw new Error("成果尝试没有终态");
    if (final) plan.finalRunId = undefined;
    else node.activeRunId = undefined;
    const current = task.revision === run.revision && node.revision === bound.nodeRevision &&
      (!final || (plan.assembled?.path === run.workPath && !plan.assembled.stale &&
        sameGraphVersions(plan.assembled.versions, bound.inputs)));
    const stopped = task.state === "cancelled" || (task.state === "paused" && run.outcome !== "completed");
    const decision = run.response.trim().split(/\r?\n/).at(-1)
      ?.replaceAll("**", "").replace(/^[\s>\-]+|[。.!！\s]+$/g, "");
    const window = this.progress.get(run.id);
    const timingFailure = window?.stop === "stalled" ? "观察点没有新进展，已请求停止" :
      window && (window.stop === "hard" || Date.parse(run.endedAt!) > window.hardAt)
        ? "回合已过硬截止，未验收迟到交付" : undefined;
    const failure = timingFailure ?? result.failure ?? (run.outcome === "completed" ? undefined : "原生回合未正常结束");
    const preview = bound.role === "execute" && this.previewJobs.forRun(run.id);
    if (preview && (!current || stopped || failure || task.state === "paused"))
      this.previewJobs.request(preview.id, timingFailure ? window!.stop ?? "hard" : "user");
    if (current && !stopped) {
      if (final) {
        if (!failure && !result.limited && (decision === "建议收口" || decision === "建议人工验收")) {
          plan.finalAccepted = run.id;
          plan.manualReview = plan.reviewByUser || decision === "建议人工验收";
        } else plan.finalFailure = failure ?? "最终复核未确认组合交付";
      } else if (bound.role === "research") {
        const evidence = node.research!.evidence;
        if (!failure && evidence?.status === "verified")
          node.accepted = { runId: run.id, reviewRunId: run.id, files: [], inputs: bound.inputs };
        else node.blocked = failure ?? "研究未提交可核对的建议，相关决定仍未通过";
      } else if (bound.role === "execute") {
        if (preview && !failure && task.state !== "paused") {
          this.previewJobs.confirmHandoff(preview.id);
        } else if (!failure && result.files?.length) {
          node.draft = { runId: run.id, files: result.files, inputs: bound.inputs };
          node.repair = undefined;
        } else node.blocked = failure ?? "回合结束时没有可核对的交付文件";
      } else if (!failure && decision === "建议收口") {
        node.accepted = { ...node.draft!, reviewRunId: run.id };
        node.draft = undefined;
        node.repair = undefined;
      } else if (!failure && node.attempts <= plan.limits.retries) {
        node.feedbackRunId = run.id;
        node.repair = node.draft;
        node.draft = undefined;
      } else node.blocked = failure ?? "独立复核未通过，已用完可修正次数";
    }
    if (!final) this.putNode(node);
    this.put(plan);
    this.store.event("graph.attempt-ended", run.id, {
      loopId: plan.id, nodeId: node.id, role: bound.role, outcome: run.outcome,
      accepted: final ? plan.finalAccepted === run.id : node.accepted?.reviewRunId === run.id,
    });
  }

  finishPreview(id: string, files?: GraphFile[], failure?: string) {
    return this.store.tx(() => {
      const job = this.previewJobs.get(id)!;
      if (job.applied || !["completed", "failed", "stopped"].includes(job.state)) return false;
      const run = this.store.get<Run>("run", job.runId)!;
      if (run.state !== "ended") return false;
      const task = this.store.get<Task>("task", job.taskId)!;
      const node = this.node(job.nodeId);
      if (node.previewJobId === job.id && node.revision === job.nodeRevision &&
          task.revision === job.taskRevision && task.state !== "cancelled") {
        if (files && job.state === "completed" && job.handoff && !job.stop && run.outcome === "completed") {
          this.putNode({ ...node, draft: { runId: run.id, files, inputs: run.graphAttempt!.inputs },
            repair: undefined, blocked: undefined });
        } else if (task.state !== "paused") {
          this.putNode({ ...node, blocked: node.blocked ?? failure ?? "预览作业未完成，帧文件未验收" });
        }
      }
      this.previewJobs.applied(id);
      return true;
    });
  }

  invalidate(id: string, key?: string, instruction?: string, parent?: Task) {
    const plan = this.get(id);
    const all = this.nodes(id);
    const nodes = key === undefined ? all : affectedGraphNodes(all, key);
    if (!nodes.length) throw new Error("没有该成果");
    for (const node of nodes)
      this.putNode({
        ...node, revision: node.revision + 1, attempts: 0,
        accepted: undefined, draft: undefined, repair: undefined,
        feedbackRunId: undefined, blocked: undefined,
        ...(node.research && (node.research.spec.mode === "local"
          ? { accepted: node.accepted, blocked: node.blocked }
          : { research: { spec: node.research.spec } })),
        ...(node.key === key && instruction !== undefined ? { instruction } : {}),
        ...(parent && node.id === plan.rootNodeId ? { goal: parent.goal, acceptance: parent.acceptance } : {}),
      });
    if (nodes.some((node) => !node.research)) {
      plan.finalAccepted = undefined;
      plan.finalFailure = undefined;
      plan.manualReview = undefined;
      plan.userAccepted = undefined;
      plan.assembled = plan.assembled && ["applying", "unknown"].includes(plan.assembled.state)
        ? { ...plan.assembled, stale: true }
        : undefined;
      this.put(plan);
    }
    return nodes;
  }

  budget(id: string, limits: GraphPlan["limits"]) {
    const plan = this.get(id);
    this.put({ ...plan, limits });
  }
  confirm(id: string) { this.put({ ...this.get(id), userAccepted: true }); }
}
