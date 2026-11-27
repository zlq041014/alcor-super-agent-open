import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MissSample } from "../src/hub/misses";
import { Hub } from "../src/hub/service";
import { defaults } from "../src/shared/contracts";

const fixtures = {
  "historical-command": {
    old: {
      goal: "保存本地导出验证说明。完成状态需要原生确认，附件已留存。",
      content: "导出列表状态：已完成。\n原生确认状态：待确认。\n",
    },
    holdout: {
      goal: "保存另一份独立的导出说明和完成状态。确认后才展示完成。",
      content: "导出列表状态：已完成。\n原生确认状态：已确认。\n",
    },
    reminder:
      "归档说明忽略了已授权的确认状态检查失败：原生确认还在等待，列表却已经显示完成。请从已保存的检查回执推导，不能再运行旧目录命令。",
  },
  notification: {
    old: {
      goal: "交付本地导出界面状态说明：输入为空时提示，缓存失败时允许重试，已确认结果才显示为成功。",
      content:
        "等待输入：提示填写名称。\n缓存写入失败：显示重试按钮。\n用户点重试：离开错误状态，通知区显示已导出，同时等待写入确认。\n收到写入确认：在结果列表展示路径。\n",
    },
    holdout: {
      goal: "交付另一份本地保存界面的状态说明：缺少标题时提示，失败时可重试，成功后展示路径。",
      content:
        "缺少标题：提示补充标题。\n首次保存失败：提供重试。\n重试开始：仅显示正在保存。\n收到写入确认：显示保存成功并展示文件路径。\n",
    },
    reminder:
      "重试后还没收到写入确认，通知区就显示已导出，违反了目标里已确认结果才显示成功的要求。",
  },
  "queue-order": {
    old: {
      goal: "交付本机审阅队列表：保留顺序，同一个撤回事件只能处理一次，最后要能核对剩余队列。",
      content: [
        "队列可新增、暂停和恢复；恢复时按原接收顺序列出。",
        "撤回输入的每项事件携带 source、receipt、slot。",
        "可见记录按 slot 归组；不同来源同编号仍分别保存。",
        "收到撤回时将 receipt 放入已处理集合并移除对应队列项目。",
        "轮次收口会归档对应 slot 的事件和已处理集合，再建立空可见集合。",
        "重启从未收口队列及各 slot 的记录恢复。重投由当前可见已处理集合过滤。",
        "待执行列表、结束时列表和已归档轮次可各自导出。",
      ].join("\n"),
    },
    holdout: {
      goal: "交付本机扫描记录归档说明：记录归档后重投不会重复计数，仍可查询任一批次。",
      content: [
        "每个来源和回执的组合向持久收据表登记一次。",
        "归档移动阅读视图；持久收据保留至重投窗口关闭。",
        "重启先载入持久收据，重复投递只返回旧接收结果。",
        "查询按批次展示；新批次不清空收据。",
      ].join("\n"),
    },
    reminder:
      "收口或重启会把去重依据留在归档中，却只用当前可见的已处理集合过滤重投，同一撤回可能再次执行。",
  },
  "no-write": {
    old: {
      goal: "交付本机报告预览说明：可选择最近产物，预览失败时给出提示，不允许预览操作修改文件。",
      content: [
        "应用用只读权限打开用户选定的 report.txt。",
        "默认以文件当前内容显示结果；不识别的扩展仅显示文件属性。",
        "预览读取失败时提示重新选择，并保存原错误分类。",
        "自动加速仅用于第二次打开：显示历史结果，空闲后重新计算文件页码。",
        "计算结束将页码缓存跟随产物放在同一目录，便于用户重新打开。",
        "关闭预览会释放文件句柄，不修改 report.txt 的内容。",
        "导出是独立操作，需要用户另选目标。",
      ].join("\n"),
    },
    holdout: {
      goal: "交付本机图片预览说明：不得向源目录写入，关闭后释放预览缓存。",
      content: [
        "从只读句柄解码选定图片。",
        "缩略图与页码只保存在内存，关闭预览释放全部缓存。",
        "源文件和同目录文件均无写入，导出需要另选目标。",
      ].join("\n"),
    },
    reminder:
      "说明只保证不改 report.txt；第二次预览会把页码缓存写入产物目录，仍然修改了文件系统。",
  },
} as const;

