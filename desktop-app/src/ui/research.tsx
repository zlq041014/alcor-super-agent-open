import React from "react";
import { ResearchSpec } from "../shared/research";

type Source = { url: string; version: string; kind: ResearchSpec["sources"][number]["kind"] };
export type ResearchFields = {
  mode: ResearchSpec["mode"]; question: string; version: string; sample: string; a: string; b: string;
  sources: Source[];
};
const unsetSource = { url: "", version: "", kind: "official" as const };
export const emptyResearch = (): ResearchFields => ({
  mode: "before", question: "", version: "", sample: "", a: "", b: "", sources: [unsetSource],
});
export function editResearch(spec: ResearchSpec): ResearchFields {
  return {
    mode: spec.mode, question: spec.question, version: spec.version, sample: spec.sample.path,
    a: spec.sample.choices[0].contains, b: spec.sample.choices[1].contains,
    sources: spec.sources.length ? spec.sources : [unsetSource],
  };
}
export function researchValue(fields: ResearchFields, key: string, consumer = "main") {
  const parsed = ResearchSpec.safeParse({
    key, consumer, mode: fields.mode, question: fields.question, version: fields.version,
    sources: fields.mode === "local" ? [] : fields.sources.filter((item) => item.url.trim())
      .map((item) => ({ ...item, url: item.url.trim(), version: item.version.trim() || fields.version })),
    sample: {
      path: fields.sample.trim(),
      choices: [{ route: "route-a", contains: fields.a }, { route: "route-b", contains: fields.b }],
    },
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

const sourceKinds = { official: "官方资料", standard: "标准", paper: "原始论文", example: "示例" };
export const researchModes = { before: "前置研究", parallel: "并行参考", local: "已有同版本范例" };
export const researchResult = {
  verified: "来源和小样已核对", local: "已核对本地范例，未联网", offline: "未联网或资料不可达",
  unmatched: "未取得目标版本资料", "sample-unproven": "本地小样未能支持路线", incomplete: "等待可核对的建议",
};
export const researchSourceStatus = {
  matched: "目标版本", "other-version": "版本不同，未读取", unavailable: "不可读取",
  "unconfirmed-version": "未核实版本", "not-read": "未读取",
};

export function ResearchFieldsForm({
  fields, set,
}: { fields: ResearchFields; set: (fields: ResearchFields) => void }) {
  const update = <K extends keyof ResearchFields>(key: K, value: ResearchFields[K]) =>
    set({ ...fields, [key]: value });
  return <div className="form-grid">
    <label>研究方式
      <select value={fields.mode} onChange={(e) => update("mode", e.target.value as ResearchFields["mode"])}>
        {Object.entries(researchModes).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
    <label>目标版本
      <input value={fields.version} onChange={(e) => update("version", e.target.value)} placeholder="例如 4.5" />
    </label>
    <label>要决定的问题
      <textarea value={fields.question} onChange={(e) => update("question", e.target.value)}
        rows={2} placeholder="例如目标版本的材质应走哪条导出路线？" />
    </label>
    <label>已冻结的小样文件
      <input value={fields.sample} onChange={(e) => update("sample", e.target.value)} placeholder="例如 trial.txt" />
    </label>
    <label>路线 A 的小样标记
      <input value={fields.a} onChange={(e) => update("a", e.target.value)} />
    </label>
    <label>路线 B 的小样标记
      <input value={fields.b} onChange={(e) => update("b", e.target.value)} />
    </label>
    {fields.mode !== "local" && <div className="info-box vertical">
      <p>填写你授权读取的公开资料。星引只打开这些地址，不发送项目文件或查询内容。</p>
      {fields.sources.map((item, i) => {
        const change = (value: Partial<Source>) => update("sources",
          fields.sources.map((source, j) => i === j ? { ...source, ...value } : source));
        return <div key={i} className="form-grid">
          <label>公开资料地址 {i + 1}
            <input value={item.url} onChange={(e) => change({ url: e.target.value })}
              placeholder="https://…" />
          </label>
          <label>资料版本 {i + 1}（留空用目标版本）
            <input value={item.version} onChange={(e) => change({ version: e.target.value })} />
          </label>
          <label>资料类型 {i + 1}
            <select value={item.kind} onChange={(e) => change({ kind: e.target.value as Source["kind"] })}>
              {Object.entries(sourceKinds).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
            </select>
          </label>
          {fields.sources.length > 1 && <button type="button"
            onClick={() => update("sources", fields.sources.filter((_, j) => i !== j))}>移除此地址</button>}
        </div>;
      })}
      {fields.sources.length < 4 && <button type="button"
        onClick={() => update("sources", [...fields.sources, unsetSource])}>添加资料地址</button>}
    </div>}
  </div>;
}
