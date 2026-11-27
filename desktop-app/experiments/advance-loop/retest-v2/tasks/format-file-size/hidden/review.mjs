import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加二进制文件大小单位", async () => {
  assert.equal(run({bytes:0,decimals:2}),'0 B');
  assert.equal(run({bytes:1024*1024,decimals:2}),'1.00 MiB');
  assert.equal(run({bytes:3*1024**3+512*1024**2,decimals:2}),'3.50 GiB');
  assert.equal(run({bytes:1023}),'1023 B');
});
