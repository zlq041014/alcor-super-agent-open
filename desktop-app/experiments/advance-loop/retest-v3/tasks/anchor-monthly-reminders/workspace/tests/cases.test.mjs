import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加以原日期为锚的月提醒", async () => {
  assert.deepEqual(run({start:'2024-01-31',limit:3}),['2024-01-31','2024-02-29','2024-03-31']);
});
