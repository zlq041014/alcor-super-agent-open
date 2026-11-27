import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Run } from "../src/shared/contracts";
import { Journal } from "../src/hub/journal";
import { entity, Store } from "../src/hub/store";
import { workspaceMcp } from "../src/adapter/dsh-files";

async function fixture(t: TestContext) {
  const base = resolve(".test-data/journal");
  await mkdir(base, { recursive: true });
  const area = await mkdtemp(join(base, "entry-"));
  const root = join(area, "project"),
    data = join(area, "state");
  await mkdir(root);
  const store = new Store(data),
    journal = new Journal(store, data);
  t.after(async () => {
    store.close();
    await rm(area, { recursive: true, force: true });
  });
  const tools = () => {
    const run = { ...entity(), workPath: root } as Run;
    const mcp = workspaceMcp(root, {
      write: true,
      paths: { protect: [], lockPackageScripts: true },
      journal: {
        ...journal.sink(run, "loop", "scope", () => {}),
        rejected() {},
      },
    });
    const call = async (name: string, arguments_: Record<string, string>) => {
      const reply = await mcp({
        id: "test",
        method: "tools/call",
        params: { name, arguments: arguments_ },
      });
      assert.ok("result" in reply && "isError" in reply.result);
      assert.equal(reply.result.isError, false, reply.result.content[0].text);
    };
    return { run, call };
  };
  return { journal, root, store, tools };
}

test("工作区工具只记录首次前镜像，生成实际补丁并保留外部修改", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "result.txt"), "one\nunchanged\ntwo\n");
  const a = f.tools();
  await a.call("edit_file", {
    path: "result.txt",
    old_text: "one",
    new_text: "three",
  });
  await a.call("edit_file", {
    path: "result.txt",
    old_text: "two",
    new_text: "four",
  });
  await a.call("create_directory", { path: "generated" });
  await a.call("write_file", { path: "generated/new.txt", text: "app data\n" });
  const files = f.journal.files(a.run, "loop");
  const modified = files.find((file) => file.path === "result.txt")!;
  assert.match(modified.patch!, /-one\n\+three\n unchanged\n-two\n\+four/);
  assert.equal(modified.removed, 2);
  assert.equal(modified.added, 2);
  assert.equal(
    f.store.all("file-journal").filter((row) => row.path === "result.txt")
      .length,
    1,
  );
  await writeFile(join(f.root, "result.txt"), "external edit\n");
  const result = f.journal.rollback("loop", f.root, "scope");
  assert.deepEqual(result, { restored: 2, skipped: ["result.txt"] });
  assert.equal(
    await readFile(join(f.root, "result.txt"), "utf8"),
    "external edit\n",
  );
  await assert.rejects(
    readFile(join(f.root, "generated", "new.txt")),
    /ENOENT/,
  );
});

test("回退以最近通过的检查点为目标，中断后按文件实际状态续做", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "change.txt");
  await writeFile(file, "initial\n");
  const accepted = f.tools();
  await accepted.call("edit_file", {
    path: "change.txt",
    old_text: "initial",
    new_text: "checkpoint",
  });
  f.journal.checkpoint("loop", "scope", "verified-version", accepted.run.id);
  const interrupted = f.tools();
  await interrupted.call("edit_file", {
    path: "change.txt",
    old_text: "checkpoint",
    new_text: "attempted",
  });
  const row = f.store
    .all("file-journal")
    .find((entry) => entry.runId === interrupted.run.id);
  f.store.put("file-journal", { ...row, restored: "restoring" });
  await writeFile(file, "checkpoint\n"); // Crash already replaced this file, but not its receipt.
  await interrupted.call("write_file", {
    path: "extra.txt",
    text: "remove this\n",
  });
  assert.deepEqual(f.journal.rollback("loop", f.root, "scope"), {
    restored: 1,
    skipped: [],
  });
  assert.equal(await readFile(file, "utf8"), "checkpoint\n");
  assert.deepEqual(f.journal.unrestored("loop"), []);
});

test("外部把文件改回较早的镜像时，不能绕过后续回退保护", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "value.txt");
  await writeFile(file, "initial");
  await f
    .tools()
    .call("edit_file", {
      path: "value.txt",
      old_text: "initial",
      new_text: "first change",
    });
  await f
    .tools()
    .call("edit_file", {
      path: "value.txt",
      old_text: "first change",
      new_text: "second change",
    });
  await writeFile(file, "first change");
  assert.deepEqual(f.journal.rollback("loop", f.root, "scope"), {
    restored: 0,
    skipped: ["value.txt"],
  });
  assert.equal(await readFile(file, "utf8"), "first change");
  assert.deepEqual(f.journal.unrestored("loop"), ["value.txt"]);
});
