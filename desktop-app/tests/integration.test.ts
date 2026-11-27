import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  isolateWorkspace,
  integrate,
  integrationVersion,
  inspectIntegration,
  workspaceVersion,
} from "../src/hub/workspaces";
import { childEnv } from "../src/hub/security";
import {
  desktopDataDirectory,
  saveDesktopDataDirectory,
} from "../src/data-directory";
const exec = promisify(execFile);
async function fixture() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "integration-"));
}
test(
  "two real Hub processes cannot own one data directory, including a directory alias",
  { timeout: 20000 },
  async () => {
    const root = await fixture();
    const dir = join(root, "data"),
      alias = join(root, "data-link");
    await mkdir(dir);
    await symlink(
      dir,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const entry = resolve("dist/hub-entry.cjs");
    const launch = (path: string) =>
      fork(entry, [path], {
        env: { ...childEnv(), CODEX_HOME: join(root, "native") },
        silent: true,
        windowsHide: true,
      });
    const first = launch(dir);
    function event(child: ReturnType<typeof fork>) {
      return new Promise<any>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("hub launch timeout")),
          8000,
        );
        child.once("message", (m) => {
          clearTimeout(t);
          resolve(m);
        });
        child.once("error", reject);
      });
    }
    const close = (child: ReturnType<typeof fork>) =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        const timer = setTimeout(() => child.kill(), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
        if (child.connected)
          child.send({ id: "close-test", internal: "shutdown" }, () => {});
      });
    try {
      assert.equal((await event(first)).event, "ready");
      for (const path of [dir, alias]) {
        const second = launch(path);
        try {
          const result = await event(second);
          assert.equal(result.event, "fatal");
          assert.match(result.error, /独占锁/);
        } finally {
          await close(second);
        }
      }
    } finally {
      await close(first);
    }
    const reopened = launch(alias);
    try {
      assert.equal((await event(reopened)).event, "ready");
    } finally {
      await close(reopened);
    }
    const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
    try {
      const generation = db
        .prepare(
          "SELECT json_extract(data, '$.value') AS value FROM records WHERE kind='meta' AND id='generation'",
        )
        .get();
      assert.equal(generation?.value, 2);
    } finally {
      db.close();
    }
  },
);

test("a corrupted data directory selection cannot silently open a new ledger", async () => {
  const root = await fixture();
  const configured = join(root, "location.json"),
    choice = join(root, "saved"),
    alias = join(root, "saved-link"),
    fallback = join(root, "default");
  await mkdir(choice);
  await symlink(
    choice,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const expected = saveDesktopDataDirectory(root, alias);
  const location = await readFile(configured, "utf8");
  assert.deepEqual(JSON.parse(location), { dataDir: expected });
  assert.equal(desktopDataDirectory(root), expected);
  await writeFile(join(root, "not-a-directory"), "ordinary file");
  assert.throws(() =>
    saveDesktopDataDirectory(root, join(root, "not-a-directory")),
  );
  assert.equal(await readFile(configured, "utf8"), location);
  await writeFile(configured, "{");
  assert.throws(() => desktopDataDirectory(root), /没有切换到其他账本/);
  assert.equal(existsSync(fallback), false);
  assert.equal(desktopDataDirectory(root, alias), expected);
  await writeFile(configured, JSON.stringify({ dataDir: "relative-folder" }));
  assert.throws(() => desktopDataDirectory(root), /绝对数据目录/);
});
test(
  "Git integration publishes one verified patch including untracked files and preserves unrelated work",
  { timeout: 30000 },
  async () => {
    const git = "D:/dev/git/cmd/git.exe";
    if (!existsSync(git)) return;
    const root = await fixture(),
      source = join(root, "project");
    await mkdir(source);
    const command = (args: string[]) =>
      exec(
        git,
        [
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Alcor Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd: source, windowsHide: true, env: childEnv() },
      );
    await command(["init"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await writeFile(join(source, "b.txt"), "other\n");
    await command(["add", "a.txt", "b.txt"]);
    await command(["commit", "-m", "fixture baseline"]);
    const nested = join(source, "authorized-child");
    await mkdir(nested);
    await assert.rejects(
      isolateWorkspace(nested, join(root, "data"), "nested"),
      /须先绑定仓库根目录/,
    );
    const w = await isolateWorkspace(source, join(root, "data"), "first");
    assert.equal(w.isolation, "worktree");
    await writeFile(join(w.path, "a.txt"), "new\n");
    await writeFile(join(w.path, "新文件 附录.txt"), "added\n");
    await writeFile(join(w.path, "empty.txt"), "");
    await writeFile(join(source, "b.txt"), "user dirty\n");
    let writes = 0;
    const begin = () => {
      writes++;
    };
    const version = await integrationVersion(w.path, w.isolation, w.baseCommit);
    const beforeVersion = (await workspaceVersion(source)).version;
    assert.equal(
      await inspectIntegration(
        source,
        w.path,
        w.isolation,
        w.baseCommit,
        version,
        beforeVersion,
      ),
      "unchanged",
    );
    await integrate(source, w.path, w.isolation, w.baseCommit, version, begin);
    assert.equal(
      await inspectIntegration(
        source,
        w.path,
        w.isolation,
        w.baseCommit,
        version,
        beforeVersion,
      ),
      "observed",
    );
    assert.equal(
      (await readFile(join(source, "a.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "new\n",
    );
    assert.equal(await readFile(join(source, "b.txt"), "utf8"), "user dirty\n");
    assert.equal(
      (await readFile(join(source, "新文件 附录.txt"), "utf8")).trim(),
      "added",
    );
    assert.equal(await readFile(join(source, "empty.txt"), "utf8"), "");
    assert.equal(
      (await command(["diff", "--cached", "--name-only"])).stdout,
      "",
    );
    const w2 = await isolateWorkspace(source, join(root, "data"), "second");
    await writeFile(join(w2.path, "a.txt"), "conflicting\n");
    await writeFile(join(w2.path, "untouched.txt"), "delivered");
    const next = await integrationVersion(w2.path, "worktree", w2.baseCommit);
    await writeFile(join(w2.path, "untouched.txt"), "edited later");
    await assert.rejects(
      integrate(source, w2.path, "worktree", w2.baseCommit, next, begin),
      /回合结束后有变化/,
    );
    await writeFile(join(w2.path, "untouched.txt"), "delivered");
    await assert.rejects(
      integrate(source, w2.path, "worktree", w2.baseCommit, next, begin),
      /冲突，未写入/,
    );
    assert.equal(
      (await readFile(join(source, "a.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "new\n",
    );
    assert.equal(existsSync(join(source, "untouched.txt")), false);
    assert.equal(writes, 1);
  },
);
