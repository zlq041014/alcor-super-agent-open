import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { candidateEdits, preflightCandidate, prepareCandidates } from "../src/hub/candidate-workspace";

test("候选的依赖不共享，提交前能拒绝外部变化与依赖联接", async (t) => {
  const base = resolve(".test-data");
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(join(base, "candidate-copy-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  const root = join(run, "project"), scratch = join(run, "copies");
  await mkdir(root);
  const git = (...args: string[]) => promisify(execFile)("D:/dev/git/cmd/git.exe", args, { cwd: root, windowsHide: true });
  await git("init", "--quiet");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "main.mjs"), "export const value = '原内容';\n");
  await git("add", "--", ".gitignore", "main.mjs");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  const dependencies = join(root, "node_modules", "dep");
  await mkdir(dependencies, { recursive: true });
  await writeFile(join(dependencies, "package.json"), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(dependencies, "index.js"), "export const marker = '真实依赖';\n");
  const pair = await prepareCandidates(root, scratch, 2);
  try {
    const [a, b] = pair.paths;
    const load = (path: string) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", "import {marker} from 'dep'; console.log(marker)"], { cwd: path, windowsHide: true });
    assert.match((await load(a)).stdout, /真实依赖/);
    await writeFile(join(a, "node_modules", "dep", "index.js"), "export const marker = '仅候选甲';\n");
    assert.match((await load(a)).stdout, /仅候选甲/);
    assert.match((await load(b)).stdout, /真实依赖/);
    assert.match((await load(root)).stdout, /真实依赖/);
    await writeFile(join(a, "main.mjs"), "export const value = '候选结果';\n");
    const edits = await candidateEdits(a, pair.files, new Set(["main.mjs"]));
    await preflightCandidate(root, pair.baseVersion, edits);
    await writeFile(join(root, "main.mjs"), "export const value = '用户在途修改';\n");
    await assert.rejects(preflightCandidate(root, pair.baseVersion, edits), /原目录已变化/);
    assert.match(await readFile(join(root, "main.mjs"), "utf8"), /用户在途修改/);
  } finally {
    await pair.clean();
  }
  const link = join(root, "node_modules", "external");
  await mkdir(join(run, "outside"));
  await symlink(join(run, "outside"), link, "junction");
  try {
    await assert.rejects(prepareCandidates(root, scratch, 2), /依赖含链接/);
    assert.deepEqual(await readdir(scratch), []);
  } finally { await unlink(link); }
});
