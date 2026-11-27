import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按依赖分批安排工作", async () => {
  const items=[{id:'z',dependsOn:['x']},{id:'a'},{id:'loop1',dependsOn:['loop2']},{id:'ready',dependsOn:['a']},{id:'loop2',dependsOn:['loop1']},{id:'unknown',dependsOn:['missing']},{id:'x',dependsOn:['ready']}];
  assert.deepEqual(run({items}),{batches:[['a'],['ready'],['x'],['z']],blocked:['loop1','loop2','unknown']});
  assert.deepEqual(run({items:[]}),{batches:[],blocked:[]});
});
