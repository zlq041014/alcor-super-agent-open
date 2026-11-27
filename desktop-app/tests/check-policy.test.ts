import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { authorizeCommand, userCommand } from "../src/core/check-policy";
import { bindCheck, discoverChecks } from "../src/hub/check-discovery";

test("检查授权：拒绝优先，模型只能使用项目入口或固定命令", () => {
  for (const line of [
    "node --test",
    "python -m pytest",
    "cargo check",
    "cargo test",
    "go vet ./...",
    "go test ./...",
    "dotnet build",
    "dotnet test",
  ])
    assert.equal(
      authorizeCommand(userCommand("check", line), "model").allowed,
      true,
      line,
    );
  for (const name of [
    "test",
    "typecheck",
    "type-check",
    "lint",
    "check",
    "build",
    "verify",
    "test:unit",
  ])
    assert.equal(
      authorizeCommand(userCommand(name, "npm run " + name), "existing", {
        name,
        bodies: ["node --test"],
      }).allowed,
      true,
      name,
    );
  for (const suffix of [
    "deploy",
    "publish",
    "release",
    "start",
    "dev",
    "serve",
    "watch",
    "package",
    "install",
    "clean",
    "fix",
    "format",
    "write",
  ]) {
    const name = "test:" + suffix;
    assert.equal(
      authorizeCommand(userCommand(name, "npm run " + name), "existing", {
        name,
        bodies: ["node --test"],
      }).allowed,
      false,
      name,
    );
  }
  for (const body of [
    "npm publish",
    "deploy",
    "git  push",
    "rm -rf",
    "rmdir /s",
    "del /s",
    "shutdown",
  ])
    assert.equal(
      authorizeCommand(userCommand("test", "npm run test"), "existing", {
        name: "test",
        bodies: [body],
      }).allowed,
      false,
      body,
    );
  for (const arg of [
    "evil&other",
    '"a"',
    "a%PATH%",
    "a b",
    "a|b",
    "!bang",
    "x^y",
  ])
    assert.equal(
      authorizeCommand(
        { ...userCommand("test", "node --test"), args: [arg] },
        "user",
      ).allowed,
      false,
      arg,
    );
  assert.throws(() => userCommand("test", 'node "two words"'));
  for (const line of [
    "npx eslint",
    "npm ci",
    "pnpm dlx lint",
    "dotnet restore",
    "python -m pip install pytest",
  ]) {
    assert.equal(
      authorizeCommand(userCommand("test", line), "user").allowed,
      false,
    );
    assert.equal(
      authorizeCommand(userCommand("test", "npm run test"), "existing", {
        name: "test",
        bodies: [line],
      }).allowed,
      false,
    );
  }
  assert.equal(
    authorizeCommand(userCommand("test", "node check.js"), "user").allowed,
    true,
  );
  assert.equal(
    authorizeCommand(userCommand("test", "node check.js"), "model").allowed,
    false,
  );
});

test("发现只查根或直属项目；绑定变更时重新判断脚本和钩子", async (t) => {
  const dir = await mkdtemp(
    join(
      (await mkdir(resolve(".test-data/check-policy"), { recursive: true })) ??
        resolve(".test-data/check-policy"),
      "fixture-",
    ),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "app"));
  const path = join(dir, "app", "package.json");
  await writeFile(path, JSON.stringify({ scripts: { test: "node --test" } }));
  const [original] = await discoverChecks(dir);
  assert.equal(original.input.name, "app:test");
  assert.equal(original.policy.allowed, true);
  await writeFile(
    path,
    JSON.stringify({ scripts: { test: "node --test", posttest: "git push" } }),
  );
  const current = await bindCheck(dir, original.input, "existing");
  assert.equal(current.policy.allowed, false);
  assert.notEqual(original.bindingHash, current.bindingHash);
  const actual = new Map(
    (await discoverChecks(process.cwd())).map((c) => [
      c.input.name,
      c.policy.allowed,
    ]),
  );
  assert.deepEqual(
    ["typecheck", "test", "build"].map((name) => actual.get(name)),
    [true, true, true],
  );
  assert.deepEqual(
    ["start", "package", "smoke"].map((name) => actual.get(name)),
    [false, false, false],
  );
});
