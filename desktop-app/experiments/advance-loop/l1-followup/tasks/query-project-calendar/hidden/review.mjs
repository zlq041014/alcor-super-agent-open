import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReminder } from "../src/index.mjs";

test("UTC、等于时间、周边切换和非法输入", () => {
  const from=Date.UTC(2025,0,6,15,45);
  assert.equal(nextReminder(from,[1],"15:45"),Date.UTC(2025,0,13,15,45));
  assert.equal(nextReminder(from,[0,2],"00:00"),Date.UTC(2025,0,7));
  assert.equal(nextReminder(Date.UTC(2025,0,4,23,59,59),[0],"00:00"),Date.UTC(2025,0,5));
  assert.equal(nextReminder(from,[],"04:00"),null);
  assert.equal(nextReminder(from,[1,7],"04:00"),null);
  assert.equal(nextReminder(from,[1.2],"04:00"),null);
  for (const time of ["2:00","24:00","09:99"])
    assert.equal(nextReminder(from,[1],time),null);
});
