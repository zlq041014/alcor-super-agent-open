import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用资源编号转换", async () => {
  assert.equal(run({screen:'details',input:'东区\tA B  '}),'东区_a_b');
  assert.equal(run({screen:'calendar',input:'  '}),'');
  const dir=new URL('../src/',import.meta.url); const entries=(await readdir(dir)).filter(p=>/\.[cm]?js$/.test(p));
  const files=await Promise.all(entries.map(p=>readFile(new URL(p,dir),'utf8')));
  assert.equal(files.filter(body=>body.includes("toLowerCase")).length,1,'规则只能保留一个定义');
});
