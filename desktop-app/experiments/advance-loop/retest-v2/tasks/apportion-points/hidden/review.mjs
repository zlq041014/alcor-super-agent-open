import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("让整数配额精确分配", async () => {
  assert.deepEqual(run({total:8,weights:[0,5,2]}),[0,6,2]);
  assert.deepEqual(run({total:9,weights:[0,0]}),[0,0]);
  assert.deepEqual(run({total:7,weights:[2,1,2]}),[3,1,3]);
});
