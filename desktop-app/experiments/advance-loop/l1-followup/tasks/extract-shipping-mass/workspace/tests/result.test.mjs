import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { itemLabel, manifestRow } from "../src/index.mjs";

test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
test("两个存量入口", () => {
  assert.equal(itemLabel(0,"g"), "重量 0 g");
  assert.equal(itemLabel(-2,"g"), "重量未知");
  assert.deepEqual(manifestRow(1.2381,"kg"), {grams:1238,weighed:true});
  assert.deepEqual(manifestRow(5,"lb"), {grams:null,weighed:false});
});
