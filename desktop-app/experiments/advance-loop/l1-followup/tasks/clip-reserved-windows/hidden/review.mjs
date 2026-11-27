import assert from "node:assert/strict";
import { test } from "node:test";
import { reserve } from "../src/index.mjs";

test("裁剪、相接、嵌套、无效项和原输入", () => {
  const items = [[40,70],[-8,4],[5,20],[3,5],[9,15],[25,27],[28,27],[18,18]];
  const baseline = structuredClone(items);
  assert.deepEqual(reserve(items,[0,50]), {windows:[[0,20],[25,27],[40,50]],minutes:32});
  assert.deepEqual(items,baseline);
  assert.deepEqual(reserve([[60,62],[3,5]],[10,30]),{windows:[],minutes:0});
});
