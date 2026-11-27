import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("插值显示进度历史", async () => {
  const samples=[{at:-5,value:100},{at:10,value:0},{at:0,value:99},{at:0,value:20}];
  assert.equal(run({samples,at:0}),20);assert.equal(run({samples,at:4}),12);assert.equal(run({samples,at:-50}),100);assert.equal(run({samples,at:110}),0);assert.equal(run({samples:[],at:0}),null);
});
