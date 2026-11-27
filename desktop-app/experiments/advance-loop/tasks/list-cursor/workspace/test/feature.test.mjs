import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加游标分页", async () => {
  const items = ['a','c','b'].map(id => ({id}));
  assert.deepEqual(run({items, limit:2}),{items:items.slice(0,2),next:'c'});
});
