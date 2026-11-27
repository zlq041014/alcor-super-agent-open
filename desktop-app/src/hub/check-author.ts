import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openDsh } from "../adapter/dsh";
import type { Settings, Task } from "../shared/contracts";
import type { Check, Criterion, Loop } from "../shared/loop-contracts";
import { hash, redact, within } from "./security";
import { snapshotFiles } from "./workspaces";
import type { Hub } from "./service";

type Snapshot = Awaited<ReturnType<typeof snapshotFiles>>;
const paths = (s: Snapshot) => Object.keys(s.files);
export const sourceDigest = (s: Snapshot, omit?: string) =>
  hash(
    JSON.stringify(
      paths(s)
        .filter((p) => p !== omit)
        .sort()
        .map((p) => [p, s.files[p].hash]),
    ),
  );
export function sameSources(a: Snapshot, b: Snapshot, added?: string) {
  return (
    !a.truncated &&
    !b.truncated &&
    paths(a).length + Number(!!added) === paths(b).length &&
    paths(a).every((p) => a.files[p].hash === b.files[p]?.hash) &&
    (!added || (!a.files[added] && !!b.files[added]))
  );
}
export async function authorPath(
  check: Check,
  root: string,
  criterionId: string,
  snapshot: Snapshot,
) {
  const input = check.input;
  if (input.kind !== "command" || check.status !== "authorized") return;
  const prefix =
    input.cwd === "."
      ? ""
      : input.cwd.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  const script =
    input.program.toLowerCase() === "node" && input.args.join(" ") === "--test"
      ? "node --test"
      : /^(npm|pnpm|yarn)(?:\.cmd|\.exe)?$/i.test(input.program) &&
          input.args.length === 2 &&
          input.args[0] === "run"
        ? await readFile(
            await within(root, resolve(root, input.cwd, "package.json")),
            "utf8",
          ).then(
            (value) =>
              JSON.parse(value.replace(/^\uFEFF/, "")).scripts?.[input.args[1]],
          )
        : undefined;
  if (typeof script !== "string" || script.trim() !== "node --test") return;
  const names = paths(snapshot).map((p) => p.replaceAll("\\", "/"));
  const sub =
    ["test/", "tests/"].find((dir) =>
      names.some((name) => name.startsWith(prefix + dir)),
    ) || "";
  return prefix + sub + "alcor-" + hash(criterionId).slice(0, 12) + ".test.mjs";
}
export async function cloneForAuthor(
  root: string,
  data: string,
  source: Snapshot,
  path: string,
) {
  const parent = join(data, "check-author");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "trial-"));
  const work = join(dir, "project");
  await mkdir(work);
  for (const name of paths(source)) {
    const target = join(work, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(
      await within(root, resolve(root, name)),
      target,
      constants.COPYFILE_EXCL,
    );
  }
  await mkdir(dirname(join(work, path)), { recursive: true });
  return { dir, work };
}
export function confirmedAssertion(output: string, candidate: string) {
  return (
    output.replaceAll("\\", "/").includes(basename(candidate)) &&
    /ERR_ASSERTION|AssertionError/.test(output) &&
    !/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(output)
  );
}
export class CheckAuthor {
  constructor(private readonly hub: Hub) {}
  async write(
    dir: string,
    work: string,
    candidate: string,
    cfg: Settings,
    loop: Loop,
    task: Task,
    criterion: Criterion,
    reason: string | undefined,
    signal: AbortSignal,
  ) {
    const session = await openDsh({
      dir: join(dir, "dsh"),
      cwd: work,
      cfg,
      profile: loop.roster.executor,
      key: await this.hub.brain.key(cfg),
      write: true,
      paths: {
        protect: loop.protectedPaths.filter(
          (name) => name !== candidate.toLowerCase(),
        ),
        lockPackageScripts: true,
        allowOnly: [candidate],
      },
      journal: {
        rejected: (path, why) => {
          this.hub.store.event("write.rejected", loop.id, {
            role: "check-author",
            path: redact(path),
            reason: why,
          });
          const latest = this.hub.store.get<Loop>("loop", loop.id)!;
          this.hub.store.put("loop", {
            ...latest,
            rejectedWrites: latest.rejectedWrites + 1,
          });
        },
      },
    });
    const close = () => session.close();
    signal.addEventListener("abort", close, { once: true });
    try {
      if (signal.aborted) return;
      return await session.prompt(
        redact(
          JSON.stringify({
            goal: task.goal,
            constraints: task.constraints,
            loop: {
              role: "check-author",
              criterion: {
                title: criterion.input.title,
                detail: criterion.input.detail,
                checkIntent: criterion.input.checkIntent,
              },
              writablePaths: [candidate],
              previousFailure: reason,
              rules: [
                "只在指定路径新建一个 Node.js 原生测试文件。用 node:test 和 node:assert/strict；不要修改已有文件。",
                "用与用户要求一致的公开行为或交付内容做断言；既有实现没有满足要求时测试应失败，正确实现后应通过。",
                "不要写死实现结构或提前提交实现，不运行命令，不加入条目之外的范围。",
                "写完报告文件路径。测试由系统单独运行。",
              ],
            },
          }),
        ),
        () => undefined,
      );
    } finally {
      signal.removeEventListener("abort", close);
      close();
    }
  }
}
