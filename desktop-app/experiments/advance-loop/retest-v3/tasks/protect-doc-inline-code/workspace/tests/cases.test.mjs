import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("保留代码块中的快捷引用", async () => {
  assert.equal(run({text:'plain [[alpha]] and `[[beta]]`'}),'plain {alpha} and `[[beta]]`');
});
