import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复预约时间重叠", async () => {
  assert.equal(run({first:[1, 4],second:[4, 10]}),false);
});
