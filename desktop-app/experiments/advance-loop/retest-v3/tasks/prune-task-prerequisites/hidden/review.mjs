import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按依赖挑选本批可运行工作", async () => {
  const tasks=[{id:'waiting',project:'k',priority:9,dependencies:['a']},{id:'r',project:'busy',priority:10},{id:'x',project:'x',dependencies:[0]},{id:'a',project:'p',priority:1},{id:'y',project:'y'},{id:'neg',project:'n',priority:-1}];
  assert.deepEqual(run({tasks,done:[0],busy:['busy'],limit:3}),{selected:['a','x','y'],waiting:['waiting','r','neg']});
  assert.deepEqual(run({tasks,limit:0}),{selected:[],waiting:tasks.map(t=>t.id)});
});
