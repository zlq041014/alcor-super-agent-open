import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("纠正文档里的页大小", async () => {
  const doc = await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.ok(doc.includes('默认显示 10 条'));
});
