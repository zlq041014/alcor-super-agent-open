import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("抽出共同的状态文案", async () => {
  const text = await Promise.all(['input','output'].map(n => readFile(new URL('../src/'+n+'.mjs',import.meta.url),'utf8')));
  const common = text.map(s=>[...s.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map(m=>m[1]));
  assert.ok(common[0].some(x=>common[1].includes(x)));
  assert.deepEqual(run([{place:'list',state:'other'},{place:'detail',state:'ready'}]),['Unknown','等待']);
});
