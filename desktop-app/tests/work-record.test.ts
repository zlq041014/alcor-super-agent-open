import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Store, entity } from "../src/hub/store";
import {
  assigned,
  pageLines,
  rememberNative,
  sealWork,
  historicalPage,
} from "../src/hub/agent-ledger";
import {
  nativeStep,
  patchStats,
  verifiedFiles,
  publicDiff,
} from "../src/hub/native-work";
import { readResponseStream } from "../src/hub/public-progress";
import { workTrace } from "../src/hub/work-trace";
import type { Run, Task } from "../src/shared/contracts";
async function fixture() {
  const root = resolve(".test-data");
  await mkdir(root, { recursive: true });
  return new Store(await mkdtemp(join(root, "records-")));
}
test("native work is chronological, replay-safe per item and preserves actual file, failed command, image and commentary evidence", async () => {
  const s = await fixture();
  try {
    const t = { ...entity(), title: "测试执行", projectId: "p" } as Task,
      a = assigned(s, t);
    const r = {
      ...entity(),
      taskId: t.id,
      workPath: "D:\\fixture",
      outcome: "completed",
      diff: "",
    } as Run;
    const emit = (method: string, params: any) =>
      rememberNative(s, r, method, params);
    const delta = "@@ -1 +1,2 @@\n-before\n+after\n+verified\n";
    emit("item/started", {
      item: { id: "f", type: "fileChange", changes: [] },
    });
    emit("item/fileChange/patchUpdated", {
      itemId: "f",
      changes: [{ path: "TRACE.txt", kind: { type: "update" }, diff: delta }],
    });
    emit("item/completed", {
      item: { id: "f", status: "completed", type: "fileChange", changes: [] },
    });
    emit("item/started", {
      item: {
        id: "c",
        type: "commandExecution",
        command: "inspect fixture",
        status: "inProgress",
      },
    });
    emit("item/commandExecution/outputDelta", {
      itemId: "c",
      delta: "sample error",
    });
    emit("item/completed", {
      item: {
        id: "c",
        type: "commandExecution",
        command: "inspect fixture",
        exitCode: 3,
        durationMs: 45,
      },
    });
    emit("item/started", {
      item: { id: "c", type: "commandExecution", command: "inspect fixture" },
    });
    emit("item/fileChange/patchUpdated", { itemId: "f", changes: [] });
    emit("item/completed", {
      item: { id: "i", type: "imageView", path: "D:\\fixture\\sample.png" },
    });
    emit("item/completed", {
      item: {
        id: "m",
        type: "agentMessage",
        phase: "commentary",
        text: "已检查测试文件。",
      },
    });
    emit("item/completed", {
      item: {
        id: "think",
        type: "reasoning",
        summary: ["可公开的依据"],
        content: ["内部字段勿展示"],
      },
    });
    emit("item/started", {
      item: { id: "orphan", type: "dynamicToolCall", tool: "fixture" },
    });
    sealWork(s, r, ["TRACE.txt", "other.txt"], []);
    const ls = pageLines(s, a.id).lines;
    assert.equal(ls.filter((l) => l.id === r.id + ":f").length, 1);
    assert.equal(ls.find((l) => l.id === r.id + ":f")?.work?.state, "done");
    const files = ls.flatMap((l) => l.work?.files || []);
    assert.equal(files.filter((f) => f.path === "TRACE.txt").length, 1);
    assert.deepEqual([files[0].added, files[0].removed], [2, 1]);
    assert.equal(files[0].patch, delta);
    assert.equal(files[1].action, "版本变化");
    assert.equal(files[1].added, undefined);
    const cmd = ls.find((l) => l.work?.kind === "command")!.work!;
    assert.deepEqual(
      [cmd.state, cmd.exitCode, cmd.durationMs, cmd.detail],
      ["failed", 3, 45, "sample error"],
    );
    assert.equal(
      ls.find((l) => l.work?.kind === "image")?.work?.detail,
      "sample.png",
    );
    assert.ok(ls.some((l) => l.phase === "commentary"));
    assert.ok(ls.some((l) => l.text === "可公开的依据"));
    assert.ok(!JSON.stringify(ls).includes("内部字段勿展示"));
    assert.equal(
      ls.find(
        (l) => l.work?.title.includes("fixture") && l.work.kind === "tool",
      )?.work?.state,
      "unknown",
    );
  } finally {
    s.close();
  }
});
test("diff line counts ignore headers, count +/- code literally, and omit unsupported or sensitive evidence", () => {
  assert.deepEqual(
    patchStats(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n---removedLiteral\n+++addedLiteral\n",
      "update",
    ),
    { added: 1, removed: 1 },
  );
  const f = verifiedFiles(
    "D:\\fixture",
    [],
    [],
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-X\n+Y\n",
  );
  assert.equal(f[0].path, "x");
  assert.equal(f[0].added, 1);
  assert.deepEqual(patchStats("Binary files a and b differ", "update"), {});
  const w = nativeStep(
    {
      type: "fileChange",
      changes: [
        { path: ".env", kind: { type: "add" }, diff: "fixture-secret-body" },
      ],
    },
    "D:\\fixture",
    true,
  )!;
  assert.ok(!JSON.stringify(w).includes("fixture-secret-body"));
  assert.equal(w.files![0].added, undefined);
  assert.ok(
    !publicDiff(
      "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-old\n+fixture-secret-body\n",
    ).includes("fixture-secret-body"),
  );
});
test("existing agent projects only retained evidence into older history; viewing never writes or fabricates line counts", async () => {
  const s = await fixture();
  try {
    const t = { ...entity(), projectId: "p", title: "旧工作" } as Task,
      a = assigned(s, t),
      r = {
        ...entity(),
        taskId: t.id,
        workPath: "D:\\fixture",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:03Z",
        response: "旧回复",
        diff: "",
        state: "ended",
      };
    s.put("run", r);
    s.put("evidence", {
      ...entity(),
      id: "older",
      createdAt: "2026-01-01T00:00:01Z",
      kind: "command",
      runId: r.id,
      command: "check sample",
      output: "sample",
      exitCode: 0,
    });
    s.put("file-check", { id: r.id, changed: ["design.txt"], deleted: [] });
    const view = historicalPage(s, a);
    assert.equal(view.lines[0].work?.kind, "command");
    assert.equal(view.lines[1].work?.files?.[0].added, undefined);
    assert.equal(view.lines.at(-1)?.text, "旧回复");
    assert.equal(s.all("agent-line").length, 0);
    assert.equal(historicalPage(s, a, view.lines[1].id).lines.length, 1);
  } finally {
    s.close();
  }
});
test("SSE public summaries are delivered before the final answer, never store raw reasoning or intermediate structured JSON", async () => {
  const sent: string[] = [],
    encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const promise = readResponseStream(new Response(stream), (id, k, v, done) =>
    sent.push([id, k, v, done].join("|")),
  );
  const feed = (obj: unknown) => {
    const packet = encoder.encode("data: " + JSON.stringify(obj) + "\r\n\r\n");
    controller.enqueue(packet.slice(0, 8));
    controller.enqueue(packet.slice(8));
  };
  feed({ type: "response.reasoning_text.delta", delta: "hidden-fixture" });
  feed({
    type: "response.reasoning_summary_text.delta",
    item_id: "r",
    summary_index: 0,
    delta: "公开依据",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sent.some((x) => x.includes("公开依据")));
  feed({
    type: "response.output_item.added",
    item: { type: "message", phase: "commentary", id: "p" },
  });
  feed({
    type: "response.output_text.done",
    item_id: "p",
    text: "第一步已完成",
  });
  feed({
    type: "response.output_text.delta",
    item_id: "final",
    delta: "internal-structured-JSON",
  });
  feed({
    type: "response.completed",
    response: { model: "fixture", output: [] },
  });
  controller.close();
  assert.equal((await promise).model, "fixture");
  assert.ok(sent.some((x) => x.includes("第一步已完成")));
  assert.ok(!sent.join("").includes("hidden-fixture"));
  assert.ok(!sent.join("").includes("structured-JSON"));
  await assert.rejects(
    readResponseStream(new Response("data: [DONE]\n\n"), () => {}),
    /缺少结束回执/,
  );
});
test("one receipt updates in place in chief and discussion, failures stay visible after restart", async () => {
  const s = await fixture(),
    dir = s.dir;
  const m = { ...entity(), role: "user", text: "fixture" };
  s.put("message", m);
  try {
    const tr = workTrace(s, () => {}, {
      message: m.id,
      agent: "a",
      group: "g",
    });
    const publish = tr.reporter();
    publish("k", "summary", "正在核对", false);
    publish("k", "summary", "已定位到文档", true);
    await assert.rejects(
      tr.call("command", "git rev-parse", async () => {
        throw Object.assign(new Error("non-public stderr"), { code: 128 });
      }),
    );
    const rows = s.get("message", m.id).work;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].detail, "已定位到文档");
    assert.equal(rows[1].exitCode, 128);
    assert.equal(rows[1].state, "failed");
    assert.ok(!JSON.stringify(rows).includes("non-public stderr"));
    assert.equal(pageLines(s, "a").lines.length, 2);
  } finally {
    s.close();
  }
  const restored = new Store(dir);
  try {
    assert.equal(restored.get("message", m.id).work.length, 2);
    assert.equal(pageLines(restored, "a").lines.length, 2);
  } finally {
    restored.close();
  }
});
