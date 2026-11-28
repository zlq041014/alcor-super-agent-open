import React, { useRef, useState } from "react";
import type { Artifact, Run, Task } from "../shared/contracts";
import { resultEvidence } from "../shared/result-evidence";

type Options = { evidenceHash: string; devices: { id: string; name: string; grantVersion: string }[]; artifacts: { id: string; name: string }[] };

export function MobileDelivery({ task, run, files, request }: {
  task: Task; run: Run; files: Artifact[]; request: (value: unknown) => Promise<any>;
}) {
  const [options, setOptions] = useState<Options>(), [device, setDevice] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [pending, setPending] = useState(false), [status, setStatus] = useState("");
  const retry = useRef<{ choice: string; id: string } | undefined>(undefined);
  const current = task.runId === run.id && task.revision === run.revision && run.state === "ended" &&
    run.outcome === "completed" && !!run.response && ["verifying", "done"].includes(task.state);
  if (!current) return null;

  async function load() {
    setPending(true);
    setStatus("");
    try {
      const result: Options = await request({ action: "delivery-devices", taskId: task.id, runId: run.id });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(resultEvidence(run, files))));
      if (Array.from(digest, n => n.toString(16).padStart(2, "0")).join("") !== result.evidenceHash)
        throw new Error("交付版本已变化，请重新打开结果");
      setOptions(result);
    } catch (error) { setStatus((error as Error).message); }
    finally { setPending(false); }
  }

  async function send() {
    if (!options || !device) return;
    const grantVersion = options.devices.find(d => d.id === device)!.grantVersion;
    setPending(true);
    setStatus("");
    const choice = JSON.stringify([device, grantVersion, selected, options.evidenceHash]);
    if (retry.current?.choice !== choice) retry.current = { choice, id: crypto.randomUUID() };
    try {
      await request({ action: "delivery-send", id: retry.current.id, deviceId: device, taskId: task.id, runId: run.id,
        evidenceHash: options.evidenceHash, grantVersion, artifacts: selected });
      setOptions(undefined);
      setStatus("已为这台手机保存；手机同步后可以打开。");
    } catch (error) { setStatus((error as Error).message); }
    finally { setPending(false); }
  }

  return <section aria-label="带到手机">
    {options ? <fieldset className="profile-picker" disabled={pending}>
      <legend>带到手机 · 第 {run.revision} 版</legend>
      {options.devices.length ? <><label>接收手机<select value={device} onChange={e => setDevice(e.target.value)}>
        <option value="">选择一台手机</option>
        {options.devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select></label><p className="field-help">带上本回合的交付正文，可另选文本产物。</p>
      {options.artifacts.map(f => <label key={f.id}><input type="checkbox" checked={selected.includes(f.id)}
        disabled={!selected.includes(f.id) && selected.length === 8}
        onChange={e => setSelected(e.target.checked ? [...selected, f.id] : selected.filter(id => id !== f.id))} /> {f.name}</label>)}
      <button type="button" className="primary" disabled={!device} onClick={() => void send()}>确认分享</button>
      </> : <p className="field-help">没有共享此项目的已配对手机。</p>}
      <button type="button" onClick={() => { setOptions(undefined); setDevice(""); setSelected([]); setStatus(""); }}>关闭</button>
    </fieldset> : <button type="button" disabled={pending} onClick={() => { setDevice(""); setSelected([]); void load(); }}>
      {pending ? "正在核对…" : "带到手机"}
    </button>}
    {status && <p role="status">{status}</p>}
  </section>;
}