async function main() {
  const option = process.argv.indexOf("--fixture");
  const name = option >= 0 ? process.argv[option + 1] : "notification";
  assert.ok(name && Object.hasOwn(fixtures, name), "未冻结的回放样本");
  const fixture = fixtures[name as keyof typeof fixtures];
  if (process.argv.includes("--verify")) {
    assert.match(
      fixtures.notification.old.content,
      /显示已导出，同时等待写入确认/,
    );
    assert.match(
      fixtures.notification.holdout.content,
      /收到写入确认：显示保存成功/,
    );
    assert.match(fixtures["queue-order"].old.content, /当前可见已处理集合过滤/);
    assert.match(fixtures["queue-order"].holdout.content, /先载入持久收据/);
    assert.match(
      fixtures["no-write"].old.content,
      /页码缓存跟随产物放在同一目录/,
    );
    assert.match(fixtures["no-write"].holdout.content, /只保存在内存/);
    assert.match(
      fixtures["historical-command"].old.content,
      /原生确认状态：待确认/,
    );
    assert.match(
      fixtures["historical-command"].holdout.content,
      /原生确认状态：已确认/,
    );
    console.log(
      JSON.stringify({
        frozenPairs: Object.keys(fixtures),
        independentHoldoutPerPair: true,
      }),
    );
    return;
  }
  if (!process.argv.includes("--authorized"))
    throw new Error("真实漏检回放需要明确开工授权");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!key) throw new Error("真实漏检回放缺少已授权的网关凭据");
  const stage = resolve("../.dev/advance-loop/L4");
  await mkdir(stage, { recursive: true });
  const dir = await mkdtemp(join(stage, "real-miss-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  const hub = new Hub(join(dir, "state"));
  const vault = hub.brain.vaultFor(defaults);
  try {
    const historical = name === "historical-command";
    if (historical) {
      await hub.request({
        op: "settings",
        value: { ...defaults, checkPath: [resolve(process.execPath, "..")] },
      });
      await writeFile(
        join(workspace, "receipt-check.cjs"),
        "const s=require('node:fs').readFileSync('delivery.txt','utf8');" +
          "if(!s.includes('原生确认状态：已确认')) { console.error('确认检查失败：列表已完成，但原生确认状态仍是待确认'); process.exitCode=1; } " +
          "else console.log('原生确认状态：已确认');",
      );
    }
    // Deliveries already exist; local file checks seal both without running an executor.
    hub.dsh.probe = async () => ({
      status: "ACP 就绪",
      version: "fixture-no-executor",
    });
    const project = await hub.request({
      op: "project.add",
      name: "隔离漏检回放",
      path: workspace,
    });
    const deliver = async (goal: string, content: string) => {
      await writeFile(join(workspace, "delivery.txt"), content);
      const { id } = await hub.request({
        op: "task.create",
        requestId: randomUUID(),
        value: {
          projectId: project.id,
          goal,
          mode: "write",
          advance: "loop",
          ...(historical
            ? {
                criteria: [
                  {
                    title: "交付说明文件留存",
                    method: "file",
                    checks: ["交付说明已保存"],
                  },
                ],
                selectedChecks: [],
              }
            : {}),
          loopChecks: [
            { kind: "file", name: "交付说明已保存", path: "delivery.txt" },
            ...(historical
              ? [
                  {
                    kind: "command",
                    name: "检查已完成是否有原生确认",
                    program: "node",
                    args: ["receipt-check.cjs"],
                    cwd: ".",
                  },
                ]
              : []),
          ],
        },
      });
      for (
        let attempt = 0;
        attempt < 240 && hub.getTask(id).state !== "done";
        attempt++
      ) {
        await hub.tick();
        await delay(25);
      }
      assert.equal(hub.getTask(id).state, "done");
      return id;
    };
    const original = await deliver(fixture.old.goal, fixture.old.content);
    const holdout = await deliver(
      fixture.holdout.goal,
      fixture.holdout.content,
    );
    const task = hub.getTask(original);
    const { id } = await hub.request({
      op: "miss.record",
      id: original,
      taskRevision: task.revision,
      revision: hub.loop.view(task).loop.contractRevision,
      requestId: randomUUID(),
      text: fixture.reminder,
    });
    await vault.save(defaults.endpoint, key);
    const checksBeforeReplay = hub.store.all("check-run").length;
    const deadline = Date.now() + 9 * 60_000;
    let sample: MissSample;
    do {
      hub.misses.tick();
      await delay(250);
      sample = hub.store.get<MissSample>("miss", id)!;
    } while (
      Date.now() < deadline &&
      (hub.misses.busy() ||
        sample.replay?.state === "pending" ||
        ["pending", "calling"].includes(sample.attribution?.state ?? ""))
    );
    if (hub.misses.busy()) await hub.misses.shutdown();
    sample = hub.store.get<MissSample>("miss", id)!;
    const calls = hub.store.all<{
      role: string;
      status: string;
      actualModel?: string;
      tokens?: number | null;
    }>("invocation");
    const snapshot = await hub.snapshot();
    const result = {
      dir,
      fixture: name,
      proof: sample.replay?.proof,
      reason: sample.replay?.reason,
      knownOutcome: sample.replay?.state ?? sample.attribution?.state,
      attribution: sample.attribution?.category,
      matchedIndependentHoldout: sample.replay?.holdoutTaskId === holdout,
      enabled: snapshot.learnedChecks.some(
        (rule) => rule.id === id && rule.enabled,
      ),
      protected:
        hub.getTask(original).state === "done" &&
        hub.getTask(holdout).state === "done",
      executorRuns: snapshot.runs.length,
      newProgramChecksDuringReplay:
        hub.store.all("check-run").length - checksBeforeReplay,
      authorizedBindingUsed:
        name !== "historical-command" ||
        (!!sample.delivery &&
          hub.misses.hints(project.id, sample.delivery.checks).length === 1 &&
          hub.misses.hints(project.id, []).length === 0),
      userRequests: snapshot.approvals.length + snapshot.launches.length,
      roles: calls.map(({ role, status, actualModel, tokens }) => ({
        role,
        status,
        actualModel,
        tokens,
      })),
    };
    const passed =
      result.enabled &&
      result.matchedIndependentHoldout &&
      result.protected &&
      result.executorRuns === 0 &&
      result.newProgramChecksDuringReplay === 0 &&
      result.authorizedBindingUsed &&
      result.userRequests === 0;
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify({ ...result, passed }, null, 2),
    );
    console.log(JSON.stringify({ ...result, passed }));
    if (!passed) process.exitCode = 1;
  } finally {
    hub.shuttingDown = true;
    await hub.misses.shutdown();
    await hub.loop.shutdown();
    hub.store.close();
    await rm(join(hub.dir, vault.filename), { force: true });
  }
}
void main().catch((error: Error) => {
  console.error(
    error.name === "AssertionError"
      ? "漏检验收实际结果未达到预期"
      : "漏检验收运行失败",
  );
  process.exitCode = 1;
});
