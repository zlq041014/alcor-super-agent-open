import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加游标分页", async () => {
  const items = [0,'x','z'].map(id => ({id}));
  assert.deepEqual(run({items,after:0,limit:1}),{items:[items[1]],next:'x'});
  assert.deepEqual(run({items,after:'x',limit:1}),{items:[items[2]],next:null});
  assert.deepEqual(run({items,after:'missing',limit:1}),{items:[],next:null});
});
