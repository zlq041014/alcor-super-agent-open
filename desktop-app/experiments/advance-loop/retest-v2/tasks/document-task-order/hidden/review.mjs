import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';
const guide = () => readFile(new URL('../README.md',import.meta.url),'utf8');

test("修正工作列表排序说明", async () => {
  const doc=await guide(); assert.match(doc,/相同|同一|一致/); assert.match(doc,/录入|输入|添加/); assert.match(doc,/\[\s*乙\s*[,，]\s*甲\s*[,，]\s*丙\s*\]/); assert.deepEqual(run({items:[{name:'甲',activity:10},{name:'乙',activity:20},{name:'丙',activity:10}]}),['乙','甲','丙']);
});
