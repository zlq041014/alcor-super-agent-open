import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用显示标题清理", async () => {
  assert.equal(run({surface:'history',value:'\t A\n B\u00a0C  '}),'A B C');assert.equal(run({surface:'detail',value:null}),'未命名');
  const root=new URL('../src/',import.meta.url);
  const names=(await readdir(root)).filter(n=>n.endsWith('.mjs'));const contents=await Promise.all(names.map(n=>readFile(new URL(n,root),'utf8')));
  assert.equal(contents.filter(x=>x.includes("未命名")).length,1,'规则在一个模块中定义');
});
