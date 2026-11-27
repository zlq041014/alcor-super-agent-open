import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("支持跨行引文前缀", async () => {
  assert.equal(run({text:'a\r\n\r\nb\r\n',prefix:'$ ' }),'$ a\r\n$ \r\n$ b\r\n');
  assert.equal(run({text:'',prefix:'> '}),'');
});
