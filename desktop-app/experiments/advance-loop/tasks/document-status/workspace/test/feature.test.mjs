import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("对齐归档说明和实际结果", async () => {
  const doc=await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.match(doc,/工作动态只显示未归档/);
});
