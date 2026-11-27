import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import {
  hasResearchVersion, researchAuthority, type ResearchMaterial,
} from "../core/research";
import { publicResearchAddress, type ResearchSourceStatus, type ResearchSpec } from "../shared/research";
import { redact } from "./security";

const excluded = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) excluded.addSubnet(ip, bits, "ipv4");

export function choosePublicResearchIp(addresses: string[]) {
  if (!addresses.length || addresses.some((ip) => !isIPv4(ip) || excluded.check(ip, "ipv4")))
    throw new Error("资料域名未解析到受支持的公网地址");
  return addresses[0];
}

export type ReadResearchSource = (url: URL, signal: AbortSignal) => Promise<string>;
export const readResearchSource: ReadResearchSource = async (url, signal) => {
  url = publicResearchAddress(url.href);
  signal.throwIfAborted();
  const hostname = url.hostname;
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void lookup(hostname, { family: 4, all: true }).then(
      (results) => resolve(results.map((entry) => entry.address)), reject,
    ).finally(() => signal.removeEventListener("abort", abort));
  });
  const ip = choosePublicResearchIp(addresses);
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const outgoing = request({
      protocol: "https:", hostname, servername: hostname, path: url.pathname,
      method: "GET", signal, agent: false, family: 4,
      headers: { accept: "text/html,text/plain,text/markdown", "accept-encoding": "identity" },
      // Keep TLS host verification and pin the checked address; there is no second DNS lookup.
      lookup: (_host, _options, done) => done(null, ip, 4),
    }, (res) => {
      const mime = res.headers["content-type"] || "";
      if (res.statusCode !== 200 || !/^text\/(?:html|plain|markdown)(?:\s*;|\s*$)/i.test(mime) ||
          (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
        reject(new Error("公开资料不可读取或要求重定向"));
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on("data", (chunk: Buffer) => {
        if ((length += chunk.length) > 512 * 1024) {
          reject(new Error("公开资料超过可核对的大小"));
          res.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new Error("公开资料不是有效的 UTF-8 文本")); }
      });
      res.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
};

function sourceText(page: string) {
  return redact(page
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/gi, (entity) =>
      ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" })[entity.toLowerCase()]!)
    .replace(/[\x00-\x1f\x7f\s]+/g, " ").trim());
}

export async function collectResearch(
  spec: ResearchSpec, read: ReadResearchSource, signal: AbortSignal,
): Promise<ResearchMaterial[]> {
  const terms = [...new Set(spec.question.toLowerCase().match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2,}/gu) ?? [])];
  return Promise.all(spec.sources.map(async (item, i): Promise<ResearchMaterial> => {
    const base = { ...item, id: "S" + (i + 1) };
    if (item.version !== spec.version)
      return { source: { ...base, outcome: "other-version" } };
    try {
      const url = publicResearchAddress(item.url);
      const response = await read(url, AbortSignal.any([signal, AbortSignal.timeout(9000)]));
      const text = sourceText(response);
      const viewedAt = new Date().toISOString();
      if (!hasResearchVersion(url.pathname, spec.version) && !hasResearchVersion(text, spec.version))
        return { source: { ...base, viewedAt, outcome: "unconfirmed-version" } };
      const chunks = [];
      for (let start = 0; start < text.length && start < 450_000; start += 850)
        chunks.push(text.slice(start, start + 1100));
      const best = chunks.sort((a, b) => {
        const score = (part: string) => terms.filter((term) => part.toLowerCase().includes(term)).length;
        return score(b) - score(a);
      }).slice(0, 2).join("\n");
      if (!best.trim()) return { source: { ...base, viewedAt, outcome: "unavailable" } };
      return { source: { ...base, viewedAt, outcome: "matched" }, excerpt: best };
    } catch {
      signal.throwIfAborted();
      const source: ResearchSourceStatus = { ...base, outcome: "unavailable" };
      return { source };
    }
  })).then((material) => material.sort((a, b) => researchAuthority[a.source.kind] - researchAuthority[b.source.kind]));
}
