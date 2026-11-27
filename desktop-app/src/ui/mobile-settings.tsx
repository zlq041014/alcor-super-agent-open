import React, { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import type { Project } from "../shared/contracts";

type Decision = {
  id: string;
  discussion: string;
  title: string;
  heads: string[];
  versions: { version: string; text: string; origin: string }[];
};
type Status = {
  addresses: string[];
  address?: string;
  error: string;
  devices: { id: string; name: string; projects: string[] }[];
  decisions: Decision[];
};

export function MobileSettings({ projects, call }: {
  projects: Project[];
  call: (request: unknown) => Promise<any>;
}) {
  const [status, setStatus] = useState<Status>();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [invite, setInvite] = useState<{ code: string; expiresAt: number }>();
  const [problem, setProblem] = useState("");
  const [decision, setDecision] = useState<{ id: string; version: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await call({ action: "status" }) as Status;
    setStatus(next);
    setAddress((old) => old || next.address || next.addresses[0] || "");
  };
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setProblem("");
    try { await job(); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(refresh); }, []);
  return <section className="settings-section" aria-label="手机接入">
    <div className="section-title"><Smartphone size={20}/><div><h2>手机接入</h2>
      <p>配对后，手机可读取选中的项目并交接工作。新工作只读或写入所选项目，原会话续聊沿用原权限。</p></div></div>
    {problem || status?.error ? <p role="alert">{problem || status?.error}</p> : null}
    {status?.address && <p>已开启局域网入口 · {status.address}</p>}
    <form onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        setInvite(await call({ action: "invite", address, projects: selected, name }));
        await refresh();
      });
    }}>
      <div className="form-grid">
        <label>局域网地址<select value={address} onChange={(e) => setAddress(e.target.value)}>
          <option value="">选择地址</option>
          {status?.addresses.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>手机名称<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的手机"/></label>
      </div>
      <fieldset>
        <legend>共享项目（最多 8 个）</legend>
        {projects.filter((p) => !p.removed && p.available !== false).map((p) =>
          <label key={p.id} title={p.path}>
            <input type="checkbox" checked={selected.includes(p.id)}
              disabled={selected.length >= 8 && !selected.includes(p.id)}
              onChange={(e) => setSelected((old) => e.target.checked ? [...old, p.id] : old.filter((x) => x !== p.id))}/>
            {p.name} · {p.path}
          </label>)}
      </fieldset>
      <div className="button-row">
        <button type="submit" disabled={busy || !address || !selected.length || !name.trim()}>生成配对码</button>
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>刷新</button>
        {status?.address && <button type="button" disabled={busy} onClick={() => void run(async () => {
          await call({ action: "off" }); setInvite(undefined); await refresh();
        })}>关闭手机入口</button>}
      </div>
    </form>
    {invite && <div>
      <label>将配对码粘贴到手机，{new Date(invite.expiresAt).toLocaleTimeString("zh-CN")} 前有效<textarea readOnly value={invite.code} onFocus={(e) => e.target.select()}/></label>
      <button disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(invite.code); })}>复制配对码</button>
    </div>}
    {status?.devices.map((d) => <p key={d.id}>{d.name} · {d.projects.map((id) => projects.find((p) => p.id === id)?.name ?? "项目已移除").join("、")}
      {" "}<button disabled={busy} onClick={() => void run(async () => { await call({ action: "revoke", id: d.id }); await refresh(); })}>撤销配对</button></p>)}
    {status && status.decisions.length > 0 && <div><h3>来自手机的讨论决定</h3>
      {status.decisions.map((d) => <div key={d.id}><strong>{d.title}</strong>
        {d.heads.map((head) => {
          const v = d.versions.find((x) => x.version === head)!;
          return <p key={head}>{v.text} · {v.origin}{" "}
            <button disabled={busy} onClick={() => setDecision({ id: d.id, version: head, text: v.text })}>修改此版本</button></p>;
        })}
        {d.heads.length > 1 && <p>两处都改过，请在手机选择要沿用的内容。</p>}
        {decision?.id === d.id && <form onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call({ action: "decision", discussion: d.discussion, value: {
              id: d.id, version: crypto.randomUUID(), parents: [decision.version], text: decision.text, quote: decision.text.slice(0, 3000),
            } });
            setDecision(undefined);
            await refresh();
          });
        }}><label>决定<textarea required maxLength={14000} value={decision.text} onChange={(e) => setDecision({ ...decision, text: e.target.value })}/></label>
          <button type="submit" disabled={busy || !decision.text.trim()}>保存决定</button>
          <button type="button" onClick={() => setDecision(undefined)}>取消</button></form>}
      </div>)}</div>}
  </section>;
}
