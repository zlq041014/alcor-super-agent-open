import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("对齐归档说明和实际结果", async () => {
  const doc=await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.match(doc,/历史保留已归档/);
  assert.match(doc,/动态：\[草稿\]/);
  assert.match(doc,/历史：\[草稿, 完结\]/);
  assert.deepEqual(run([{title:'草稿',archived:false},{title:'完结',archived:true}]),{feed:['草稿'],history:['草稿','完结']});
});
