import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复分片事件文本", async () => {
  assert.deepEqual(run({chunks:['id: 2\r','\nevent: next\r\ndata: a\r','\n\r\n']}),[{type:'next',id:'2',data:'a'}]);
});
