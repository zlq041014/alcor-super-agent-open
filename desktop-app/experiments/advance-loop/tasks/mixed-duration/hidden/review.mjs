import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("支持组合时长", async () => {
  assert.equal(run(' 2 M 15s '),135);
  for (const bogus of ['2h junk','m5','5h3','1.5h','']) assert.equal(run(bogus),null);
});
