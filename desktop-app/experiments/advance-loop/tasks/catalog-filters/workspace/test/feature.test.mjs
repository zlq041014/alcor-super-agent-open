import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("加入组合筛选", async () => {
  const items = [{title:'Alcor',score:4},{title:'Alcor Beta',score:2}];
  assert.deepEqual(run({items,query:'alcor',min:3}),[items[0]]);
});
