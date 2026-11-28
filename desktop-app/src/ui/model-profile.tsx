import React, { useEffect, useId, useState } from "react";
import "./model-profile.css";
import { RefreshCw } from "lucide-react";
import {
  CHIEF_MODEL,
  MEMBER_MODEL,
  EffortSchema,
  type ModelProfile,
  type ModelEntry,
  type Snapshot,
  type ExecutorBackend,
  apiTarget,
} from "../shared/contracts";
export const effortName = (e: string) => (e === "default" ? "后端默认" : e);
export function ProfilePicker({
  beforeLoad,
  s,
  backend,
  value,
  onChange,
}: {
  beforeLoad?: () => Promise<unknown>;
  s: Snapshot;
  backend: "api" | ExecutorBackend;
  value: ModelProfile;
  onChange: (p: ModelProfile) => void;
}) {
  const uid = useId(),
    [custom, setCustom] = useState(false),
    [loading, setLoading] = useState(false),
    [msg, setMsg] = useState(""),
    [fresh, setFresh] = useState<ModelEntry[]>();
  const target = apiTarget(s.settings);
  useEffect(() => {
    setFresh(undefined);
    setMsg("");
  }, [backend, s.settings.apiSource, target.endpoint, target.protocol, s.settings.dshPath, s.settings.codexPath, s.settings.codexCredentialEnv]);
  const entries =
    backend === "api" ? fresh ?? s.models.ids.map(id => ({ id, efforts: [] })) : s.executorModels?.[backend]?.entries ?? [];
  const ids = [
    ...new Set(
      [
        value.model,
        ...(backend === "api" ? [CHIEF_MODEL, MEMBER_MODEL] : []),
        ...entries.map((m) => m.id),
      ].filter(Boolean),
    ),
  ];
  const caps = entries.find((m) => m.id === value.model)?.efforts || [],
    available = caps.length
      ? [...new Set(["default", ...caps])]
      : backend === "api" && s.settings.apiSource === "deepseek"
        ? ["default", "none", "low", "high", "max"]
        : EffortSchema.options;
  const unsupported = !available.includes(value.effort);
  return (
    <fieldset className="profile-picker">
      <legend>
        {backend === "codex"
          ? "Codex 执行模型"
          : backend === "dsh"
            ? "DSH 执行模型"
            : "API 对话模型"}
      </legend>
      <div className="form-grid">
        <label htmlFor={uid + "m"}>
          模型
          <select
            id={uid + "m"}
            aria-label="Agent 模型"
            value={custom ? "@custom" : value.model}
            onChange={(e) => {
              setMsg("");
              if (e.target.value === "@custom") {
                setCustom(true);
                return;
              }
              onChange({ ...value, model: e.target.value });
            }}
          >
            {ids.map((id) => (
              <option key={id}>{id}</option>
            ))}
            <option value="@custom">输入其他模型 ID…</option>
          </select>
        </label>
        <label htmlFor={uid + "e"}>
          思考强度
          <select
            id={uid + "e"}
            aria-label="思考强度"
            value={value.effort}
            onChange={(e) =>
              onChange({ ...value, effort: EffortSchema.parse(e.target.value) })
            }
          >
            {unsupported && (
              <option value={value.effort} disabled>
                {value.effort}（模型不支持）
              </option>
            )}
            {available.map((e) => (
              <option key={e} value={e}>
                {effortName(e)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {custom && (
        <label>
          自定义模型 ID
          <input
            required
            aria-label="自定义模型 ID"
            value={value.model}
            maxLength={120}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
          <button
            type="button"
            className="inline-link"
            onClick={() => setCustom(false)}
          >
            返回模型列表
          </button>
        </label>
      )}
      <div className="profile-hint">
        <button
          type="button"
          className="inline-link"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await beforeLoad?.();
              const models: ModelEntry[] = await window.alcor.request({
                op: "agent.models",
                backend,
              });
              if (backend === "api") setFresh(models);
              setMsg("已读取 " + models.length + " 个模型");
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        >
          <RefreshCw size={12} />
          {loading ? "正在读取…" : "读取可用模型"}
        </button>
        <small>
          {unsupported
            ? "请选择该模型支持的强度。"
            : msg ||
              (!entries.length
                ? "可读取当前连接的模型目录。"
                : "可用性以实际调用为准。")}
        </small>
      </div>
    </fieldset>
  );
}
