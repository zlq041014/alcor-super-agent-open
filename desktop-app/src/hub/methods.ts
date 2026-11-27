import {
  APP_VERSION,
  type MethodReceipt,
  type Run,
  type Task,
  type WorkIssue,
  type WorkMethod,
} from "../shared/contracts";
import { hash } from "./security";
import type { Hub } from "./service";
import { entity, stamp, type Store } from "./store";

interface Verification {
  id: string;
  taskId: string;
  runId: string;
  revision: number;
  passed: boolean;
}
interface Issue extends WorkIssue {
  scopeKey?: string;
}
interface Method extends WorkMethod {
  scopeKey: string;
  recheckAt?: string;
}
const steps = [
  "先把交付件路径和目标内容逐项对照现有文件验收条件。",
  "如有失败，依据实际失败回执修正交付件，再核对原验收条件，不改验收标准。",
];
const methodVersion = 1;
const deletedMethod = (id: string) => "work-method:" + id;

export function restoreMethod(
  item: Method,
  tombstones: Set<string>,
  current?: Method,
) {
  if (tombstones.has(deletedMethod(item.id))) return;
  if (
    current?.state === "needs-review" &&
    current.recheckAt &&
    current.revision > item.revision
  )
    return {
      ...item,
      state: "needs-review",
      revision: current.revision + 1,
      recheckAt: current.recheckAt,
      counterexample: current.counterexample,
      reason: "更新证据已撤销旧证明，恢复后需独立复验",
    };
  return item.state === "active"
    ? { ...item, state: "verified", revision: item.revision + 1 }
    : item;
}

function privateMethod(item: Method): WorkMethod {
  const { scopeKey: _key, recheckAt: _at, ...publicFields } = item;
  return publicFields;
}

export class Methods {
  constructor(private readonly hub: Hub) {}

  issues() {
    return this.hub.store
      .all<Issue>("work-issue")
      .filter((item) => item.kind !== "file-check" || item.failed.length >= 2)
      .map(({ scopeKey: _key, ...issue }) => issue);
  }
  list() {
    return this.hub.store.all<Method>("work-method").map(privateMethod);
  }
  references(projectId: string) {
    return this.hub.store
      .all<Method>("work-method")
      .filter(
        (item) =>
          item.projectId === projectId &&
          item.state === "active" &&
          item.environment.app === APP_VERSION,
      )
      .map(({ id, revision }) => ["method:" + id, revision] as const);
  }
  version(projectId: string) {
    return hash(JSON.stringify(this.references(projectId)));
  }

  private scope(task: Task, run: Run) {
    if (
      !task.checks?.length ||
      task.loopId ||
      !run.adapterVersion ||
      !run.model ||
      !run.profile
    )
      return;
    const environment = {
      app: APP_VERSION,
      backend: run.backend ?? "codex",
      adapter: run.adapterVersion,
      model: run.model,
      effort: run.actualEffort ?? run.profile.effort,
    };
    const key = hash(
      JSON.stringify([
        methodVersion,
        task.projectId,
        run.workPath.toLowerCase(),
        task.mode,
        task.access,
        task.isolate,
        task.checks,
        environment,
        run.apiRouteHash,
        run.actualSandbox,
        run.actualSandboxNetwork,
        run.toolApproval,
      ]),
    );
    return { key, environment };
  }

  private methodFor(scopeKey: string) {
    const row = this.hub.store.db
      .prepare(
        "SELECT data FROM records WHERE kind='work-method' AND json_extract(data,'$.scopeKey')=? ORDER BY updated DESC LIMIT 1",
      )
      .get(scopeKey);
    return row ? (JSON.parse(String(row.data)) as Method) : undefined;
  }

  attach(task: Task, run: Run, prompt: string) {
    const scope = this.scope(task, run);
    if (!scope) return prompt;
    const method = this.methodFor(scope.key);
    if (
      method?.state !== "active" ||
      method.proofs.some((proof) => proof.taskId === task.id)
    )
      return prompt;
    run.methodInput = { id: method.id, revision: method.revision };
    return (
      prompt +
      "\n\n同项目同条件下验证过的做法（仅作核对建议，不改变授权或验收）：\n- " +
      method.steps.join("\n- ")
    );
  }

