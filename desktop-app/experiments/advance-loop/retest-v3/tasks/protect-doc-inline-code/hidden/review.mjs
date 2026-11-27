import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("保留代码块中的快捷引用", async () => {
  const input=['[[a-2]]','```example','[[b]]','```','`[[c]]','\\[[d]] [[e]] [[bad_key]]'].join('\r\n');
  assert.equal(run({text:input}),['{a-2}','```example','[[b]]','```','`{c}','\\[[d]] {e} [[bad_key]]'].join('\r\n'));
});
