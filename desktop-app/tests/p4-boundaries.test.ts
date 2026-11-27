import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openP4Model } from "../scripts/p4-model";

test("真实试验透传 DSH 原始请求、原生工具、多轮历史和流式回执", async () => {
  const received: string[] = [];
  const reply = 'data: {"usage":{"total_tokens":18},"choices":[]}\n\ndata: [DONE]\n\n';
  const vendor = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    received.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "text/event-stream" }).end(reply);
  });
  await new Promise<void>(ok => vendor.listen(0, "127.0.0.1", ok));
  const port = (vendor.address() as {port:number}).port;
  const observer = await openP4Model({ key:"TEST-PLACEHOLDER", model:"local-test", endpoint:"http://127.0.0.1:"+port+"/v1" });
  try {
    for (const limits of [{ max_tokens: 128000 }, {}]) {
      const raw = JSON.stringify({ model:"local-test", ...limits, stream:true, messages:[
        {role:"user",content:"first"},{role:"assistant",content:"second"},{role:"user",content:"third"}],
        tools:[{type:"function",function:{name:"pwsh"}}] }, null, 2);
      const res = await fetch(observer.endpoint+"/chat/completions", { method:"POST",
        headers:{ authorization:"Bearer "+observer.token }, body:raw });
      assert.equal(await res.text(),reply);
      assert.equal(received.at(-1),raw);
    }
    assert.deepEqual(observer.counters,{requests:2,knownRequests:2,tokens:36,errors:0});
    assert.deepEqual(observer.observed,{outputFields:[{max_tokens:128000},{}],tools:["pwsh"],maxMessages:3});
  } finally { observer.close(); vendor.close(); vendor.closeAllConnections(); }
});

