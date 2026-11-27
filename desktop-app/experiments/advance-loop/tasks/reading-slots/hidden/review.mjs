import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复预约时间重叠", async () => {
  assert.equal(run({first:[3,5],second:[1,7]}),true);
  assert.equal(run({first:[3,3],second:[1,7]}),false);
  assert.equal(run({first:[5,3],second:[1,7]}),false);
  assert.equal(run({first:[1,3],second:[-5,-1]}),false);
});
