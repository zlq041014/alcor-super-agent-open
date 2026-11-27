import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("集中时段边界判断", async () => {
  const seen=await Promise.all(['input','output'].map(n=>readFile(new URL('../src/'+n+'.mjs',import.meta.url),'utf8')));
  assert.ok(seen.every(x=>!x.includes('>=')&&!x.includes('<')));
  assert.deepEqual(run([{action:'register',start:2,end:5,minute:3},{action:'view',start:8,end:8,minute:8}]),[true,false]);
});
