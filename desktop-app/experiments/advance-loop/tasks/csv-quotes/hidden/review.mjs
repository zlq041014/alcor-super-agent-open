import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复带引号的 CSV 字段", async () => {
  assert.deepEqual(run(',"a""b,c",,"",'), ['', 'a"b,c', '', '', '']);
  assert.deepEqual(run('  x ,y'), ['  x ', 'y']);
});
