import React, { useState } from "react";
import type { DecisionReview, ManualAcceptanceDetail } from "../shared/contracts";

type Request = (input: unknown) => Promise<any>;
const issue = (error: unknown) => (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");

export function ProjectDecisionReviews({ projectId, request }: { projectId: string; request: Request }) {
  const [rows, setRows] = useState<DecisionReview[]>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ManualAcceptanceDetail>();
  const load = (input: unknown, receive: (value: any) => void) => {
    setError(""); setBusy(true);
    void request(input).then(receive).catch(error => setError(issue(error))).finally(() => setBusy(false));
  };
  const refresh = () => {
    setRows(undefined); setReceipt(undefined);
    load({ op: "project.decisionReviews", projectId }, setRows);
  };
  return <details onToggle={event => { if (event.currentTarget.open && !busy) refresh(); }}>
    <summary>查看决定变更</summary>
    <section aria-label="建议复核的交付">
      <h4>建议复核的交付</h4>
      {busy && <p role="status">正在核对…</p>}
      {error && <p role="alert">{error}</p>}
      {rows && (rows.length === 0 ? <p>没有已确认采用旧版且需要复核的交付。</p> :
        <ul>{rows.map(row => <li key={row.acceptanceId}>
          <strong>{row.title} · 交付第 {row.taskRevision} 版</strong>
          <ul>{row.changes.map(change => <li key={change.id}>
            <p>当次采用 · 第 {change.previous.revision} 版：{change.previous.text}</p>
            <p>当前 · 第 {change.current.revision} 版：{change.current.text}</p>
          </li>)}</ul>
          <button type="button" disabled={busy} onClick={() => {
            setReceipt(undefined);
            load({ op: "acceptance.read", id: row.acceptanceId }, setReceipt);
          }}>查看原验收</button>
          {receipt?.id === row.acceptanceId && <section aria-label="原验收">
            <p>原验收 · 第 {receipt.revision} 版</p>
            {receipt.result ? <>
              <p>{receipt.result.response}</p>
              {receipt.result.files.length > 0 && <ul>{receipt.result.files.map(file => <li key={file.id}>{file.name}</li>)}</ul>}
            </> : <p>原结果不可核对。</p>}
          </section>}
        </li>)}</ul>)}
      <button type="button" disabled={busy} onClick={refresh}>刷新复核提示</button>
    </section>
  </details>;
}
