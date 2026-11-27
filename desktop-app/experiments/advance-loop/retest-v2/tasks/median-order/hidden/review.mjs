import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修正统计中位数", async () => {
  assert.equal(run({values:[10,-2,3,2]}),2.5);
  assert.equal(run({values:[-5,-1]}),-3);
  assert.equal(run({values:[]}),null);
  const source=[7,2,3]; run({values:source}); assert.deepEqual(source,[7,2,3]);
});
