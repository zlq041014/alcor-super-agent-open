import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加以原日期为锚的月提醒", async () => {
  assert.deepEqual(run({start:'2023-12-31',after:'2024-02-29',limit:3}),['2024-03-31','2024-04-30','2024-05-31']);
  assert.deepEqual(run({start:'2025-01-31',after:'2025-02-27',limit:2}),['2025-02-28','2025-03-31']);
  assert.deepEqual(run({start:'2024-01-01',limit:0}),[]);
});
