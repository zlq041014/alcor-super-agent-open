import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("加入组合筛选", async () => {
  const items = [{title:'THE SHOW',score:0},{title:'Show',score:-2},{title:'showcase',score:7},{title:'Other',score:0}];
  assert.deepEqual(run({items,query:' Show ',min:0,max:0}),[items[0]]);
  assert.deepEqual(run({items}),items);
});
