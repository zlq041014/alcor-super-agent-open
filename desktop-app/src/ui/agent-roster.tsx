import React, { useState } from "react";
import type { RosterMember, Snapshot, Task } from "../shared/contracts";
import { stateLabels } from "../shared/contracts";

const sourceLabel = { codex: "Codex", dsh: "DSH", manual: "手动登记" };
const memberLabel = { active: "在册", paused: "暂停接新单", retired: "已退出管理" };

export function AgentRoster({ snapshot, request, refresh, openTask, showLaunch }: {
  snapshot: Snapshot; request: (r: unknown) => Promise<any>; refresh: () => Promise<void>;
  openTask: (t: Task) => void; showLaunch: (result: any) => Promise<void>;
}) {
  const [selected, setSelected] = useState(""), [panel, setPanel] = useState<"add" | "edit" | "link" | "dispatch">(),
    [busy, setBusy] = useState(false), [error, setError] = useState("");
  const member = snapshot.roster?.find(m => m.id === selected);
  const projects = new Map(snapshot.projects.filter(p => !p.removed).map(p => [p.id, p]));
  const linked = new Map<string, Task[]>();
  for (const task of snapshot.tasks) {
    if (!task.rosterId) continue;
    const items = linked.get(task.rosterId) ?? [];
    items.push(task);
    linked.set(task.rosterId, items);
  }
  const tasks = member ? linked.get(member.id) ?? [] : [];
  const candidates = snapshot.tasks.filter(t => !t.rosterId && projects.has(t.projectId) &&
    (member?.source === "manual" || (t.backend ?? "codex") === member?.source));
  const editable = member?.state !== "retired";
  const ready = member?.source === "codex" ? snapshot.codex.status === "就绪" : snapshot.dsh.status === "ACP 就绪";
  const dispatchable = ready && member?.state === "active" && member.mode === "managed";
  function show(next?: typeof panel) { setPanel(next); setError(""); }
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); await refresh(); setPanel(undefined); }
    catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setBusy(false); }
  }
  const fields = (entry?: RosterMember) => <>
    <label>Agent 名称<input name="name" defaultValue={entry?.name} required maxLength={80} /></label>
    <label>能力与备注<textarea name="note" defaultValue={entry?.note} maxLength={2000} /></label>
  </>;
  const actions = (label: string) => <div className="button-row"><button type="submit" className="primary">{label}</button>
    <button type="button" onClick={() => show()}>取消</button></div>;
  return <section className="page" aria-label="Agent 名册">
    <header><small className="workbench-eyebrow">AGENT DIRECTORY</small><h1>Agent 名册</h1><p>按执行者查看项目和已有工作。没有记录的运行状态显示为未知。</p></header>
    <div className="button-row"><button type="button" disabled={busy} onClick={() => show("add")}>登记 Agent</button></div>
    {!snapshot.roster?.length && !panel && <p>还没有已登记的 Agent。</p>}
    <div className="button-row" aria-label="已登记的 Agent">{snapshot.roster?.map(m => <button type="button" key={m.id}
      disabled={busy} aria-pressed={member?.id === m.id} onClick={() => { setSelected(m.id); show(); }}>
      {m.name} · {sourceLabel[m.source]} · {linked.get(m.id)?.length ?? 0} 项工作
    </button>)}</div>
    {member && panel !== "add" && <section aria-label={member.name}>
      <h2>{member.name}</h2><p>{sourceLabel[member.source]} · {memberLabel[member.state]} · {member.mode === "record" ? "仅登记分工" :
        ready ? "执行端就绪" : "执行端未就绪，请在设置中检测"}</p>
      {member.note && <p className="field-help">{member.note}</p>}
      <div className="button-row"><button type="button" disabled={busy} onClick={() => show("edit")}>编辑 Agent</button>
        {editable && <button type="button" disabled={busy} onClick={() => show("link")}>关联已有工作</button>}
        {dispatchable && <button type="button" disabled={busy} onClick={() => show("dispatch")}>准备派工</button>}
      </div>
      <h3>关联工作</h3>
      {tasks.length ? <ul>{tasks.map(t => <li key={t.id}>
        <button type="button" onClick={() => openTask(t)}>{t.title}</button> · {projects.get(t.projectId)?.name ?? "原项目不可用"} · {stateLabels[t.state]}
        {t.rosterRecorded && " · 手动关联"}
      </li>)}</ul> : <p>未分配项目 · 运行状态未知</p>}
    </section>}
    {panel && (panel === "add" || member) && <form key={panel + ":" + selected} onSubmit={e => {
      e.preventDefault();
      if (busy) return;
      const form = new FormData(e.currentTarget), get = (name: string) => String(form.get(name) ?? "");
      void perform(async () => {
        if (panel === "add") {
          const src = get("source");
          const entry = await request({ op: "roster.add", name: get("name"), source: src, mode: src === "manual" ? "record" : get("mode"),
            note: get("note"), requestId: crypto.randomUUID() });
          if (!entry.id) throw new Error(entry.error ?? "登记失败");
          setSelected(entry.id);
        } else if (panel === "edit" && member) await request({ op: "roster.update", id: member.id, revision: member.revision,
          name: get("name"), note: get("note"), state: get("state") });
        else if (panel === "link" && member) {
          const task = candidates.find(t => t.id === get("task"));
          if (!task) throw new Error("请重新选择工作");
          await request({ op: "roster.link", id: member.id, taskId: task.id, revision: task.revision });
        } else if (panel === "dispatch" && member) await showLaunch(await request({ op: "task.create", requestId: crypto.randomUUID(),
          value: { rosterId: member.id, projectId: get("project"), goal: get("goal"), acceptance: get("acceptance"),
            mode: get("scope"), advance: "single", access: "project" } }));
      });
    }}><fieldset className="profile-picker" disabled={busy}>
      <legend>{{ add: "登记 Agent", edit: "编辑 Agent", link: "关联已有工作", dispatch: "准备单次派工" }[panel]}</legend>
      {panel === "add" && <>{fields()}<label>来源<select name="source"><option value="manual">手动登记</option>
        <option value="codex">Codex</option><option value="dsh">DSH</option></select></label>
        <label>用途<select name="mode"><option value="record">仅登记分工</option><option value="managed">托管单次工作</option></select></label>
        <p className="field-help">手动登记只用于查看分工。</p>{actions("保存登记")}</>}
      {panel === "edit" && member && <>{fields(member)}<label>管理状态<select name="state" defaultValue={member.state}>
        {Object.entries(memberLabel).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <p className="field-help">暂停和退出只影响新工作。</p>{actions("保存 Agent")}</>}
      {panel === "link" && <><label>已有工作<select name="task" required defaultValue=""><option value="">选择一项工作</option>
        {candidates.map(t => <option key={t.id} value={t.id}>{t.title} · {projects.get(t.projectId)?.name}</option>)}</select></label>
        <p className="field-help">此关联只记录分工，不改变原执行回执。</p>{actions("确认关联")}</>}
      {panel === "dispatch" && <><label>目标项目<select name="project" required defaultValue=""><option value="">选择一个项目</option>
        {[...projects.values()].filter(p => p.available !== false).map(p => <option key={p.id} value={p.id}>{p.name} · {p.path}</option>)}</select></label>
        <label>工作目标<textarea name="goal" required maxLength={24000} /></label><label>验收条件<textarea name="acceptance" required maxLength={12000} /></label>
        <label>文件范围<select name="scope"><option value="read">只读</option><option value="write">项目内修改</option></select></label>
        {actions("核对派工")}</>}
    </fieldset></form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
