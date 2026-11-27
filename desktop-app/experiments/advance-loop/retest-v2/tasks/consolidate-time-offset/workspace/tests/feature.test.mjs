import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用时区标签生成", async () => {
  assert.deepEqual(run({screen:'calendar',input:-75}),'UTC-01:15'); assert.equal(run({screen:'details',input:0}),'UTC+00:00');
});
