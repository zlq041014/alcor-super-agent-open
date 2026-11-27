import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加标签颜色回退", async () => {
  assert.equal(run({colors:{Info:'',default:'#000'},label:'INFO'}),'');
  assert.equal(run({colors:{default:'#9ab'},label:'new'}),'#9ab');
  assert.equal(run({colors:{},label:'constructor'}),'');
});
