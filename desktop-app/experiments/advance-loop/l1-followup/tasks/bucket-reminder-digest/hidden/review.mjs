import assert from "node:assert/strict";
import { test } from "node:test";
import { reminderDigest } from "../src/index.mjs";

test("默认保留已读并按最新值排序，同值保持名称顺序", () => {
  const rows=[{channel:"b",at:15},{at:16,unread:true},{channel:"a",at:17,unread:1},
    {channel:"b",at:17,unread:false},{channel:"a",at:9,unread:true}];
  assert.deepEqual(reminderDigest(rows),[
    {channel:"a",count:2,newest:17},{channel:"b",count:2,newest:17},{channel:"general",count:1,newest:16}
  ]);
  assert.deepEqual(reminderDigest(rows,{onlyUnread:true}),[
    {channel:"general",count:1,newest:16},{channel:"a",count:1,newest:9}
  ]);
  assert.deepEqual(reminderDigest([],{onlyUnread:true}),[]);
});
