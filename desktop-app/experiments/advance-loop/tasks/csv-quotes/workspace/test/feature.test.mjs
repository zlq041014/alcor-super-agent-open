import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复带引号的 CSV 字段", async () => {
  assert.deepEqual(run('one,"two,three",four'), ['one','two,three','four']);
});
