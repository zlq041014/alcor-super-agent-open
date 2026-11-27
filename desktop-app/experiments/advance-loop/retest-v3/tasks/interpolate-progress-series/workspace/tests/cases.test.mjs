import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("插值显示进度历史", async () => {
  assert.equal(run({samples:[{at:10,value:8},{at:0,value:2}],at:5}),5);
});
