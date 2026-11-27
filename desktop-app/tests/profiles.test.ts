import test from "node:test";
import { submitAgentForm } from "../src/shared/agent-form";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { Brain } from "../src/hub/brain";
import { Vault } from "../src/hub/security";
import {
  CHIEF,
  CHIEF_MODEL,
  MEMBER_MODEL,
  readSettings,
  defaultProfile,
  defaults,
  type Run,
} from "../src/shared/contracts";
class Native extends EventEmitter {
  initialized = true;
  calls: any[] = [];
  replies: any[] = [];
  seq = 0;
  sandboxOverride?: Record<string, unknown>;
  runtimeRootsOverride?: string[];
  async call(method: string, p: any) {
    this.calls.push({ method, p });
    if (method === "project/list") return { data: [] };
    if (method === "model/list")
      return {
        data: [
          {
            model: "limited",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      };
    if (method === "thread/start" || method === "thread/resume")
      return {
        thread: { id: p.threadId || "thread-" + ++this.seq },
        model: p.model,
        reasoningEffort: p.config?.model_reasoning_effort,
        sandbox: this.sandboxOverride ?? {
          type:
            p.sandbox === "read-only"
              ? "readOnly"
              : p.sandbox === "workspace-write"
                ? "workspaceWrite"
                : "dangerFullAccess",
          networkAccess: false,
          writableRoots: [],
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        runtimeWorkspaceRoots:
          this.runtimeRootsOverride ?? p.runtimeWorkspaceRoots,
        approvalPolicy: p.approvalPolicy,
      };
    if (method === "turn/start") return { turn: { id: "turn-" + ++this.seq } };
    return {};
  }
  reply(id: any, result: any) {
    this.replies.push({ id, result });
  }
}
async function fixture() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "profiles-"));
  const n = new Native(),
    h = new Hub(join(dir, "state"), n as any);
  h.store.put("settings", {
    id: "global",
    value: { ...h.settings(), executorBackend: "codex" },
  });
  const project = join(dir, "workspace");
  await mkdir(project);
  const p = await h.request({
    op: "project.add",
    path: project,
    name: "样例项目",
  });
  return { h, n, dir, p };
}
const member = { model: MEMBER_MODEL, effort: "max" } as const;
async function wait(h: Hub) {
  for (let i = 0; h.scheduling && i < 300; i++)
    await new Promise((r) => setTimeout(r, 5));
}
async function finish(h: Hub, r: Run) {
  await h.handleEvent({
    method: "turn/completed",
    params: {
      threadId: r.threadId,
      turn: { id: r.turnId, status: "completed", items: [] },
    },
  });
}
test("legacy built-in defaults migrate without resetting explicit newer choices; both API protocols carry the selected effort", async () => {
  assert.deepEqual(
    defaultProfile(
      readSettings({ model: "gpt-6.1-sol", codexModel: "" }),
      true,
    ),
    { model: CHIEF_MODEL, effort: "max" },
  );
  assert.equal(
    readSettings({ model: "my-model", codexModel: "other" }).model,
    "my-model",
  );
  assert.equal(
    readSettings({ ...defaults, model: "gpt-6.1-sol", reasoningEffort: "low" })
      .model,
    "gpt-6.1-sol",
  );
  const b = new Brain(new Vault(".")),
    sent: any[] = [];
  b.request = async (_s, route, body) => {
    sent.push(structuredClone(body));
    if (body.reasoning?.summary) throw Error("PUBLIC_SUMMARY_UNSUPPORTED");
    return route === "responses"
      ? { model: body.model, output_text: "ok" }
      : { model: body.model, choices: [{ message: { content: "ok" } }] };
  };
  await b.complete(
    {
      ...defaults,
      protocol: "responses",
      model: "selected",
      reasoningEffort: "high",
    },
    "fixture",
    "fixture",
  );
  assert.deepEqual(sent[0].reasoning, { summary: "auto", effort: "high" });
  assert.deepEqual(sent[1].reasoning, { effort: "high" });
  assert.ok(sent.every((x) => x.model === "selected"));
  await b.complete(
    { ...defaults, protocol: "chat", reasoningEffort: "low" },
    "fixture",
    "fixture",
  );
  assert.equal(sent.at(-1).reasoning_effort, "low");
});
test("all new nodes wait for confirmation, survive restart, cancel cleanly and use the confirmed per-node profile", async () => {
  const { h, n, dir, p } = await fixture();
  let active = h;
  try {
    const first = await h.request({
      op: "chat",
      text: "为样例项目新开「验收」需求讨论",
      requestId: "talk",
    });
    assert.ok(first.launchId);
    assert.equal(h.store.all("agent").length, 0);
    assert.equal(h.store.all("task").length, 0);
    h.store.close();
    active = new Hub(join(dir, "state"), n as any);
    const hub = active,
      card = hub.launches.pending()[0];
    assert.deepEqual(card.profile, member);
    const prof = { model: "discussion-choice", effort: "high" };
    const a = await hub.request({
      op: "agent.launch.confirm",
      id: card.id,
      profile: prof,
    });
    assert.equal(
      (
        await hub.request({
          op: "agent.launch.confirm",
          id: card.id,
          profile: prof,
        })
      ).openAgentId,
      a.openAgentId,
    );
    let started!: () => void, reply!: (v: any) => void;
    const inFlight = new Promise<void>((r) => (started = r));
    hub.brain.complete = async (cfg) => {
      assert.equal(cfg.model, prof.model);
      assert.equal(cfg.reasoningEffort, "high");
      started();
      return new Promise((r) => (reply = r));
    };
    const turn = hub.request({
      op: "agent.send",
      agentId: a.openAgentId,
      text: "核对文档内容",
      requestId: "msg",
    });
    await inFlight;
    await hub.request({
      op: "agent.configure",
      agentId: a.openAgentId,
      profile: member,
    });
    reply({ text: "讨论回复", model: prof.model, usage: null });
    await turn;
    assert.deepEqual(hub.profile(a.openAgentId), member);
    assert.deepEqual(hub.profile(CHIEF), { model: CHIEF_MODEL, effort: "max" });
    hub.brain.handoff = async (cfg) => {
      assert.equal(cfg.model, CHIEF_MODEL);
      return {
        ready: true,
        goal: "核对文档",
        mode: "read",
        constraints: "",
        acceptance: "标题",
        question: "",
      };
    };
    const proposed = await hub.request({
      op: "agent.send",
      agentId: a.openAgentId,
      text: "按这个方案做",
      requestId: "go",
    });
    assert.equal(hub.store.all("task").length, 0);
    assert.equal(n.calls.filter((x) => x.method === "turn/start").length, 0);
    await hub.request({ op: "agent.launch.cancel", id: proposed.launchId });
    await assert.rejects(
      hub.request({
        op: "agent.launch.confirm",
        id: proposed.launchId,
        profile: member,
      }),
    );
    const req = await hub.request({
      op: "agent.send",
      agentId: a.openAgentId,
      text: "按这个方案做",
      requestId: "go-again",
    });
    const worker = await hub.request({
      op: "agent.launch.confirm",
      id: req.launchId,
      profile: member,
    });
    await wait(hub);
    const child = await hub.request({
      op: "agent.delegate",
      agentId: worker.worker,
      goal: "核对名称",
      requestId: "deep",
    });
    assert.ok(child.launchId);
    assert.equal(hub.store.all("agent").length, 2);
    const deep = await hub.request({
      op: "agent.launch.confirm",
      id: child.launchId,
      profile: { model: "reviewer", effort: "low" },
    });
    assert.equal(hub.desk.agent(deep.worker).parentAgentId, worker.worker);
    assert.equal(hub.profile(deep.worker).model, "reviewer");
  } finally {
    await wait(active);
    active.shuttingDown = true;
    active.store.close();
  }
});
test("native defaults inherit local permissions without auto-approving unexpected requests; stricter scopes and the next-turn profile are explicit", async () => {
  const { h, n, p } = await fixture();
  try {
    const req = await h.request({
      op: "task.create",
      requestId: "write",
      value: { projectId: p.id, goal: "文字答复", mode: "write" },
    });
    assert.ok(req.launchId);
    assert.equal(n.calls.length, 0);
    await h.request({ op: "agent.models", backend: "codex" });
    await assert.rejects(
      h.request({
        op: "agent.launch.confirm",
        id: req.launchId,
        profile: { model: "limited", effort: "max" },
      }),
    );
    assert.equal(h.launches.pending().length, 1);
    const w = await h.request({
      op: "agent.launch.confirm",
      id: req.launchId,
      profile: member,
    });
    await wait(h);
    const t = h.getTask(w.id),
      r = h.store.get<Run>("run", t.runId!)!;
    const params = n.calls.find((x) => x.method === "turn/start").p;
    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.sandboxPolicy, undefined);
    assert.equal(params.model, MEMBER_MODEL);
    assert.equal(params.effort, "max");
    assert.equal(r.actualSandbox, "dangerFullAccess");
    h.handleApproval({
      id: 4,
      method: "item/commandExecution/requestApproval",
      params: { threadId: r.threadId, turnId: r.turnId, command: "fixture" },
    });
    assert.equal(h.store.all("approval").length, 0);
    assert.deepEqual(n.replies.at(-1).result, { decision: "decline" });
    h.handleApproval({
      id: 5,
      method: "item/tool/requestUserInput",
      params: { threadId: r.threadId, turnId: r.turnId, questions: [] },
    });
    assert.equal(h.store.all("approval").length, 1);
    await h.request({
      op: "agent.configure",
      agentId: w.worker,
      profile: { model: "limited", effort: "low" },
    });
    assert.deepEqual(h.store.get<Run>("run", r.id)!.profile, member);
    await finish(h, r);
    await h.request({
      op: "agent.send",
      agentId: w.worker,
      text: "下一轮核对",
      requestId: "next",
      revision: t.revision,
      runId: r.id,
      turnId: r.turnId,
    });
    await wait(h);
    let next = n.calls.filter((x) => x.method === "turn/start").at(-1).p;
    assert.equal(next.model, "limited");
    assert.equal(next.effort, "low");
    assert.equal(next.threadId, r.threadId);
    const rr = h.store.get<Run>("run", h.getTask(t.id).runId!)!;
    await finish(h, rr);
    await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      requestId: "read",
      profile: member,
      value: { projectId: p.id, goal: "仅阅读", mode: "read" },
    });
    await wait(h);
    next = n.calls.filter((x) => x.method === "turn/start").at(-1).p;
    assert.equal(next.approvalPolicy, "never");
    assert.equal(next.sandboxPolicy.type, "readOnly");
    assert.equal(next.sandboxPolicy.networkAccess, false);
  } finally {
    await wait(h);
    h.shuttingDown = true;
    h.store.close();
  }
});

