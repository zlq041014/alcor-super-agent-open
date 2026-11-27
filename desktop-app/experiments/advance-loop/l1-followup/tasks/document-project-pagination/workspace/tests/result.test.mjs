import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { pageProjects } from "../src/index.mjs";
import {readFileSync} from "node:fs";
test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
test("README 的分页示例与代码一致",()=>{
  const doc=readFileSync(new URL("../README.md",import.meta.url),"utf8");
  const example=doc.split("```json")[1].split("```")[0];
  assert.deepEqual(JSON.parse(example),pageProjects(["a","b","c"],2,"a"));
});
