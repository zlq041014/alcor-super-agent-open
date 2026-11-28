import test from "node:test";
import { submitAgentForm } from "../src/shared/agent-form";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { Brain } from "../src/hub/brain";
import { Vault } from "../src/hub/security";
import { dshCatalogOptions } from "../src/adapter/dsh";
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

test("executor catalogs separate equal IDs, atomically save the default source, and discard old responses", async () => {
  const { h, n, p } = await fixture();
  try {
    h.dsh.models = async () => [{ id: "limited", efforts: ["none", "high"] }, { id: "dsh-only", efforts: [] }];
    let downstreamApi = 0;
    h.brain.models = async () => { downstreamApi++; return ["api-only"]; };
    const from = (backend: "codex" | "dsh") => h.request({ op: "executor.models", backend });
    const [codex, dsh] = await Promise.all([from("codex"), from("dsh")]);
    assert.deepEqual(codex.entries, [{ id: "limited", efforts: ["low"] }]);
    assert.deepEqual(dsh.entries, [{ id: "limited", efforts: ["none", "high"] }, { id: "dsh-only", efforts: [] }]);
    assert.equal(downstreamApi, 0);
    const original = h.settings();
    const save = (backend: string, catalogVersion: string, effort: string) => h.request({ op: "executor.modelDefault", backend, catalogVersion,
      profile: { model: "limited", effort } });
    await assert.rejects(save("codex", dsh.catalogVersion, "low"), /目录已变化/);
    await assert.rejects(save("dsh", dsh.catalogVersion, "low"), /目录未确认/);
    await save("dsh", dsh.catalogVersion, "high");
    await h.request({ op: "settings", value: { ...original, theme: "dark" } });
    assert.equal(h.settings().executorBackend, "dsh");
    assert.equal(h.settings().executorProfiles?.dsh?.model, "limited");
    assert.equal(h.settings().model, original.model);
    assert.equal(h.settings().theme, "dark");
    await save("codex", codex.catalogVersion, "low");
    assert.equal(h.settings().executorBackend, "codex");
    assert.equal(h.settings().executorProfiles?.dsh?.effort, "high");
    const proposed = await h.request({ op: "task.create", requestId: "selected-default-source", value: {
      projectId: p.id, goal: "核对下次采用的执行路线", advance: "single", mode: "read",
    } });
    const card = h.launches.pending().find(value => value.id === proposed.launchId);
    assert.equal(card?.backend, "codex");
    assert.deepEqual(card?.profile, { model: "limited", effort: "low" });
    n.emit("disconnect");
    assert.equal((await h.snapshot()).executorModels.codex.state, "unread");
    await assert.rejects(save("codex", codex.catalogVersion, "low"), /目录已变化/);
    let release!: (rows: typeof dsh.entries) => void;
    h.dsh.models = async () => new Promise(resolve => { release = resolve; });
    const inFlight = from("dsh");
    while (!release) await Promise.resolve();
    await h.request({ op: "settings", value: { ...h.settings(), dshPath: "different.exe" } });
    release(dsh.entries);
    assert.equal((await inFlight).state, "unread");
    h.dsh.models = async () => { throw new Error("DSH 连接不可用"); };
    assert.deepEqual((await from("dsh")).entries, []);
    assert.equal((await h.snapshot()).executorModels.dsh.state, "unavailable");
    assert.ok(!n.calls.some(c => c.method === "turn/start"));
  } finally { h.shuttingDown = true; h.store.close(); }
});

test("DSH ACP catalog only projects advertised managed provider values and reported effort levels", () => {
  const choice = (provider: string, id: string) => ({ value: JSON.stringify([provider, id]), name: id });
  const options = [{ id: "model", type: "select", currentValue: choice("alcor-api", "same").value, options: [
    { group: "unrelated", options: [choice("unrelated", "same"), choice("unrelated", "other")] },
    { group: "alcor-api", options: [choice("alcor-api", "same"), choice("alcor-api", "next"), choice("alcor-api", "gone"), { value: "broken" }] },
  ] }, { id: "reasoning_effort", options: [{ value: "off" }, { value: "high" }, { value: "invented" }] }];
  assert.deepEqual(dshCatalogOptions(options, ["same", "next", "not-reported"]), [
    { id: "same", efforts: ["none", "high"] }, { id: "next", efforts: [] },
  ]);
  assert.deepEqual(dshCatalogOptions([], ["same"]), []);
});

