import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复折扣分币和退款", async () => {
  assert.equal(run(['-1.005', '15.495', '-0.005']), 1448);
  assert.equal(run(['+2', '.125', '0.0049']), 213);
});
