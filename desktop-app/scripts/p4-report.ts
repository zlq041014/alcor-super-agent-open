import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/hub/security";

type Row = {
  caseId: string; pair: number; arm: "A" | "B" | "C"; status: string; applicationDone: boolean;
  checks: Record<string, boolean>; extraFiles: number;
  firstMs: number | null; allMs: number | null; closeMs: number | null;
  directionRework: number; researchRuns: number; branchCount: number; maxConcurrentExecute: number;
  runCount: number; receiptUnknown: number; lateStarts: number; duplicateCommands: number;
  sourceReads: number; sourceVersions: string[]; adopted: number;
  transport: { requests: number; knownRequests: number; tokens: number; denied: number; limited: number; errors: number };
};
type Manifest = {
  model: string; effort: string;
  limits: { runs: number; apiCalls?: number };
  ordering: Record<string, string[]>;
  gates: { parallelMinimumMedianSaving: number; minimumPairedEvidence: number };
};
const median = (samples: number[]) => {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const filesPass = (row: Row) => !row.extraFiles && !!Object.keys(row.checks).length && Object.values(row.checks).every(Boolean);
const passed = (row: Row) => row.applicationDone && filesPass(row);
const fraction = (number: number, total: number) => number + "/" + total;
const seconds = (milliseconds: number | null) => milliseconds === null ? "—" : (milliseconds / 1000).toFixed(1);
function summary(rows: Row[]) {
  const observed = (key: "firstMs" | "allMs" | "closeMs") =>
    median(rows.flatMap((row) => row[key] === null ? [] : [row[key]]));
  return {
    passed: rows.filter(passed).length, filePassed: rows.filter(filesPass).length, total: rows.length,
    firstMedianMs: observed("firstMs"), allMedianMs: observed("allMs"), closeMedianMs: observed("closeMs"),
    directionRework: rows.reduce((total, row) => total + row.directionRework, 0),
    researchRuns: rows.reduce((total, row) => total + row.researchRuns, 0),
    sourceReads: rows.reduce((total, row) => total + row.sourceReads, 0),
    adopted: rows.reduce((total, row) => total + row.adopted, 0),
    runCount: rows.reduce((total, row) => total + row.runCount, 0),
    tokenKnown: rows.reduce((total, row) => total + row.transport.tokens, 0),
    usageUnknown: rows.reduce((total, row) => total + row.transport.requests - row.transport.knownRequests, 0),
  };
}

async function main() {
  if (!process.argv[2]) throw new Error("需要实际 P4 结果目录");
  const dir = await realpath(resolve(process.argv[2]));
  const base = await realpath(resolve("../.dev/advance-loop/P4"));
  const target = relative(base, dir);
  if (!target || isAbsolute(target) || target.startsWith("..")) throw new Error("报告须保存在 P4 隔离结果目录");
  const buffer = await readFile(join(dir, "manifest.json"));
  const manifest = JSON.parse(buffer.toString("utf8")) as Manifest;
  const rows: Row[] = [];
  const absent: string[] = [];
  for (const [caseId, ordering] of Object.entries(manifest.ordering))
    for (const [index, arms] of ordering.entries())
      for (const arm of arms) {
        const path = join(dir, `${caseId}-${index + 1}-${arm}`, "result.json");
        try {
          const row = JSON.parse(await readFile(path, "utf8")) as Row;
          if (row.caseId !== caseId || row.pair !== index + 1 || row.arm !== arm) throw new Error("样本身份不符");
          rows.push(row);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          absent.push(`${caseId}-${index + 1}-${arm}`);
        }
      }
  const optional = await readdir(dir);
  const replay = optional.includes("wcag-excerpt.json") ? await readFile(join(dir, "wcag-excerpt.json")) : undefined;
  const publicReplay = replay ? { digest: hash(replay), capturedAt: JSON.parse(replay.toString("utf8")).capturedAt } : undefined;
  const online: Row | undefined = optional.includes("focus-live-C")
    ? JSON.parse(await readFile(join(dir, "focus-live-C", "result.json"), "utf8")) : undefined;
  const subset = (cases: string[], arm: Row["arm"]) => rows.filter((r) => cases.includes(r.caseId) && r.arm === arm);
  const parallelCases = ["clips", "colors"];
  const a = subset(parallelCases, "A"), b = subset(parallelCases, "B");
  const bResearch = subset(["focus"], "B"), cResearch = subset(["focus"], "C");
  const bSimple = subset(["existing"], "B"), cSimple = subset(["existing"], "C");
  const localProof = cSimple.map((row) => {
    const path = join(dir, `existing-${row.pair}-C`, "state", "state.sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return !!db.prepare(`SELECT 1 FROM records WHERE kind='graph-node'
        AND json_extract(data,'$.research.spec.mode')='local'
        AND json_extract(data,'$.research.evidence.status')='local'`).get();
    } finally { db.close(); }
  });
  const pairedSavings = a.flatMap((left) => {
    const right = b.find((r) => r.caseId === left.caseId && r.pair === left.pair);
    return right && passed(left) && passed(right) && left.allMs && right.allMs !== null
      ? [(left.allMs - right.allMs) / left.allMs] : [];
  });
  const saving = median(pairedSavings);
  const audited = online ? [...rows, online] : rows;
  const safety = audited.filter((r) => r.lateStarts || r.duplicateCommands ||
    r.runCount > manifest.limits.runs || (manifest.limits.apiCalls !== undefined && r.transport.requests > manifest.limits.apiCalls) ||
    (r.applicationDone && !filesPass(r))).map((r) => ({
      sample: `${r.caseId}/${r.pair}/${r.arm}`, lateStarts: r.lateStarts,
      duplicateCommands: r.duplicateCommands, falseClose: r.applicationDone && !filesPass(r),
    }));
  const result = {
    protocol: hash(buffer), publicReplay, settings: { model: manifest.model, effort: manifest.effort, limits: manifest.limits },
    absent, groups: { A: summary(a), B: summary(b), researchB: summary(bResearch),
      researchC: summary(cResearch), simpleB: summary(bSimple), simpleC: summary(cSimple) },
    parallel: { pairs: pairedSavings.length, medianSaving: saving,
      overlapObserved: b.filter((r) => r.maxConcurrentExecute > 1).length,
      candidate: !absent.length && !safety.length && b.filter(passed).length >= a.filter(passed).length &&
        pairedSavings.length >= manifest.gates.minimumPairedEvidence &&
        saving !== null && saving >= manifest.gates.parallelMinimumMedianSaving },
    research: { candidate: !absent.length && !safety.length &&
      (cResearch.filter(passed).length > bResearch.filter(passed).length ||
        (cResearch.filter(passed).length === bResearch.filter(passed).length &&
          summary(cResearch).directionRework < summary(bResearch).directionRework)) },
    simpleNoResearch: cSimple.length === (manifest.ordering.existing?.length ?? 0) &&
      localProof.every(Boolean) &&
      cSimple.every((row) => row.runCount > 0 && row.researchRuns === 0 && row.sourceReads === 0),
    safety, online, rows,
    deniedToolRequests: audited.reduce((total, row) => total + (row.transport.denied ?? 0), 0),
  };
  await writeFile(join(dir, "report.json"), JSON.stringify(result, null, 2));
  const heads = { A: "可拆 A 串行", B: "可拆 B 并行", researchB: "方向 B 无研究", researchC: "方向 C 前置研究",
    simpleB: "简单 B 无研究", simpleC: "简单 C 本地范例" };
  const data = Object.entries(result.groups).map(([name, s]) =>
    `| ${heads[name as keyof typeof heads]} | ${fraction(s.filePassed, s.total)} | ${fraction(s.passed, s.total)} | ${seconds(s.firstMedianMs)} | ${seconds(s.allMedianMs)} | ${seconds(s.closeMedianMs)} | ${s.directionRework} | ${s.runCount} | ${s.tokenKnown} / ${s.usageUnknown} |`);
  const detail = rows.map((row) => `| ${row.caseId}/${row.pair}/${row.arm} | ${row.status} | ${filesPass(row) ? "通过" : "未通过"} | ${passed(row) ? "通过" : "未通过"} | ${seconds(row.firstMs)} | ${seconds(row.allMs)} | ${seconds(row.closeMs)} | ${row.runCount} | ${row.transport.tokens} / ${row.transport.requests - row.transport.knownRequests} |`);
  const lines = [
    "# P4 对照结果", "",
    `模型 ${manifest.model} / ${manifest.effort}。各次使用隔离目录，失败留在分母；中位数只统计该项存在可用回执的样本。`, "",
    ...(publicReplay ? [`B/C 的冻结公开资料摘要：${publicReplay.digest}。`, ""] : []),
    "| 组 | 最终文件通过 | 整项通过 | 首个可用秒 | 全部可用秒 | 收口秒 | 路线返工 | 回合数 | 已知 token / 未知请求 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...data, "",
    `A/B 双方通过且有时间证据：${result.parallel.pairs} 对；节省比例中位数：${saving === null ? "无" : (saving * 100).toFixed(1) + "%"}。`,
    `B 组确实有两个执行回合重叠的试次：${fraction(result.parallel.overlapObserved, b.length)}。`,
    `并行收益门槛：${result.parallel.candidate ? "达到" : "未达到"}；研究收益门槛：${result.research.candidate ? "达到" : "未达到"}；简单任务零研究：${result.simpleNoResearch ? "通过" : "未证明"}。`,
    `待审计放行否决项：${safety.length}；代理拦下工具调用请求：${result.deniedToolRequests}；缺失：${absent.length ? absent.join("、") : "无"}。`,
    `独立真实联网：${online ? "文件" + (filesPass(online) ? "通过" : "未通过") + "、整项" + (passed(online) ? "通过" : "未通过") + "；读取 " + online.sourceReads + " 次、匹配版本 " + (online.sourceVersions.join(", ") || "无") : "未完成"}。该样本不进入 B/C 成对统计。`,
    "", "| 样本 | 应用终态 | 最终文件 | 整项判定 | 首个秒 | 全部秒 | 收口秒 | 回合 | 已知 token / 未知请求 |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |", ...detail, "",
  ];
  await writeFile(join(dir, "report.md"), lines.join("\n"));
  console.log(JSON.stringify({ groups: result.groups, parallel: result.parallel, research: result.research,
    simpleNoResearch: result.simpleNoResearch, absent, safety, online: online?.status }));
}
void main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; });
