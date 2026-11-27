import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { userCommand } from "../src/core/check-policy";
import { checkPidAlive, failureSignature, runCheck } from "../src/hub/checks";

async function fixture(t: Pick<import("node:test").TestContext, "after">) {
  const base = resolve(".test-data/checks");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    checkPath: [dirname(process.execPath), root],
    timeoutMs: 5000,
  };
}
test("运行器分类退出、程序缺失、依赖缺失和拒绝参数；保留首尾并脱敏", async (t) => {
  const options = await fixture(t);
  const key = "sk-" + "fake-fixture-value";
  process.env.ALCOR_SAMPLE_API_KEY = key;
  t.after(() => {
    delete process.env.ALCOR_SAMPLE_API_KEY;
  });
  await writeFile(
    join(options.root, "fixture.cjs"),
    [
      "if (process.env.ALCOR_SAMPLE_API_KEY || process.env.CODEX_HOME || process.env.CI !== '1') process.exit(21);",
      "console.log('START authorization: Bearer ' + 'sk-' + 'fake-fixture-value');",
      "console.log('x'.repeat(100000));",
      "console.error('FINISH'); process.exit(Number(process.argv[2] || 0));",
    ].join("\n"),
  );
  const c = userCommand("fixture", "node fixture.cjs 3");
  const fail = await runCheck(c, options);
  assert.equal(fail.outcome, "failed");
  assert.equal(fail.exitCode, 3);
  assert.match(fail.output, /^START authorization: \[已隐藏\]/);
  assert.match(fail.output, /已截断/);
  assert.match(fail.output, /FINISH/);
  assert.ok(
    !fail.output.includes(key) && Buffer.byteLength(fail.output) < 83 * 1024,
  );
  assert.equal(
    (await runCheck({ ...c, args: ["fixture.cjs", "0"] }, options)).outcome,
    "passed",
  );
  assert.equal(
    (await runCheck({ ...c, args: ["never-exists.js"] }, options)).outcome,
    "environment",
  );
  assert.equal(
    (await runCheck({ ...c, program: "alcor-check-does-not-exist" }, options))
      .outcome,
    "environment",
  );
  assert.equal(
    (await runCheck({ ...c, args: ["fixture.cjs", "2&unsafe"] }, options))
      .outcome,
    "environment",
  );
  assert.equal(
    failureSignature("15 ms C:\\fixture\\a.js 0xAB"),
    failureSignature("20 ms D:\\project\\b.js 0xCC"),
  );
});

test(
  "Windows 批处理无拼接用户语法，接受带空格的程序路径",
  { skip: process.platform !== "win32" },
  async (t) => {
    const options = await fixture(t);
    const dir = join(options.root, "check binaries");
    await mkdir(dir);
    await writeFile(
      join(dir, "alcor-fixture.cmd"),
      "@echo off\r\necho fixture-%1\r\nexit /b 7\r\n",
    );
    const result = await runCheck(
      userCommand("cmd", "alcor-fixture argument"),
      { ...options, checkPath: [dir] },
    );
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /fixture-argument/);
  },
);

test(
  "超时和用户停止均终止派生进程",
  { skip: process.platform !== "win32" },
  async (t) => {
    const options = await fixture(t);
    await writeFile(
      join(options.root, "tree.cjs"),
      [
        "const { spawn } = require('node:child_process');",
        "const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {std​io: 'ignore', windowsHide: true});".replace(
          "\u200b",
          "",
        ),
        "const pids=process.pid+' '+p.pid; console.log(pids); require('node:fs').writeFileSync('tree.ready',pids); setInterval(()=>{},1000);",
      ].join("\n"),
    );
    const check = userCommand("tree", "node tree.cjs");
    const timeout = await runCheck(check, options);
    assert.equal(timeout.outcome, "timeout");
    const validate = (s: string) => {
      const pids = s.trim().split(/\s+/).map(Number);
      assert.equal(pids.length, 2, s);
      assert.ok(
        pids.every((pid) => pid > 0 && !checkPidAlive(pid)),
        s,
      );
    };
    validate(timeout.output);
    const ready = join(options.root, "tree.ready");
    await rm(ready);
    const stop = new AbortController();
    const running = runCheck(check, {
      ...options,
      timeoutMs: 10000,
      signal: stop.signal,
    });
    let pids = "";
    try {
      for (let i = 0; !pids && i < 100; i++) {
        pids = await readFile(ready, "utf8").catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return "";
        });
        if (!pids) await delay(50);
      }
    } finally { stop.abort(); }
    const cancelled = await running;
    assert.match(pids, /^\d+ \d+$/);
    validate(pids);
    assert.equal(cancelled.outcome, undefined);
    assert.equal(cancelled.state, "ended");
    validate(cancelled.output);
  },
);
