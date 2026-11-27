import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加二进制文件大小单位", async () => {
  assert.equal(run({bytes:1536,decimals:1}),'1.5 KiB');
});
