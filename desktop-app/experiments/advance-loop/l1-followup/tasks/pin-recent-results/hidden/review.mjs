import assert from "node:assert/strict";
import { test } from "node:test";
import { orderedResults } from "../src/index.mjs";

test("顺序、去重、同时间和零上限", () => {
  const list=[{id:"a",at:9},{id:"b",at:9},{id:"c",at:1},{id:"d",at:22}];
  const pins=["c","none","c","b"];
  assert.deepEqual(orderedResults(list,pins,8).map(row=>row.id),["c","b","d","a"]);
  assert.deepEqual(orderedResults(list,undefined,3).map(row=>row.id),["d","a","b"]);
  assert.deepEqual(orderedResults(list,pins,2).map(row=>row.id),["c","b"]);
  assert.deepEqual(orderedResults(list,pins,0),[]);
  assert.deepEqual(list.map(row=>row.id),["a","b","c","d"]);
  assert.deepEqual(pins,["c","none","c","b"]);
});
