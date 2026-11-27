import assert from "node:assert/strict";
import { test } from "node:test";
import { pageWindow } from "../src/index.mjs";

test("越界、缺省、逆序、数字字符串和无页", () => {
  assert.deepEqual(pageWindow(12,"010","2"),{first:2,last:10,count:9});
  assert.deepEqual(pageWindow(7,-6,200),{first:1,last:7,count:7});
  assert.deepEqual(pageWindow(8,"3x",5.5),{first:1,last:8,count:8});
  assert.deepEqual(pageWindow(2,undefined,"1"),{first:1,last:1,count:1});
  assert.deepEqual(pageWindow(0,2,20),{first:0,last:0,count:0});
});
