import assert from "node:assert/strict";
import { test } from "node:test";
import { retryDelay } from "../src/index.mjs";

test("HTTP 日期、零等待、无效值及用户上限", () => {
  const now = Date.UTC(2025, 0, 6, 0, 0, 0);
  const caps = { normalDelay:3800, maxDelay:6800 };
  assert.equal(retryDelay(new Date(now+2000).toUTCString(),now,now+1700,caps),1700);
  assert.equal(retryDelay(new Date(now-5000).toUTCString(),now,now+20000,caps),0);
  assert.equal(retryDelay("0",now,now+5000,caps),0);
  for (const value of ["1.5","5sec","",null,"Tue, 06 Jan 2025 00:01:00 GMT"]) {
    assert.equal(retryDelay(value,now,now+20000,caps),3800);
  }
  assert.equal(retryDelay("999",now,now+10000,caps),6800);
  assert.equal(retryDelay("4",now,now-1,caps),0);
});
