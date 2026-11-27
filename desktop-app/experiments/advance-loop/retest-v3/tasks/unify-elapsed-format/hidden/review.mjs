import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用用时徽标", async () => {
  assert.equal(run({surface:'history',value:-10}),'0 秒');assert.equal(run({surface:'history',value:120999}),'2 分 0 秒');assert.equal(run({surface:'detail',value:59999}),'59 秒');
  const root=new URL('../src/',import.meta.url);
  const names=(await readdir(root)).filter(n=>n.endsWith('.mjs'));const contents=await Promise.all(names.map(n=>readFile(new URL(n,root),'utf8')));
  assert.equal(contents.filter(x=>x.includes(" 分 ")).length,1,'规则在一个模块中定义');
});
