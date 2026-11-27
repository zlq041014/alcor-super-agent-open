import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复分片事件文本", async () => {
  const raw='id: keep\r:comment\rdata: hello\rdata:\r\rid: bad\0id\nevent:\ndata:  leading\n\nid:\ndata';
  const expected=[{type:'message',id:'keep',data:'hello\n'},{type:'message',id:'keep',data:' leading'},{type:'message',id:'',data:''}];
  for(let split=0;split<=raw.length;split++)assert.deepEqual(run({chunks:[raw.slice(0,split),raw.slice(split)]}),expected);
  assert.deepEqual(run({chunks:['event: unused\n\n']}),[]);
});
