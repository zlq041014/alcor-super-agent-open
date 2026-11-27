import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { endpointUrl } from "../core/policy";
import {
  apiTarget,
  type Settings,
  type ModelProfile,
  type DshUsage,
} from "../shared/contracts";
import { workspaceMcp, type WorkspaceOptions } from "./dsh-files";
import { dshUsageReader } from "./dsh-usage";

// One loopback capability per ACP run. The vendor key stays in the Hub;
// neither the harness, its tools nor its native history receives it.
export async function dshModelRoute(
  cfg: Settings,
  profile: ModelProfile,
  key: string,
  workspace: { cwd: string; native?: boolean; taskBudget?: boolean } & WorkspaceOptions,
) {
  const target = apiTarget(cfg);
  const responses = target.protocol === "responses";
  const route = responses ? "responses" : "chat/completions";
  const upstream = endpointUrl(target.endpoint, route);
  const token = randomBytes(32).toString("hex");
  const lifetime = new AbortController();
  const usage: DshUsage = { requests: 0, knownRequests: 0, tokensKnown: 0 };
  const evidence = { accepted: false, error: "", usage };
  const mcp = workspace.native ? undefined : workspaceMcp(workspace.cwd, workspace);
  const filesToken = randomBytes(32).toString("hex");
  let filesOpen = true;
  const server = createServer(async (req, res) => {
    const fail = (status: number) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Model request failed", code: status },
        }),
      );
    };
    const files = req.url === "/workspace";
    if (
      (!files && req.url !== "/v1/" + route) ||
      req.headers.authorization !== "Bearer " + (files ? filesToken : token)
    )
      return fail(403);
    if (req.method !== "POST") return fail(405);
    let sawEnd = false;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        if (files && (size += chunk.length) > 8 * 1024 * 1024) return fail(413);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (files) {
        if (!mcp || !filesOpen || lifetime.signal.aborted) return fail(403);
        if (body.jsonrpc !== "2.0") return fail(400);
        if (body.id == null) {
          res.writeHead(202);
          res.end();
          return;
        }
        const reply = await mcp(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
        return;
      }
      if (body.model !== profile.model) return fail(400);
      // The selected DSH provider owns the history and output fields on both protocols.
      if (responses) {
        if (profile.effort !== "default")
          body.reasoning = { ...body.reasoning, effort: profile.effort };
        body.store = false;
      } else {
        if (cfg.apiSource === "deepseek" && profile.effort === "none") {
          delete body.reasoning_effort;
          body.thinking = { type: "disabled" };
        } else if (profile.effort !== "default")
          body.reasoning_effort = profile.effort;
      }
      usage.requests++;
      const remote = await fetch(upstream, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: workspace.taskBudget ? lifetime.signal : AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(cfg.maxMinutes * 60000),
        ]),
      });
      if (!remote.ok || !remote.body) {
        evidence.error = "模型服务返回 HTTP " + remote.status;
        await remote.body?.cancel();
        return fail(remote.ok ? 502 : remote.status);
      }
      evidence.accepted = true;
      const contentType =
        remote.headers.get("content-type") || "application/json";
      const usageReader = dshUsageReader(usage, contentType);
      res.writeHead(200, {
        "content-type": contentType,
      });
      let tail = "";
      const endMarker = new Transform({
        transform(chunk, _encoding, done) {
          usageReader.write(chunk);
          const window = tail + chunk.toString("utf8");
          if (
            /^(?:data:\s*\[DONE\]|event:\s*response\.completed)\s*$/m.test(
              window,
            )
          )
            sawEnd = true;
          tail = window.slice(-64);
          done(null, chunk);
        },
        flush(done) {
          usageReader.end();
          done();
        },
      });
      await pipeline(Readable.fromWeb(remote.body as any), endMarker, res);
      evidence.error = "";
    } catch {
      // Some streaming clients close immediately after consuming the terminal SSE event.
      if (!files) evidence.error = sawEnd ? "" : "模型请求中断或响应无效";
      if (!res.headersSent && !res.destroyed) fail(502);
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("本机模型连接不可用");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    token,
    evidence,
    mcp: {
      type: "http",
      name: "workspace",
      url: `http://127.0.0.1:${address.port}/workspace`,
      headers: [{ name: "Authorization", value: "Bearer " + filesToken }],
    },
    stopFiles() {
      filesOpen = false;
    },
    close() {
      lifetime.abort();
      server.close();
      server.closeAllConnections();
    },
  };
}
