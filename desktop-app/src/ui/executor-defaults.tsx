import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import { executorProfile, type ExecutorBackend, type Snapshot } from "../shared/contracts";

const sources = ["codex", "dsh"] as const;
const names = { codex: "Codex", dsh: "DSH" };
const optionKey = (source: ExecutorBackend, model: string) => source + "/" + model;

export function ExecutorDefaults({ settings, catalogs, blocked, request, refresh, saving, saved }: {
  settings: Snapshot["settings"];
  catalogs: Snapshot["executorModels"];
  blocked: Record<ExecutorBackend, boolean>;
  request: (input: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  saving: (busy: boolean) => void;
  saved: (source: ExecutorBackend) => void;
}) {
  const [busy, setBusy] = useState<"read" | "save">();
  const [issue, setIssue] = useState("");
  const source = settings.executorBackend;
  const profile = executorProfile(settings, source);
  const groups = busy === "read" ? [] : sources.flatMap(backend => {
    const { state, catalogVersion, entries } = catalogs[backend];
    return !blocked[backend] && state === "available" && catalogVersion ? [{ backend, catalogVersion, entries }] : [];
  });
  const choices = new Map(groups.flatMap(({ backend, catalogVersion, entries }) =>
    entries.map(model => [optionKey(backend, model.id), { backend, catalogVersion, model }] as const)));
  const available = choices.has(optionKey(source, profile.model));
  const unverified = blocked[source] || busy === "read" || catalogs[source].state === "unread";
  const hint = busy === "read" ? "正在读取已配置的执行端…" : available ? "仅用于新工作。" :
    unverified ? "读取目录后可选择。" : "当前模型无法从目录核实，请重新选择。";

  async function update(action: "read" | "save", key?: string) {
    setIssue("");
    setBusy(action);
    if (action === "save") saving(true);
    try {
      if (action === "read") {
        const outcome = await Promise.allSettled(sources.filter(backend => !blocked[backend])
          .map(backend => request({ op: "executor.models", backend })));
        await refresh();
        const failed = outcome.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      } else {
        const choice = choices.get(key!);
        if (!choice) return;
        const { backend, model, catalogVersion } = choice;
        const effort = executorProfile(settings, backend).effort;
        await request({ op: "executor.modelDefault", backend, catalogVersion,
          profile: { model: model.id, effort: model.efforts.includes(effort) ? effort : "default" } });
        await refresh();
        saved(backend);
      }
    } catch (error) {
      setIssue((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
      if (action === "save") await refresh();
    } finally {
      if (action === "save") saving(false);
      setBusy(undefined);
    }
  }

  return <div className="workbench-executor-defaults">
    <div className="workbench-pref-row">
      <div><label htmlFor="workspace-executor-model">新工作执行模型</label>
        <p id="workspace-executor-model-hint" aria-live="polite">{hint}</p></div>
      <select id="workspace-executor-model" aria-describedby="workspace-executor-model-hint"
        disabled={!!busy || !groups.length} value={available ? optionKey(source, profile.model) : ""}
        onChange={event => void update("save", event.target.value)}>
        {!available && <option value="" disabled>{names[source]} · {profile.model}{unverified ? "（待核实）" : "（不可用）"}</option>}
        {groups.map(({ backend, entries }) => <optgroup key={backend} label={names[backend]}>
          {entries.map(model => <option key={model.id} value={optionKey(backend, model.id)}>{names[backend]} · {model.id}</option>)}
        </optgroup>)}
      </select>
    </div>
    <div className="workbench-executor-model-status">
      <div aria-live="polite">{sources.map(backend => {
        const catalog = catalogs[backend];
        return <p key={backend}>{names[backend]} · {blocked[backend] ? "连接设置未保存" :
          catalog.state === "unread" ? "待读取" : catalog.state === "available" ? `${catalog.entries.length} 个模型` :
            catalog.state === "empty" ? "没有返回模型" : catalog.issue || "暂不可用"}</p>;
      })}</div>
      <button type="button" disabled={!!busy || sources.every(backend => blocked[backend])} onClick={() => void update("read")}>
        <RefreshCw size={13} aria-hidden="true" />{busy === "read" ? "正在读取…" : "读取执行模型"}
      </button>
    </div>
    {busy === "save" && <p role="status" className="field-help">正在保存新工作的默认模型…</p>}
    {issue && <p role="alert" className="field-help">{issue}</p>}
  </div>;
}
