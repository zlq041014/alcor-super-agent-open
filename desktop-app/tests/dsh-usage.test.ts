import test from "node:test";
import assert from "node:assert/strict";
import { dshUsageReader } from "../src/adapter/dsh-usage";

test("多行分片的事件流按每个请求的最后回执计量，JSON 缺值保持未知", () => {
  const result = { requests: 3, knownRequests: 0, tokensKnown: 0 };
  const first = dshUsageReader(result, "text/event-stream; charset=utf-8");
  first.write(
    Buffer.from(
      'event: response.completed\r\ndata: {"response": {\r\ndata: "usa',
    ),
  );
  first.write(
    Buffer.from('ge": {"input_tokens": 7,"output_tokens": 3}}}\r\n\r\n'),
  );
  first.write(
    Buffer.from('data: {"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n'),
  );
  first.end();
  const second = dshUsageReader(result, "application/json");
  second.write(Buffer.from('{"usage":{"total_tokens":0}}'));
  second.end();
  const last = dshUsageReader(result, "application/json");
  last.write(Buffer.from('{"usage":{"prompt_tokens":5},"message":"fixture"}'));
  last.end();
  assert.deepEqual(result, { requests: 3, knownRequests: 2, tokensKnown: 12 });
});
