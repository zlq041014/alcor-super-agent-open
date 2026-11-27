import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复带引号的配置值", async () => {
  const source=String.raw`title= x=y # note
  [view]
  q="a\"b\\c"
  bad="no ending # note
  [view] # keep other values
  q="second\q"
  blank=""`;
  assert.deepEqual(run({source}),{'':{title:'x=y'},view:{q:'second\\q',blank:''}});
  assert.deepEqual(run({source:'[one]\nx=1\n[two]\ny=2\n[one]\nk=3'}),{'':{},one:{x:'1',k:'3'},two:{y:'2'}});
});
