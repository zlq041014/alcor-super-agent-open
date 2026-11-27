import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("去重后保留最新内容", async () => {
  const entries=[{id:'a',at:1},{id:'b',at:2},{id:'a',at:3}]; assert.deepEqual(run({entries}),[entries[2],entries[1]]);
});
