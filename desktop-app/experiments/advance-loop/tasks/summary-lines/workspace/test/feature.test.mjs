import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("支持跨行引文前缀", async () => {
  assert.equal(run({text:'a\nb', prefix:'> '}),'> a\n> b');
});
