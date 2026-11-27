import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("给缓存增加到期统计", async () => {
  const entries=[{id:'old',expiresAt:10},{id:'ok',expiresAt:11}]; assert.deepEqual(run({entries,now:10}),{items:[entries[1]],expired:1});
});
