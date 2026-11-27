import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Snapshot } from "../src/shared/contracts";
import { Hub } from "../src/hub/service";
import { checkPidAlive } from "../src/hub/checks";
import { childEnv } from "../src/hub/security";

async function until<T>(read: () => Promise<T | undefined>, reason: string) {
  const end = Date.now() + 8000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(30);
  } while (Date.now() < end);
  assert.fail(reason);
}

test(
  "Hub 强退后 Windows 结束检查的分离子进程，重启只重跑检查",
  {
    skip: process.platform !== "win32",
    timeout: 40_000,
  },
  async (t) => {
    const base = resolve(".test-data/loop-crash");
    await mkdir(base, { recursive: true });
    const area = await mkdtemp(join(base, "crash-"));
    const project = join(area, "project");
    const data = join(area, "data");
    await mkdir(join(project, "dist"), { recursive: true });
    await writeFile(
      join(project, "fixture.cjs"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const mark = 'dist/check-pids';",
        "if (fs.existsSync(mark)) { console.log('恢复后检查通过'); process.exit(0); }",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], {detached:true, stdio:'ignore', windowsHide:true});",
        "child.unref();",
        "fs.writeFileSync(mark, JSON.stringify([process.pid, child.pid]));",
        "setTimeout(()=>{},20000);",
      ].join("\n"),
    );
    const seeded = new Hub(data);
    let task: string;
    try {
      seeded.dsh.probe = async () => ({ status: "夹具", version: "fixture" });
      seeded.scheduling = true;
      await seeded.request({
        op: "settings",
        value: {
          ...seeded.settings(),
          codexPath: join(area, "disabled"),
          checkPath: [dirname(process.execPath)],
        },
      });
      const p = await seeded.request({
        op: "project.add",
        path: project,
        name: "重启隔离测试",
      });
      task = (
        await seeded.request({
          op: "task.create",
          requestId: "local-crash-check",
          value: {
            advance: "loop",
            mode: "write",
            projectId: p.id,
            goal: "验证恢复",
            loopChecks: [
              {
                kind: "command",
                program: "node",
                name: "恢复检查",
                args: ["fixture.cjs"],
              },
            ],
          },
        })
      ).id;
    } finally {
      seeded.store.close();
    }

    const children: ReturnType<typeof fork>[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const killed = once(child, "exit");
          child.kill("SIGKILL");
          await killed;
        }
      await rm(area, { recursive: true, force: true, maxRetries: 5 });
    });
    async function start() {
      const child = fork(resolve("src/hub/entry.ts"), [data], {
        execArgv: ["--import", "tsx"],
        env: { ...childEnv(), CODEX_HOME: join(area, "native") },
        silent: true,
        windowsHide: true,
      });
      children.push(child);
      child.stdout?.resume();
      child.stderr?.resume();
      const ready = new AbortController();
      const timer = setTimeout(() => ready.abort(), 8000);
      try {
        for await (const [msg] of on(child, "message", {
          signal: ready.signal,
        }))
          if (msg?.event === "ready") return child;
          else if (msg?.event === "fatal") throw new Error(String(msg.error));
      } finally {
        clearTimeout(timer);
      }
      throw new Error("Hub 启动未返回就绪");
    }
    async function snapshot(child: ReturnType<typeof fork>) {
      const id = "snapshot:" + crypto.randomUUID();
      return new Promise<Snapshot>((ok, fail) => {
        const onMessage = (message: any) => {
          if (message.id !== id) return;
          cleanup();
          if (message.ok) ok(message.value);
          else fail(new Error(message.error));
        };
        const timer = setTimeout(() => {
          cleanup();
          fail(new Error("Hub 快照请求超时"));
        }, 3500);
        const cleanup = () => {
          clearTimeout(timer);
          child.off("message", onMessage);
        };
        child.on("message", onMessage);
        child.send({ id, request: { op: "snapshot" } }, (e) => {
          if (e) {
            cleanup();
            fail(e);
          }
        });
      });
    }
    const first = await start();
    const pids = await until(async () => {
      const raw = await readFile(
        join(project, "dist", "check-pids"),
        "utf8",
      ).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return "";
      });
      return raw ? (JSON.parse(raw) as [number, number]) : undefined;
    }, "检查没有启动父、子进程");
    const live = (await snapshot(first)).checkRuns.find(
      (r) => r.state === "running",
    );
    assert.ok(live?.guarded && live?.pid);
    assert.ok(pids.every(checkPidAlive));
    const exit = once(first, "exit");
    first.kill("SIGKILL");
    await exit;
    const second = await start();
    const result = await until(async () => {
      const snap = await snapshot(second);
      return snap.tasks.find((r) => r.id === task)?.state === "done"
        ? snap
        : undefined;
    }, "恢复后没有收口");
    assert.ok(
      !checkPidAlive(live.pid) && pids.every((pid) => !checkPidAlive(pid)),
    );
    assert.deepEqual(result.runs, []);
    assert.equal(
      result.checkRuns.filter((r) => r.state === "unknown").length,
      1,
    );
    assert.ok(
      result.checkRuns.some(
        (r) => r.purpose === "baseline" && r.outcome === "passed",
      ),
    );
    assert.ok(
      result.checkRuns.some(
        (r) => r.purpose === "final" && r.outcome === "passed",
      ),
    );
  },
);
