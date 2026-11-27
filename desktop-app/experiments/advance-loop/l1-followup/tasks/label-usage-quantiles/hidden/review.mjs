import assert from "node:assert/strict";
import { test } from "node:test";
import { usageProfile } from "../src/index.mjs";

test("使用最近秩、边界值、无效样本，且不改原数组", () => {
  const numbers=Array.from({length:20},(_,i)=>19-i);
  const input=[...numbers,-1,NaN,Infinity,"12",null];
  assert.deepEqual(usageProfile(input),{count:25,known:20,mean:9.5,p50:9,p95:18});
  assert.deepEqual(input.slice(0,20),numbers);
  assert.deepEqual(usageProfile([NaN,null,-1]),{count:3,known:0,mean:null,p50:null,p95:null});
  assert.deepEqual(usageProfile([0]),{count:1,known:1,mean:0,p50:0,p95:0});
});
