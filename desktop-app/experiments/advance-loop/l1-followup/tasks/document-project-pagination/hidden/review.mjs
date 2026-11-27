import assert from "node:assert/strict";
import { test } from "node:test";
import { pageProjects } from "../src/index.mjs";
import {readFileSync} from "node:fs";
test("明确默认、无效和末页语义，示例可直接核对",()=>{
  const doc=readFileSync(new URL("../README.md",import.meta.url),"utf8");
  assert.match(doc,/默认[^。\n]{0,24}3/);
  assert.match(doc,/无效|非正整数/);
  assert.match(doc,/最多\s*50|上限\s*50/);
  assert.match(doc,/之后|下一项/);
  assert.match(doc,/找不到|不存在|未知/);
  assert.match(doc,/没有更多|无剩余|最后一页|末页/);
  assert.match(doc,/null/);
  assert.deepEqual(pageProjects(["a","b","c","d"],0,"unknown"),{items:["a","b","c"],cursor:"c"});
  assert.deepEqual(pageProjects(["a"],3,"a"),{items:[],cursor:null});
});
