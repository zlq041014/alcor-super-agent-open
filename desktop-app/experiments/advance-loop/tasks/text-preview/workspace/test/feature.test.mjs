import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("按字符缩略预览", async () => {
  assert.equal(run({text:'abcdef',limit:4}),'abc…');
});
