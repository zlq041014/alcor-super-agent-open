import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { weeklyHeading, monthlyHeading } from "../src/index.mjs";

test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
test("跨日期与缺失日期", () => {
  assert.equal(monthlyHeading("2025-02-01","2025-02-28"),"月报 · 2025-02-01 至 2025-02-28");
  assert.equal(weeklyHeading("2025-02-01"),"周报 · 未指定期间");
});
