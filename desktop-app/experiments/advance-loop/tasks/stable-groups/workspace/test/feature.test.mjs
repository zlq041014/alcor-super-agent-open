import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复标签分组顺序", async () => {
  assert.deepEqual(run([{tag:'9',title:'a'},{tag:'2',title:'b'}]),[['9',['a']],['2',['b']]]);
});
