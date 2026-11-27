import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hub } from "../src/hub/service";
import { createIntent } from "../src/hub/project-intent";
import { projectFileList } from "../src/everything";
import type { Message, Project } from "../src/shared/contracts";

async function fixture() {
  const base = resolve(".test-data");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "local-projects-")),
    root = join(dir, "我的 项目"),
    other = join(dir, "其它位置");
  await mkdir(root);
  await mkdir(other);
  const native = Object.assign(new EventEmitter(), {
    initialized: true,
    calls: [] as string[],
    data: [] as any[],
    offline: true,
    async call(m: string) {
      this.calls.push(m);
      if (this.offline) throw new Error("offline");
      return { data: m === "project/list" ? this.data : [], nextCursor: null };
    },
  });
  const state = join(dir, "state"),
    h = new Hub(state, native as any, resolve("tools/fd/fd.exe"));
  const add = (path: string) => h.request({ op: "projects.rootAdd", path });
  const send = (text: string) =>
    h.request({ op: "chat", text, requestId: crypto.randomUUID() });
  const last = () => h.store.all<Message>("message").at(-1)!;
  const rows = () => h.store.all<Project>("project").filter((p) => !p.removed);
  return { h, root, other, dir, state, add, send, last, rows, native };
}
test("总管按名称在指定位置查找文件和目录，无需模型或 Codex", async () => {
  const f = await fixture();
  const folder = join(f.root, "技术美术"),
    matching = join(folder, "清单.txt"),
    outside = join(f.other, "清单-外部.txt"),
    junction = join(f.root, "链接");
  try {
    await mkdir(folder);
    await writeFile(matching, "不读取正文");
    await writeFile(outside, "");
    await symlink(f.other, junction, "junction");
    await f.send("在 " + f.root + " 查找文件 清单");
    assert.ok(f.last().text.includes(matching), f.last().text);
    assert.ok(!f.last().text.includes("清单-外部.txt"));
    assert.ok(!f.last().text.includes("不读取正文"));
    assert.deepEqual(f.rows(), []);
    await f.add(f.root);
    await f.send("查找文件夹 技术美术");
    assert.ok(f.last().text.includes(folder), f.last().text);
    await f.send("查找文件 不存在的文件");
    assert.match(f.last().text, /没有找到匹配/);
    assert.deepEqual(f.native.calls, []);
    assert.equal(f.h.store.all("invocation").length, 0);
    assert.equal(f.h.store.all("task").length, 0);
  } finally {
    f.h.store.close();
  }
});
test("Codex 离线时总管能实测本机目录访问并列出未登记目录", async () => {
  const f = await fixture();
  try {
    f.h.store.put("catalog", { id: "codex", status: "offline", count: 0 });
    await mkdir(join(f.other, "子目录"));
    await writeFile(join(f.other, "样例.txt"), "正文不会进入结果");
    await f.send("你现在可以读文件夹了吧");
    assert.match(f.last().text, /刚用本机文件系统打开目录验证过/);
    await f.send("看看 " + f.other + " 里有什么");
    assert.match(f.last().text, /子目录\//);
    assert.match(f.last().text, /样例\.txt/);
    assert.doesNotMatch(f.last().text, /正文不会进入结果/);
    await assert.rejects(f.send("读取 " + join(f.other, "找不到")), /目录不存在/);
    assert.deepEqual(f.native.calls, []);
    assert.deepEqual(f.rows(), []);
    assert.equal(f.h.store.all("invocation").length, 0);
  } finally {
    f.h.store.close();
  }
});
test("在 project 中再找时刷新本机目录，只用用户原话定位，不读取猜测项目", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "game-dev"));
    await f.add(f.root);
    const target = join(f.root, "tech-art-daily");
    await mkdir(target);
    f.h.store.put("catalog", { id: "codex", status: "offline", count: 0 });
    f.h.message("user", "找到技术美术作品集项目", undefined, "answered");
    f.h.message("assistant", "先前猜的是 game-dev");
    f.h.brain.advise = async (_cfg, input) => {
      const context = JSON.parse(input);
      const project = context.projects.find((p: Project) => p.path === target);
      assert.ok(project, "应实际刷新刚新增的目录");
      assert.ok(context.localProjectSearch.includes(f.root));
      assert.ok(context.recent.some((m: Message) => m.text === "找到技术美术作品集项目"));
      assert.ok(context.recent.every((m: Message) => m.role === "user"));
      return { model: "fixture", text: "", usage: null, advice: { reply: "", proposal: null, lookup: { projectId: project.id } } };
    };
    await f.send("你自己再project中找");
    assert.equal(f.last().text, "已在本机找到：" + target);
    assert.equal(f.h.store.all("project-read").length, 0);
    assert.deepEqual(f.native.calls, []);
    f.h.brain.advise = async () => ({
      model: "fixture", text: "", usage: null, advice: { reply: "可能是 game-dev", proposal: null, lookup: null },
    });
    await f.send("在项目目录里找未知项目");
    assert.match(f.last().text, /没有找到能确定匹配的项目/);
    assert.doesNotMatch(f.last().text, /game-dev/);
    assert.equal(f.h.store.all("project-read").length, 0);
  } finally {
    f.h.store.close();
  }
});
test("离线只索引授权直属文件夹；漏项刷新、手选、原生关联和重启沿用身份", async () => {
  const f = await fixture(),
    project = join(f.root, "星引"),
    nested = join(project, "desktop-app"),
    external = join(f.other, "外部");
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(external);
    await mkdir(join(f.root, "node_modules"));
    await symlink(external, join(f.root, "跳转"), "junction");
    await f.add(f.root);
    assert.deepEqual(
      f.rows().map((p) => p.path),
      [project],
    );
    const first = f.rows()[0];
    await f.h.request({ op: "project.update", id: first.id, name: "星图" });
    await mkdir(join(f.root, "刚刚新增"));
    await f.send("找一下刚刚新增项目");
    assert.equal(
      f.last().projectId,
      f.rows().find((p) => p.name === "刚刚新增")!.id,
    );
    await f.send("找星引项目");
    assert.equal(f.last().projectId, first.id);
    assert.deepEqual(f.native.calls, []);
    f.h.store.put("message", {
      ...f.last(),
      id: "old-history",
      projectId: first.id,
      text: "保留的讨论",
    });
    f.native.offline = false;
    f.native.data = [{ id: "n", name: "原生别名", roots: [{ path: project }] }];
    await f.h.refreshProjects(true);
    assert.equal(f.rows().length, 2);
    assert.equal(f.h.project(first.id).name, "星图");
    assert.equal(f.h.project(first.id).nativeProjectId, "n");
    await f.send("定位原生别名项目");
    assert.equal(f.last().projectId, first.id);
    assert.equal(f.h.store.get("message", "old-history").projectId, first.id);
    await f.h.request({ op: "project.update", id: first.id, remove: true });
    await f.h.refreshProjects(true);
    assert.equal(f.rows().length, 1);
  } finally {
    f.h.store.close();
  }
  const reopened = new Hub(f.state, f.native as any);
  try {
    assert.equal((await reopened.snapshot()).projectRoots[0].path, f.root);
    await reopened.refreshProjects(true);
    assert.equal(
      reopened.store.all<Project>("project").filter((p) => !p.removed).length,
      1,
    );
  } finally {
    reopened.store.close();
  }
});
test("同名选择继续原进度查询；缺失的绑定不按同名重定向或悄悄新建", async () => {
  const f = await fixture(),
    a = join(f.root, "同名"),
    b = join(f.other, "同名");
  try {
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(b, "README.md"), "第二份资料");
    await f.add(f.root);
    await f.add(f.other);
    await f.send("看看同名项目的进度");
    const ask = f.last();
    assert.equal(ask.choices?.length, 2);
    assert.ok(ask.text.includes(a) && ask.text.includes(b));
    assert.equal(f.h.store.all("project-read").length, 0);
    const index = ask.choices!.findIndex((c) => c.label.includes(b));
    await f.h.request({
      op: "agent.choose",
      messageId: ask.id,
      index,
      requestId: "choose-b",
    });
    assert.ok(f.last().text.includes("第二份资料"));
    assert.equal(f.last().projectId, f.rows().find((p) => p.path === b)!.id);
    const old = f.rows().find((p) => p.path === a)!;
    await rename(a, join(f.dir, "moved"));
    await f.h.refreshLocal(true);
    assert.equal(f.h.project(old.id).available, false);
    await assert.rejects(
      f.h.request({ op: "project.create", parent: f.root, name: "同名" }),
      /失联/,
    );
    await assert.rejects(f.h.request({ op: "project.directory", id: old.id }));
    assert.equal(f.h.project(old.id).path, a);
  } finally {
    f.h.store.close();
  }
});
test("未命中提供已查位置、已有目录和新建；选好后继续原请求；明确新建不覆盖", async () => {
  const f = await fixture(),
    p = join(f.root, "天气记录");
  try {
    await f.add(f.root);
    await f.send("看看天气记录项目的进度");
    const ask = f.last();
    assert.ok(ask.projectPicker);
    assert.ok(ask.text.includes(f.root));
    assert.deepEqual(await readdir(f.root), []);
    const r = await f.send("在 " + f.root + " 新建项目「天气记录」");
    assert.equal(f.h.project(r.projectId).path, p);
    assert.deepEqual(await readdir(p), []);
    await writeFile(join(p, "README.md"), "已有的说明不应覆盖");
    await f.send("新建「天气记录」项目");
    assert.ok(f.last().projectPicker?.collision);
    const use = await f.h.request({
      op: "project.create",
      parent: f.root,
      name: "天气记录",
      reuse: true,
    });
    assert.equal(use.project.id, r.projectId);
    await f.h.request({
      op: "project.use",
      messageId: ask.id,
      projectId: r.projectId,
      requestId: "pick-new",
    });
    assert.ok(f.last().text.includes("已有的说明不应覆盖"));
    assert.equal(
      await readFile(join(p, "README.md"), "utf8"),
      "已有的说明不应覆盖",
    );
    assert.equal(f.h.store.all("task").length, 0);
    for (const name of [
      "../escape",
      "LPT1",
      "other:stream",
      "folder.",
      "x\\nested",
    ])
      await assert.rejects(
        f.h.request({ op: "project.create", parent: f.root, name }),
      );
    await assert.rejects(access(join(f.dir, "escape")));
    const rootRec = (await f.h.snapshot()).projectRoots[0];
    await rename(f.root, join(f.dir, "offline"));
    await f.send("查找一个未登记项目");
    assert.ok(f.last().text.includes("无法访问"));
    await f.h.request({ op: "projects.rootRemove", id: rootRec.id });
    assert.ok(f.h.project(r.projectId));
  } finally {
    f.h.store.close();
  }
});
test("Everything 清单仅含已选位置的实际项目目录，并保留 CSV 中的逗号和中文", async () => {
  const f = await fixture(),
    path = join(f.root, "中文,项目"),
    hidden = join(f.other, "仅在原生端");
  try {
    await mkdir(path);
    await mkdir(hidden);
    await f.add(f.root);
    f.native.offline = false;
    f.native.data = [{ id: "hidden", name: "其他", roots: [{ path: hidden }] }];
    await f.h.refreshProjects(true);
    const rows = await f.h.request({ op: "projects.fileList" }),
      list = projectFileList(rows);
    assert.deepEqual(rows, [{ path }]);
    assert.equal(list.count, 1);
    assert.ok(list.text.includes('"' + path + '\\",,,,16'));
    assert.ok(!list.text.includes(hidden));
    assert.equal(f.h.store.all("project-read").length, 0);
  } finally {
    f.h.store.close();
  }
});
test("新建和新开讨论、举例、否定、询问有清晰区别", () => {
  for (const cmd of [
    "新建项目讨论",
    "新开项目会话",
    "不要新建「天气」项目",
    "能否新建天气项目？",
    "新建项目之前先讨论",
    "例如在 D:\\projects 新建天气项目",
    "新建项目怎么做",
    "新建「天气」项目，然后执行脚本",
  ])
    assert.equal(createIntent(cmd), undefined, cmd);
  assert.deepEqual(createIntent("请在 D:\\projects 新建项目「天气记录」"), {
    parent: "D:\\projects",
    name: "天气记录",
  });
  assert.deepEqual(createIntent("新建「天气记录」项目"), {
    parent: undefined,
    name: "天气记录",
  });
});
test("指定不存在的项目新开讨论时，不选仅有项目，也不误用同名讨论", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "现有样例"));
    await f.add(f.root);
    await f.send("给外地样例新开讨论");
    assert.ok(f.last().projectPicker);
    assert.equal(f.last().projectPicker?.name, "外地样例");
    assert.equal(f.h.store.all("agent").length, 0);
    assert.equal((await f.h.snapshot()).launches.length, 0);
  } finally {
    f.h.store.close();
  }
});
