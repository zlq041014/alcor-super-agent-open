import assert from "node:assert/strict";
import { test } from "node:test";
import { preview } from "../src/preview.mjs";
import { expected } from "../src/sample.mjs";
import { moveSelection } from "../src/index.mjs";

test("项目示例", () => assert.deepEqual(JSON.parse(preview()), expected));
