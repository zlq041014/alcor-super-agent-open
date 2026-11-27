import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  affectedGraphNodes, assertGraph, planGraph, validateProposal,
} from "../src/core/native-graph";
import {
  buildGraphWorkspace, sealGraphFiles, verifyGraphWorkspace,
} from "../src/hub/graph-workspace";
import { GraphLedger } from "../src/hub/graph-ledger";
import { graphInstructions } from "../src/hub/graph-standard";
import { backupFiles } from "../src/hub/backup-files";
import { workspaceMcp } from "../src/adapter/dsh-files";
import { hash } from "../src/hub/security";
import type { Command, Run, Task } from "../src/shared/contracts";
import type { GraphNode, GraphPlan, GraphRole } from "../src/shared/native-graph";
import { entity, Store } from "../src/hub/store";

const plan: GraphPlan = {
  ...entity(), version: 2, taskId: "parent", projectId: "fixture",
  rootNodeId: "scene", inputs: [], spent: 0,
  limits: { runs: 10, wallMinutes: 30, runMinutes: 10, retries: 2 },
};
function node(key: string, fields: Partial<GraphNode> = {}): GraphNode {
  return {
    ...entity(), id: key, key, title: key, loopId: plan.id, goal: "交付成果",
    acceptance: "核对输出文件", outputs: [key + ".txt"],
    dependencies: [], resources: [], required: true, revision: 1, attempts: 0,
    ...fields,
  };
}
const accepted = (n: GraphNode) => ({
  ...n, activeRunId: undefined,
  accepted: { runId: n.id + ":execute", reviewRunId: n.id + ":review", files: [], inputs: [] },
});
const status = { paused: false, expired: false, remaining: 10 };

test("失联分支保留资源，独立分支完成后才就绪整合", () => {
  const scene = node("scene", { activeRunId: "missing", resources: ["blender:desktop"] });
  const web = node("web");
  const caption = node("caption", { resources: ["blender:desktop"] });
  const runs = new Map<string, { role: GraphRole; state: string; nodeRevision: number }>([
    ["missing", { role: "execute", state: "unknown", nodeRevision: 1 }],
  ]);
  const held = new Set(scene.resources);
  const before = planGraph(plan, [scene, web, caption], runs, held, status);
  assert.deepEqual(before.jobs.map((job) => "node" in job && job.node.key), ["web"]);
  assert.deepEqual([...before.waiting], [["scene", "receipt"], ["caption", "resource"]]);
  const partial = planGraph(plan, [scene, accepted(web)], runs, held, status);
  assert.deepEqual(partial.jobs, []);
  const complete = planGraph(plan, [accepted(scene), accepted(web)], new Map(), new Set(), status);
  assert.equal(complete.jobs[0].role, "assemble");
  assert.deepEqual(complete.jobs[0].inputs.map((input) => input.reviewRunId), ["scene:review", "web:review"]);
});

test("必需下游依赖和最终复核的预算不会被可选节点领走", () => {
  const research = node("research", { required: false });
  const scene = node("scene", { dependencies: ["research"] });
  const polish = node("polish", { required: false });
  const graph = [research, scene, polish];
  const decide = (remaining: number, paused = false) =>
    planGraph(plan, graph, new Map(), new Set(), { ...status, remaining, paused });
  const reserve = decide(5);
  assert.equal(reserve.minimum, 5);
  assert.deepEqual(reserve.jobs.map((job) => "node" in job && job.node.key), ["research"]);
  assert.equal(reserve.waiting.get("polish"), "budget");
  assert.equal(decide(4).jobs.length, 0);
  assert.equal(decide(8, true).jobs.length, 0);
});

