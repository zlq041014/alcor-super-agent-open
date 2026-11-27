import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("支持组合时长", async () => {
  assert.equal(run('1h30m'),5400); assert.equal(run('10'),600);
});
