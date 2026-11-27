import test from "node:test";
import assert from "node:assert/strict";
import { unfinished } from "../src/hub/evidence";
import { cite, clusters, preference } from "../src/hub/triage";
import type { Finding } from "../src/shared/loop-contracts";
import type { EvidenceBundle } from "../src/hub/evidence";

test("半成品扫描报告行号，不把普通实现或字符串中的 TODO 当成待办", () => {
  const source = [
    "const category = 'TODOs';",
    "// TODO complete label output",
    "function label() {}",
    "const format = () => { return 4; };",
    "const text = 'placeholder text';",
  ].join("\n");
  assert.deepEqual(
    unfinished("label.mjs", source).map(({ line, kind }) => [line, kind]),
    [
      [2, "todo"],
      [3, "empty"],
      [5, "placeholder"],
    ],
  );
});

test("分诊引用必须来自同一个实际材料，聚类按证据位置，反向排序不一致视为平局", () => {
  const one = "function first() {} // known";
  const two = "function second() {} // known";
  const tail = "function farAway() {} // long";
  const bundle: EvidenceBundle = {
    workspace: { version: "v", truncated: false },
    original: "修改测试文件内的函数",
    concerns: [],
    rules: [],
    signals: [],
    materials: [
      {
        id: "file:file.mjs",
        kind: "file",
        title: "file.mjs",
        sourceVersion: "v",
        content: [one, two, "\n\n\n\n\n\n", tail].join("\r\n"),
      },
      {
        id: "check:look",
        kind: "check-output",
        title: "实际测试",
        sourceVersion: "v",
        content: "lookup completed successfully",
      },
    ],
    limited: false,
    checkOutputRefs: [],
    diffRunIds: [],
  };
  const pick = (id: string, quote: string): Finding => ({
    id,
    loopId: "l",
    round: 1,
    lens: "完整性",
    title: id,
    claim: id,
    impact: id,
    severity: "major",
    createdAt: "",
    updatedAt: "",
    workspaceVersion: "v",
    status: "proposed",
    evidence: [{ kind: "file", path: "file.mjs", quote }],
  });
  const a = pick("a", one),
    b = pick("b", two),
    c = pick("c", tail);
  assert.ok(cite(a.evidence[0], bundle, []));
  assert.equal(
    cite({ kind: "file", path: "unknown.mjs", quote: one }, bundle, []),
    false,
  );
  assert.equal(
    cite(
      { kind: "file", path: "file.mjs", quote: "invented text does not occur" },
      bundle,
      [],
    ),
    false,
  );
  assert.equal(
    cite(
      {
        kind: "check-run",
        id: "missing",
        excerpt: "lookup completed successfully",
      },
      bundle,
      [],
    ),
    false,
  );
  assert.ok(
    cite(
      {
        kind: "check-run",
        id: "look",
        excerpt: "lookup completed successfully",
      },
      bundle,
      [],
    ),
  );
  assert.deepEqual(
    clusters([a, b, c], bundle).map((g) => g.map((x) => x.id)),
    [["a", "b"]],
  );
  assert.equal(preference("A", "B"), 1);
  assert.equal(preference("B", "A"), -1);
  assert.equal(preference("A", "A"), 0);
  assert.equal(preference("equal", "B"), 0);
});
