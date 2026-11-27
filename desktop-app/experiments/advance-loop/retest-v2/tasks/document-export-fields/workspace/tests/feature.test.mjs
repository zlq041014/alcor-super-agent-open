import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';
const guide = () => readFile(new URL('../README.md',import.meta.url),'utf8');

test("修正导出字段说明", async () => {
  const doc=await guide(); assert.match(doc,/exportedAt/); assert.match(doc,/taskCount/);
});
