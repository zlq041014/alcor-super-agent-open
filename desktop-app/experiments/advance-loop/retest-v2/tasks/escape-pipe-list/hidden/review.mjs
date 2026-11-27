import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("允许标签中包含分隔符", async () => {
  assert.deepEqual(run({text:'|x\\\\y||\\q|\\'}),['','x\\y','','\\q','\\']);
});
