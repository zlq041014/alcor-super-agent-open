import assert from "node:assert/strict";
import { test } from "node:test";
import { weeklyHeading, monthlyHeading } from "../src/index.mjs";
import {existsSync,readFileSync} from "node:fs";
test("公共模块处理所有格式，两个原入口仍可用", async () => {
  assert.ok(existsSync(new URL("../src/period.mjs",import.meta.url)),"缺少要求的日期模块");
  const {formatPeriod}=await import("../src/period.mjs");
  assert.equal(formatPeriod(" 2025-01-31 ","2025-01-31"),"2025-01-31");
  assert.equal(formatPeriod(" 2025-02-27 ","2025-03-03"),"2025-02-27 至 2025-03-03");
  assert.equal(formatPeriod(null,"2025-03-03"),"未指定期间");
  assert.equal(monthlyHeading("","2025-03-03"),"月报 · 未指定期间");
  const source=readFileSync(new URL("../src/operation.mjs",import.meta.url),"utf8");
  assert.match(source,/from\s*["']\.\/period\.mjs["']/);
  assert.equal([...source.matchAll(/\bformatPeriod\s*\(/g)].length,2);
});
