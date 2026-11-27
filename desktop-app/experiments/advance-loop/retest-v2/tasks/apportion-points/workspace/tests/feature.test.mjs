import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("让整数配额精确分配", async () => {
  assert.deepEqual(run({total:5,weights:[1,1,1]}),[2,2,1]);
});
