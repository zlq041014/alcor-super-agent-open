import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';
const doc=()=>readFile(new URL('../README.md',import.meta.url),'utf8');
const fence=s=>s.match(/```json\s*([\s\S]*?)```/)?.[1];

test("对齐工作日志导出文档", async () => {
  assert.match(await doc(),/\brecords\b/);
});
