import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("避免重复统计覆盖时长", async () => {
  assert.equal(run({periods:[[10,12],[1,6],[3,5],[6,10],[8,8],[40,32]]}),11);
  assert.equal(run({periods:[[-9,-6],[-7,-4],[-2,-1]]}),6);
  assert.equal(run({periods:[]}),0);
});
