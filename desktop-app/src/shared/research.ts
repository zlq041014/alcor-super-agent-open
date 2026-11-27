import { z } from "zod";

export function publicResearchAddress(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      url.search || url.hash || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) ||
      /\.(?:local|localhost|internal|lan|home|onion)$/i.test(url.hostname))
    throw new Error("资料必须使用无查询参数和认证信息的公开 HTTPS 地址");
  return url;
}

const graphKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const version = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
const publicAddress = z.string().max(700).transform((raw, ctx) => {
  try { return publicResearchAddress(raw).href; }
  catch {
    ctx.addIssue({ code: "custom", message: "请填写确切的公开 HTTPS 资料地址，不带查询参数或认证信息" });
    return z.NEVER;
  }
});
export const ResearchSpec = z.object({
  key: graphKey,
  consumer: graphKey.default("main"),
  mode: z.enum(["before", "parallel", "local"]),
  question: z.string().trim().min(1).max(600),
  version,
  sources: z.array(z.object({
    url: publicAddress,
    kind: z.enum(["official", "standard", "paper", "example"]),
    version,
  }).strict()).max(4).default([]),
  sample: z.object({
    path: z.string().min(1).max(240),
    choices: z.tuple([
      z.object({ route: graphKey, contains: z.string().trim().min(1).max(200) }).strict(),
      z.object({ route: graphKey, contains: z.string().trim().min(1).max(200) }).strict(),
    ]),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const [a, b] = value.sample.choices;
  if (a.route === b.route || a.contains.includes(b.contains) || b.contains.includes(a.contains))
    ctx.addIssue({ code: "custom", path: ["sample"], message: "两条小样判据必须能区分路线" });
  if (new Set(value.sources.map((source) => source.url)).size !== value.sources.length)
    ctx.addIssue({ code: "custom", path: ["sources"], message: "公开资料地址重复" });
  if (value.mode === "local" && value.sources.length)
    ctx.addIssue({ code: "custom", path: ["sources"], message: "本地范例模式不读取公开地址" });
});
export type ResearchSpec = z.infer<typeof ResearchSpec>;

export const ResearchFinding = z.object({
  route: graphKey,
  recommendation: z.string().trim().min(1).max(900),
  conditions: z.string().trim().min(1).max(600),
  fact: z.string().trim().min(1).max(600),
  unresolved: z.string().trim().max(600),
  citations: z.array(z.object({
    id: z.string().regex(/^S[1-4]$/),
    quote: z.string().trim().min(8).max(350),
  }).strict()).min(1).max(4),
}).strict();
export type ResearchFinding = z.infer<typeof ResearchFinding>;
export const ResearchUse = z.object({
  key: graphKey,
  disposition: z.enum(["adopted", "declined"]),
  reason: z.string().trim().min(1).max(900),
}).strict();
export type ResearchUse = z.infer<typeof ResearchUse>;

export type ResearchStatus = "verified" | "local" | "offline" | "unmatched" | "sample-unproven" | "incomplete";
export type ResearchSourceStatus = {
  id: string;
  url: string;
  kind: ResearchSpec["sources"][number]["kind"];
  version: string;
  viewedAt?: string;
  outcome: "matched" | "other-version" | "unavailable" | "unconfirmed-version" | "not-read";
};
export type ResearchSample = {
  path: string;
  blob?: string;
  state: "passed" | "ambiguous" | "failed" | "missing";
  route?: string;
};
export type ResearchEvidence = {
  status: ResearchStatus;
  sources: ResearchSourceStatus[];
  sample: ResearchSample;
  finding?: ResearchFinding;
  detail?: string;
};
