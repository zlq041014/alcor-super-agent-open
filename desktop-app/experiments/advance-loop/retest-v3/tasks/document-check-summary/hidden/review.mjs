import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile, readdir } from 'node:fs/promises';
const doc=()=>readFile(new URL('../README.md',import.meta.url),'utf8');
const fence=s=>s.match(/```json\s*([\s\S]*?)```/)?.[1];

test("对齐检查统计接口文档", async () => {
  const text=await doc();assert.match(text,/total/);assert.match(text,/不计|未计|排除|不包括|不纳入|不含/); assert.deepEqual(JSON.parse(fence(text)),run({statuses:['passed','failed','skipped','passed']}));
});
