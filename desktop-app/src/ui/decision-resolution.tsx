import React, { useRef, useState } from "react";
import type { Memory } from "../shared/contracts";

type Choice = { id: string; projectId: string; revision: number; heads: number[]; selectedRevision: number };

export function DecisionResolution({ memory, confirm }: {
  memory: Memory; confirm: (choice: Choice) => Promise<unknown>;
}) {
  const [review, setReview] = useState<Memory>();
  const [chosen, setChosen] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const heads = memory.decision?.heads ?? [];
  const shown = review ?? memory;
  const shownHeads = shown.decision?.heads ?? [];
  const stale = !!review && (review.revision !== memory.revision ||
    shownHeads.length !== heads.length || !shownHeads.every(head => heads.includes(head)));
  if (heads.length < 2 && !review) return null;
  const open = () => { setReview(memory); setChosen(undefined); setError(""); };
  const close = () => { setReview(undefined); setChosen(undefined); setError(""); };
  const versions = shownHeads.map(head => shown.decision?.versions?.find(version => version.revision === head));
  return <section aria-label="确认并列决定">
    {review ? <fieldset disabled={busy}>
      <legend>选择要生效的版本</legend>
      {shownHeads.map((head, index) => <label className="check-label" key={head}>
        <input type="radio" name={"decision:" + memory.id} checked={chosen === head} disabled={stale || !versions[index]}
          onChange={() => setChosen(head)} />
        <span>第 {head} 版 <small>{versions[index]?.text ?? "版本内容不可核对"}</small></span>
      </label>)}
      {stale && <p role="alert">并列决定已变化，请重新核对。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="card-actions">
        <button type="button" onClick={close}>取消选择</button>
        {stale && heads.length > 1 && <button type="button" onClick={open}>重新核对版本</button>}
        <button type="button" className="primary" disabled={stale || !chosen || versions.some(v => !v)}
          onClick={async () => {
            if (sending.current || stale || !chosen) return;
            sending.current = true;
            setBusy(true); setError("");
            try {
              await confirm({ id: shown.id, projectId: shown.projectId, revision: shown.revision, heads: shownHeads,
                selectedRevision: chosen });
              close();
            } catch (cause) {
              setError((cause as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
            } finally { sending.current = false; setBusy(false); }
          }}>确认采用此版本</button>
      </div>
    </fieldset> : <>
      <ul>{shownHeads.map((head, index) => <li key={head}>第 {head} 版 · {versions[index]?.text ?? "版本内容不可核对"}</li>)}</ul>
      <button type="button" onClick={open}>核对并列版本</button>
    </>}
  </section>;
}
