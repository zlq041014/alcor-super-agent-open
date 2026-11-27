import assert from "node:assert/strict";
import test from "node:test";
import {
  hasResearchVersion, probeResearchSample, researchEvidence, verifyResearchFinding,
} from "../src/core/research";
import { choosePublicResearchIp, collectResearch } from "../src/hub/research-source";
import { publicResearchAddress, ResearchSpec } from "../src/shared/research";

function spec(mode: "before" | "parallel" | "local" = "before") {
  return ResearchSpec.parse({
    key: "material", consumer: "main", mode, version: "4.5",
    question: "Blender glTF material export route",
    sources: mode === "local" ? [] : [
      { url: "https://docs.blender.org/manual/en/4.4/export.html", kind: "example", version: "4.4" },
      { url: "https://docs.blender.org/manual/en/4.5/export.html", kind: "official", version: "4.5" },
    ],
    sample: {
      path: "trial.txt", choices: [
        { route: "metallic", contains: "output=metallic-ok" },
        { route: "fallback", contains: "output=fallback-ok" },
      ],
    },
  });
}

test("公开资料只接受无凭据的 HTTPS 地址，DNS 必须全为公网", () => {
  for (const raw of [
    "http://docs.blender.org/manual/4.5", "https://docs.blender.org:444/manual/4.5",
    "https://docs.blender.org/manual/4.5?token=fixture", "https://docs.blender.org/#key",
    "https://user:fixture@docs.blender.org/", "https://localhost/a", "https://127.1/",
  ]) assert.throws(() => publicResearchAddress(raw), /公开 HTTPS/);
  assert.throws(() => choosePublicResearchIp(["10.3.0.1"]), /公网/);
  assert.throws(() => choosePublicResearchIp(["8.8.8.8", "169.254.169.254"]), /公网/);
  assert.throws(() => choosePublicResearchIp(["100.100.100.100"]), /公网/);
  assert.equal(choosePublicResearchIp(["8.8.8.8"]), "8.8.8.8");
});

test("只发送确切资料地址，不发送技术问题或小样；排除旧版本和伪造引文", async () => {
  const decision = spec(), visited: string[] = [];
  const material = await collectResearch(decision, async (url) => {
    visited.push(url.href);
    return "<html><script>badToken() </script><p>Blender 4.5 glTF material uses Metallic Roughness.</p></html>";
  }, new AbortController().signal);
  assert.deepEqual(visited, ["https://docs.blender.org/manual/en/4.5/export.html"]);
  assert.equal(material.length, 2);
  assert.equal(material[1].source.outcome, "other-version");
  assert.doesNotMatch(material[0].excerpt!, /badToken/);
  const sample = probeResearchSample(decision, { blob: "fixture", text: "output=metallic-ok" });
  const candidate = researchEvidence(decision, sample, material);
  const finding = {
    route: "metallic", recommendation: "使用 Metallic Roughness", conditions: "Blender 4.5",
    fact: "示例使用 Metallic Roughness", unresolved: "尚未检验浏览器性能",
    citations: [{ id: "S2", quote: "glTF material uses Metallic Roughness." }],
  };
  assert.equal(verifyResearchFinding(candidate, material, finding).status, "verified");
  assert.throws(() => verifyResearchFinding(candidate, material, { ...finding, route: "fallback" }), /小样/);
  assert.throws(() => verifyResearchFinding(candidate, material, {
    ...finding, citations: [{ id: "S2", quote: "Other source said the same" }],
  }), /引文/);
});

test("区分没联网、没有目标版本和本地小样不通过；同版本本地范例无需读网", async () => {
  const decision = spec();
  const sample = probeResearchSample(decision, { blob: "sample", text: "output=metallic-ok output=fallback-ok" });
  assert.equal(sample.state, "ambiguous");
  const offline = await collectResearch(decision, async () => { throw new Error("offline"); }, AbortSignal.timeout(1000));
  assert.equal(researchEvidence(decision, sample, offline).status, "offline");
  const mismatch = ResearchSpec.parse({ ...decision, sources: [
    { url: "https://docs.blender.org/manual/export.html", version: "4.5", kind: "official" },
  ] });
  const notMatched = await collectResearch(mismatch, async () => "Text tagged only 4.50", AbortSignal.timeout(1000));
  assert.equal(researchEvidence(mismatch, sample, notMatched).status, "unmatched");
  assert.equal(hasResearchVersion("from v4.5.1", "4.5"), false);
  const matched = await collectResearch(decision, async () => "Blender 4.5 release.", AbortSignal.timeout(1000));
  assert.equal(researchEvidence(decision, sample, matched).status, "sample-unproven");
  const local = spec("local");
  const localProof = probeResearchSample(local, { blob: "sample", text: "Blender 4.5 — output=metallic-ok" });
  assert.equal(researchEvidence(local, localProof, []).status, "local");
  assert.equal(researchEvidence(local, probeResearchSample(local, {
    blob: "sample", text: "Blender 4.4 — output=metallic-ok",
  }), []).status, "sample-unproven");
});
