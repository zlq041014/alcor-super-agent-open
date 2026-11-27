import assert from "node:assert/strict";
import { test } from "node:test";
import { moveSelection } from "../src/index.mjs";

test("不存在的目标放在末尾，自选目标不移动", () => {
  const ids=["r","s","t","u","v"], picked=["v","s","s","n","t"];
  assert.deepEqual(moveSelection(ids,picked,"missing"),["r","u","s","t","v"]);
  assert.deepEqual(moveSelection(ids,picked,"u"),["r","s","t","v","u"]);
  const same=moveSelection(ids,picked,"t");
  assert.deepEqual(same,ids);
  assert.notEqual(same,ids);
  assert.deepEqual(moveSelection(ids,["not-there"],"r"),ids);
  assert.deepEqual(ids,["r","s","t","u","v"]);
  assert.deepEqual(picked,["v","s","s","n","t"]);
});
