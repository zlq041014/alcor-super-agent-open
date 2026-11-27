import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import {
  defaults,
  apiTarget,
  CUSTOM_ENDPOINT,
  OFFICIAL_ENDPOINT,
  defaultProfile,
  readSettings,
} from "../src/shared/contracts";
import { Brain } from "../src/hub/brain";
import { Vault, hash } from "../src/hub/security";
import { workspaceMcp } from "../src/adapter/dsh-files";
import { dshModelInput } from "../src/adapter/dsh";
import { dshModelRoute } from "../src/adapter/dsh-model";
import { dshReceipt } from "../src/adapter/dsh-receipt";
import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
import { LEDGER_VERSION, Store } from "../src/hub/store";

const fixture = async () => {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "dsh-contract-"));
};
test("opening a v1 ledger preserves a restorable snapshot before fencing old writers", async () => {
  const dir = await fixture();
  const old = new DatabaseSync(join(dir, "state.sqlite"));
  old.exec(
    "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;",
  );
  old
    .prepare("INSERT INTO records VALUES(?,?,?,?)")
    .run(
      "draft",
      "main",
      JSON.stringify({ id: "main", text: "example draft" }),
      "fixture",
    );
  old.close();
  const store = new Store(dir);
  try {
    assert.equal(
      store.db.prepare("PRAGMA user_version").get()?.user_version,
      LEDGER_VERSION,
    );
    assert.equal(store.get("draft", "main")?.text, "example draft");
    const [name] = await readdir(join(dir, "backups"));
    const backup = join(dir, "backups", name);
    const manifest = JSON.parse(
      await readFile(join(backup, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(
      manifest.databaseHash,
      hash(await readFile(join(backup, "state.sqlite"))),
    );
    const saved = new DatabaseSync(join(backup, "state.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(saved.prepare("PRAGMA user_version").get()?.user_version, 1);
    } finally {
      saved.close();
    }
  } finally {
    store.close();
  }
});
test("new and stock legacy defaults use the custom Flash/max route; explicit choices survive", () => {
  for (const cfg of [
    defaults,
    readSettings({
      profileVersion: 1,
      model: "gpt-6.2-astra",
      codexModel: "gpt-6.2-sol",
      endpoint: CUSTOM_ENDPOINT,
      protocol: "responses",
    }),
  ]) {
    assert.deepEqual(apiTarget(cfg), {
      endpoint: CUSTOM_ENDPOINT,
      protocol: "chat",
    });
    assert.equal(cfg.executorBackend, "dsh");
    for (const chief of [false, true])
      assert.deepEqual(defaultProfile(cfg, chief), {
        model: "deepseek-flash",
        effort: "max",
      });
  }
  const explicit = readSettings({
    profileVersion: 1,
    endpoint: "https://example.invalid",
    protocol: "responses",
    model: "my-chief",
    codexModel: "my-worker",
    memberEffort: "low",
  });
  assert.deepEqual(apiTarget(explicit), {
    endpoint: "https://example.invalid",
    protocol: "responses",
  });
  assert.deepEqual(defaultProfile(explicit), {
    model: "my-worker",
    effort: "low",
  });
  assert.deepEqual(readSettings(explicit), explicit);
});

test(
  "official is pinned to DeepSeek Chat and its own DPAPI key even with a saved custom Responses route",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await fixture(),
      brain = new Brain(new Vault(dir));
    const custom = {
      ...defaults,
      endpoint: "https://example.invalid/v1",
      protocol: "responses" as const,
    };
    const official = { ...custom, apiSource: "deepseek" as const };
    await brain.vaultFor(custom).save(custom.endpoint, "CUSTOM-PLACEHOLDER");
    assert.equal(await brain.configured(official), false);
    await assert.rejects(brain.key(official), /官方/);
    await brain
      .vaultFor(official)
      .save(OFFICIAL_ENDPOINT, "OFFICIAL-PLACEHOLDER");
    const seen: any[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        seen.push({
          url,
          auth: (init.headers as any).Authorization,
          body,
          redirect: init.redirect,
        });
        return Response.json({
          model: body.model,
          choices: [
            {
              message: {
                content: "ok",
                reasoning_content: "PRIVATE-PLACEHOLDER",
              },
            },
          ],
          output_text: "ok",
        });
      },
    );
    const r = await brain.complete(official, "sample", "sample");
    assert.equal(r.text, "ok");
    assert.equal(r.summary, undefined);
    assert.equal(seen[0].url, OFFICIAL_ENDPOINT + "/chat/completions");
    assert.equal(seen[0].auth, "Bearer OFFICIAL-PLACEHOLDER");
    assert.equal(seen[0].body.reasoning_effort, "max");
    assert.equal(seen[0].body.max_tokens, defaults.maxOutputTokens);
    assert.equal(seen[0].body.model, "deepseek-flash");
    assert.equal(seen[0].redirect, "error");
    await brain.complete(custom, "sample", "sample");
    assert.equal(seen[1].url, custom.endpoint + "/responses");
    assert.equal(seen[1].auth, "Bearer CUSTOM-PLACEHOLDER");
    await brain.complete(
      { ...official, reasoningEffort: "none" },
      "sample",
      "sample",
    );
    assert.deepEqual(seen[2].body.thinking, { type: "disabled" });
    assert.equal(seen[2].body.reasoning_effort, undefined);
  },
);

test("DSH model route pins destination and model, preserves native output and separates workspace credentials", async () => {
  const dir = await fixture(),
    calls: any[] = [];
  const upstream = createServer(async (req, res) => {
    const pieces = [];
    for await (const b of req) pieces.push(b);
    calls.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(pieces).toString()),
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"usa');
    res.end(
      'ge": {"total_tokens": 17}}\n\ndata: {"usage":{"total_tokens":23}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  try {
    const addr = upstream.address();
    assert.ok(addr && typeof addr !== "string");
    const cfg = { ...defaults, endpoint: `http://127.0.0.1:${addr.port}/v1` };
    const route = await dshModelRoute(
      cfg,
      defaultProfile(cfg),
      "UPSTREAM-PLACEHOLDER",
      { cwd: dir, write: false },
    );
    try {
      const post = (url: string, token: string, body: any) =>
        fetch(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: JSON.stringify(body),
        });
      assert.equal(
        (
          await post(
            route.endpoint + "/chat/completions",
            "WRONG-PLACEHOLDER",
            {},
          )
        ).status,
        403,
      );
      assert.equal((await post(route.mcp.url, route.token, {})).status, 403);
      assert.equal(
        (
          await post(route.endpoint + "/chat/completions", route.token, {
            model: "other",
          })
        ).status,
        400,
      );
      const response = await post(
        route.endpoint + "/chat/completions",
        route.token,
        {
          model: "deepseek-flash",
          max_tokens: 999999,
          reasoning_effort: "low",
        },
      );
      assert.match(await response.text(), /DONE/);
      assert.deepEqual(route.evidence.usage, {
        requests: 1,
        knownRequests: 1,
        tokensKnown: 23,
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        path: "/v1/chat/completions",
        auth: "Bearer UPSTREAM-PLACEHOLDER",
        body: {
          model: "deepseek-flash",
          max_tokens: 999999,
          reasoning_effort: "max",
        },
      });
    } finally {
      route.close();
    }
  } finally {
    upstream.close();
    upstream.closeAllConnections();
  }
});

test("DSH file tools enforce task scope on read, write, links, protected files and clobbering", async () => {
  const dir = await fixture(),
    root = join(dir, "project"),
    other = join(dir, "neighbor");
  await mkdir(root);
  await mkdir(other);
  await writeFile(join(other, "sample.txt"), "outside");
  await symlink(other, join(root, "linked"), "junction");
  const use = (write: boolean, name: string, args: any) =>
    workspaceMcp(root, { write })({
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }).then((x) => (x as any).result);
  assert.equal(
    (await use(false, "write_file", { path: "sample.txt", text: "denied" }))
      .isError,
    true,
  );
  for (const path of [
    "../neighbor/sample.txt",
    join(other, "sample.txt"),
    "linked/sample.txt",
    ".env",
    "api-key.dpapi",
    "key.txt",
    "sample.txt:stream",
    ".. /sample.txt",
  ])
    assert.equal((await use(true, "read_file", { path })).isError, true);
  assert.equal(
    (await use(true, "write_file", { path: "sample.txt", text: "first" }))
      .isError,
    false,
  );
  assert.equal(
    (await use(true, "write_file", { path: "sample.txt", text: "clobber" }))
      .isError,
    true,
  );
  assert.equal(
    (
      await use(true, "edit_file", {
        path: "sample.txt",
        old_text: "first",
        new_text: "second",
      })
    ).isError,
    false,
  );
  assert.equal(
    (await use(false, "read_file", { path: "sample.txt" })).content[0].text,
    "second",
  );
  assert.equal(await readFile(join(other, "sample.txt"), "utf8"), "outside");
});

test("循环文件工具锁定已有验收路径和 scripts，新增测试仍可写", async () => {
  const root = await fixture();
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "keep.test.js"), "original");
  await writeFile(
    join(root, "package.json"),
    '{"scripts":{"test":"node --test"},"dependencies":{"a":"1"}}',
  );
  const rejected: string[] = [];
  const call = workspaceMcp(root, {
    write: true,
    paths: { protect: ["tests/KEEP.test.js"], lockPackageScripts: true },
    journal: { rejected: (path) => rejected.push(path) },
  });
  const callTool = async (name: string, args: object) =>
    (
      (await call({
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      })) as any
    ).result;
  const edit = (path: string, old_text: string, new_text: string) =>
    callTool("edit_file", { path, old_text, new_text });
  assert.equal(
    (await edit("tests\\keep.test.js", "original", "tampered")).isError,
    true,
  );
  assert.equal(
    await readFile(join(root, "tests", "keep.test.js"), "utf8"),
    "original",
  );
  assert.equal(
    (await callTool("write_file", { path: "tests/new.test.js", text: "new" }))
      .isError,
    false,
  );
  assert.equal(
    (await edit("package.json", '"a":"1"', '"a":"2"')).isError,
    false,
  );
  assert.equal(
    (await edit("package.json", "node --test", "exit 0")).isError,
    true,
  );
  assert.equal((await edit("package.json", "scripts", '"')).isError, true);
  assert.deepEqual(rejected, [
    "tests/keep.test.js",
    "package.json",
    "package.json",
  ]);
  const author = workspaceMcp(root, {
    write: true,
    paths: { protect: [], allowOnly: ["tests/**"], lockPackageScripts: true },
  });
  const write = async (path: string) =>
    (
      (await author({
        id: 1,
        method: "tools/call",
        params: { name: "write_file", arguments: { path, text: "new" } },
      })) as any
    ).result;
  assert.equal((await write("implementation.js")).isError, true);
  assert.equal((await write("tests/acceptance.js")).isError, false);
});

