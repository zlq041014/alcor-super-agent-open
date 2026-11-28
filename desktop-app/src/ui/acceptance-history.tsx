import React, { useState } from "react";
import { AcceptanceDecisions } from "./acceptance-decisions";
import type { ManualAcceptance, ManualAcceptanceDetail, Snapshot } from "../shared/contracts";

const date = (at: string) => new Date(at).toLocaleString("zh-CN");

export function AcceptanceHistory({ snapshot, request }: { snapshot: Snapshot; request: (input: unknown) => Promise<ManualAcceptanceDetail> }) {
  const [detail, setDetail] = useState<ManualAcceptanceDetail>(), [pending, setPending] = useState(false), [error, setError] = useState("");
  const receipts = snapshot.manualAcceptances ?? [];
  const tasks = new Map(snapshot.tasks.map(t => [t.id, t])), projects = new Map(snapshot.projects.map(p => [p.id, p.name]));
  function open(receipt: ManualAcceptance) {
    setDetail(undefined); setError(""); setPending(true);
    void request({ op: "acceptance.read", id: receipt.id }).then(setDetail).catch(e => setError((e as Error).message
      .replace(/^Error invoking remote method '[^']+': Error: /, ""))).finally(() => setPending(false));
  }
  return <section aria-label="人工验收历史">
    <h2>人工验收</h2>
    {!receipts.length && <p>还没有人工验收记录。</p>}
    {receipts.length > 0 && <ul className="workbench-rows">{receipts.map(row => {
      const task = tasks.get(row.taskId);
      return <li className="workbench-history-card" key={row.id}>
        <button type="button" disabled={pending} onClick={() => open(row)}>
          {row.title ?? "原工作标题不可核对"} · 第 {row.revision} 版
        </button>
        <p><time dateTime={row.at}>{date(row.at)}</time> · {task ? projects.get(task.projectId) ?? "原项目不可核对" : "原工作不可核对"}
          {task && task.revision !== row.revision ? " · 工作已有新版" : ""}</p>
      </li>;
    })}</ul>}
    {receipts.length === 100 && <p className="field-help">显示最近 100 条人工验收。</p>}
    {pending && <p role="status">正在核对原验收结果…</p>}
    {error && <p role="alert">{error}</p>}
    {detail && <section aria-label="原验收结果" className="info-box vertical">
      <div className="button-row"><h3>原验收结果 · 第 {detail.revision} 版</h3>
        <button type="button" onClick={() => setDetail(undefined)}>关闭结果</button></div>
      <p>{detail.title ?? "原工作标题不可核对"} · <time dateTime={detail.at}>{date(detail.at)}</time></p>
      {detail.result ? <>
        {detail.result.response && <pre className="diff">{detail.result.response}</pre>}
        {detail.result.diff && <details><summary>当时的差异</summary><pre className="diff">{detail.result.diff}</pre></details>}
        {detail.result.files.length > 0 && <ul aria-label="当时的产物">{detail.result.files.map(f => <li key={f.id}>{f.name}</li>)}</ul>}
        {detail.result.truncated && <p className="field-help">这里只显示原结果的部分内容。</p>}
        <AcceptanceDecisions key={detail.id} detail={detail} request={request} changed={setDetail} />
      </> : <p>已保留验收记录，原回合或结果版本不可核对。</p>}
    </section>}
  </section>;
}