test("质量标准节点不进入组合，派工说明按角色、联网条件和轮次区分", () => {
  const card = accepted(node("standard", { kind: "standard", outputs: ["quality-standard.md"] }));
  const scene = accepted(node("scene", { dependencies: ["standard"] }));
  const ready = planGraph(plan, [card, scene], new Map(), new Set(), status);
  assert.equal(ready.jobs[0].role, "assemble");
  assert.deepEqual(ready.jobs[0].inputs.map((input) => input.nodeId), ["scene"]);
  const text = (role: "execute" | "review" | "final", change: Partial<Parameters<typeof graphInstructions>[0]> = {}) =>
    graphInstructions({ role, authoring: false, preview: false, card: true, web: false, last: false, ...change });
  assert.match(text("execute"), /逐维度写出自评档位/);
  assert.match(text("review"), /最多三项/);
  assert.doesNotMatch(text("review"), /最后一次复核/);
  assert.match(text("review", { last: true }), /最后一次复核/);
  assert.match(text("final"), /建议人工验收/);
  assert.match(text("execute", { authoring: true, web: true }), /只发送通用的类型和技法关键词/);
  assert.match(text("execute", { authoring: true }), /未联网/);
  assert.match(text("review", { authoring: true }), /核对这份质量标准卡/);
  assert.doesNotMatch(text("execute", { card: false }) + text("review", { card: false }), /质量标准/);
  assert.match(text("review", { card: false }), /其余列为备注。最后一行写「建议收口」或「建议继续」。$/);
});

test("成果版本只使依赖它的节点失效，方案拒绝成环和重叠写入", () => {
  const scene = node("scene", { outputs: ["assets/model.txt"] });
  const web = node("web");
  const adapter = node("adapter", { dependencies: ["scene"] });
  const smoke = node("smoke", { dependencies: ["adapter"] });
  const graph = [scene, web, adapter, smoke];
  assertGraph(graph);
  assert.deepEqual(affectedGraphNodes(graph, "scene").map((n) => n.key), ["scene", "adapter", "smoke"]);
  assert.throws(() => assertGraph([{ ...scene, dependencies: ["smoke"] }, web, adapter, smoke]), /不能成环/);
  assert.throws(() => validateProposal(graph, [node("other", { outputs: ["ASSETS"] })], []), /重叠/);
  assert.throws(() => validateProposal(graph, [node("other", { outputs: ["spec.txt"] })], ["spec.txt"]), /重叠/);
});

test("独立组合目录从冻结版本重建，冲突后旧结果和原目录均保留", async (t) => {
  const base = resolve(".test-data/native-graph");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "workspace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source"), blobs = join(dir, "blobs"), combined = join(dir, "combined");
  await mkdir(join(source, "web"), { recursive: true });
  await mkdir(blobs);
  await writeFile(join(source, "web", "index.html"), "经复核的网页");
  const files = await sealGraphFiles(source, ["web/index.html"], async (_name, bytes, hash) => {
    const path = join(blobs, hash);
    await writeFile(path, bytes, { flag: "wx" });
    return path;
  });
  await writeFile(join(source, "web", "index.html"), "用户后续修改");
  await buildGraphWorkspace(combined, blobs, files);
  await verifyGraphWorkspace(combined, files);
  assert.equal(await readFile(join(combined, "web", "index.html"), "utf8"), "经复核的网页");
  await writeFile(join(combined, "web", "index.html"), "整合回执丢失后的变动");
  await assert.rejects(verifyGraphWorkspace(combined, files), /版本.*不一致/);
  await assert.rejects(buildGraphWorkspace(combined, blobs, files), { code: "EEXIST" });
  assert.equal(await readFile(join(combined, "web", "index.html"), "utf8"), "整合回执丢失后的变动");
  assert.equal(await readFile(join(source, "web", "index.html"), "utf8"), "用户后续修改");
});

