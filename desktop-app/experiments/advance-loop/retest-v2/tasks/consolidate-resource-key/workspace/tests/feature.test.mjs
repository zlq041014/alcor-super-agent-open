import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用资源编号转换", async () => {
  assert.equal(run({screen:'calendar',input:'  Room  B  '}),'room_b'); assert.equal(run({screen:'details',input:' VIP '}),'vip');
});
