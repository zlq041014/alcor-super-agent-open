import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修正统计中位数", async () => {
  assert.equal(run({values:[10,2,30]}),10);
});
