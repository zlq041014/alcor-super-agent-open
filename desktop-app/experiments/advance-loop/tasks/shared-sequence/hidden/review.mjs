import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("复用工作编号生成器", async () => {
  const text=await Promise.all(['input','output'].map(n=>readFile(new URL('../src/'+n+'.mjs',import.meta.url),'utf8')));
  assert.ok(text.every(x=>!x.includes('padStart')));
  assert.deepEqual(run([{style:'short',n:2024},{style:'long',n:0}]),['A-2024','WORK-00000']);
});
