import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用审批徽标转换", async () => {
  assert.equal(run({surface:'list',value:'approved'}),'已批准');assert.equal(run({surface:'detail',value:'denied'}),'已拒绝');
});
