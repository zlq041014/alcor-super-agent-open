import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用计数徽标规则", async () => {
  assert.equal(run({screen:'calendar',input:100}),'99+'); assert.equal(run({screen:'details',input:0}),'');
});