test("launch confirmation fences model choices by source and catalog without losing a pending card", async () => {
  const { h, n, p } = await fixture();
  h.tick = async () => {};
  try {
    const prepare = () => h.request({ op: "task.create", requestId: "verified-executor-launch", value: {
      projectId: p.id, goal: "只读核对", advance: "single", mode: "read",
    } });
    const { launchId } = await prepare();
    const ask = (backend: "codex" | "dsh") => h.request({ op: "executor.models", backend });
    const confirm = (catalogVersion: string, model = "limited", effort = "low") =>
      h.request({ op: "agent.launch.confirm", id: launchId, catalogVersion, profile: { model, effort } });
    h.dsh.models = async () => [{ id: "limited", efforts: ["low"] }];
    const [a, dsh] = await Promise.all([ask("codex"), ask("dsh")]);
    await assert.rejects(confirm(dsh.catalogVersion), /目录已变化/);
    await assert.rejects(confirm(a.catalogVersion, "limited", "max"), /目录未确认/);
    const oldCall = n.call.bind(n);
    n.call = async (m, body) => m === "model/list" ? { data: [{ model: "replacement", supportedReasoningEfforts: [] }] } : oldCall(m, body);
    const newCatalog = await ask("codex");
    await assert.rejects(confirm(a.catalogVersion), /目录已变化/);
    await assert.rejects(confirm(newCatalog.catalogVersion), /目录已变化/);
    assert.equal(h.store.all("task").length, 0);
    assert.equal(h.launches.pending()[0]?.id, launchId);
    const receipt = await confirm(newCatalog.catalogVersion, "replacement", "default");
    assert.equal(h.getTask(receipt.id).backend, "codex");
    assert.deepEqual(h.profile(receipt.worker), { model: "replacement", effort: "default" });
    assert.equal(h.store.get("agent-launch", launchId)?.catalogVersion, newCatalog.catalogVersion);
    n.emit("disconnect");
    assert.deepEqual(await confirm(newCatalog.catalogVersion, "replacement", "default"), receipt);
    assert.equal(h.store.all("task").length, 1);
    const discussion = await h.request({ op: "discussion.open", projectId: p.id, title: "API 讨论", requestId: "discussion-no-catalog" });
    await assert.rejects(h.request({ op: "agent.launch.confirm", id: discussion.launchId, catalogVersion: a.catalogVersion,
      profile: { model: "limited", effort: "default" } }), /讨论不能使用执行端目录/);
  } finally { h.shuttingDown = true; h.store.close(); }
});

test("single-work form keeps the chosen catalog version through final confirmation", async () => {
  const { h, n, p } = await fixture();
  try {
    const { catalogVersion } = await h.request({ op: "executor.models", backend: "codex" });
    const calls: string[] = [];
    const send = async (request: any) => {
      calls.push(request.op);
      const result = await h.request(request);
      if (request.op === "task.create") {
        assert.equal(request.catalogVersion, undefined);
        // Even an identical list refreshed after the button was rendered is a new directory revision.
        await h.request({ op: "executor.models", backend: "codex" });
      }
      return result;
    };
    await assert.rejects(submitAgentForm(send, { op: "task.create", requestId: "catalog-form", catalogVersion,
      profile: { model: "limited", effort: "low" }, value: { projectId: p.id, goal: "只读", mode: "read", advance: "single" } }), /目录已变化/);
    assert.deepEqual(calls, ["task.create", "agent.launch.confirm"]);
    assert.equal(h.launches.pending().length, 1);
    assert.equal(h.store.all("task").length, 0);
    assert.ok(!n.calls.some(c => c.method === "turn/start"));
  } finally { h.shuttingDown = true; h.store.close(); }
});
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
