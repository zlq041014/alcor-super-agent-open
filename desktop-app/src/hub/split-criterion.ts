import { z } from "zod";
import type { Task } from "../shared/contracts";
import type { Check, Criterion, Loop, LoopStep } from "../shared/loop-contracts";
import type { Hub } from "./service";

export async function planSplit(hub: Hub, loop: Loop, task: Task, step: LoopStep, parent: Criterion, checks: Check[], maxItems: number, signal: AbortSignal) {
  const checkNames = new Set(checks.map((c) => c.input.name));
  const schema = z.object({ items: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    detail: z.string().trim().min(1).max(1200),
    checks: z.array(z.string().refine((name) => checkNames.has(name))).min(1).max(8),
  }).strict()).max(maxItems).refine((items) => {
    const used = items.flatMap((item) => item.checks);
    return items.length !== 1 && new Set(used).size === used.length && new Set(items.map((item) => item.title)).size === items.length;
  }) }).strict();
  return hub.roles.call({
    loopId: loop.id, revision: loop.contractRevision, stepId: step.id,
    role: "planner", purpose: "split", promptVersion: 1,
    instructions: "只拆分父条目中确实需要完成的内容，形成两或三个各自可验收的小条目。每项引用 checks 清单中不同的现有检查。不得改父要求、扩张权限或发明命令。只返回 {\"items\":[{\"title\":\"小条目\",\"detail\":\"可核对的范围\",\"checks\":[\"已有检查名\"]}]}。如果不能独立检查，返回空数组，由程序保留原因。",
    schema, input: { goal: task.goal, constraints: task.constraints, parent: parent.input, previousFailure: parent.failure?.detail,
      checks: checks.map((c) => ({ name: c.input.name, kind: c.input.kind })), maxItems },
    materials: [], timeoutMs: 150000, maxOutputTokens: 3000, signal,
  });
}
