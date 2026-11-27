import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按修订号恢复工作流状态", async () => {
  const events=[{id:'a',rev:3,seq:1,title:'new'},{id:'a',rev:2,seq:9,title:'old'}];
  assert.deepEqual(run({events}),[{id:'a',title:'new',rev:3}]);
});
