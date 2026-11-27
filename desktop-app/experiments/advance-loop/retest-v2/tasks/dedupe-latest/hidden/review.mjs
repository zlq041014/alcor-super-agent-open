import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("去重后保留最新内容", async () => {
  const entries=[{id:0,at:6},{id:'',at:3},{id:0,at:4},{id:'',at:3,title:'new'},{id:'constructor',at:0}]; assert.deepEqual(run({entries}),[entries[0],entries[3],entries[4]]);
});
