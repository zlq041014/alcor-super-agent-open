import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加路径式项目字段查询", async () => {
  const data={'':null,'~1':7,items:['first','second'], nested:{'~':'tilde'}};
  assert.deepEqual(run({data,pointer:'/'}),{found:true,value:null});assert.deepEqual(run({data,pointer:'/~01'}),{found:true,value:7});assert.deepEqual(run({data,pointer:'/items/01'}),{found:false});assert.deepEqual(run({data,pointer:'/nested/~0'}),{found:true,value:'tilde'});assert.deepEqual(run({data,pointer:'/~2'}),{found:false});assert.deepEqual(run({data,pointer:''}),{found:true,value:data});
});
