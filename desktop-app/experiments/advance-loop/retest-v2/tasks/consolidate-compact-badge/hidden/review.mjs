import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用计数徽标规则", async () => {
  assert.equal(run({screen:'calendar',input:99}),'99');
  assert.equal(run({screen:'details',input:-3}),'');
  const dir=new URL('../src/',import.meta.url); const entries=(await readdir(dir)).filter(p=>/\.[cm]?js$/.test(p));
  const files=await Promise.all(entries.map(p=>readFile(new URL(p,dir),'utf8')));
  assert.equal(files.filter(body=>body.includes("99+")).length,1,'规则只能保留一个定义');
});
