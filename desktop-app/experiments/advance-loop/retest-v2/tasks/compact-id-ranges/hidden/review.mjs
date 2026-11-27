import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("压缩乱序编号", async () => {
  assert.equal(run({ids:[1,-3,0,-2,12,9,0]}),'-3..-2,0..1,9,12');
  assert.equal(run({ids:[]}),'');
  assert.equal(run({ids:[7,7]}),'7');
});
