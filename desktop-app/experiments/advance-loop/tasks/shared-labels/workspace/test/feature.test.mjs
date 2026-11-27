import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("抽出共同的状态文案", async () => {
  assert.deepEqual(run([{place:'list',state:'ready'},{place:'detail',state:'done'}]),['等待','完成']);
});