async function ledgerFixture(t: TestContext, budget: number) {
  const base = resolve(".test-data/native-graph");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "ledger-"));
  const blobs = join(dir, "blobs");
  await mkdir(blobs);
  let store = new Store(dir), ledger = new GraphLedger(store, dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const task: Task = {
    ...entity(), projectId: "fixture", mode: "write", advance: "loop-native",
    loopId: "native:" + entity().id, title: "组合交付", goal: "交付场景及网页",
    acceptance: "检查场景及网页输出", constraints: "", model: "", state: "ready",
    revision: 1, stateVersion: 1, archived: false, unread: false, attempt: 0,
    attachments: [], dependencies: [],
  };
  const id = task.loopId!;
  store.tx(() => {
    store.put("task", task);
    ledger.initialize(task, [], { runs: budget, retries: 1, wallMinutes: 30, runMinutes: 10 });
  });
  const jobs = () => ledger.evaluatePlan(id).jobs;
  const claim = (role: GraphRole, key?: string) => {
    const entry = jobs().find((job) => job.role === role &&
      (key === undefined || "node" in job && job.node.key === key));
    assert.ok(entry, role + " 非就绪: " + key);
    const claim = ledger.claim(id, entry, { model: "fixture", effort: "max" });
    assert.ok(claim);
    return claim.run;
  };
  const sent = (run: Run) => store.tx(() => {
    store.put("command", {
      ...store.get<Command>("command", run.commandId)!, state: "accepted",
    });
    store.put("run", { ...run, threadId: "fixture:" + run.id, state: "running" });
  });
  const finish = (
    run: Run, choice: "approve" | "execute" = "approve", previous = "经核对",
  ) => store.tx(() => {
    const saved = store.get<Run>("run", run.id)!;
    if (saved.state === "ended") return;
    const ended: Run = {
      ...saved, state: "ended", outcome: "completed",
      response: choice === "approve" ? previous + "\n建议收口" : "已交付",
    };
    store.put("run", ended);
    store.put("command", { ...store.get<Command>("command", run.commandId)!, state: "resolved" });
    ledger.settle(ended, choice === "execute" ? {
      files: ledger.handoff(run)!.map((path) => {
        const blob = hash(path);
        writeFileSync(join(blobs, blob), path);
        return { path, blob };
      }),
    } : {});
  });
  const handoff = (run: Run, ...paths: string[]) =>
    ledger.tool(run, "handoff", "submit_delivery", { paths });
  const restart = () => {
    store.close();
    store = new Store(dir);
    ledger = new GraphLedger(store, dir);
    store.tx(() => ledger.recover());
  };
  return { task, id, blobs, get store() { return store; }, get ledger() { return ledger; },
    jobs, claim, sent, finish, handoff, restart };
}

test("账本持久化局部失联：网页先交付，原场景回执只派一次复核和整合", async (t) => {
  const f = await ledgerFixture(t, 5);
  const scene = f.claim("execute", "main");
  f.sent(scene);
  const workspace = workspaceMcp(scene.workPath, {
    write: true, graph: (req, action, data) => f.ledger.tool(scene, req, action, data),
  });
  const webRequest = {
    id: 21, method: "tools/call", params: { name: "suggest_branches", arguments: {
      value: JSON.stringify({ nodes: [{
        key: "web", title: "网页", goal: "用样例实现交互",
        acceptance: "检查预期交互", outputs: ["web/index.html"],
        dependencies: [], resources: [], required: true,
      }] }),
    } },
  };
  const first = await workspace(webRequest);
  assert.ok("result" in first && "isError" in first.result);
  assert.equal(first.result.isError, false);
  assert.deepEqual(await workspace(webRequest), first);
  assert.equal(f.ledger.nodes(f.id).length, 2);
  f.handoff(scene, "assets/scene.txt");

  f.restart();
  assert.equal(f.store.get<Run>("run", scene.id)?.state, "unknown");
  assert.equal(f.ledger.get(f.id).spent, 1);
  const web = f.claim("execute", "web");
  f.sent(web);
  f.handoff(web, "web/index.html");
  f.finish(web, "execute");
  const webReview = f.claim("review", "web");
  f.finish(webReview);
  assert.equal(f.ledger.nodes(f.id).find((n) => n.key === "web")?.accepted?.reviewRunId, webReview.id);
  assert.deepEqual(f.jobs(), []);
  assert.equal(f.ledger.evaluatePlan(f.id).waiting.get("main"), "receipt");
  assert.equal(f.ledger.get(f.id).assembled, undefined);

  f.finish(scene, "execute");
  f.finish(scene, "execute");
  const sceneReview = f.claim("review", "main");
  f.finish(sceneReview);
  const [assemble] = f.jobs();
  assert.equal(assemble.role, "assemble");
  const building = f.ledger.claimAssembly(f.id, assemble.inputs)!;
  assert.equal(f.ledger.claimAssembly(f.id, assemble.inputs), undefined);
  // The files reached disk, but the process exited before writing the receipt.
  const files = f.ledger.filesFor(f.ledger.get(f.id), building.versions);
  await buildGraphWorkspace(building.path, f.blobs, files);
  f.restart();
  assert.equal(f.ledger.get(f.id).assembled?.state, "unknown");
  assert.deepEqual(f.jobs(), []);
  assert.equal(f.ledger.claimAssembly(f.id, assemble.inputs), undefined);
  await writeFile(join(building.path, "unapproved.txt"), "用户临时文件");
  await assert.rejects(f.ledger.reconcileAssembly(f.id), /保留未知/);
  assert.equal(f.ledger.get(f.id).assembled?.state, "unknown");
  await rm(join(building.path, "unapproved.txt"));
  assert.ok(await f.ledger.reconcileAssembly(f.id));
  const final = f.claim("final");
  f.finish(final);
  assert.equal(f.ledger.get(f.id).finalAccepted, final.id);
  assert.equal(f.ledger.get(f.id).spent, 5);
  assert.deepEqual([...backupFiles(f.store.db).values()].sort(),
    [hash("assets/scene.txt"), hash("web/index.html")].sort());
  assert.equal(f.store.all<Run>("run").filter((r) => r.graphAttempt?.role === "execute").length, 2);
});

