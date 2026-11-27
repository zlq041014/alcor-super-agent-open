import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按字符缩略预览", async () => {
  for (const a of ['👩‍💻','🇨🇳','e\u0301']) {
    assert.equal(run({text:a+'abc',limit:2}),a+'…');
    assert.equal(run({text:a,limit:1}),a);
  }
  assert.equal(run({text:'abc',limit:0}),'');
});
