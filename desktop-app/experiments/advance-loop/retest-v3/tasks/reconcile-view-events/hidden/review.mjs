import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按修订号恢复工作流状态", async () => {
  const events=[{id:'x',rev:0,seq:2,title:'early'},{id:'a',rev:2,seq:7,title:'live'},{id:'x',rev:0,seq:1,kind:'delete'},{id:'x',rev:0,seq:2,title:'tie'},{id:'a',rev:2,seq:8,kind:'delete'},{id:'b',rev:0,seq:0,title:'b'}];
  assert.deepEqual(run({events}),[{id:'x',title:'tie',rev:0},{id:'b',title:'b',rev:0}]);
  const staleDelete = [{id:'a',rev:2,seq:0,title:'restored'},{id:'a',rev:1,seq:99,kind:'delete'}];
  assert.deepEqual(run({events:staleDelete}),[{id:'a',title:'restored',rev:2}]);
});
