import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加路径式项目字段查询", async () => {
  assert.deepEqual(run({data:{p:{'a/b':4}},pointer:'/p/a~1b'}),{found:true,value:4});
});
