import { createServer } from "node:net";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hash } from "../src/hub/security";
import type { Group } from "./loop-score";

const count = z.number().int().nonnegative();
export const AttemptSchema = z
  .object({
    group: z.enum(["A", "B", "C", "D"]),
    task: z.string(),
    run: z.number().int().min(1).max(3),
    systemCompleted: z.boolean(),
    visiblePassed: z.boolean(),
    hiddenPassed: z.boolean(),
    passed: z.boolean(),
    mechanicalFalseCompletion: count,
    protectedFilesChanged: count,
    executorRuns: count,
    rejectedWrites: count,
    wallMs: count,
    tokensKnown: count.nullable(),
    infrastructureRetry: z.boolean(),
    timedOut: z.boolean(),
    scoringTimedOut: z.literal(true).optional(),
    infrastructure: z.boolean(),
    confirmationRequests: count,
    roleCalls: count.optional(),
    version: z.string().nullable(),
    runs: z.array(
      z.object({
        model: z.string().nullable(),
        effort: z.string().nullable(),
        outcome: z.string().nullable(),
        tokens: count.nullable(),
        sandbox: z.string().nullable().optional(),
        network: z.boolean().nullable().optional(),
      }),
    ),
    interrupted: z.boolean().optional(),
  })
  .strict();
export type Attempt = z.infer<typeof AttemptSchema>;
export async function optionalJson<T>(path: string, schema: z.ZodType<T>) {
  const body = await readFile(path, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return undefined;
  });
  return body === undefined ? undefined : schema.parse(JSON.parse(body));
}

export async function saveJson(path: string, record: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(record, null, 2), { flag: "wx" });
  await rename(temp, path);
}
const RoundSummary = z.object({
  mode: z.enum(["--live", "--fake"]),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  groups: z.record(z.object({ total: count })),
});
export async function saveRoundSummary(path: string, summary: unknown) {
  const next = RoundSummary.parse(summary);
  const old = await optionalJson(path, RoundSummary);
  if (old) {
    if (old.mode !== next.mode || old.manifestHash !== next.manifestHash)
      throw new Error("原摘要与当前实验轮次不一致");
    if (
      Object.entries(old.groups).some(
        ([name, value]) => (next.groups[name]?.total ?? 0) < value.total,
      )
    )
      return false;
  }
  await saveJson(path, summary);
  return true;
}
// The OS releases this ownership claim even when the runner is killed.
export async function withRound<T>(dir: string, run: () => Promise<T>) {
  const lock = createServer((socket) => socket.destroy());
  const key = hash(dir.toLowerCase()).slice(0, 32);
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\alcor-experiment-" + key
      : "\0alcor-experiment-" + key;
  await new Promise<void>((done, fail) => {
    lock.once("error", (e) =>
      fail(new Error("该轮实验已有运行器，或无法取得独占权", { cause: e })),
    );
    lock.listen(endpoint, done);
  });
  try {
    return await run();
  } finally {
    await new Promise<void>((done, fail) =>
      lock.close((e) => (e ? fail(e) : done())),
    );
  }
}

type Slot = { group: Group; task: string; run: number };
function matches(record: Attempt, slot: Slot, attempt?: number) {
  if (
    record.group !== slot.group ||
    record.task !== slot.task ||
    record.run !== slot.run ||
    (attempt !== undefined && record.infrastructureRetry !== (attempt === 2))
  )
    throw new Error("保存的样本与当前组别、任务或尝试不一致");
  return record;
}
async function interrupted(
  dir: string,
  slot: Slot,
  attempt: number,
): Promise<Attempt> {
  let db: DatabaseSync | undefined;
  let executorRuns = 0,
    confirmationRequests = 0;
  const ledger = join(dir, "state", "state.sqlite");
  const exists = await stat(ledger).then(
    () => true,
    (e) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    },
  );
  try {
    if (exists) {
      db = new DatabaseSync(ledger, { readOnly: true });
      executorRuns = Number(
        db.prepare("SELECT count(*) AS n FROM records WHERE kind='run'").get()
          ?.n,
      );
      confirmationRequests = Number(
        db
          .prepare("SELECT count(*) AS n FROM records WHERE kind='approval'")
          .get()?.n,
      );
    }
  } finally {
    db?.close();
  }
  return {
    ...slot,
    interrupted: true,
    systemCompleted: false,
    visiblePassed: false,
    hiddenPassed: false,
    passed: false,
    mechanicalFalseCompletion: 0,
    protectedFilesChanged: 0,
    executorRuns,
    rejectedWrites: 0,
    wallMs: (slot.group === "B" || slot.group === "D" ? 60 : 20) * 60_000,
    tokensKnown: null,
    infrastructureRetry: attempt === 2,
    timedOut: false,
    infrastructure: true,
    confirmationRequests,
    version: null,
    runs: [],
  };
}

export async function runSlot(
  dir: string,
  slot: Slot,
  execute: (dir: string, attempt: number) => Promise<Attempt>,
) {
  const finalPath = join(dir, "result.json");
  const final = await optionalJson(finalPath, AttemptSchema);
  if (final) return matches(final, slot);
  await mkdir(dir, { recursive: true });
  for (const n of [1, 2]) {
    const path = join(dir, "attempt-" + n);
    const resultPath = join(path, "result.json");
    const old = await optionalJson(resultPath, AttemptSchema);
    let data: Attempt;
    if (old) data = matches(old, slot, n);
    else {
      const created = await mkdir(path).then(
        () => true,
        (e) => {
          if (e.code !== "EEXIST") throw e;
          return false;
        },
      );
      const hasExecution =
        !created &&
        (await stat(join(path, "execution.json")).then(
          (f) => f.isFile(),
          (e) => {
            if (e.code !== "ENOENT") throw e;
            return false;
          },
        ));
      data =
        created || hasExecution
          ? matches(AttemptSchema.parse(await execute(path, n)), slot, n)
          : await interrupted(path, slot, n);
      await saveJson(resultPath, data);
    }
    if (!data.infrastructure || n === 2) {
      await saveJson(finalPath, data);
      return data;
    }
  }
  throw new Error("未取得样本结果");
}
