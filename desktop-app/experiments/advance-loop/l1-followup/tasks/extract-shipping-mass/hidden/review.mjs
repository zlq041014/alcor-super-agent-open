import assert from "node:assert/strict";
import { test } from "node:test";
import { itemLabel, manifestRow } from "../src/index.mjs";
import {existsSync,readFileSync} from "node:fs";
test("换算是共用可调用模块，原行为不变", async () => {
  assert.ok(existsSync(new URL("../src/mass.mjs",import.meta.url)),"缺少要求的重量模块");
  const {toGrams}=await import("../src/mass.mjs");
  assert.equal(toGrams(0.0016,"kg"),2);
  assert.equal(toGrams(17.5,"g"),18);
  for (const [value,unit] of [[-1,"g"],[1,"lb"],[Infinity,"kg"],["3","g"]])
    assert.equal(toGrams(value,unit),null);
  const source=readFileSync(new URL("../src/operation.mjs",import.meta.url),"utf8");
  assert.match(source,/from\s*["']\.\/mass\.mjs["']/);
  assert.equal([...source.matchAll(/\btoGrams\s*\(/g)].length,2);
  assert.deepEqual(manifestRow(0,"kg"),{grams:0,weighed:true});
  assert.equal(itemLabel(0.0006,"kg"),"重量 1 g");
});
