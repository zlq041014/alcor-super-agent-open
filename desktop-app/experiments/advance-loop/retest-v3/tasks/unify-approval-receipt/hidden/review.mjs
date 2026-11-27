import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用审批徽标转换", async () => {
  assert.equal(run({surface:'history',value:'waiting'}),'等待确认');assert.equal(run({surface:'detail',value:''}),'未知状态');assert.equal(run({surface:'history',value:'constructor'}),'未知状态');
  const root=new URL('../src/',import.meta.url);
  const names=(await readdir(root)).filter(n=>n.endsWith('.mjs'));const contents=await Promise.all(names.map(n=>readFile(new URL(n,root),'utf8')));
  assert.equal(contents.filter(x=>x.includes("等待确认")).length,1,'规则在一个模块中定义');
});
