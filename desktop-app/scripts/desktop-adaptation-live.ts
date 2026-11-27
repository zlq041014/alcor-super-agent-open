import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { submitAgentForm } from "../src/shared/agent-form";
import { defaults, type Message, type Task } from "../src/shared/contracts";

const preferenceHoldout = [
  {
    text: "把这份合成移交转换成一段给新同事的说明，并保留识别号及关键事实。管道 P4 在周三 14:00 停止接收，重开前必须收到回执 R7，完成后保留副本 C2。解释这个流程。",
    markers: ["P4", "14:00", "R7", "C2"],
  },
  {
    text: "说明这个合成本地故障的处理流程。先核对状态 K1；如果未知不要重复发送，等待编号 B3 的回执；看到终态后才释放队列 Q8。把这些要点解释清楚。",
    markers: ["K1", "B3", "Q8"],
  },
] as const;
const marker = {
  pending: "ALCOR_SAMPLE_PENDING",
  passed: "ALCOR_SAMPLE_CONFIRMED",
};
const methodGoal =
  "这是隔离验收。只读取同目录 phase.txt 的一行标记，将它原样写入 method.txt，不添加其他内容、不修改 phase.txt。验收脚本会调整 phase.txt，当前回合一律以实际读取为准。";

async function main() {
  if (!process.argv.includes("--authorized"))
    throw new Error("真实适配验收需要开工授权");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw new Error("真实验收缺少已授权凭据");
  const base = resolve("../.dev/desktop-live");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "adaptation-"));
  const withHub = async <T>(name: string, run: (hub: Hub) => Promise<T>) => {
    const hub = new Hub(join(dir, name, "state"));
    const vault = hub.brain.vaultFor(defaults);
    try {
      await vault.save(defaults.endpoint, key);
      await hub.request({
        op: "settings",
        value: {
          ...defaults,
          codexPath: join(dir, "offline.exe"),
          maxOutputTokens: 8000,
        },
      });
      return await run(hub);
    } finally {
      await hub.shutdown();
      hub.store.close();
      await rm(join(hub.dir, vault.filename), { force: true });
    }
  };
  if (process.argv.includes("--preferences")) {
    const outcomes = [];
    for (const [index, fixture] of preferenceHoldout.entries()) {
      const arms = [];
      for (const enabled of [false, true]) {
        arms.push(
          await withHub("preference-" + index + "-" + enabled, async (hub) => {
            await hub.request({ op: "preference.learning", enabled: true });
            for (const n of [1, 2]) {
              const request = hub.message(
                "user",
                "本地样例问题 " + n,
                undefined,
                "answered",
                "seed-" + n,
              );
              const reply = hub.message(
                "assistant",
                "本地样例答复 " + n,
                undefined,
                undefined,
                "reply-" + n,
              );
              hub.store.put("message", { ...reply, workRequestId: request.id });
              await hub.request({
                op: "preference.feedback",
                id: reply.id,
                style: "concise",
              });
            }
            if (enabled) {
              const item = hub.preferences.list()[0];
              await hub.request({
                op: "preference.manage",
                id: item.id,
                revision: item.revision,
                generation: item.generation,
                action: "enable",
              });
            }
            const result = await hub.chat(fixture.text, "holdout-question");
            const reply = hub.store
              .all<Message>("message")
              .find((item) => item.workRequestId === "holdout-question");
            const invocation = hub.store.all("invocation").at(-1);
            return {
              enabled,
              available: !!reply && !result.error,
              characters: reply?.text.length ?? 0,
              completeFacts:
                !!reply &&
                fixture.markers.every((part) => reply.text.includes(part)),
              applied: !!reply?.preferenceInput,
              proposed: !!result.proposal,
              calls: hub.store.all("invocation").length,
              actualModel: invocation?.actualModel,
              usageKnown: !!invocation?.usage,
              executorRuns: hub.store.all("run").length,
            };
          }),
        );
      }
      outcomes.push(arms);
    }
    const passed =
      outcomes.every(
        ([baseline, candidate]) =>
          baseline.available &&
          candidate.available &&
          baseline.completeFacts &&
          candidate.completeFacts &&
          !baseline.applied &&
          candidate.applied &&
          !baseline.proposed &&
          !candidate.proposed &&
          baseline.actualModel === candidate.actualModel &&
          baseline.calls === 1 &&
          candidate.calls === 1 &&
          baseline.executorRuns === 0 &&
          candidate.executorRuns === 0,
      ) &&
      outcomes.reduce((total, [, item]) => total + item.characters, 0) <
        outcomes.reduce((total, [item]) => total + item.characters, 0);
    const result = { dir, passed, frozenPairs: 2, outcomes };
    await writeFile(
      join(dir, "preference-result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    if (!passed) process.exitCode = 1;
    return;
  }
  const result = await withHub("method", async (hub) => {
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const { id: projectId } = await hub.request({
      op: "project.add",
      name: "工作方法隔离复验",
      path: workspace,
    });
    const cases = [];
    for (const [name, failures] of [
      ["original", 2],
      ["holdout", 1],
      ["reuse", 0],
    ] as const) {
      await writeFile(
        join(workspace, "phase.txt"),
        failures ? marker.pending : marker.passed,
      );
      await writeFile(join(workspace, "method.txt"), marker.pending);
      const created = await submitAgentForm(hub.request.bind(hub), {
        op: "task.create",
        requestId: name,
        profile: { model: defaults.codexModel, effort: defaults.memberEffort },
        value: {
          projectId,
          goal: methodGoal,
          mode: "write",
          checks: [{ path: "method.txt", contains: marker.passed }],
        },
      });
      const deadline = Date.now() + 7 * 60_000;
      while (Date.now() < deadline) {
        const task = hub.getTask(created.id);
        if (["done", "blocked"].includes(task.state)) break;
        if (task.state === "ready" && task.attempt >= failures)
          await writeFile(join(workspace, "phase.txt"), marker.passed);
        await hub.tick();
        await delay(200);
      }
      const task: Task = hub.getTask(created.id);
      const invocations = (await hub.snapshot()).runs.filter(
        (item) => item.taskId === task.id,
      );
      const final = invocations.find((item) => item.id === task.runId);
      cases.push({
        name,
        done: task.state === "done",
        runs: invocations.length,
        attempted: task.attempt,
        adapter: final?.adapterVersion,
        model: final?.model,
        correction: !!final?.correctionInput,
        used: !!final?.methodInput,
        verifiedFailures: hub.store
          .all("verification")
          .filter((item) => item.taskId === task.id && !item.passed).length,
      });
      if (name === "original" && hub.methods.list()[0]?.state !== "candidate")
        break;
      if (name === "holdout") {
        const item = hub.methods.list()[0];
        if (item?.state !== "verified") break;
        await hub.request({
          op: "method.manage",
          id: item.id,
          revision: item.revision,
          action: "enable",
        });
      }
    }
    const snapshot = await hub.snapshot();
    const passed =
      cases.length === 3 &&
      cases.every(
        (item) =>
          item.done && item.adapter && item.model === defaults.codexModel,
      ) &&
      cases[0].verifiedFailures === 2 &&
      cases[0].correction &&
      cases[1].verifiedFailures === 1 &&
      cases[1].correction &&
      cases[2].used &&
      snapshot.approvals.length === 0 &&
      snapshot.launches.length === 0;
    return {
      dir,
      passed,
      cases,
      userRequests: snapshot.approvals.length + snapshot.launches.length,
    };
  });
  await writeFile(
    join(dir, "method-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
void main().catch(() => {
  console.error("真实适配验收未能正常收口");
  process.exitCode = 1;
});
