import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dshUsageReader } from "../src/adapter/dsh-usage";
import { endpointUrl } from "../src/core/policy";
import { defaults } from "../src/shared/contracts";

export type P4Usage = { requests: number; knownRequests: number; tokens: number; errors: number };
/** Observe DSH's actual request and stream without changing history, tools, or output fields. */
export async function openP4Model(options: { model: string; key: string; endpoint?: string }) {
  const token = randomBytes(32).toString("hex");
  const stop = new AbortController();
  const usage = { requests: 0, knownRequests: 0, tokensKnown: 0 };
  const upstream = endpointUrl(options.endpoint ?? defaults.endpoint, "chat/completions");
  const outputFields = new Set<string>(), tools = new Set<string>();
  let errors = 0, maxMessages = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer " + token) {
      res.writeHead(403).end(); return;
    }
    try {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const bytes = Buffer.concat(chunks), request = JSON.parse(bytes.toString("utf8"));
      if (request.model !== options.model) { res.writeHead(400).end(); return; }
      usage.requests++;
      outputFields.add(JSON.stringify(Object.fromEntries(["max_tokens", "max_completion_tokens", "max_output_tokens"]
        .filter(k => k in request).map(k => [k, request[k]]))));
      for (const t of request.tools ?? []) if (typeof t.function?.name === "string") tools.add(t.function.name);
      maxMessages = Math.max(maxMessages, request.messages?.length ?? 0);
      const remote = await fetch(upstream, { method: "POST", redirect: "error", signal: stop.signal,
        headers: { authorization: "Bearer " + options.key, "content-type": "application/json" }, body: bytes });
      if (!remote.ok || !remote.body) { errors++; await remote.body?.cancel(); res.writeHead(remote.ok ? 502 : remote.status).end(); return; }
      const type = remote.headers.get("content-type") ?? "application/json";
      const reader = dshUsageReader(usage, type);
      res.writeHead(remote.status, { "content-type": type });
      await pipeline(Readable.fromWeb(remote.body as any), new Transform({
        transform(chunk, _encoding, done) { reader.write(chunk); done(null, chunk); },
        flush(done) { reader.end(); done(); },
      }), res);
    } catch {
      if (!res.destroyed) { errors++; if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }
    }
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const addr = server.address() as { port: number };
  return { endpoint: "http://127.0.0.1:" + addr.port + "/v1", token,
    get counters(): P4Usage { return { requests: usage.requests, knownRequests: usage.knownRequests, tokens: usage.tokensKnown, errors }; },
    get observed() { return { outputFields: [...outputFields].map(s=>JSON.parse(s)), tools: [...tools].sort(), maxMessages }; },
    close() { stop.abort(); server.closeAllConnections(); server.close(); } };
}

