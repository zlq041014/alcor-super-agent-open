import React, { useState } from "react";
import type { ReuseItem, ReuseRef, Run, Snapshot, Task } from "../shared/contracts";

type Request = (value: unknown) => Promise<any>;
type ProjectOption = { id: string; name: string };
const refOf = ({ id, version, versionId }: ReuseRef) => ({ id, version, versionId });
const errorText = (error: unknown) => (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
const labels = { used: "确认采用", "not-used": "未采用", counterexample: "不适用 · 反例" };

function Projects({ items, selected = [] }: { items: ProjectOption[]; selected?: string[] }) {
  return <fieldset><legend>可采用的项目</legend>{items.map(p => <label key={p.id}>
    <input type="checkbox" name="projects" value={p.id} defaultChecked={selected.includes(p.id)} /> {p.name}
  </label>)}</fieldset>;
}

export function SaveReuse({ snapshot, task, run, request, refresh }: {
  snapshot: Snapshot; task: Task; run: Run; request: Request; refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  if (task.state !== "done" || run.id !== task.runId || run.revision !== task.revision || run.outcome !== "completed" || !run.response.trim()) return null;
  const items = snapshot.reuseItems?.filter(item => item.projectId === task.projectId) ?? [];
  const projects = snapshot.projects.filter(p => !p.removed && p.available !== false);
  return <section aria-label="留给下次">
    {!open ? <button type="button" onClick={() => { setOpen(true); setNotice(""); }}>留给下次</button> :
      <form onSubmit={e => {
        e.preventDefault();
        const form = new FormData(e.currentTarget), field = (name: string) => String(form.get(name) ?? "");
        const prior = items.find(item => item.id === field("prior"));
        setBusy(true); setNotice("");
        void request({ op: "reuse.publish", taskId: task.id, runId: run.id, title: field("title"), condition: field("condition"),
          excerpt: field("excerpt"), projectIds: form.getAll("projects"), requestId: crypto.randomUUID(),
          ...(prior ? { id: prior.id, revision: prior.revision } : {}) }).then(async result => {
          if (!result.id) throw new Error(result.error ?? "未留用");
          await refresh(); setOpen(false); setNotice("已把指定文字留到留用架。");
        }).catch(error => setNotice(errorText(error))).finally(() => setBusy(false));
      }}><fieldset className="profile-picker" disabled={busy}>
        <legend>留用这次的文字</legend>
        {items.length > 0 && <label>条目<select name="prior"><option value="">新条目</option>{items.map(item =>
          <option key={item.id} value={item.id}>{item.title} · 第 {item.version} 版</option>)}</select></label>}
        <label>留用标题<input name="title" required maxLength={100} /></label>
        <label>适用条件<textarea name="condition" required maxLength={1000} /></label>
        <label>只保留这段原文<textarea name="excerpt" required maxLength={6000} defaultValue={run.response.trim().length <= 6000 ? run.response.trim() : ""} /></label>
        {run.response.trim().length > 6000 && <details><summary>查看可选的回合原文</summary><p className="launch-goal">{run.response}</p></details>}
        <Projects items={projects} selected={[task.projectId]} />
        <div className="button-row"><button type="submit" className="primary">保存到留用架</button><button type="button" onClick={() => setOpen(false)}>取消</button></div>
      </fieldset></form>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function ReuseLibrary({ snapshot, request, refresh, showLaunch, openTask }: {
  snapshot: Snapshot; request: Request; refresh: () => Promise<void>; showLaunch: (result: any) => Promise<void>; openTask: (task: Task) => void;
}) {
  const [selected, setSelected] = useState(""), [details, setDetails] = useState<{ text: string; taskId: string; runId: string; versionId: string }>(),
    [action, setAction] = useState<"scope" | "apply">(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const items = snapshot.reuseItems ?? [], item = items.find(entry => entry.id === selected);
  const projects = snapshot.projects.filter(p => !p.removed && p.available !== false);
  const targets = projects.filter(p => item?.projectIds.includes(p.id));
  const origin = snapshot.tasks.find(t => t.id === details?.taskId);
  const uses = snapshot.reuseUses?.filter(u => u.ref.id === item?.id) ?? [];
  function open(entry: ReuseItem) {
    setSelected(entry.id); setAction(undefined); setDetails(undefined); setError(""); setBusy(true);
    void request({ op: "reuse.inspect", ref: refOf(entry) }).then(value => setDetails({ ...value, versionId: entry.versionId }))
      .catch(e => setError(errorText(e))).finally(() => setBusy(false));
  }
  return <section className="page" aria-label="跨项目留用">
    <h1>留用架</h1>
    <p>已验收的文字按版本带到指定项目。</p>
    {!items.length && <p>还没有跨项目留用内容。可以从已验收的结果选择「留给下次」。</p>}
    <ul>{items.map(entry => <li key={entry.id}><button type="button" disabled={busy} aria-pressed={item?.id === entry.id}
      onClick={() => open(entry)}>{entry.title} · 第 {entry.version} 版{!entry.active && " · 已停用"}</button></li>)}</ul>
    {item && details && details.versionId !== item.versionId && <p role="status">版本已变化，请重新打开条目。</p>}
    {item && details?.versionId === item.versionId && <section aria-label={item.title}>
      <h2>{item.title} · 第 {item.version} 版</h2><p>{item.condition}</p><p className="launch-goal">{details.text}</p>
      {origin && <button type="button" onClick={() => openTask(origin)}>打开原工作</button>}
      <p>可采用：{targets.map(p => p.name).join("、") || "无"}</p>
      <div className="button-row"><button type="button" disabled={busy} onClick={() => setAction("scope")}>编辑授权</button>
        {item.active && targets.length > 0 && <button type="button" disabled={busy} onClick={() => setAction("apply")}>用于新工作</button>}</div>
      {uses.length > 0 && <ul>{uses.map(u => <li key={u.id}>第 {u.ref.version} 版 · {labels[u.outcome]}{u.note ? `：${u.note}` : ""}</li>)}</ul>}
    </section>}
    {item && action && details?.versionId === item.versionId && <form key={action + item.id + item.revision} onSubmit={e => {
      e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError("");
      const job = action === "scope" ? request({ op: "reuse.scope", id: item.id, revision: item.revision, projectIds: form.getAll("projects"), active: form.has("active") }) :
        request({ op: "task.create", requestId: crypto.randomUUID(), value: { projectId: form.get("project"), goal: form.get("goal"),
          acceptance: form.get("acceptance"), mode: form.get("mode"), access: "project", advance: "single", reuse: [refOf(item)] } }).then(showLaunch);
      void job.then(async () => { await refresh(); setAction(undefined); }).catch(e => setError(errorText(e))).finally(() => setBusy(false));
    }}><fieldset className="profile-picker" disabled={busy}>
      <legend>{action === "scope" ? "编辑授权" : "使用此版本准备单次工作"}</legend>
      {action === "scope" ? <><label><input name="active" type="checkbox" defaultChecked={item.active} /> 允许新工作使用</label>
        <Projects items={projects} selected={item.projectIds} /></> : <>
        <label>目标项目<select name="project" defaultValue="" required><option value="">选择项目</option>
          {targets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>工作目标<textarea name="goal" required maxLength={24000} /></label><label>验收条件<textarea name="acceptance" required maxLength={12000} /></label>
        <label>文件权限<select name="mode"><option value="read">只读</option><option value="write">项目内修改</option></select></label>
      </>}
      <div className="button-row"><button type="submit" className="primary">{action === "scope" ? "保存授权" : "核对派工"}</button>
        <button type="button" onClick={() => setAction(undefined)}>取消</button></div>
    </fieldset></form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function RecordReuse({ snapshot, task, run, request, refresh }: {
  snapshot: Snapshot; task: Task; run: Run; request: Request; refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const refs = run.reuseInputs;
  if (!refs?.length || run.id !== task.runId || run.revision !== task.revision) return null;
  return <section aria-label="留用记录"><h3>本回合留用版本</h3>{refs.map(ref => {
    const used = snapshot.reuseUses?.find(row => row.taskId === task.id && row.ref.versionId === ref.versionId);
    return <div key={ref.versionId}>
      <p>{snapshot.reuseItems?.find(item => item.id === ref.id && item.versionId === ref.versionId)?.title ?? "已选择的留用内容"} · 第 {ref.version} 版 · {used ? labels[used.outcome] : "尚无采用确认"}</p>
      {!used && task.state === "done" && run.turnId && <form onSubmit={e => {
        e.preventDefault(); setPending(true); setError(""); const form = new FormData(e.currentTarget);
        void request({ op: "reuse.record", taskId: task.id, runId: run.id, ref: refOf(ref), outcome: form.get("outcome"),
          note: form.get("note") }).then(refresh).catch(e => setError(errorText(e))).finally(() => setPending(false));
      }}><fieldset className="profile-picker" disabled={pending}><legend>核对实际采用结果</legend>
        <label>结果<select name="outcome">{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>依据或不适用原因<textarea name="note" maxLength={2000} /></label><button type="submit">记录结果</button>
      </fieldset></form>}
    </div>;
  })}{error && <p role="alert">{error}</p>}</section>;
}
