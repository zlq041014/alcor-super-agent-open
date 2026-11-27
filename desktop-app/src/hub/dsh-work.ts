import { join } from "node:path";
import { openDsh, type DshSession } from "../adapter/dsh";
import { RpcError } from "../adapter/codex";
import { dshReceipt } from "../adapter/dsh-receipt";
import type { WorkspaceOptions } from "../adapter/dsh-files";
import {
  apiTarget,
  defaultProfile,
  type Command,
  type Run,
  type Settings,
  type Task,
} from "../shared/contracts";
import { hash, redact } from "./security";
import { stamp } from "./store";
import type { Hub } from "./service";

function failureMessage(reason: Run["nativeEndReason"]) {
  if (reason === "max-tokens")
    return "DSH 达到本回合的模型输出上限，已保留实际文件变更，回合未正常结束";
  if (reason === "blocked") return "DSH 报告本回合被阻塞，未正常结束";
  if (reason === "error") return "DSH 报告本回合执行失败";
  return "DSH 未提供完整的最终答复";
}
export class MissingDshReceipt extends Error {}

export type DshWriter = Omit<WorkspaceOptions, "write"> & {
  fresh: boolean;
  canSend?: () => boolean;
};

export class DshWork {
  sessions = new Map<string, DshSession>();
  status = { status: "未检测", version: undefined as string | undefined };
  constructor(private hub: Hub) {}
  private home(run: Run) {
    return join(this.hub.dir, "dsh", hash(run.graphAttempt ? run.id : run.taskId));
  }
  async probe() {
    const cfg = this.hub.settings(),
      dir = join(this.hub.dir, "dsh", "probe");
    try {
      const s = await openDsh({
        cfg,
        dir,
        cwd: dir,
        write: false,
        profile: defaultProfile(cfg),
      });
      try {
        this.status = { status: "ACP 就绪", version: s.version };
      } finally {
        s.close();
      }
      return this.status;
    } catch (e) {
      this.status = { status: "检测失败", version: undefined };
      throw e;
    } finally {
      this.hub.changed();
    }
  }
  async start(
    task: Task,
    run: Run,
    command: Command,
    cfg: Settings,
    prompt: string,
    memoryVersion: string,
    methodVersion: string,
    previous?: Run,
    writer?: DshWriter,
  ) {
    const graph = run.graphAttempt;
    if (graph && !writer?.canSend)
      throw new Error("成果回合缺少派发校验");
    const native = task.advance === "loop-native" && !graph;
    const plan = graph ? this.hub.graph.ledger.get(task.loopId!) : undefined;
    const write = graph ? graph.role === "execute" : task.mode === "write";
    prompt = "星引派发编号：" + command.id + "\n" + prompt;
    if (run.attachmentInputs?.some((input) => input.kind === "image"))
      throw new Error("此 DSH 连接器接收文本任务；含图片的任务请使用 Codex");
    const { store } = this.hub;
    const routeHash = hash(
      JSON.stringify([
        cfg.apiSource,
        apiTarget(cfg),
        run.profile,
        task.mode,
        run.workPath,
        ...(native ? ["native"] : []),
      ]),
    );
    const resume =
      !graph && !writer?.fresh &&
      previous?.backend === "dsh" &&
      !previous.methodInput &&
      previous.apiRouteHash === routeHash &&
      task.memoryVersion === memoryVersion
        ? previous.threadId
        : undefined;
    const home = this.home(run);
    const session = await openDsh({
      cfg,
      dir: home,
      cwd: run.workPath,
      write,
      native,
      nativeGraph: plan?.nativeTools === true,
      taskBudget: native || plan?.version === 3,
      paths: writer?.paths,
      journal: writer?.journal,
      graph: writer?.graph,
      research: writer?.research,
      reportResearchUse: writer?.reportResearchUse,
      allowPreview: writer?.allowPreview,
      profile: run.profile!,
      resume,
      key: await this.hub.brain.key(cfg),
    });
    const latest = this.hub.getTask(task.id);
    if (this.hub.methods.version(task.projectId) !== methodVersion) {
      session.close();
      throw new Error("工作方法在准备期间变化，未发送执行回合");
    }
    if (
      latest.revision !== run.revision ||
      (graph ? !writer!.canSend!() :
        (latest.state !== "active" || (task.loopId && !this.hub.loop.writerActive(task, run)))) ||
      this.hub.shuttingDown
    ) {
      session.close();
      if (graph) {
        this.hub.graph.unsent(run);
        return;
      }
      if (task.loopId && !this.hub.shuttingDown) {
        await this.hub.finishRun(run, { status: "interrupted" });
        return;
      }
      run.state = "ended";
      run.outcome = "interrupted";
      command.state = "voided";
      store.tx(() => {
        store.put("run", run);
        store.put("command", command);
      });
      this.hub.changed();
      return;
    }
    this.sessions.set(run.id, session);
    this.status = { status: "ACP 就绪", version: session.version };
    run.threadId = session.id;
    run.turnId = command.id; // ACP has a session id; this id correlates our one outstanding prompt.
    run.model = run.profile!.model;
    run.adapterVersion = session.version;
    run.actualEffort = session.effort;
    run.actualSandbox = native ? "danger-full-access" : write ? "workspace-write" : "read-only";
    run.apiRouteHash = routeHash;
    run.apiSource = cfg.apiSource;
    if (!graph) prompt = this.hub.methods.attach(latest, run, prompt);
    command.state = "dispatching";
    command.payloadHash = hash(prompt);
    store.tx(() => {
      store.put("run", run);
      store.put("command", command);
      store.put("task", { ...latest, memoryVersion });
    });
    const event = (method: string, p: any) =>
      this.hub.handleEvent(
        {
          method,
          params: { threadId: session.id, turnId: command.id, ...p },
        },
        "dsh",
      );
    const enqueue = (fn: () => Promise<void>) => {
      this.hub.eventQueue = this.hub.eventQueue
        .then(fn)
        .catch(() => this.hub.fault("DSH 运行记录保存失败"));
      return this.hub.eventQueue;
    };
    let acknowledged = false,
      lastMessage: string | undefined,
      finalText = "";
    const acknowledge = async () => {
      if (acknowledged) return;
      acknowledged = true;
      store.tx(() => {
        store.put("command", {
          ...command,
          state: "accepted",
          receipt: session.id,
        });
        const current = store.get<Run>("run", run.id)!;
        if (current.attachmentInputs?.length && !current.inputsAcceptedAt)
          store.put("run", { ...current, inputsAcceptedAt: stamp() });
      });
      this.hub.desk.receipt(latest, run, "sent");
      await event("turn/started", {});
    };
    const titles = new Map<string, string>();
    void session
      .prompt(prompt, (u) => {
        if (!u) return;
        // Never record private thought chunks, raw tool payloads or ACP error data.
        void enqueue(async () => {
          await acknowledge();
          if (
            u.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text" &&
            typeof u.content.text === "string"
          ) {
            if (lastMessage !== u.messageId) finalText = "";
            lastMessage = u.messageId;
            finalText += u.content.text;
            await event("item/agentMessage/delta", { delta: u.content.text });
          }
          if (
            ["tool_call", "tool_call_update"].includes(u.sessionUpdate) &&
            typeof u.toolCallId === "string"
          ) {
            if (u.sessionUpdate === "tool_call") finalText = "";
            if (typeof u.title === "string")
              titles.set(u.toolCallId, u.title.slice(0, 120));
            const done = u.status === "completed" || u.status === "failed";
            await event(done ? "item/completed" : "item/started", {
              item: {
                id: run.id + ":" + u.toolCallId,
                type: "dynamicToolCall",
                tool: titles.get(u.toolCallId) || "DSH 工具",
                status: u.status,
                success: u.status !== "failed",
              },
            });
          }
        });
      })
      .then(
        (out) =>
          enqueue(async () => {
            await acknowledge();
            const receipt = await dshReceipt(
              home,
              run.workPath,
              session.id,
              command.payloadHash,
            );
            const endReason =
              receipt?.nativeEndReason ??
              (out.reason === "max_tokens" ? "max-tokens" : undefined);
            if (receipt) finalText = receipt.answer;
            if (finalText)
              await event("item/completed", {
                item: {
                  type: "agentMessage",
                  id: run.id + ":answer",
                  text: finalText,
                },
              });
            const stopped =
              out.reason === "cancelled" || receipt?.status === "interrupted";
            const ok =
              out.reason === "end_turn" &&
              receipt?.status !== "failed" &&
              !!finalText.trim() &&
              out.accepted &&
              !out.error;
            await event("turn/completed", {
              turn: {
                id: command.id,
                status: stopped ? "interrupted" : ok ? "completed" : "failed",
                nativeEndReason: endReason,
                dshUsage: out.usage,
                error:
                  stopped || ok
                    ? undefined
                    : {
                        message: out.error || failureMessage(endReason),
                      },
              },
            });
          }),
        (e) =>
          enqueue(async () => {
            if (e instanceof RpcError && !e.uncertain)
              await event("turn/completed", {
                turn: {
                  id: command.id,
                  status: "failed",
                  dshUsage: session.usage(),
                  error: { message: e.message },
                },
              });
            else this.hub.markUnknown("dsh", run.id);
          }),
      )
      .finally(() => {
        this.sessions.delete(run.id);
        session.close();
      });
    this.hub.changed();
  }
  async reconcile(run?: Run) {
    if (!run?.threadId || run.state !== "unknown")
      throw new Error("只有状态未知的 DSH 回合需要核对");
    const command = this.hub.store.get<Command>("command", run.commandId);
    const receipt =
      command &&
      (await dshReceipt(
        this.home(run),
        run.workPath,
        run.threadId,
        command.payloadHash,
      ));
    if (!receipt)
      throw new MissingDshReceipt(
        "尚无与本次派发匹配的 DSH 结束记录；保持未知，不自动重派",
      );
    const current = this.hub.store.get<Run>("run", run.id)!;
    if (current.state === "unknown") {
      current.response = redact(receipt.answer);
      if (current.attachmentInputs?.length) current.inputsAcceptedAt ??= stamp();
      await this.hub.finishRun(current, {
        status: receipt.status,
        nativeEndReason: receipt.nativeEndReason,
        ...(receipt.status === "failed"
          ? { error: { message: failureMessage(receipt.nativeEndReason) } }
          : {}),
      });
    }
  }
  cancel(runId: string) {
    const s = this.sessions.get(runId);
    if (!s) throw new RpcError("DSH 会话已断开，无法确认停止", true);
    s.cancel();
  }
  close() {
    for (const s of this.sessions.values()) s.close();
  }
}
