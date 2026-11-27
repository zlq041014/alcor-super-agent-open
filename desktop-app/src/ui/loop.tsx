import React, { useEffect, useState } from "react";
import { userCommand } from "../core/check-policy";
import type { Settings, Snapshot, Task } from "../shared/contracts";
import type { GraphView, GraphWait } from "../shared/native-graph";
import { editResearch, emptyResearch, ResearchFieldsForm, researchModes, researchResult, researchSourceStatus, researchValue } from "./research";
import {
  CriterionInput,
  type Check,
  type CriterionChange,
  type Finding,
  type MissEntry,
  type MissCategory,
  type LearnedCheckEntry,
  type CriterionInput as ItemInput,
  Advance,
  CheckInput,
  CheckRun,
  Criterion,
  LoopBudget,
} from "../shared/loop-contracts";
import "./loop.css";
import { roleLabels } from "./agents";

export type CheckChoice = {
  input: CheckInput;
  policy: { allowed: boolean; rule: string };
};
export type LoopFields = {
  criteria: string;
  command: string;
  file: string;
  contains: string;
  selected?: string[];
};
export const emptyLoopFields: LoopFields = {
  criteria: "",
  command: "",
  file: "",
  contains: "",
};
export function loopTaskValue(fields: LoopFields, choices: CheckChoice[]) {
  const loopChecks: CheckInput[] = [];
  if (fields.command.trim())
    loopChecks.push(userCommand("自填命令", fields.command));
  if (fields.file.trim())
    loopChecks.push({
      kind: "file",
      name: "交付文件",
      path: fields.file.trim(),
      contains: fields.contains,
    });
  const checks = [
    ...(fields.selected ??
      choices.filter((c) => c.policy.allowed).map((c) => c.input.name)),
    ...loopChecks.map((c) => c.name),
  ];
  const titles = fields.criteria
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (titles.length && checks.length > 10)
    throw new Error("每个条目最多关联 10 项检查，请减少所选检查");
  return {
    loopChecks,
    selectedChecks: fields.selected,
    criteria: titles.map((title) => ({ title, checks })),
  };
}

export function AdvanceSelect({
  value,
  onChange,
  description,
}: {
  value: Advance;
  onChange: (value: Advance) => void;
  description?: string;
}) {
  return (
    <label>
      {description || "推进模式"}
      <select
        aria-label={description || "推进模式"}
        value={value}
        onChange={(e) => onChange(e.target.value as Advance)}
      >
        <option value="single">单次</option>
        <option value="loop-native">循环推进</option>
      </select>
    </label>
  );
}

