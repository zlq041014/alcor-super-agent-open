import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按依赖挑选本批可运行工作", async () => {
  const tasks=[{id:'a',project:'p',priority:0},{id:'b',project:'p',priority:2},{id:'c',project:'q'}];
  assert.deepEqual(run({tasks,limit:3}),{selected:['b','c'],waiting:['a']});
});
