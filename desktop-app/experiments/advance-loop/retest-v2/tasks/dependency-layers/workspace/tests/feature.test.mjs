import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按依赖分批安排工作", async () => {
  const items=[{id:'c',dependsOn:['a']},{id:'a'},{id:'b'}]; assert.deepEqual(run({items}),{batches:[['a','b'],['c']],blocked:[]});
});
