import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("增加标签颜色回退", async () => {
  assert.equal(run({colors:{Info:'#55f',default:'#000'},label:'info'}),'#55f');
});
