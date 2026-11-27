import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';

test("共用时区标签生成", async () => {
  assert.equal(run({screen:'details',input:330}),'UTC+05:30');
  assert.equal(run({screen:'calendar',input:-5}),'UTC-00:05');
  const dir=new URL('../src/',import.meta.url); const entries=(await readdir(dir)).filter(p=>/\.[cm]?js$/.test(p));
  const files=await Promise.all(entries.map(p=>readFile(new URL(p,dir),'utf8')));
  assert.equal(files.filter(body=>body.includes("Math.abs")).length,1,'规则只能保留一个定义');
});
