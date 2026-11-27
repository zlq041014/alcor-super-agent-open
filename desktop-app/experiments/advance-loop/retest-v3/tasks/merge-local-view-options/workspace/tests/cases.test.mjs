import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复界面选项递归覆盖", async () => {
  assert.deepEqual(run({defaults:{panel:{width:300,enabled:true}},override:{panel:{enabled:false}}}),{panel:{width:300,enabled:false}});
});
