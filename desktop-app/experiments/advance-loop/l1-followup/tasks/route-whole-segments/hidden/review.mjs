import assert from "node:assert/strict";
import { test } from "node:test";
import { helpSection } from "../src/index.mjs";

test("根、查询片段、同长优先和最长段", () => {
  const entries=[["/","root"],["/a/","a"],["/a/a","first"],["/a/a/","second"],["/ab","ab"]];
  assert.equal(helpSection("/a/a/child/?v=2#x",entries),"first");
  assert.equal(helpSection("/a?q=1",entries),"a");
  assert.equal(helpSection("/a/aaa#x",entries),"a");
  assert.equal(helpSection("/ab#x",entries),"ab");
  assert.equal(helpSection("/abc",entries),"root");
  assert.equal(helpSection("/abc",[["/a","a"]]),null);
});
