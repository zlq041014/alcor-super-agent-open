import assert from "node:assert/strict";
import { test } from "node:test";
import { currentShifts } from "../src/index.mjs";

test("不同站点、乱序取消和同版本最后到达", () => {
  const a={site:"East",id:"a",revision:1}, b={site:"West",id:"a",revision:1};
  const cancelled={...b,revision:4,cancelled:true}, old={...b,revision:3};
  const reinstated={...cancelled,cancelled:false,room:"B3"};
  const last={...a,revision:2,room:"A1"};
  assert.deepEqual(currentShifts([a,b,cancelled,old,last]),[last]);
  assert.deepEqual(currentShifts([a,b,cancelled,old,reinstated,last]),[last,reinstated]);
  assert.deepEqual(currentShifts([{...a,site:"a:b",id:"c"},{...b,site:"a",id:"b:c"}]).length,2);
});
