import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("共用显示标题清理", async () => {
  assert.equal(run({surface:'list',value:' 甲   乙 '}),'甲 乙');assert.equal(run({surface:'detail',value:''}),'未命名');
});
