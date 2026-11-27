import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复标签分组顺序", async () => {
  assert.deepEqual(run([{tag:'constructor',title:'a'},{tag:7,title:'b'},{tag:'7',title:'c'},{tag:'__proto__',title:'d'}]),[['constructor',['a']],['7',['b','c']],['__proto__',['d']]]);
});
