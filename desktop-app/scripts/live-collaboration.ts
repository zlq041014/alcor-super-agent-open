import { submitAgentForm } from "../src/shared/agent-form";
import { defaultProfile } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { Vault, hash } from "../src/hub/security";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task, Run } from "../src/shared/contracts";
async function main() {
  const root = resolve("../.dev/desktop-live");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "collaboration-"));
  const path = join(dir, "project");
  await mkdir(path);
  const h = new Hub(join(dir, "state"));
  const result: any = { dir };
  try {
    const name = "ALCOR_NATIVE_API_KEY";
    await new Vault(join(dir, "state"), "codex-native.dpapi").save(
      `codex:${name}`,
      process.env[name]!,
    );
    await h.request({
      op: "settings",
      value: {
        ...h.settings(),
        codexPath: process.argv[2],
        codexCredentialEnv: name,
        maxMinutes: 2,
        concurrency: 2,
      },
    });
    h.start();
    const p = await h.request({
      op: "project.add",
      path,
      name: "隔离协作验证",
    });
    const tasks: Task[] = [];
    for (const letter of ["a", "b"])
      tasks.push(
        await submitAgentForm(h.request.bind(h), {
          op: "task.create",
          profile: defaultProfile(h.settings()),
          requestId: `parallel-${letter}`,
          value: {
            projectId: p.id,
            mode: "write",
            access: "project",
            isolate: true,
            goal: `仅在当前隔离输出目录创建 ${letter}.txt，内容为 ALCOR-${letter.toUpperCase()} 换行。读取文件检查后结束；不要更改原项目，不联网，不创建其他智能体。`,
            acceptance: "指定文件存在且内容严格匹配",
          },
        }),
      );
    let overlapping = false;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const runs = h.store.all<Run>("run");
      if (runs.filter((r) => r.state === "running").length === 2)
        overlapping = true;
      if (
        tasks.every((t) =>
          ["verifying", "blocked"].includes(h.getTask(t.id).state),
        )
      )
        break;
    }
    for (let i = 0; i < tasks.length; i++) {
      const t = h.getTask(tasks[i].id);
      if (t.state !== "verifying")
        throw new Error(t.reason || "parallel incomplete");
      const r = h.store.get<Run>("run", t.runId!)!;
      const letter = ["a", "b"][i];
      if (
        (await readFile(join(r.workPath, `${letter}.txt`), "utf8")).trim() !==
        `ALCOR-${letter.toUpperCase()}`
      )
        throw new Error("artifact mismatch");
      await h.control(t.id, "accept", t.revision, hash(r.response + r.diff));
      await h.request({ op: "task.integrate", id: t.id, revision: t.revision });
    }
    result.overlapObserved = overlapping;
    result.independentThreads =
      new Set(h.store.all<Run>("run").map((r) => r.threadId)).size === 2;
    result.integrated =
      (await readFile(join(path, "a.txt"), "utf8")).trim() === "ALCOR-A" &&
      (await readFile(join(path, "b.txt"), "utf8")).trim() === "ALCOR-B";
    result.passed = result.independentThreads && result.integrated;
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch (e) {
    result.passed = false;
    result.error = (e as Error).message;
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    await h.shutdown();
    h.store.close();
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  }
}
void main();
