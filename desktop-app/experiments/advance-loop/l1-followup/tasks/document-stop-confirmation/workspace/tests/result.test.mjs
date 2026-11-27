import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { stopSummary } from "../src/index.mjs";
import {readFileSync} from "node:fs";
test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
test("README 的例子使用真实回执",()=>{
  const doc=readFileSync(new URL("../README.md",import.meta.url),"utf8");
  const example=JSON.parse(doc.split("```json")[1].split("```")[0]);
  assert.deepEqual(example,{withoutReceipt:stopSummary(true,undefined),interrupted:stopSummary(true,"interrupted")});
});