export function LoopCreate({
  fields,
  change,
  choices,
  state,
}: {
  fields: LoopFields;
  change: (f: LoopFields) => void;
  choices: CheckChoice[];
  state: string;
}) {
  const selected =
    fields.selected ??
    choices.filter((c) => c.policy.allowed).map((c) => c.input.name);
  return (
    <div className="loop-form">
      <label>
        验收清单（每行一项）
        <textarea
          rows={3}
          value={fields.criteria}
          onChange={(e) => change({ ...fields, criteria: e.target.value })}
          placeholder="留空时根据目标整理验收清单"
        />
      </label>
      <fieldset className="loop-checks">
        <legend>发现的项目检查</legend>
        {state && (
          <p className="field-help" role="status">
            {state}
          </p>
        )}
        {!state && !choices.length && (
          <p className="field-help">没有发现检查，可以填写命令或文件条件。</p>
        )}
        {choices.map(({ input, policy }) => (
          <label className="check-label" key={input.name}>
            <input
              type="checkbox"
              disabled={!policy.allowed}
              checked={policy.allowed && selected.includes(input.name)}
              onChange={(e) =>
                change({
                  ...fields,
                  selected: e.target.checked
                    ? [...selected, input.name]
                    : selected.filter((n) => n !== input.name),
                })
              }
            />
            <span>
              {input.name}
              {!policy.allowed && <small> · {policy.rule}</small>}
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        自填检查命令
        <input
          value={fields.command}
          onChange={(e) => change({ ...fields, command: e.target.value })}
          placeholder="可选，例如 npm run test"
        />
      </label>
      <div className="form-grid">
        <label>
          待检查文件
          <input
            value={fields.file}
            onChange={(e) => change({ ...fields, file: e.target.value })}
            placeholder="项目内相对路径（可选）"
          />
        </label>
        <label>
          文件应包含
          <input
            value={fields.contains}
            onChange={(e) => change({ ...fields, contains: e.target.value })}
            placeholder="留空只检查存在"
          />
        </label>
      </div>
    </div>
  );
}

const phase = {
  contracting: "正在定约",
  baseline: "建立基线",
  advancing: "推进与验证",
  reviewing: "找问题与分诊",
  closing: "最终核对",
  closed: "已收口",
  halted: "已停止",
};
const statuses: Record<Criterion["status"], string> = {
  pending: "待处理",
  in_progress: "处理中",
  passed: "已通过",
  failed: "未通过",
  stale: "需要重验",
  blocked: "受阻",
  waived: "已豁免",
};
const outcomes: Record<NonNullable<CheckRun["outcome"]>, string> = {
  passed: "通过",
  failed: "未通过",
  timeout: "超时",
  environment: "环境错误",
  unstable: "结果不稳定",
};
type Request = (input: object) => Promise<any>;

function EditCriterion({
  initial,
  checks,
  save,
  cancel,
}: {
  initial?: ItemInput;
  checks: Check[];
  save: (value: ItemInput) => Promise<void>;
  cancel: () => void;
}) {
  const [value, set] = useState(
    initial ?? {
      title: "",
      detail: "",
      necessity: "required" as const,
      method: "command" as const,
      checks: [],
      points: "",
    },
  );
  const [busy, setBusy] = useState(false);
  const write = (patch: Partial<ItemInput>) =>
    set((current) => ({ ...current, ...patch }));
  return (
    <form
      className="loop-criterion"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void save(CriterionInput.parse(value)).finally(() => setBusy(false));
      }}
    >
      <label>
        条目名称
        <input
          value={value.title}
          maxLength={300}
          required
          onChange={(event) => write({ title: event.target.value })}
        />
      </label>
      <label>
        交付说明
        <textarea
          value={value.detail}
          rows={2}
          maxLength={4000}
          onChange={(event) => write({ detail: event.target.value })}
        />
      </label>
      <label>
        需要程度
        <select
          value={value.necessity}
          onChange={(event) =>
            write({ necessity: event.target.value as ItemInput["necessity"] })
          }
        >
          <option value="required">必需</option>
          <option value="optional">可选</option>
        </select>
      </label>
      <label>
        验收方式
        <select
          value={value.method}
          onChange={(event) =>
            write({
              method: event.target.value as ItemInput["method"],
              checks: [],
              needsAuthoredCheck: false,
            })
          }
        >
          <option value="command">程序检查</option>
          <option value="file">文件检查</option>
          <option value="judge">独立评审</option>
          <option value="user">本人验收</option>
        </select>
      </label>
      {value.method !== "user" && (
        <fieldset>
          <legend>关联检查</legend>
          {checks
            .filter(
              (check) =>
                value.method === "judge" || check.input.kind === value.method,
            )
            .map((check) => (
              <label key={check.id}>
                <input
                  type="checkbox"
                  disabled={check.status !== "authorized"}
                  checked={value.checks.includes(check.input.name)}
                  onChange={(event) =>
                    write({
                      checks: event.target.checked
                        ? [...value.checks, check.input.name]
                        : value.checks.filter(
                            (name) => name !== check.input.name,
                          ),
                    })
                  }
                />
                {check.input.name}
              </label>
            ))}
        </fieldset>
      )}
      {value.method === "command" && (
        <label>
          <input
            type="checkbox"
            checked={!!value.needsAuthoredCheck}
            onChange={(event) =>
              write({ needsAuthoredCheck: event.target.checked })
            }
          />
          先补验收测试
        </label>
      )}
      {value.needsAuthoredCheck && value.method === "command" && (
        <label>
          新测试应验证
          <textarea
            value={value.checkIntent || ""}
            rows={2}
            maxLength={4000}
            onChange={(event) => write({ checkIntent: event.target.value })}
          />
        </label>
      )}
      {value.method === "judge" && (
        <label>
          评审要点（每行一个）
          <textarea
            value={value.points}
            rows={3}
            maxLength={4000}
            onChange={(event) => write({ points: event.target.value })}
          />
        </label>
      )}
      <div className="button-row">
        <button
          type="submit"
          disabled={busy || !value.title.trim() || value.checks.length > 10}
        >
          保存条目
        </button>
        <button type="button" onClick={cancel}>
          取消编辑
        </button>
      </div>
    </form>
  );
}

function CheckResult({
  row,
  name,
  request,
}: {
  row: CheckRun;
  name: string;
  request: Request;
}) {
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  return (
    <details
      className="loop-output"
      onToggle={(e) => {
        if (
          !e.currentTarget.open ||
          !row.outputRef ||
          text !== undefined ||
          loading
        )
          return;
        setLoading(true);
        void request({ op: "check.output", id: row.id })
          .then(setText, (e) => setText((e as Error).message))
          .finally(() => setLoading(false));
      }}
    >
      <summary>
        {name} ·{" "}
        {row.outcome
          ? outcomes[row.outcome]
          : row.state === "running"
            ? "运行中"
            : row.state === "unknown"
              ? "未知"
              : "已停止"}
      </summary>
      {row.exitCode !== undefined && (
        <small>
          退出码 {row.exitCode} · {row.durationMs} ms
        </small>
      )}
      <pre>{text ?? (loading ? "正在读取…" : "暂无输出")}</pre>
    </details>
  );
}

const findingStates: Record<Finding["status"], string> = {
  proposed: "已提出",
  invalid_evidence: "证据无效",
  duplicate: "已合并",
  refuted: "已反驳",
  unverified: "未核实",
  confirmed: "已确认",
  queued: "已加入清单",
  deferred: "已搁置",
  fixed: "已修复",
  declined: "已豁免",
};
function FindingDetails({
  item,
  criteria,
  findings,
}: {
  item: Finding;
  criteria: Criterion[];
  findings: Finding[];
}) {
  const target = criteria.find((c) => c.id === item.criterionId);
  const duplicate = findings.find((f) => f.id === item.duplicateOf);
  return (
    <details className="loop-output">
      <summary>
        {item.rank ? "#" + item.rank + " · " : ""}
        {item.title} · {findingStates[item.status]}
      </summary>
      <p>
        第 {item.round} 轮 · {item.lens} ·{" "}
        {{ blocker: "阻塞", major: "主要", minor: "轻微" }[item.severity]}
      </p>
      <p>{item.claim}</p>
      <p>影响：{item.impact}</p>
      {item.reason && <p>{item.reason}</p>}
      {target && (
        <p>
          条目：{target.input.title} · {statuses[target.status]}
        </p>
      )}
      {duplicate && <p>合并到：{duplicate.title}</p>}
      {item.evidence.map((ref, index) => (
        <div key={index} className="loop-check-info">
          {ref.kind === "file" ? (
            <>
              <small>{ref.path}</small>
              <pre>{ref.quote}</pre>
            </>
          ) : ref.kind === "check-run" ? (
            <>
              <small>实际检查回执</small>
              <pre>{ref.excerpt}</pre>
            </>
          ) : ref.kind === "criterion" ? (
            <small>
              条目：{criteria.find((c) => c.id === ref.id)?.input.title}
            </small>
          ) : (
            <pre>{ref.text}</pre>
          )}
        </div>
      ))}
    </details>
  );
}

const missCategories: Record<MissCategory, string> = {
  contract: "清单漏项", check: "检查没有覆盖", review: "评审没有发现",
  triage: "发现被排在后面", implementation: "通过检查但实现有误",
};

function MissAttribution({ item, correct }: {
  item: MissEntry;
  correct: (category: MissCategory | undefined, revision: number) => Promise<void>;
}) {
  const attr = item.attribution!;
  const [category, setCategory] = useState<MissCategory | "">(attr.category ?? "");
  const labels = {
    pending: "等待归因", calling: "正在归因", derived: "候选待回放",
    none: "没有可派生的候选", failed: "归因未完成", paused: "归因待继续",
  };
  return (
    <>
      <p>{labels[attr.state]}{attr.category ? " · " + missCategories[attr.category] : ""}</p>
      {attr.reason && <p>{attr.reason}</p>}
      {attr.candidate && <p>候选：{attr.candidate}</p>}
      {item.replay?.reason && <p>{item.replay.reason}</p>}
      {["paused", "failed"].includes(attr.state) && (
        <button onClick={() => void correct(undefined, attr.revision)}>继续归因</button>
      )}
      {attr.state !== "pending" && (
        <div className="button-row">
          <label>
            归因分类
            <select value={category} onChange={(event) => setCategory(event.target.value as MissCategory | "")}>
              <option value="">选择分类</option>
              {Object.entries(missCategories).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <button disabled={!category} onClick={() => { if (category) void correct(category, attr.revision); }}>
            按此分类重新归因
          </button>
        </div>
      )}
    </>
  );
}

function MissFeedback({ task, revision, request, run }: {
  task: Task;
  revision: number;
  request: Request;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<MissEntry[]>([]);
  const waiting = items.some((item) => item.attribution?.state === "pending" || item.attribution?.state === "calling" ||
    item.replay?.state === "pending" || item.replay?.state === "calling");
  useEffect(() => {
    let alive = true;
    const load = () => run(async () => {
      const saved: MissEntry[] = await request({ op: "miss.list", id: task.id });
      if (alive) setItems(saved);
    });
    void load();
    const refresh = waiting ? setInterval(() => void load(), 1000) : undefined;
    return () => { alive = false; clearInterval(refresh); };
  }, [task.id, waiting]);
  return (
    <details>
      <summary>漏检反馈{items.length ? " · " + items.length : ""}</summary>
      <label>
        哪个问题本应发现却没有发现？
        <textarea
          aria-label="漏检提醒"
          value={text}
          maxLength={4000}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            setRequestId(crypto.randomUUID());
          }}
        />
      </label>
      <button disabled={busy || !text.trim()} onClick={async () => {
        setBusy(true);
        try {
          const saved: MissEntry | undefined = await run(() => request({
            op: "miss.record", id: task.id, taskRevision: task.revision,
            revision, requestId, text,
          }));
          if (saved) {
            setItems((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
            setText("");
            setRequestId(crypto.randomUUID());
          }
        } finally {
          setBusy(false);
        }
      }}>
        {busy ? "正在登记…" : "登记漏检"}
      </button>
      {items.map((item) => (
        <div key={item.id} className="loop-check-info">
          <p>{item.text}</p>
          <small>
            工作 v{item.taskRevision} · 清单 v{item.contractRevision} · {
              item.materialStatus === "frozen" ? "已保存交付材料" : item.materialReason
            }
          </small>
          {item.attribution && (
            <MissAttribution key={item.id + ":" + item.attribution.revision} item={item} correct={async (category, revision) => {
              const saved: MissEntry | undefined = await run(() => request({
                op: "miss.attribute", id: item.id, category, revision,
              }));
              if (saved) setItems((current) => current.map((row) => row.id === saved.id ? saved : row));
            }} />
          )}
        </div>
      ))}
    </details>
  );
}

export function LearnedCheckCard({ item, project, open, request, run }: {
  item: LearnedCheckEntry;
  project: string;
  open: () => void;
  request: Request;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [edit, setEdit] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const state = {
    pending: "等待回放", waiting: "缺少历史材料", calling: "正在回放",
    passed: item.enabled ? "生效中" : "已停用", rejected: "未通过回放", paused: "回放暂停",
  }[item.replay.state];
  const apply = (action: string, text?: string) =>
    run(() => request({ op: "miss.manage", id: item.id, revision: item.revision, action, text }));
  return (
    <article className={`memory-card ${!item.enabled ? "disabled" : ""}`}>
      <div className="memory-heading"><span>{project}</span><span className="badge">{state}</span></div>
      <p>{item.text}</p>
      {item.replay.reason && <small>{item.replay.reason}</small>}
      <details><summary>漏检来源</summary><p>{item.reminder}</p><button onClick={open}>打开原工作</button></details>
      {edit !== undefined && <label>项目检查提示
        <textarea value={edit} maxLength={400} onChange={(e) => setEdit(e.target.value)} />
      </label>}
      <div className="card-actions">
        {edit !== undefined ? <>
          <button disabled={!edit.trim()} onClick={async () => { if (await apply("edit", edit)) setEdit(undefined); }}>保存并重跑回放</button>
          <button onClick={() => setEdit(undefined)}>取消编辑</button>
        </> : <>
          {item.editable && <button onClick={() => setEdit(item.text)}>编辑检查</button>}
          {item.replay.state === "passed" && <button onClick={() => void apply(item.enabled ? "disable" : "enable")}>
            {item.enabled ? "停用检查" : "启用检查"}
          </button>}
          {["waiting", "paused", "rejected"].includes(item.replay.state) &&
            <button onClick={() => void apply("retry")}>重跑回放</button>}
          {deleting ? <>
            <button className="danger-text" onClick={() => void apply("delete")}>确认删除检查与提醒</button>
            <button onClick={() => setDeleting(false)}>取消删除</button>
          </> : <button className="danger-text" onClick={() => setDeleting(true)}>删除检查</button>}
        </>}
      </div>
    </article>
  );
}

export function LoopDetails({
  task,
  snapshot,
  request,
  run,
}: {
  task: Task;
  snapshot: Snapshot;
  request: Request;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const loop = snapshot.loops.find((l) => l.id === task.loopId);
  const [add, setAdd] = useState(1);
  const [minutes, setMinutes] = useState(10);
  const [editing, setEditing] = useState<string>();
  if (!loop) return null;
  const criteria = snapshot.criteria
    .filter((c) => c.loopId === loop.id)
    .sort((a, b) => a.order - b.order);
  const checks = snapshot.checks.filter((c) => c.loopId === loop.id);
  const rows = snapshot.checkRuns.filter((r) => r.loopId === loop.id);
  const findings = snapshot.findings
    .filter((item) => item.loopId === loop.id)
    .sort(
      (a, b) =>
        b.round - a.round || (a.rank ?? Infinity) - (b.rank ?? Infinity),
    );
  const report = loop.report;
  const calls = loop.budget.spent.executorRuns;
  const available = task.state !== "cancelled" && !task.archived;
  const change = (entry: CriterionChange) =>
    run(() =>
      request({
        op: "loop.revise",
        id: task.id,
        revision: loop.contractRevision,
        changes: [entry],
      }),
    );
  const save = (item: ItemInput) =>
    change(
      editing === "new"
        ? { action: "add", value: item }
        : { action: "edit", id: editing!, value: item },
    ).then((result) => {
      if (result) setEditing(undefined);
    });
  return (
    <section className="loop-panel">
      <h3>推进循环 · {phase[loop.phase]}</h3>
      <p>
        {loop.mode === "loop-native" ? "原生回合" : "清单 v" + loop.contractRevision + " · 执行"} {calls} /{" "}
        {loop.budget.limits.executorRuns} 回合 · 墙钟上限{" "}
        {loop.budget.limits.wallMinutes} 分钟
      </p>
      {loop.mode === "loop-native" && task.reason && <p role="status">{task.reason}</p>}
      {loop.mode === "loop-improve" && (
        <p>
          改进轮 {loop.reviewedRounds ?? 0} / {loop.budget.limits.improveRounds}
        </p>
      )}
      {loop.contract && (
        <details>
          <summary>定约依据</summary>
          <p>{loop.contract.understanding}</p>
          {loop.contract.outOfScope.length > 0 && (
            <p>不在范围内：{loop.contract.outOfScope.join("、")}</p>
          )}
          {loop.contract.fallback && <p>定约退化：{loop.contract.fallback}</p>}
          {loop.assumptions.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </details>
      )}
      {task.state !== "paused" &&
        task.state !== "cancelled" &&
        loop.phase === "advancing" &&
        loop.step?.state === "running" &&
        (loop.step.kind === "author" || loop.step.kind === "judge") && (
          <p role="status">
            {loop.step.kind === "author" ? "正在编写验收检查" : "正在独立评审"}
            ：
            {criteria.find((item) => item.id === loop.step?.criterionId)?.input
              .title ?? task.title}
          </p>
        )}
      {report && (
        <div className="loop-report">
          <h3>收口报告</h3>
          {report.blockedRequired.length > 0 && (
            <ul>
              {report.blockedRequired.map((c) => (
                <li key={c.criterionId}>
                  {criteria.find((x) => x.id === c.criterionId)?.input.title}：
                  {c.reason}
                </li>
              ))}
            </ul>
          )}
          {report.judgedOnly.length > 0 && (
            <p>仅凭评审通过：{report.judgedOnly.join("、")}</p>
          )}
          {report.assumptions.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {report.deferredFindings.length > 0 && (
            <ul>
              {findings
                .filter((item) => report.deferredFindings.includes(item.id))
                .map((item) => (
                  <li key={item.id}>
                    搁置：{item.title} · {item.reason}
                  </li>
                ))}
            </ul>
          )}
          {report.preexistingPasses.length > 0 && (
            <p>{report.preexistingPasses.length} 个条目在基线时已通过。</p>
          )}
          {report.unavailableChecks.length > 0 && (
            <p>未运行或不可用：{report.unavailableChecks.join("、")}</p>
          )}
          {report.unrestoredFiles.length > 0 && (
            <p>未能安全回退：{report.unrestoredFiles.join("、")}</p>
          )}
          <small>
            拒绝写入 {report.rejectedWrites} 次 · 已知{" "}
            {report.usage.tokensKnown} token · {report.usage.unknownUsageCalls}{" "}
            次请求用量未知
          </small>
          {!!report.roleUsage?.length && (
            <details>
              <summary>各角色用量</summary>
              <ul>
                {report.roleUsage.map((usage) => (
                  <li key={usage.role}>
                    {roleLabels[usage.role] ?? usage.role}：{usage.calls} 次 ·
                    已知 {usage.tokensKnown} token · {usage.unknown}{" "}
                    次请求用量未知
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.outcome === "awaiting_user" && (
            <button
              className="primary"
              onClick={() =>
                void run(() =>
                  request({
                    op: "task.control",
                    action: "accept",
                    id: task.id,
                    revision: task.revision,
                  }),
                )
              }
            >
            {loop.mode === "loop-native" ? "验收交付" : "验收需判断的条目"}
            </button>
          )}
          {loop.mode !== "loop-native" && <MissFeedback
            key={task.revision + ":" + loop.contractRevision}
            task={task}
            revision={loop.contractRevision}
            request={request}
            run={run}
          />}
        </div>
      )}
      {loop.mode !== "loop-native" && available && editing === undefined && (
        <button onClick={() => setEditing("new")}>新增验收条目</button>
      )}
      {available && editing === "new" && (
        <EditCriterion
          key={loop.contractRevision + ":new"}
          checks={checks}
          save={save}
          cancel={() => setEditing(undefined)}
        />
      )}
      {criteria.map((c) => {
        const runs = checks
          .filter((check) => c.verify.checkIds.includes(check.id))
          .map((check) => ({
            check,
            row: rows.findLast(
              (row) =>
                row.checkId === check.id &&
                (c.passed?.checkRunIds.length
                  ? c.passed.checkRunIds.includes(row.id)
                  : row.purpose !== "author-before" &&
                    row.purpose !== "author-after" && row.purpose !== "candidate"),
            ),
          }));
        const authorProof = rows.find((row) => row.id === c.author?.beforeFail);
        return (
          <article className="loop-criterion" key={c.id}>
            <strong>{c.input.title}</strong>
            <small>
              {c.input.necessity === "required" ? "必需" : "可选"} ·{" "}
              {statuses[c.status]} · {c.attempts} 次尝试
              {c.passed &&
                (c.passed.grade === "program"
                  ? " · 程序证据"
                  : c.passed.grade === "judged"
                    ? c.passed.checkRunIds.length
                      ? " · 程序检查及独立评审"
                      : " · 独立评审"
                    : " · 用户验收")}
            </small>
            {c.input.detail && <p>{c.input.detail}</p>}
            {c.sourceQuote && <small>需求原话：{c.sourceQuote}</small>}
            {c.splitFrom && <small>源自：{criteria.find((row) => row.id === c.splitFrom)?.input.title}</small>}
            {c.escalation?.stage === "split-parent" && <small>子条目通过后仍需重新验收此条。</small>}
            {c.assumption && <small>含规划假设</small>}
            {c.blockedReason && <p>{c.blockedReason}</p>}
            {c.review?.detail && <p>{c.review.detail}</p>}
            {c.escalation?.diagnosis && (
              <details>
                <summary>诊断与备选做法</summary>
                {c.escalation.diagnosis.causes.map((cause, i) => <p key={i}>{cause}</p>)}
                {c.escalation.diagnosis.approaches.map((item) => (
                  <p key={item.title}><strong>{item.title}：</strong>{item.plan}</p>
                ))}
              </details>
            )}
            {c.escalation?.fallback && <small>直接用新会话重试：{c.escalation.fallback}</small>}
            {c.escalation?.advisor && <p>顾问{c.escalation.advisor.actualModel ? " · " + c.escalation.advisor.actualModel : ""}：{c.escalation.advisor.plan}</p>}
            {snapshot.candidates.filter((candidate) => candidate.criterionId === c.id).map((candidate) => (
              <details key={candidate.id}>
                <summary>{candidate.approach} · {{
                  running: "候选运行中", rejected: "未通过", passed: "检查通过", integrating: "正在整合",
                  selected: "已整合", discarded: "未选用", unknown: "结果未知",
                }[candidate.status]}</summary>
                {candidate.reason && <p>{candidate.reason}</p>}
                {rows.filter((row) => candidate.checkRunIds.includes(row.id)).map((row) => (
                  <CheckResult key={row.id} row={row} name={checks.find((c) => c.id === row.checkId)?.input.name || "候选检查"} request={request} />
                ))}
                {candidate.diff && <pre>{candidate.diff}</pre>}
              </details>
            ))}
            {c.author?.path && (
              <>
                <small>已保护的验收检查：{c.author.path}</small>
                {authorProof && (
                  <CheckResult
                    row={authorProof}
                    name="采纳前的失败检查"
                    request={request}
                  />
                )}
              </>
            )}
            {runs.map(({ check, row }) =>
              row ? (
                <CheckResult
                  key={row.id}
                  row={row}
                  name={check.input.name}
                  request={request}
                />
              ) : (
                <small key={check.id}>
                  {check.input.name} · {check.policyRule}
                </small>
              ),
            )}
            {available &&
              ["passed", "waived", "blocked"].includes(c.status) && (
                <button
                  onClick={() =>
                    void run(() =>
                      request({
                        op: "loop.revise",
                        id: task.id,
                        revision: loop.contractRevision,
                        changes: [{ action: "reopen", id: c.id }],
                      }),
                    )
                  }
                >
                  重开条目
                </button>
              )}
            {available && editing === undefined && (
              <div className="button-row">
                <button onClick={() => setEditing(c.id)}>编辑条目</button>
                {c.status !== "waived" && (
                  <button
                    onClick={() => void change({ action: "waive", id: c.id })}
                  >
                    豁免条目
                  </button>
                )}
              </div>
            )}
            {available && editing === c.id && (
              <EditCriterion
                key={loop.contractRevision + ":" + c.id}
                initial={{
                  ...c.input,
                  method: c.verify.method,
                  checks: checks
                    .filter((check) => c.verify.checkIds.includes(check.id))
                    .map((check) => check.input.name),
                }}
                checks={checks}
                save={save}
                cancel={() => setEditing(undefined)}
              />
            )}
          </article>
        );
      })}
      {findings.length > 0 && (
        <section aria-label="改进发现" className="loop-report">
          <h3>改进发现</h3>
          {findings.map((item) => (
            <FindingDetails
              key={item.id}
              item={item}
              criteria={criteria}
              findings={findings}
            />
          ))}
        </section>
      )}
      {checks.length > 0 && (
        <details>
          <summary>全部检查</summary>
          {checks.map((check) => {
            const row = rows.findLast((item) => item.checkId === check.id);
            return (
              <div className="loop-check-info" key={check.id}>
                <small>
                  {check.input.name} · {check.policyRule}
                  {check.baseline
                    ? " · 基线：" +
                      {
                        passed: "通过",
                        failed: "既有失败",
                        unavailable: "不可用",
                      }[check.baseline]
                    : ""}
                </small>
                {row && (
                  <CheckResult
                    key={row.id}
                    row={row}
                    name={check.input.name}
                    request={request}
                  />
                )}
              </div>
            );
          })}
        </details>
      )}
      {available && loop.halt?.reason === "budget" && (
        <div className="loop-budget">
          <label>
            追加回合数
            <input
              type="number"
              min={0}
              max={200 - loop.budget.limits.executorRuns}
              value={add}
              onChange={(e) => setAdd(e.target.valueAsNumber)}
            />
          </label>
          <label>
            追加分钟数
            <input
              type="number"
              min={0}
              max={1440 - loop.budget.limits.wallMinutes}
              value={minutes}
              onChange={(e) => setMinutes(e.target.valueAsNumber)}
            />
          </label>
          <button
            disabled={!(add > 0 || minutes > 0)}
            onClick={() =>
              void run(() =>
                request({
                  op: "loop.budget",
                  id: task.id,
                  add: {
                    ...(add > 0 ? { executorRuns: add } : {}),
                    ...(minutes > 0 ? { wallMinutes: minutes } : {}),
                  },
                }),
              )
            }
          >
            追加预算并继续
          </button>
        </div>
      )}
    </section>
  );
}

const graphWait: Record<GraphWait, string> = {
  preview: "等待独立预览作业",
  input: "等待上游成果", resource: "等待独占资源", receipt: "回执待核对",
  budget: "等待额度", paused: "暂停", blocked: "受阻或已停止",
};

export function GraphDetails({
  task, snapshot, request, run,
}: {
  task: Task;
  snapshot: Snapshot;
  request: Request;
  run: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [view, setView] = useState<GraphView>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [researchFields, setResearchFields] = useState(emptyResearch);
  const [consumer, setConsumer] = useState("main");
  const [researchError, setResearchError] = useState("");
  const [editingResearch, setEditingResearch] = useState<{ key: string; revision: number }>();
  useEffect(() => {
    let current = true;
    request({ op: "graph.view", id: task.id }).then((value) => {
      if (current) { setView(value); setError(""); }
    }, (err: Error) => { if (current) setError(err.message); });
    return () => { current = false; };
  }, [task.id, snapshot, request]);
  if (error) return <p role="alert">{error}</p>;
  if (!view) return <p role="status">正在读取成果</p>;
  const title = new Map(view.nodes.map((node) => [node.key, node.title]));
  const reconcile = (runId?: string) => void run(() => request({
    op: "graph.reconcile", id: task.id, revision: task.revision, ...(runId && { runId }),
  }));
  const budget = (add: { executorRuns: number } | { wallMinutes: number }) => void run(() => request({
    op: "loop.budget", id: task.id, add,
  }));
  const assemblyLabels = { applying: "正在组合交付", unknown: "组合结果待核对",
    ready: "已组合", failed: "组合失败" };
  const previewLabels = {
    queued: "排队", dispatching: "正在启动", preparing: "准备中", running: "正在生成",
    stopping: "已请求停止，等候回执", unknown: "结果未知，设备和目录仍保留占用",
    completed: "已取得完成回执", stopped: "已停止", failed: "已失败",
  };
  const previewAction = (jobId: string, action: "stop" | "reconcile") => void run(() => request({
    op: "graph.preview", id: task.id, revision: task.revision, jobId, action,
  }));
  return <section className="loop-panel" aria-label="成果调度">
    <h3>成果调度</h3>
    <p>{view.spent} / {view.limits.runs} 回合 · 必需步骤还需 {view.minimum} 回合</p>
    <p>硬截止：{new Date(view.deadline).toLocaleString("zh-CN")} · 每回合最多 {view.limits.runMinutes} 分钟</p>
    {view.timing && <p>每 {view.timing.observeMinutes} 分钟核对一次进展；硬截止不延长。</p>}
    {task.state !== "cancelled" && !task.archived && view.nodes.length > 0 && task.state !== "done" &&
      <div className="button-row">
        <button onClick={() => budget({ executorRuns: 2 })}>追加 2 回合</button>
        <button onClick={() => budget({ wallMinutes: 10 })}>追加 10 分钟</button>
      </div>}
    {!task.archived && task.state !== "cancelled" &&
      (editingResearch || view.nodes.filter((node) => node.research).length < 4) &&
      <details open={editingResearch ? true : undefined}>
        <summary>{editingResearch ? "更新研究决定" : "登记研究决定"}</summary>
        <label>影响哪个成果
          <select value={consumer} disabled={!!editingResearch} onChange={(e) => setConsumer(e.target.value)}>
            {view.nodes.filter((node) => !node.research).map((node) =>
              <option key={node.key} value={node.key}>{node.title}</option>)}
          </select>
        </label>
        <ResearchFieldsForm fields={researchFields} set={setResearchFields} />
        {researchError && <p role="alert">{researchError}</p>}
        <button type="button" onClick={() => {
          let spec;
          try {
            spec = researchValue(researchFields,
              editingResearch?.key ?? "research-" + crypto.randomUUID().slice(0, 8), consumer);
            setResearchError("");
          } catch (err) {
            setResearchError((err as Error).message);
            return;
          }
          void run(async () => {
            const updated = await request({ op: "graph.research", id: task.id, revision: task.revision, spec,
              ...(editingResearch && { researchRevision: editingResearch.revision }) });
            setResearchFields(emptyResearch());
            setEditingResearch(undefined);
            return updated;
          });
        }}>保存研究决定</button>
        {editingResearch && <button type="button" onClick={() => {
          setResearchFields(emptyResearch());
          setEditingResearch(undefined);
        }}>取消编辑</button>}
      </details>}
    {view.nodes.map((node) => <article key={node.id} className="loop-criterion">
      <strong>{node.title} · v{node.revision}</strong>
      <p>
        {node.standard ? "质量标准" : node.research ? researchModes[node.research.mode] : node.required ? "必需成果" : "可选成果"} · {node.accepted
          ? node.research ? "证据可用" : "已独立验收" :
          node.attempt?.stopping ? "已请求停止，待回执" :
          node.waiting ? graphWait[node.waiting] :
          node.attempt ? node.attempt.role === "review" ? "独立复核中" :
            node.attempt.role === "research" ? "研究中" : "执行中" : "就绪"}
      </p>
      {node.outputs.length > 0 && <p>交付文件：{node.outputs.join("、")}</p>}
      {node.dependencies.length > 0 && <p>依赖：{node.dependencies.map((key) => title.get(key)).join("、")}</p>}
      {node.resources.length > 0 && <p>独占资源：{node.resources.join("、")}</p>}
      {node.blocked && <p>{node.blocked}</p>}
      {node.standard?.card && <details>
        <summary>查看标准卡</summary>
        <pre>{node.standard.card}</pre>
      </details>}
      {node.preview && <section aria-label="视频预览作业">
        <p>独立视频预览 · {previewLabels[node.preview.state]} · {node.preview.frames} / {node.preview.expected} 帧</p>
        <p>硬截止 {new Date(node.preview.hardAt).toLocaleTimeString("zh-CN")}
          {node.preview.observeAt && node.preview.state === "running" &&
            " · 下次核对 " + new Date(node.preview.observeAt).toLocaleTimeString("zh-CN")}
          {node.preview.requested && !["completed", "stopped", "failed"].includes(node.preview.state) && " · 已请求停止"}</p>
        {!["completed", "stopped", "failed"].includes(node.preview.state) && <div className="button-row">
          <button onClick={() => previewAction(node.preview!.id, "reconcile")}>核对预览回执</button>
          {!node.preview.requested && <button onClick={() => previewAction(node.preview!.id, "stop")}>停止预览作业</button>}
        </div>}
      </section>}
      {node.research && <details open={!!node.research.evidence}>
        <summary>研究决定与依据</summary>
        <p>影响：{title.get(node.research.consumer)} · 目标版本 {node.research.version}</p>
        {node.research.evidence && <>
          <p>{researchResult[node.research.evidence.status]}{!node.accepted &&
            node.research.evidence.status === "verified" ? "，待原生终态" : ""}</p>
          <p>小样：{node.research.evidence.sample.path} · {
            node.research.evidence.sample.state === "passed"
              ? "支持 " + (node.research.evidence.sample.route === "route-a" ? "路线 A" :
                node.research.evidence.sample.route === "route-b" ? "路线 B" : node.research.evidence.sample.route)
              : { ambiguous: "两条路线均命中", failed: "不通过", missing: "缺少文件" }[node.research.evidence.sample.state]
          }</p>
          {node.research.evidence.sources.map((source) => <p key={source.id}>
            <code>{source.url}</code> · {source.version} · {researchSourceStatus[source.outcome]}
            {source.viewedAt && " · " + new Date(source.viewedAt).toLocaleDateString("zh-CN")}
          </p>)}
          {node.research.evidence.finding && <>
            <p>建议：{node.research.evidence.finding.recommendation}</p>
            <p>适用条件：{node.research.evidence.finding.conditions}</p>
            <p>资料要点：{node.research.evidence.finding.fact}</p>
            {node.research.evidence.finding.citations.map((item, i) =>
              <blockquote key={i}>{item.id}：{item.quote}</blockquote>)}
            {node.research.evidence.finding.unresolved && <p>未决：{node.research.evidence.finding.unresolved}</p>}
          </>}
          <p>{node.research.use
            ? (node.research.use.disposition === "adopted" ? "已声明采纳：" : "未采纳：") + node.research.use.reason
            : "当前交付未声明采纳"}</p>
        </>}
      </details>}
      {node.research && !task.archived && task.state !== "cancelled" &&
        <button onClick={() => {
          setConsumer(node.research!.consumer);
          setResearchFields(editResearch(node.research!.spec));
          setResearchError("");
          setEditingResearch({ key: node.key, revision: node.revision });
        }}>更新这项研究</button>}
      {node.attempt?.turnId && <small>原生回合：{node.attempt.turnId}</small>}
      {node.attempt?.observation && <p>
        回合硬截止 {new Date(node.attempt.observation.hardAt).toLocaleTimeString("zh-CN")}
        {node.attempt.observation.stop
          ? " · " + (node.attempt.observation.stop === "hard" ? "已到硬截止" : "无新增进展") + "，已请求停止"
          : " · 下次核对 " + new Date(node.attempt.observation.observeAt).toLocaleTimeString("zh-CN")}
        {node.attempt.observation.latest && " · 最新证据：" +
          (node.attempt.observation.latest.kind === "frames"
            ? "完成 " + node.attempt.observation.latest.value + " 帧"
            : "核对 " + node.attempt.observation.latest.value + " 个新文件")}
      </p>}
      {node.attempt?.state === "unknown" && <button onClick={() => reconcile(node.attempt!.id)}>核对成果回执</button>}
      {!node.research && !task.archived && task.state !== "cancelled" && (editing === node.id ?
        <label>新的成果要求
          <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <button disabled={!instruction.trim()} onClick={() => void run(async () => {
            const changed = await request({
              op: "graph.revise", id: task.id, revision: task.revision, nodeId: node.id,
              nodeRevision: node.revision, instruction,
            });
            setEditing(undefined);
            return changed;
          })}>应用到此成果和下游</button>
          <button onClick={() => setEditing(undefined)}>收起</button>
        </label> : <button onClick={() => { setInstruction(""); setEditing(node.id); }}>调整此成果</button>)}
    </article>)}
    {view.assembly && <div className="loop-report">
      <h4>{assemblyLabels[view.assembly.state]}</h4>
      {view.assembly.failure && <p>{view.assembly.failure}</p>}
      {view.assembly.state === "unknown" && <button onClick={() => reconcile()}>只读核对组合结果</button>}
      {view.final && <p>{view.final.state === "accepted" ? "最终复核已通过" :
        view.final.state === "unknown" ? "最终复核回执待核对" : "正在独立复核组合交付"}</p>}
      {view.final?.state === "unknown" && <button onClick={() => reconcile(view.final!.runId)}>核对最终复核回执</button>}
      {view.finalFailure && <p>{view.finalFailure}</p>}
      {task.state === "verifying" && view.final?.state === "accepted" &&
        <button className="primary" onClick={() => void run(() => request({
          op: "task.control", id: task.id, revision: task.revision, action: "accept",
        }))}>验收组合交付</button>}
    </div>}
  </section>;
}

const settings: [keyof LoopBudget, string, number, number][] = [
  ["executorRuns", "执行回合上限", 1, 200],
  ["roleCalls", "角色调用上限", 0, 2000],
  ["roleConcurrency", "角色同时运行数", 1, 8],
  ["retries", "每项重试次数", 0, 5],
  ["wallMinutes", "墙钟时间上限（分钟）", 10, 1440],
  ["checkTimeoutSec", "单项检查超时（秒）", 10, 1800],
  ["criteria", "清单条目上限", 1, 100],
  ["improveRounds", "改进轮上限", 0, 5],
  ["findingsPerLens", "每个视角的发现上限", 1, 10],
  ["findingsPerRound", "每轮修复项上限", 1, 10],
  ["refutationsPerRound", "每轮反驳项上限", 0, 30],
  ["comparisonsPerRound", "每轮排序比较上限", 0, 200],
];
export function LoopSettings({
  value,
  onChange,
}: {
  value: Settings;
  onChange: (settings: Settings) => void;
}) {
  const [paths, setPaths] = useState(value.checkPath.join("\n"));
  return (
    <section className="settings-section">
      <div className="section-title">
        <div>
          <h2>推进循环</h2>
          <p>执行与复核 Agent 使用原生 DSH 工具，星引负责衔接回合。</p>
        </div>
      </div>
      <AdvanceSelect
        description="默认推进模式"
        value={value.defaultAdvance === "single" ? "single" : "loop-native"}
        onChange={(defaultAdvance) => onChange({ ...value, defaultAdvance })}
      />
      <label>
        收口方式
        <select
          value={value.loopCloseMode}
          onChange={(e) =>
            onChange({
              ...value,
              loopCloseMode: e.target.value as Settings["loopCloseMode"],
            })
          }
        >
          <option value="auto">通过后自动收口</option>
          <option value="review-judged">包含独立评审时留待验收</option>
        </select>
      </label>
      <div className="form-grid">
        {settings.map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              value={value.loopBudget[key]}
              onChange={(e) =>
                onChange({
                  ...value,
                  loopBudget: {
                    ...value.loopBudget,
                    [key]: e.target.valueAsNumber,
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <label>
        顾问模型（可选）
        <input value={value.advisorModel} maxLength={120} placeholder="留空时不启用顾问"
          onChange={(e) => onChange({ ...value, advisorModel: e.target.value })} />
        <small>仅在此前升级步骤都未解决时使用；继续沿用当前 API 和成员强度。</small>
      </label>
      <label>
        检查程序目录（每行一个，可选）
        <textarea
          rows={3}
          value={paths}
          onChange={(e) => {
            setPaths(e.target.value);
            onChange({
              ...value,
              checkPath: e.target.value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean),
            });
          }}
        />
      </label>
    </section>
  );
}
