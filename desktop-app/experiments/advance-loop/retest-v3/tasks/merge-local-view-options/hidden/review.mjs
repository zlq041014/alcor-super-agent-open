import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.mjs';

test("修复界面选项递归覆盖", async () => {
  const defaults={views:['a','b'],nav:{pinned:{limit:4},order:'recent'},optional:{id:1}};
  const override={views:['c'],nav:{pinned:{limit:undefined},order:null},optional:null};
  const result=run({defaults,override}); assert.deepEqual(result,{views:['c'],nav:{pinned:{limit:4},order:null},optional:null});
  result.views.push('z'); result.nav.pinned.limit=90; assert.deepEqual(override.views,['c']); assert.equal(defaults.nav.pinned.limit,4);
});