test("DSH recovery requires the matching session, workspace, prompt hash and native terminal turn", async () => {
  const home = await fixture(),
    id = randomUUID(),
    folder = join(home, "sessions", "group", id);
  await mkdir(folder, { recursive: true });
  const prompt = "unique synthetic dispatch";
  const answer = "原生输出".repeat(40000) + "\n建议收口";
  const events = [
    { type: "session", id, version: 4, cwd: home },
    { type: "turn/start", data: { turn: 1 } },
    {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: prompt }],
      },
    },
    {
      type: "assistant/message",
      data: {
        turn: 1,
        message: {
          content: [
            { type: "reasoning", text: "PRIVATE-PLACEHOLDER" },
            { type: "text", text: answer },
          ],
        },
      },
    },
    {
      type: "user/message",
      data: {
        source: { kind: "runtime-context" },
        content: [{ type: "text", text: "context-only" }],
      },
    },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const save = (v: any[]) =>
    writeFile(
      join(folder, "session.v4.jsonl.zstd"),
      zstdCompressSync(v.map((e) => JSON.stringify(e)).join("\n")),
    );
  await save(events);
  assert.deepEqual(await dshReceipt(home, home, id, hash(prompt)), {
    status: "completed",
    answer,
    nativeEndReason: "completed",
  });
  assert.equal(
    await dshReceipt(home, home, id, hash("other dispatch")),
    undefined,
  );
  assert.equal(
    await dshReceipt(home, join(home, "other"), id, hash(prompt)),
    undefined,
  );
  await save(events.slice(0, -1));
  assert.equal(await dshReceipt(home, home, id, hash(prompt)), undefined);
  await save([
    ...events.slice(0, -1),
    { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
  ]);
  assert.deepEqual(await dshReceipt(home, home, id, hash(prompt)), {
    status: "failed",
    answer,
    nativeEndReason: "max-tokens",
  });
});

test("只有自定义网关的 deepseek-flash 声明图像输入，其余路由保持纯文本", () => {
  const flash = { model: "deepseek-flash", effort: "max" } as const;
  assert.deepEqual(dshModelInput(defaults, flash), ["text", "image"]);
  assert.deepEqual(dshModelInput({ ...defaults, apiSource: "deepseek" }, flash), ["text"]);
  assert.deepEqual(dshModelInput(defaults, { ...flash, model: "deepseek-pro" }), ["text"]);
});
