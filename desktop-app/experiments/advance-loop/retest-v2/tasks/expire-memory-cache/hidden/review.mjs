import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("给缓存增加到期统计", async () => {
  const entries=[{id:'z',expiresAt:0},{id:'keep'},{id:'x',expiresAt:-5},{id:'future',expiresAt:4},{id:'forever',expiresAt:null}];
  assert.deepEqual(run({entries,now:0}),{items:[entries[1],entries[3],entries[4]],expired:2});
});
