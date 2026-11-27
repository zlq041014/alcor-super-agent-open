import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复 UTC 日期区间", async () => {
  assert.equal(run({ start: '2026-03-01', end: '2026-03-01' }), 1);
});
