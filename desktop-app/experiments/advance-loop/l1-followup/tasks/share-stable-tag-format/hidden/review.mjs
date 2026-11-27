import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTags, exportTags } from "../src/index.mjs";
import {existsSync,readFileSync} from "node:fs";
test("通过同一函数处理控制字符、数字和空输入", async () => {
  assert.ok(existsSync(new URL("../src/tags.mjs",import.meta.url)),"缺少要求的标签模块");
  const {normalizeTags}=await import("../src/tags.mjs");
  const rows=["\nONE\t",1,"two","One","零","  "," TWO "];
  assert.deepEqual(normalizeTags(rows),["one","two","零"]);
  assert.deepEqual(filterTags(rows),["one","two","零"]);
  assert.equal(exportTags(rows),"one,two,零");
  assert.equal(exportTags([]),"");
  const source=readFileSync(new URL("../src/operation.mjs",import.meta.url),"utf8");
  assert.match(source,/from\s*["']\.\/tags\.mjs["']/);
  assert.equal([...source.matchAll(/\bnormalizeTags\s*\(/g)].length,2);
});
