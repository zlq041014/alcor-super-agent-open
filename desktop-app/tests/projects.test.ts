import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { Store, entity } from "../src/hub/store";
import { discoverProjects, readProgress } from "../src/hub/projects";
import type { Project } from "../src/shared/contracts";

class NativeCatalog extends EventEmitter {
  initialized = true;
  version = "fixture";
  calls: { method: string; params: any }[] = [];
  pages: any[] = [];
  fail = false;
  paths: Record<string, string> = {};
  async connect() {}
  async stop() {}
  reply() {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (this.fail) throw new Error("fixture offline");
    if (method === "project/list")
      return (
        this.pages[params.cursor ? 1 : 0] || { data: [], nextCursor: null }
      );
    if (method === "thread/list")
      return {
        data: [
          {
            id: "thread-fixture",
            cwd: params.cwd,
            name: "phase two",
            status: { type: "notLoaded" },
            updatedAt: 1794900000,
          },
        ],
        nextCursor: "earlier",
      };
    if (method === "thread/read")
      return {
        thread: { id: params.threadId, cwd: this.paths[params.threadId] },
      };
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "turn-fixture",
            status: "completed",
            items: [
              {
                id: "answer",
                type: "agentMessage",
                text: "界面开发已完成，设备验收仍待执行。",
              },
            ],
          },
        ],
        nextCursor: "older-turns",
      };
    return {};
  }
}
async function setup() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "discovery-"));
  const a = join(dir, "geelygalaxycruiser700"),
    b = join(dir, "another");
  await mkdir(a);
  await mkdir(b);
  const native = new NativeCatalog();
  native.pages = [
    {
      data: [
        { id: "native-a", name: "geelygalaxycruiser700", roots: [{ path: a }] },
      ],
      nextCursor: null,
    },
  ];
  native.paths["thread-fixture"] = a;
  const hub = new Hub(join(dir, "state"), native as any);
  return { dir, a, b, native, hub };
}
test("discovery imports all pages by root identity and keeps user names/removal", async () => {
  const f = await setup();
  try {
    const local = await f.hub.request({
      op: "project.add",
      path: f.a,
      name: "我的车型项目",
    });
    f.native.pages[0].nextCursor = "page-2";
    f.native.pages.push({
      data: [{ id: "native-b", name: "another", roots: [{ path: f.b }] }],
      nextCursor: null,
    });
    const first = await f.hub.refreshProjects(true);
    assert.equal(first.status, "ready");
    assert.equal(f.hub.store.all("project").length, 2);
    assert.equal(f.hub.project(local.id).name, "我的车型项目");
    assert.equal(f.hub.project(local.id).nativeProjectId, "native-a");
    await f.hub.request({ op: "project.update", id: local.id, remove: true });
    await f.hub.refreshProjects(true);
    assert.equal(f.hub.store.get("project", local.id).removed, true);
    assert.equal(f.hub.store.all("project").length, 2);
  } finally {
    f.hub.store.close();
  }
});
test("failed catalog page never replaces a prior complete snapshot with empty results", async () => {
  const f = await setup();
  try {
    await f.hub.refreshProjects(true);
    const before = f.hub.store.all("project");
    f.native.fail = true;
    const result = await f.hub.refreshProjects(true);
    assert.equal(result.status, "offline");
    assert.ok(result.lastSuccessAt);
    assert.deepEqual(f.hub.store.all("project"), before);
  } finally {
    f.hub.store.close();
  }
});
test("read progress gathers actual docs and paginated history without execution or file edits", async () => {
  const f = await setup();
  try {
    await writeFile(
      join(f.a, "README.md"),
      "# Project\n已完成设计，测试还未完成。",
    );
    await f.hub.refreshProjects(true);
    const p = f.hub.store.all<Project>("project")[0];
    const evidence = await readProgress(p, f.native, async () => {});
    assert.equal(
      evidence.documents[0].text,
      "# Project\n已完成设计，测试还未完成。",
    );
    assert.equal(
      evidence.sessions[0].turns[0].text[0],
      "界面开发已完成，设备验收仍待执行。",
    );
    assert.equal(evidence.sessions[0].runtimeStatus, "notLoaded");
    assert.equal(
      evidence.sources.find((s) => s.kind === "session")?.complete,
      false,
    );
    assert.equal(
      await readFile(join(f.a, "README.md"), "utf8"),
      "# Project\n已完成设计，测试还未完成。",
    );
    assert.ok(
      f.native.calls.every((c) =>
        [
          "project/list",
          "thread/list",
          "thread/read",
          "thread/turns/list",
        ].includes(c.method),
      ),
    );
  } finally {
    f.hub.store.close();
  }
});
test("Chinese project lookup reads evidence in the same chat and saves provenance", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.a, "README.md"), "已完成方案，待测试。");
    let calls = 0;
    f.hub.brain.advise = async (_cfg, raw) => {
      const context = JSON.parse(raw);
      calls++;
      if (!context.progressEvidence)
        return {
          text: "",
          model: "fixture",
          usage: { total_tokens: 1 },
          advice: {
            reply: "正在核对",
            proposal: null,
            lookup: { projectId: context.projects[0].id },
          },
        };
      assert.equal(
        context.progressEvidence.project.name,
        "geelygalaxycruiser700",
      );
      return {
        text: "",
        model: "fixture",
        usage: { total_tokens: 1 },
        advice: {
          reply: "根据 README.md 和近期会话，方案已完成，设备验收仍待执行。",
          proposal: null,
          lookup: null,
        },
      };
    };
    const result = await f.hub.chat("看看吉利项目开发到哪一步了", "lookup-1");
    assert.ok(result.projectId);
    assert.equal(calls, 2);
    const reply = f.hub.store.all("message").at(-1);
    assert.equal(reply.projectId, result.projectId);
    assert.ok(reply.sources.some((s: any) => s.kind === "document"));
    assert.ok(reply.sources.some((s: any) => s.kind === "session"));
    assert.equal(f.hub.store.all("task").length, 0);
    assert.ok(
      !f.native.calls.some((c) => /start|resume|interrupt/.test(c.method)),
    );
  } finally {
    f.hub.store.close();
  }
});
test("explicit project name works without a lookup round and prevents wrong-project reads", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.a, "README.md"), "fixture");
    f.hub.brain.advise = async (_cfg, raw) => {
      const c = JSON.parse(raw);
      assert.equal(c.progressEvidence.project.path, f.a);
      return {
        text: "",
        model: "fixture",
        usage: null,
        advice: { reply: "已根据已读取来源核对进度。", proposal: null },
      };
    };
    const result = await f.hub.chat("geelygalaxycruiser700项目", "explicit-1");
    assert.ok(!result.error);
    assert.ok(result.projectId);
    assert.equal(f.hub.store.all("invocation").length, 1);
  } finally {
    f.hub.store.close();
  }
});
test("same-name projects ask for concrete paths without reading either workspace", async () => {
  const f = await setup();
  try {
    f.native.pages = [
      {
        data: [
          { id: "a", name: "同名项目", roots: [{ path: f.a }] },
          { id: "b", name: "同名项目", roots: [{ path: f.b }] },
        ],
        nextCursor: null,
      },
    ];
    const result = await f.hub.chat("看看同名项目的进度", "ambiguous-1");
    assert.equal(result.proposal, null);
    assert.equal(f.hub.store.all("project").length, 2);
    assert.ok(f.hub.store.all("message").at(-1).text.includes(f.b));
    assert.ok(f.native.calls.every((c) => c.method === "project/list"));
  } finally {
    f.hub.store.close();
  }
});
test("model cannot supply an arbitrary project id or request a native write", async () => {
  const f = await setup();
  try {
    f.hub.brain.advise = async () => ({
      text: "",
      model: "fixture",
      usage: null,
      advice: {
        reply: "",
        proposal: null,
        lookup: { projectId: "unregistered" },
      },
    });
    const result = await f.hub.chat("查一下项目进度", "invalid-lookup");
    assert.ok(result.error);
    assert.equal(f.hub.store.all("project-read").length, 0);
    assert.ok(f.native.calls.every((c) => c.method === "project/list"));
  } finally {
    f.hub.store.close();
  }
});
test("offline model still returns retrieved project excerpts with sources", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.a, "README.md"), "目前完成接口，下一步设备测试。");
    f.hub.brain.advise = async () => {
      throw new Error("fixture model offline");
    };
    await f.hub.chat("看看geelygalaxycruiser700项目进度", "offline-model");
    const reply = f.hub.store.all("message").at(-1);
    assert.equal(reply.role, "assistant");
    assert.ok(reply.sources.length > 0);
    assert.ok(reply.text.includes("下一步设备测试"));
    assert.ok(!reply.text.includes("请提供项目 ID"));
  } finally {
    f.hub.store.close();
  }
});
test("project card progress check never clears an unrelated composer draft", async () => {
  const f = await setup();
  try {
    await f.hub.refreshProjects(true);
    f.hub.store.put("draft", { id: "main", text: "用户尚未发送的草稿" });
    f.hub.brain.advise = async () => ({
      text: "",
      model: "fixture",
      usage: null,
      advice: { reply: "已核对资料。", proposal: null },
    });
    await f.hub.request({
      op: "project.progress",
      id: f.hub.store.all("project")[0].id,
      requestId: "card-progress",
    });
    assert.equal(f.hub.store.get("draft", "main").text, "用户尚未发送的草稿");
  } finally {
    f.hub.store.close();
  }
});
