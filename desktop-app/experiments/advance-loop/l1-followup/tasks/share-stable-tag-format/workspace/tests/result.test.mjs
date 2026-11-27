import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { filterTags, exportTags } from "../src/index.mjs";

test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
test("仍按原顺序去重，导出是字符串", () => {
  const rows=[" R ","q","r",false,"  ", "Q","last"];
  assert.deepEqual(filterTags(rows),["r","q","last"]);
  assert.equal(exportTags(rows),"r,q,last");
});