test("Codex 回执与项目权限不符时，不发送任务目标", async () => {
  const { h, n, p } = await fixture();
  try {
    const scoped = {
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: [],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    const mismatches: [Record<string, unknown>, string[]?][] = [
      [{}, undefined],
      [{ ...scoped, type: "readOnly" }, undefined],
      [{ ...scoped, type: "dangerFullAccess" }, undefined],
      [{ ...scoped, networkAccess: true }, undefined],
      [{ ...scoped, networkAccess: undefined }, undefined],
      [{ ...scoped, writableRoots: [join(p.path, "..")] }, undefined],
      [{ ...scoped, excludeTmpdirEnvVar: false }, undefined],
      [scoped, [p.path, join(p.path, "..", "other")]],
      [scoped, []],
    ];
    for (const [index, [sandbox, roots]] of mismatches.entries()) {
      n.sandboxOverride = sandbox;
      n.runtimeRootsOverride = roots;
      const created = await submitAgentForm(h.request.bind(h), {
        op: "task.create",
        requestId: "restricted-" + index,
        value: {
          projectId: p.id,
          goal: "在项目内实现",
          mode: "write",
          access: "project",
        },
        profile: member,
      });
      await wait(h);
      const task = h.getTask(created.id);
      const run = h.store.get<Run>("run", task.runId!)!;
      assert.equal(task.state, "blocked");
      assert.match(task.reason!, /沙箱回执.*不符/);
      assert.equal(run.actualSandbox, sandbox.type);
      assert.equal(run.actualSandboxNetwork, sandbox.networkAccess);
      assert.equal(run.outcome, "failed");
      assert.equal(
        n.calls.some((item) => item.method === "turn/start"),
        false,
      );
    }
    n.sandboxOverride = scoped;
    n.runtimeRootsOverride = undefined;
    const allowed = await submitAgentForm(h.request.bind(h), {
      op: "task.create",
      requestId: "known-project-scope",
      value: {
        projectId: p.id,
        goal: "在项目内实现",
        mode: "write",
        access: "project",
      },
      profile: member,
    });
    await wait(h);
    assert.equal(h.getTask(allowed.id).state, "active");
    assert.equal(
      n.calls.filter((item) => item.method === "turn/start").length,
      1,
    );
  } finally {
    await wait(h);
    h.shuttingDown = true;
    h.store.close();
  }
});
