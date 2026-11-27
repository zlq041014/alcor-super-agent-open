import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复折扣分币和退款", async () => {
  assert.equal(run(['1.005', '1.10']), 211);
});
