import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用用时徽标", async () => {
  assert.equal(run({surface:'list',value:60000}),'1 分 0 秒');assert.equal(run({surface:'detail',value:2300}),'2 秒');
});