  // Called in the transaction that commits the real verification and task outcome.
  verified(task: Task, run: Run, verification: Verification) {
    if (!run.turnId) return;
    const { store } = this.hub;
    const scope = this.scope(task, run);
    if (!scope) return;
    const proof = {
      taskId: task.id,
      revision: task.revision,
      runId: run.id,
      verificationId: verification.id,
    };
    const method = this.methodFor(scope.key);
    if (
      !verification.passed &&
      method &&
      method.state === "active" &&
      method.id === run.methodInput?.id &&
      method.revision === run.methodInput.revision
    ) {
      this.saveMethod(store, {
        ...method,
        state: "needs-review",
        counterexample: proof,
        reason: "使用方法后原检查仍失败，需要独立复验",
        recheckAt: stamp(),
      });
    }
    const issueId = hash(
      JSON.stringify(["file-check", task.id, task.revision, scope.key]),
    );
    const prior = store.get<Issue>("work-issue", issueId);
    if (
      prior?.failed.some((item) => item.runId === run.id) ||
      prior?.recovery?.runId === run.id
    )
      return;
    if (!verification.passed) {
      const issue: Issue = prior ?? {
        ...entity(),
        id: issueId,
        taskId: task.id,
        projectId: task.projectId,
        revision: task.revision,
        kind: "file-check",
        state: "open",
        failed: [],
        scopeKey: scope.key,
      };
      store.put("work-issue", {
        ...issue,
        state: "open",
        failed: [...issue.failed, proof],
        updatedAt: stamp(),
      });
      if (issue.failed.length === 1)
        store.event("work.issue.repeated", issueId, {
          taskId: task.id,
          revision: task.revision,
        });
      return;
    }
    if (
      !prior?.failed.some((item) => item.verificationId === run.correctionInput)
    )
      return;
    store.put("work-issue", {
      ...prior,
      state: "recovered",
      recovery: proof,
      updatedAt: stamp(),
    });
    store.event("work.issue.recovered", issueId, {
      runId: run.id,
      verificationId: verification.id,
    });
    if (!method) {
      if (
        prior.failed.length < 2 ||
        store.db
          .prepare("SELECT 1 FROM tombstones WHERE id=?")
          .get("work-method-origin:" + issueId)
      )
        return;
      const candidate: Method = {
        ...entity(),
        scopeKey: scope.key,
        projectId: task.projectId,
        originIssueId: issueId,
        originTaskId: task.id,
        state: "candidate",
        revision: 1,
        steps,
        proofs: [proof],
        environment: scope.environment,
        reason: "原工作已通过同一检查，等待另一项独立工作的复验",
      };
      store.put("work-method", candidate);
      store.event("work.method.derived", candidate.id, { issueId });
      return;
    }
    if (!["candidate", "needs-review"].includes(method.state)) return;
    const fresh = (receipt: MethodReceipt) =>
      !method.recheckAt ||
      (store.get<Run>("run", receipt.runId)?.endedAt ?? "") > method.recheckAt;
    if (method.proofs.some((item) => item.taskId === task.id && fresh(item)))
      return;
    const proofs = [...method.proofs, proof];
    const independent = proofs.filter(fresh);
    const confirmed =
      independent.length >= 2 &&
      (!method.counterexample ||
        independent.some(
          (item) => item.taskId === method.counterexample!.taskId,
        ));
    this.saveMethod(store, {
      ...method,
      proofs,
      state: confirmed ? "verified" : method.state,
      reason: confirmed
        ? "原检查和独立工作的复验均有实际通过记录"
        : "仍需更多独立复验",
    });
  }

  // Keep the original receipt and never claim that a stopped or failed attempt passed.
  native(task: Task, run: Run, kind: "native-recovery" | "scope-mismatch") {
    const { store } = this.hub;
    const id = hash(JSON.stringify([task.id, run.revision, kind]));
    const prior = store.get<Issue>("work-issue", id);
    const proof = { taskId: task.id, revision: run.revision, runId: run.id };
    if (prior?.failed.some((item) => item.runId === run.id)) return;
    const item: Issue = prior ?? {
      ...entity(),
      id,
      projectId: task.projectId,
      taskId: task.id,
      revision: run.revision,
      kind,
      state: "open",
      failed: [],
    };
    store.put("work-issue", {
      ...item,
      updatedAt: stamp(),
      failed: [...item.failed, proof],
      ...(kind === "native-recovery"
        ? { state: "recovered", recovery: proof }
        : {}),
    });
  }

  manage(
    id: string,
    revision: number,
    action: "enable" | "pause" | "delete" | "recheck",
  ) {
    const { store } = this.hub;
    const item = store.get<Method>("work-method", id);
    if (!item || item.revision !== revision)
      throw new Error("方法已变化，请刷新后操作");
    store.tx(() => {
      if (action === "delete") {
        store.remove("work-method", id);
        store.db
          .prepare("INSERT OR REPLACE INTO tombstones VALUES(?,?)")
          .run(deletedMethod(id), stamp());
        store.db
          .prepare("INSERT OR IGNORE INTO tombstones VALUES(?,?)")
          .run("work-method-origin:" + item.originIssueId, stamp());
        store.event("work.method.deleted", id);
      } else if (action === "recheck") {
        this.saveMethod(store, {
          ...item,
          state: "needs-review",
          recheckAt: stamp(),
          reason: "用户要求重新验证",
        });
      } else {
        if (item.state !== (action === "enable" ? "verified" : "active"))
          throw new Error("当前方法状态不允许此操作");
        this.saveMethod(store, {
          ...item,
          state: action === "enable" ? "active" : "verified",
        });
      }
    });
    this.hub.changed();
    return true;
  }

  private saveMethod(store: Store, item: Method) {
    store.put("work-method", {
      ...item,
      revision: item.revision + 1,
      updatedAt: stamp(),
    });
    store.event("work.method.updated", item.id, {
      state: item.state,
      revision: item.revision + 1,
    });
  }
}
