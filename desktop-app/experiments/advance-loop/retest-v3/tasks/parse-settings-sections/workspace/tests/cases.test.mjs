import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复带引号的配置值", async () => {
  assert.deepEqual(run({source:'[view]\ntext="  a#b  " # comment'}),{'':{},view:{text:'  a#b  '}});
});
