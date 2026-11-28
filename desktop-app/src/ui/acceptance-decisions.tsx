import React, { useState } from "react";
import type { ManualAcceptanceDetail } from "../shared/contracts";

type Request = (input: unknown) => Promise<ManualAcceptanceDetail>;
const key = (id: string, revision: number) => JSON.stringify([id, revision]);
const issue = (error: unknown) => (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");

export function AcceptanceDecisions({ detail, request, changed }: {
  detail: ManualAcceptanceDetail; request: Request; changed: (value: ManualAcceptanceDetail) => void;
}) {
  const [selected, choose] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!detail.decisions?.length) return <p className="field-help">没有可核对的决定版本。</p>;
  const decisions = detail.decisions;
  return <section aria-label="这次实际采用的决定">
    <h4>采用的决定</h4>
    <p className="field-help">只勾选你核实这次交付确实采用的版本。</p>
    <fieldset disabled={busy}>
      <legend>原回合的决定</legend>
      {decisions.map(ref => {
        const id = key(ref.id, ref.revision);
        return <label className="check-label" key={id}>
          <input type="checkbox" checked={ref.adopted || selected.includes(id)} disabled={ref.adopted}
            onChange={e => choose(e.target.checked ? [...selected, id] : selected.filter(value => value !== id))} />
          <span>第 {ref.revision} 版 · {ref.text}{ref.adopted && <small>已确认采用</small>}</span>
        </label>;
      })}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy || selected.length === 0} onClick={async () => {
      setError(""); setBusy(true);
      try {
        const references = decisions.filter(ref => selected.includes(key(ref.id, ref.revision))).map(({ id, revision }) => ({ id, revision }));
        changed(await request({ op: "acceptance.adoptDecisions", id: detail.id, references }));
        choose([]);
      } catch (error) { setError(issue(error)); }
      finally { setBusy(false); }
    }}>记录已采用版本</button>
  </section>;
}
