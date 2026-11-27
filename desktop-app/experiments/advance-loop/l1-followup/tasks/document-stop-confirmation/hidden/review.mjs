import assert from "node:assert/strict";
import { test } from "node:test";
import { stopSummary } from "../src/index.mjs";
import {readFileSync} from "node:fs";
test("文档区分原生结束与连接丢失",()=>{
  const doc=readFileSync(new URL("../README.md",import.meta.url),"utf8").split("## 示例")[0];
  for (const state of ["requested","stopped","finished","unknown","active"])
    assert.ok(doc.includes(state),state);
  for (const state of ["interrupted","completed","failed","lost","hold","true","false"])
    assert.ok(doc.includes(state),state);
  assert.deepEqual(stopSummary(true,"lost"),{state:"unknown",hold:true});
  assert.deepEqual(stopSummary(true,"failed"),{state:"finished",hold:false});
  assert.deepEqual(stopSummary(false,undefined),{state:"active",hold:true});
});
