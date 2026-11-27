import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';

test("集中时段边界判断", async () => {
  assert.deepEqual(run([{action:'view',start:5,end:10,minute:5},{action:'register',start:5,end:10,minute:10}]),[true,false]);
});
