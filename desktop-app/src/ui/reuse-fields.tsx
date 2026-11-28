import React, { useState } from "react";
import { REUSE_KIND_LABELS, type ReuseItem, type ReuseKind } from "../shared/contracts";

export function ReusePublishFields({ items }: { items: ReuseItem[] }) {
  const [id, setId] = useState("");
  const [selected, setSelected] = useState<ReuseKind>("content");
  const prior = items.find(item => item.id === id);
  const kind = prior?.kind ?? selected;
  return <>
    {items.length > 0 && <label>条目<select name="prior" value={id} onChange={e => setId(e.target.value)}>
      <option value="">新条目</option>
      {items.map(item => <option key={item.id} value={item.id}>{item.title} · 第 {item.version} 版</option>)}
    </select></label>}
    {prior ? <p>类别：{REUSE_KIND_LABELS[kind]}<input type="hidden" name="kind" value={kind} /></p> :
      <label>类别<select name="kind" value={selected} onChange={e => setSelected(e.target.value as ReuseKind)}>
        {Object.entries(REUSE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>}
    {kind === "experience" && <label>可复用的做法<textarea name="guidance" required maxLength={6000} /></label>}
  </>;
}

export function ReuseGoal({ template }: { template?: string }) {
  const [goal, setGoal] = useState("");
  return <>
    <label>工作目标<textarea name="goal" required maxLength={24000} value={goal} onChange={e => setGoal(e.target.value)} /></label>
    {template !== undefined && <button type="button" disabled={!!goal.trim()} onClick={() => setGoal(template)}>
      复制模板到工作目标
    </button>}
  </>;
}
