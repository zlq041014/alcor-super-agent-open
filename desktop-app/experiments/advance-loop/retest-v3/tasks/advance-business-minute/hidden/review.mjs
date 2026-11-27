import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加工作时间内延后", async () => {
  assert.equal(run({start:'2026-11-20T17:50:00Z',minutes:20,holidays:['2026-11-23']}),'2026-11-24T09:10:00.000Z');
  assert.equal(run({start:'2026-11-19T09:00:00Z',minutes:180}),'2026-11-19T12:00:00.000Z');
  assert.equal(run({start:'2026-11-21T04:00:00Z',minutes:0}),'2026-11-23T09:00:00.000Z');
});
