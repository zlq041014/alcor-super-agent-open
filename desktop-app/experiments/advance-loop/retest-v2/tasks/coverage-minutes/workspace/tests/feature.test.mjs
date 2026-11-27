import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("避免重复统计覆盖时长", async () => {
  assert.equal(run({periods:[[5,12],[1,7]]}),11);
});
