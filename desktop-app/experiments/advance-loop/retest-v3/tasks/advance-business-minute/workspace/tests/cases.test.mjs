import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加工作时间内延后", async () => {
  assert.equal(run({start:'2026-11-19T11:50:00Z',minutes:20}),'2026-11-19T13:10:00.000Z');
});
