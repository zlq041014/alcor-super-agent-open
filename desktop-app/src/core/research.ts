import type {
  ResearchEvidence, ResearchFinding, ResearchSample, ResearchSourceStatus, ResearchSpec,
} from "../shared/research";

export const researchAuthority = { official: 0, standard: 1, paper: 2, example: 3 };
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function hasResearchVersion(text: string, version: string) {
  const label = escapePattern(version);
  return new RegExp(`(?:^|[^A-Za-z0-9.])(?:v|V)?${label}(?=$|[^A-Za-z0-9.])`).test(text);
}

export function probeResearchSample(
  spec: ResearchSpec, material?: { blob: string; text: string },
): ResearchSample {
  const path = spec.sample.path;
  if (!material) return { path, state: "missing" };
  const base = { path, blob: material.blob };
  if (spec.mode === "local" && !hasResearchVersion(material.text, spec.version))
    return { ...base, state: "failed" };
  const matches = spec.sample.choices.filter((item) => material.text.includes(item.contains));
  return matches.length === 1
    ? { ...base, state: "passed", route: matches[0].route }
    : { ...base, state: matches.length ? "ambiguous" : "failed" };
}

export type ResearchMaterial = { source: ResearchSourceStatus; excerpt?: string };
export function researchEvidence(
  spec: ResearchSpec, sample: ResearchSample, material: ResearchMaterial[],
): ResearchEvidence {
  const joined = { sample, sources: material.map((entry) => entry.source) };
  if (spec.mode === "local")
    return { ...joined, status: sample.state === "passed" ? "local" : "sample-unproven",
      detail: sample.state === "passed" ? "已核对同版本本地范例，无需联网" : "冻结范例未能区分两条路线或版本不符" };
  const attempted = material.filter(({ source }) => source.outcome !== "other-version");
  if (!material.length || (attempted.length > 0 && attempted.every(({ source }) =>
      source.outcome === "unavailable" || source.outcome === "not-read")))
    return { ...joined, status: "offline", detail: "没有可读取的公开资料" };
  if (!material.some(({ source }) => source.outcome === "matched"))
    return { ...joined, status: "unmatched", detail: "未找到可核对的目标版本资料" };
  if (sample.state !== "passed")
    return { ...joined, status: "sample-unproven", detail: "本地小样没有区分可采用的路线" };
  return { ...joined, status: "incomplete", detail: "已取得资料和小样，等待研究建议" };
}

export function verifyResearchFinding(
  evidence: ResearchEvidence, material: ResearchMaterial[], finding: ResearchFinding,
): ResearchEvidence {
  if (evidence.status !== "incomplete" || finding.route !== evidence.sample.route)
    throw new Error("建议的路线与本地小样证据不一致");
  const checked = material.filter(({ source, excerpt }) => source.outcome === "matched" && excerpt);
  const best = Math.min(...checked.map(({ source }) => researchAuthority[source.kind]));
  const cited = finding.citations.map(({ id, quote }) => {
    const source = checked.find((item) => item.source.id === id && item.excerpt!.includes(quote));
    if (!source) throw new Error("引文不在已读取的目标版本资料中");
    return source;
  });
  if (!cited.some(({ source }) => researchAuthority[source.kind] === best))
    throw new Error("有较可靠的同版本资料，请核对后引用");
  return { ...evidence, status: "verified", finding, detail: undefined };
}
