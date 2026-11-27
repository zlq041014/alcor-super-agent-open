import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';
const guide = () => readFile(new URL('../README.md',import.meta.url),'utf8');

test("修正工作列表排序说明", async () => {
  const doc=await guide(); assert.match(doc,/由近到远|从新到旧|降序/);
});
