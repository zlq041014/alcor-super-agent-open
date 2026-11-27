import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("纠正文档里的页大小", async () => {
  const doc = await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.match(doc,/\[1,2,3,4,5,6,7,8,9,10\]/);
  assert.doesNotMatch(doc,/20 条|第 20 项/);
  assert.deepEqual(run(Array.from({length:25},(_,i)=>i+1)), Array.from({length:10},(_,i)=>i+1));
});
