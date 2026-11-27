import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("复用工作编号生成器", async () => {
  assert.deepEqual(run([{style:'short',n:7},{style:'long',n:26}]),['A-007','WORK-00026']);
});
