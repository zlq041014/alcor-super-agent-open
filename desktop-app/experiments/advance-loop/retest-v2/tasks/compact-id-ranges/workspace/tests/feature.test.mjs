import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("压缩乱序编号", async () => {
  assert.equal(run({ids:[5,2,3,3,9]}),'2..3,5,9');
});