test("成果领取与 Run、Command 共用一个事务，重启只退回确定未发送的份额", async (t) => {
  const f = await ledgerFixture(t, 3);
  f.store.db.exec(`CREATE TRIGGER fail_graph_command BEFORE INSERT ON records
    WHEN NEW.kind='command' BEGIN SELECT RAISE(ABORT,'command write failed'); END`);
  assert.throws(() => f.claim("execute"), /command write failed/);
  assert.equal(f.ledger.get(f.id).spent, 0);
  assert.equal(f.ledger.nodes(f.id)[0].activeRunId, undefined);
  assert.deepEqual(f.store.all("run"), []);
  f.store.db.exec("DROP TRIGGER fail_graph_command");
  const first = f.claim("execute");
  f.restart();
  assert.equal(f.store.get<Command>("command", first.commandId)?.state, "voided");
  assert.equal(f.ledger.get(f.id).spent, 0);
  const second = f.claim("execute");
  f.sent(second);
  f.restart();
  assert.equal(f.ledger.get(f.id).spent, 1);
  assert.equal(f.ledger.nodes(f.id)[0].activeRunId, second.id);
  assert.deepEqual(f.jobs(), []);
});

test("上游换版后，旧最终复核无法收口且无关成果保持验收", async (t) => {
  const f = await ledgerFixture(t, 10);
  const scene = f.claim("execute", "main");
  f.ledger.tool(scene, 1, "suggest_branches", { nodes: [{
    key: "web", title: "网页", goal: "实现交互",
    acceptance: "核对网页行为", outputs: ["web/index.html"],
    dependencies: [], resources: [], required: true,
  }] });
  const web = f.claim("execute", "web");
  f.handoff(scene, "assets/scene.txt");
  f.handoff(web, "web/index.html");
  f.finish(scene, "execute");
  f.finish(web, "execute");
  f.finish(f.claim("review", "main"));
  const webReview = f.claim("review", "web");
  f.finish(webReview);
  const [job] = f.jobs();
  const assembly = f.ledger.claimAssembly(f.id, job.inputs)!;
  await f.ledger.assemble(f.ledger.get(f.id), assembly);
  const oldFinal = f.claim("final");
  f.sent(oldFinal);
  f.store.tx(() => f.ledger.invalidate(f.id, "main"));
  f.finish(oldFinal);
  f.finish(oldFinal);
  const current = f.ledger.get(f.id);
  assert.equal(current.finalAccepted, undefined);
  assert.equal(current.assembled, undefined);
  assert.equal(f.ledger.nodes(f.id).find((node) => node.key === "web")?.accepted?.reviewRunId, webReview.id);
  const [next] = f.jobs();
  assert.ok("node" in next);
  assert.equal(next.node.key, "main");
  assert.equal(next.node.revision, 2);
  assert.equal(await readFile(join(assembly.path, "assets/scene.txt"), "utf8"), "assets/scene.txt");
});
