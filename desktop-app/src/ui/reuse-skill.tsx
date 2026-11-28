import React, { useRef, useState } from "react";
import type { ExecutorBackend, Project, ReuseItem, ReuseRef, SkillCatalog, SkillMatch, SkillSource } from "../shared/contracts";

type Request = (value: unknown) => Promise<any>;
const backends: { id: ExecutorBackend; name: string }[] = [{ id: "codex", name: "Codex" }, { id: "dsh", name: "DSH" }];
const host = (id: ExecutorBackend) => backends.find(backend => backend.id === id)!.name;
const scopeLabels: Record<SkillSource["scope"], string> = { repo: "项目", user: "用户", system: "系统", admin: "管理员" };
const matchLabels: Record<SkillMatch, string> = {
  listed: "目标宿主报告了同一来源。执行能力未核对。",
  "tool-requirements": "目标宿主报告了同一来源，但还有工具要求未核对。",
  "not-listed": "目标项目未报告同一来源。",
  "catalog-unavailable": "目标宿主没有返回完整目录。",
  "different-host": "目标宿主与原来源不同。",
  unsupported: "此宿主没有提供可核对的 Skill 目录。",
};
const errorText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");

export function RegisterSkill({ projects, request, refresh, item }: {
  projects: Project[]; request: Request; refresh: () => Promise<void>; item?: ReuseItem;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(item?.projectId ?? "");
  const [revision, setRevision] = useState(item?.revision);
  const [backend, setBackend] = useState<ExecutorBackend>("codex");
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const retry = useRef<{ body: string; id: string }>(undefined);
  return <section aria-label={item ? "更新 Skill 引用" : "登记 Skill 引用"}>
    <button type="button" disabled={busy} aria-expanded={open} onClick={() => {
      if (!open) { setRevision(item?.revision); setCatalog(undefined); setMessage(""); }
      setOpen(!open);
    }}>
      {item ? "登记新版 Skill 引用" : "登记 Skill 引用"}
    </button>
    {open && <form onSubmit={e => {
      e.preventDefault();
      if (busy) return;
      const data = new FormData(e.currentTarget);
      const value = { op: "reuse.publishSkill", projectId, backend, skillId: data.get("skill"),
        title: data.get("title"), condition: data.get("condition"), reference: data.get("reference"), projectIds: data.getAll("projects"),
        ...(item && { id: item.id, revision }) };
      const body = JSON.stringify(value);
      if (retry.current?.body !== body) retry.current = { body, id: crypto.randomUUID() };
      setBusy(true); setError(""); setMessage("");
      void request({ ...value, requestId: retry.current.id }).then(async saved => {
        if (!saved.id) {
          retry.current = undefined;
          throw new Error(saved.error ?? "Skill 引用未保存");
        }
        retry.current = undefined;
        await refresh();
        setOpen(false); setMessage("已保存 Skill 引用。");
      }).catch(e => setError(errorText(e))).finally(() => setBusy(false));
    }}><fieldset className="profile-picker" disabled={busy}>
      <legend>从实际宿主核对来源</legend>
      <label>来源项目<select aria-label="来源项目" required value={projectId} disabled={!!item} onChange={e => {
        setProjectId(e.target.value); setCatalog(undefined); setError("");
      }}><option value="">选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>来源宿主<select aria-label="来源宿主" value={backend} onChange={e => {
        setBackend(e.target.value as ExecutorBackend); setCatalog(undefined); setError("");
      }}>{backends.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <button type="button" disabled={!projectId} onClick={() => {
        setBusy(true); setCatalog(undefined); setError("");
        void request({ op: "reuse.skillCatalog", projectId, backend }).then(setCatalog)
          .catch(e => setError(errorText(e))).finally(() => setBusy(false));
      }}>读取 Skill 目录</button>
      {catalog?.state === "unsupported" ? <p role="status">此宿主没有提供可核对的 Skill 目录。</p> :
        catalog && !catalog.skills.length ? <p role="status">没有读到可登记的 Skill。</p> : null}
      {catalog?.state === "partial" && <p role="status">宿主只返回了部分目录。</p>}
      {!!catalog?.skills.length && <label>Skill<select aria-label="Skill" required name="skill" defaultValue="">
        <option value="">选择已启用的 Skill</option>
        {catalog.skills.map(s => <option key={s.id} value={s.id}>{s.name} · {scopeLabels[s.scope]}</option>)}
      </select></label>}
      <label>留用标题<input required name="title" maxLength={100} defaultValue={item?.title} /></label>
      <label>适用条件<textarea required name="condition" maxLength={1000} defaultValue={item?.condition} /></label>
      <label>参考文字<textarea required name="reference" maxLength={6000} /></label>
      <fieldset><legend>可参考的项目</legend>{projects.map(p => <label key={p.id}>
        <input type="checkbox" name="projects" value={p.id} defaultChecked={item?.projectIds.includes(p.id)} /> {p.name}
      </label>)}</fieldset>
      <p className="field-help">只分享你写的参考文字。星引不会复制或运行原 Skill。</p>
      <button type="submit" disabled={!catalog?.skills.length}>保存 Skill 引用</button>
      <button type="button" onClick={() => { setOpen(false); setError(""); }}>取消</button>
    </fieldset></form>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function SkillReferenceStatus({ skill, reference, targets, request, defaultBackend }: {
  skill: SkillSource; reference: ReuseRef; targets: Project[]; request: Request; defaultBackend: ExecutorBackend;
}) {
  const [projectId, setProjectId] = useState(targets.length === 1 ? targets[0].id : "");
  const [backend, setBackend] = useState(defaultBackend);
  const [state, setState] = useState<SkillMatch>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const project = targets.find(p => p.id === projectId);
  return <section aria-label="Skill 来源">
    <p>{host(skill.host)} · {skill.name} · {scopeLabels[skill.scope]} · 只作参考</p>
    {targets.length > 0 && <fieldset className="profile-picker" disabled={busy}>
      <legend>核对目标宿主</legend>
      <label>核对项目<select aria-label="核对项目" value={project?.id ?? ""} onChange={e => { setProjectId(e.target.value); setState(undefined); setError(""); }}>
        <option value="">选择已授权项目</option>{targets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label>目标宿主<select aria-label="目标宿主" value={backend} onChange={e => { setBackend(e.target.value as ExecutorBackend); setState(undefined); setError(""); }}>
        {backends.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></label>
      <button type="button" disabled={!project} onClick={() => {
        if (!project) return;
        setBusy(true); setState(undefined); setError("");
        void request({ op: "reuse.skillMatch", projectId: project.id, backend, ref: reference })
          .then(result => setState(result.state)).catch(e => setError(errorText(e))).finally(() => setBusy(false));
      }}>核对 Skill 来源</button>
      {project && state && <p role="status">{matchLabels[state]}</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>}
  </section>;
}
