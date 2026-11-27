import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复 UTC 日期区间", async () => {
  assert.equal(run({ start:'2024-02-28', end:'2024-03-02' }), 4);
  assert.equal(run({ start:'2024-03-02', end:'2024-02-28' }), 0);
  assert.equal(run({ start:'2025-12-31', end:'2026-01-01' }), 2);
});
