# 推进循环实施指南

> 2026-11-24 状态：本指南仅用于核对既有桌面循环与历史工作包，不作为下一轮开发指令。当前开发顺序见[手机总管首版路线](roadmap.md#mobile-manager-v1)。

2026-11-21 新默认循环工作包：新建表单、总管按循环默认设置发起的工作使用原生编排；已创建的清单循环仍按记录运行。使用原 DSH ACP 派发、回执、暂停和历史，取消新路径上的星引文件工具裁剪、命令白名单和前置 JSON 审查。执行结束后，另启有同样原生工具的 Agent 检查实际成果；需继续时把复核原文交回下一轮。只有复核明确建议收口才自动完成；失败、未知回执和预算耗尽按实际状态记录。不使用旧文件工具的写前记录声称能回退原生工具的改动。

总管入口：用户直接说「循环推进 项目名：具体任务」就用这条消息创建原生循环，即使默认设为单次。总管复用本机项目选择和已有的幂等派发，项目明确时不新开讨论、不先调用模型定约。项目不明确时只问项目；用法询问、延期及明确只读的要求不触发全权限循环。

验收：新循环先出现执行记录；两种角色都能调用同一原生 PowerShell 工具；非 JSON 交接可以继续；修复后复核可以收口；未知回合不会重派；旧清单任务及单次流程回归通过。验证使用隔离项目。

> 类型：实施指南
> 状态：有效；L1、L2 已通过真实验收，L3 按工作包实现；默认仍是单次
> 更新：2026-11-20（Asia/Shanghai）
> 适用：`desktop-app`，以 0.1.8 源码为基线；面向实现推进循环 L0～L4 的开发者或执行 Agent

本文回答“怎么做、怎么验证”。“做什么、为什么”见[推进循环架构](advance-loop-architecture.md)；各角色的材料、输出和提示词见[角色契约](advance-loop-roles.md)；对照实验见[L0 实验规程](advance-loop-experiment.md)。本文对现有代码的描述来自 2026-11-19 对 0.1.8 源码的阅读；动手前先核对所引用的函数是否仍是文中描述的样子。

阅读入口：[用法](#usage)、[开发约定](#dev-conventions)、[改动地图](#change-map)、[数据契约](#contracts)、[推进引擎](#engine)、[检查](#checks)、[文件工具扩展](#file-tools)、[工作包](#work-packages)、[测试计划](#tests)、[界面](#ui)、[账本版本](#ledger)、[放行清单](#release)、[注意点](#pitfalls)、[度量](#metrics)。

<a id="usage"></a>

## 1. 怎样使用本文

- **按工作包顺序推进，一次一个。** 工作包的编号就是顺序。每个工作包结束时，仓库处于能通过全部检查的状态。
- **先读设计再动手。** 每个工作包列出了对应的架构章节。
- **与设计不一致时先改设计。** 实现中发现设计有缺陷或与现有代码冲突，先在架构文档或本文中记录原因和新的做法，再改代码。不在代码里悄悄偏离。
- **不需要找用户确认的事。** 架构文档[第 15.1 节](advance-loop-architecture.md#decisions)已经作出的决定、本文写明的做法、实现细节上的选择。
- **需要用户的事只有两件。** 真实模型实验和真实执行端验证的开工指令；推翻已作出的决定。

每个工作包都要满足下面的通用完成条件，另加各自小节里的专属条件：

1. `npm run typecheck` 通过。
2. `npm test` 通过，包含本工作包新增的用例；原有用例没有被删除，断言没有被放宽。
3. 涉及界面或入口时 `npm run build` 通过。
4. 单次模式的行为没有变化。
5. 需要真实执行端或模型的验证单独记录，不用模拟结果代替。
6. 受影响的文档已同步，验证结果已写入[开发路线](roadmap.md)。

<a id="dev-conventions"></a>

## 2. 开发环境与约定

环境与命令沿用[桌面端说明](../desktop-app/README.md)的“源码开发”一节，在 `desktop-app` 目录下执行：

```powershell
$env:Path = 'D:\dev\nodejs;' + $env:Path
$env:npm_config_cache = 'D:\cache\npm'
$env:ELECTRON_CACHE = 'D:\cache\electron'
npm ci
npm run typecheck
npm test
npm run build
```

- **模块边界。** `src/shared` 放运行时契约和类型；`src/core` 放纯策略，不引入 Node 文件系统、Electron 或模型接口；`src/hub` 放账本、模型调用、调度和进程；`src/adapter` 放原生协议；`src/ui` 放界面。循环的判断逻辑写成 `core` 里的纯函数，读写和进程放在 `hub`。
- **依赖。** 不新增运行时依赖。进程管理用 `node:child_process`，通配匹配和文本差异自行实现并配测试。
- **风格。** 沿用现有代码的 Prettier 格式和命名；契约一律用 Zod，并在入口做运行时校验。
- **测试。** 用例放在 `tests/*.test.ts`，使用 `node:test`，由 `node --import tsx --test tests/*.test.ts` 运行。临时目录建在 `desktop-app/.test-data/` 下，做法参照 [`tests/core.test.ts`](../desktop-app/tests/core.test.ts) 的 `fixture()`。
- **没有 Git。** 修改源码前，把将要改动的文件复制到 `.dev/advance-loop/<阶段>/before/` 并记录 SHA-256，做法与文档备份相同。
- **数据目录。** 测试和验证只使用隔离的数据目录。任何脚本都不指向用户的实时数据。
- **凭据。** 真实验证脚本从指定名称的环境变量读取密钥，写入隔离目录的 DPAPI 保管库，做法参照 [`scripts/live-file-check.ts`](../desktop-app/scripts/live-file-check.ts)。密钥不打印、不写入结果文件。
- **真实模型和执行端。** 需要用户的开工指令。记录所用版本、时间和证据目录；失败样本保留，不用后来的成功样本覆盖。
- **打包与升级用户数据。** 不属于各工作包。阶段放行后是否打包、是否切换用户数据，按用户当时的要求执行。

<a id="change-map"></a>

## 3. 改动地图

### 3.1 现有文件

| 文件与位置 | 现状（0.1.8） | 改动 | 阶段 |
| --- | --- | --- | --- |
| [`shared/contracts.ts`](../desktop-app/src/shared/contracts.ts) | 设置、任务输入、请求、记录类型；多数对象是 `.strict()` | 增加[第 4 节](#contracts)的契约 | L0 起 |
| [`hub/service.ts`](../desktop-app/src/hub/service.ts) `request` 的 `task.create` | 一律走 `launches.propose`。表单提交随后自动确认；对话发起的停在待确认卡 | 循环模式直接调用 `createTask`，不产生待确认记录 | L0 |
| 同文件 `createTask` | 一个事务内写入任务、Agent、意图、消息和幂等记录；初始状态“等待执行” | 同一事务内写入循环、条目和检查 | L0 |
| 同文件 `tick` | 每秒一次；回合超时处理；对“等待执行”的任务判断 `attempt >= maxRuns` 和 `canSchedule` 后派发 | 循环任务不做 `maxRuns` 判断，改问推进引擎是否需要写入者；把正在运行检查的工作区计入占用 | L0 |
| 同文件 `dispatch` | 创建回合和命令；续接同一任务上一个回合的会话；DSH 调用 `dsh.start` | 循环任务按引擎给出的选项决定是否新会话，并传入路径策略 | L0 |
| 同文件 `context` | 组装任务包 JSON，上限 100000 字符 | 循环任务增加 `loop` 段 | L0 |
| 同文件 `finishRun` | 回合结束后采集文件变化；任务进入“待验收”或“需要处理”；文件检查自动验收；向总管记一条 | 主事务之后把循环任务交给推进引擎，跳过文件检查分支和逐回合通知 | L0 |
| 同文件 `control` | 暂停、取消、继续、验收、核对 | 暂停和取消时通知引擎终止检查与角色调用；继续后让引擎重新选步 | L0 |
| 同文件 `task.revise` 分支 | 保存旧意图，修订号加一，停止旧回合 | 循环任务同时递增清单修订号并按修订规则处理条目；不把任务置为已暂停，旧回合结束后由引擎自动继续 | L0 |
| 同文件 `recover`、`snapshot`、`backup`、`restore`、`diagnostics` | 启动恢复、快照、备份恢复、诊断 | 纳入循环相关记录和副本 | L0 |
| [`hub/dsh-work.ts`](../desktop-app/src/hub/dsh-work.ts) `start` | 同路由、同规则版本时续接上一个 DSH 会话 | 增加强制新会话的参数；向 `openDsh` 传路径策略和镜像接收器 | L0 |
| [`adapter/dsh.ts`](../desktop-app/src/adapter/dsh.ts) `openDsh` | 把 `options` 直接交给 `dshModelRoute` 作为工作区参数 | 选项增加路径策略和镜像接收器并向下透传 | L0 |
| [`adapter/dsh-model.ts`](../desktop-app/src/adapter/dsh-model.ts) | 用 `workspaceMcp(cwd, write)` 建文件工具；模型响应只转发 | 传入新选项；L1 起从响应中取用量 | L0、L1 |
| [`adapter/dsh-files.ts`](../desktop-app/src/adapter/dsh-files.ts) `workspaceMcp` | 只区分只读和可写 | 写入前做路径策略判断；L1 起记录写前镜像 | L0、L1 |
| [`hub/agents.ts`](../desktop-app/src/hub/agents.ts) `finished`、`handoff` | 每个回合向总管记一条；对话交接走 `launches.propose` | 循环任务只在收口或停止时记一条；L1 起默认推进模式为循环时直接创建 | L0、L1 |
| [`hub/brain.ts`](../desktop-app/src/hub/brain.ts) | 单次补全；固定 90 秒超时；错误只有文字描述，没有结构化的状态字段 | 超时可配置；错误带上可识别的状态 | L1 |
| [`core/policy.ts`](../desktop-app/src/core/policy.ts) | 任务状态转移表和调度准入 | 增加“草稿”状态 | L1 |
| [`hub/store.ts`](../desktop-app/src/hub/store.ts) | `LEDGER_VERSION = 2`；从版本 1 升级前先备份 | 提升为 3，从版本 2 升级前先备份 | L0 |
| [`ui/app.tsx`](../desktop-app/src/ui/app.tsx) `TaskForm`、`TaskDetail`、`SettingsPage` | 创建表单只有一条文件检查；详情显示尝试次数和验收 | 推进模式、清单、检查、预算和报告 | L0 起 |
| [`ui/agents.tsx`](../desktop-app/src/ui/agents.tsx) | Agent 树和工作区 | 角色节点 | L1 |
| [`hub/workspaces.ts`](../desktop-app/src/hub/workspaces.ts) | 隔离工作区与整合；含未跟踪文件时要求人工整合 | 候选的隔离、选优后的整合 | L3 |

### 3.2 新增文件

| 文件 | 职责 | 阶段 |
| --- | --- | --- |
| `src/core/check-policy.ts` | 检查授权策略：脚本名和内容的判断、用户命令的解析、参数校验 | L0 |
| `src/core/glob.ts` | 通配匹配（`*`、`**`），大小写不敏感，路径统一为正斜杠 | L0 |
| `src/core/loop-policy.ts` | 选步函数、预算判断、无进展判断、条目选择 | L0 |
| `src/hub/check-discovery.ts` | 在项目内查找检查入口 | L0 |
| `src/hub/checks.ts` | 检查运行器：启动、限时、终止、输出保存、分类 | L0 |
| `src/hub/loop.ts` | 推进引擎：创建、选步、执行各类步骤、收口与报告 | L0 |
| `src/ui/loop.tsx`、`src/ui/loop.css` | 清单、检查输出、预算和报告的界面 | L0 |
| `scripts/loop-experiment.ts`、`scripts/loop-score.ts` | 对照实验的运行与评分 | L0 |
| `scripts/loop-live.ts` | 真实 DSH 加真实模型跑一次小循环 | L0 |
| `experiments/advance-loop/` | 实验任务集 | L0 |
| `src/hub/roles.ts` | 角色端口：材料包、调用、输出校验、修复一次、并发与退避 | L1 |
| `src/hub/contracting.ts` | 定约：规划、审查、程序校验、退化处理 | L1 |
| `src/hub/journal.ts` | 写前镜像、检查点、回退 | L1 |
| `src/core/diff.ts` | 由修改前后文本生成统一差异和增删行数 | L1 |
| `src/hub/evidence.ts` | 证据包与半成品扫描 | L2 |
| `src/hub/triage.ts` | 证据核对、聚类、反驳、排序、范围判定 | L2 |
| `src/hub/misses.ts` | 漏检登记、归因、派生、回放 | L4 |
| `tests/check-policy.test.ts`、`tests/checks.test.ts`、`tests/loop-policy.test.ts`、`tests/loop.test.ts` 等 | 见[测试计划](#tests) | L0 起 |

<a id="contracts"></a>

## 4. 数据契约

以下是契约草案。进入实现时在 `src/shared/contracts.ts` 中用 Zod 定义；字段名可以按现有命名习惯微调，语义不变。`Entity`、`ModelProfile`、`ProfileSchema` 沿用现有定义。

### 4.1 设置

`SettingsSchema` 新增的字段都带默认值，旧设置读入后自动补齐。

```ts
const LoopBudgetSchema = z
  .object({
    executorRuns: z.number().int().min(1).max(200).default(30),
    roleCalls: z.number().int().min(0).max(2000).default(200),
    retries: z.number().int().min(0).max(5).default(2),
    candidates: z.number().int().min(1).max(5).default(3),
    improveRounds: z.number().int().min(0).max(5).default(2),
    findingsPerLens: z.number().int().min(1).max(10).default(5),
    findingsPerRound: z.number().int().min(1).max(10).default(3),
    refutationsPerRound: z.number().int().min(0).max(30).default(10),
    comparisonsPerRound: z.number().int().min(0).max(200).default(40),
    wallMinutes: z.number().int().min(10).max(1440).default(180),
    roleConcurrency: z.number().int().min(1).max(8).default(4),
    criteria: z.number().int().min(1).max(100).default(40),
    checkTimeoutSec: z.number().int().min(10).max(1800).default(600),
  })
  .strict();

// SettingsSchema 新增
defaultAdvance: z.enum(["single", "loop", "loop-improve"]).default("single"),
loopCloseMode: z.enum(["auto", "review-judged"]).default("auto"),
loopBudget: LoopBudgetSchema.default({}),
checkPath: z.array(z.string().max(500)).max(8).default([]), // 检查进程 PATH 的追加目录
advisorModel: z.string().max(120).default(""), // 空表示没有顾问模型
```

### 4.2 任务输入与任务

```ts
const relPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !p.split(/[\\/]/).includes("..") && !/^[\\/]|^[A-Za-z]:/.test(p),
    "必须使用项目内相对路径",
  );

export const CheckInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      name: z.string().min(1).max(80),
      program: z.string().min(1).max(200),
      args: z.array(z.string().max(300)).max(20).default([]),
      cwd: relPath.default("."),
      timeoutSec: z.number().int().min(10).max(1800).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      name: z.string().min(1).max(80),
      path: relPath,
      contains: z.string().max(6000).default(""),
    })
    .strict(),
]);

export const CriterionInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    detail: z.string().max(4000).default(""),
    necessity: z.enum(["required", "optional"]).default("required"),
    method: z.enum(["command", "file", "judge", "user"]).default("command"),
    checks: z.array(z.string().max(80)).max(10).default([]), // 引用 loopChecks 里的 name
    points: z.string().max(4000).default(""), // 评审判定的要点
  })
  .strict();

// TaskInput 新增
advance: z.enum(["single", "loop", "loop-improve"]).optional(), // 缺省取设置里的默认值
criteria: z.array(CriterionInput).max(100).default([]),
loopChecks: z.array(CheckInput).max(20).default([]), // 用户亲自填写的检查
protect: z.array(z.string().max(300)).max(20).default([]), // 额外的受保护通配

// Task 新增
advance?: "single" | "loop" | "loop-improve"; // 缺省视为 single
loopId?: string;
```

创建时的规则：循环任务固定使用 DSH 执行端，不取设置里的执行端；只读任务不能使用循环模式；DSH 不可用或任务只读时拒绝创建并说明原因。L0 没有规划者，未给出条目时自动生成单一条目“完成用户目标”，检查取全部可用的检查。

L0 实现边界：循环固定使用项目原目录；`loop-improve` 直到 L2 才接受创建。循环专用集合省略时按空集合处理，使已保存的单次创建请求继续沿用原有内容摘要。表单可通过 `loop.discover` 只读预览候选，提交时可以省略自动发现的选择（默认全选），或携带 `selectedChecks`；创建时重新发现和授权，不能把预览结果当作执行权限。

### 4.3 请求

| 操作 | 载荷 | 用途 | 阶段 |
| --- | --- | --- | --- |
| `loop.view` | 任务标识 | 返回循环、条目、检查、最近的检查运行、发现和报告 | L0 |
| `loop.discover` | 项目标识 | 只读预览可选检查和策略结果 | L0 |
| `loop.revise` | 任务标识、期望的清单修订号、要新增、修改、豁免、重开的条目 | 用户修改清单；修订号不符时拒绝并要求刷新 | L0 |
| `loop.budget` | 任务标识、要追加的预算项 | 追加预算；因预算停止的循环随后继续 | L0 |
| `check.output` | 检查运行标识 | 读取保存的输出片段 | L0 |
| `miss.record` | 任务标识、用户原话 | 登记漏检样本 | L4 |

暂停、继续、取消沿用现有的 `task.control`。

### 4.4 记录

```ts
type RoleName =
  | "planner" | "contract-critic" | "check-author" | "executor" | "verifier"
  | "diagnoser" | "reviewer" | "triager" | "refuter" | "ranker" | "attributor" | "advisor";

interface Loop extends Entity {
  taskId: string;
  projectId: string;
  mode: "loop" | "loop-improve";
  phase:
    | "contracting" | "baseline" | "advancing" | "critiquing"
    | "triaging" | "closing" | "closed" | "halted";
  step?: {
    id: string; // 去重键，见第 5.3 节
    kind: "contract" | "baseline" | "author" | "execute" | "check" | "validate"
      | "rollback" | "critique" | "triage" | "close";
    criterionId?: string;
    attempt: number;
    level: number; // 升级阶梯的级别
    fresh: boolean; // 是否使用新会话
    state: "pending" | "running" | "done";
    runId?: string;
  };
  contractRevision: number;
  roster: Partial<Record<RoleName, ModelProfile>>; // 创建时从设置取得的快照
  closeMode: "auto" | "review-judged";
  budget: { limits: LoopBudget; spent: Record<string, number> };
  round: number; // 已进行的改进轮数
  blockedStreak: number; // 连续受阻的条目数
  protectedPaths: string[]; // 循环开始时展开得到的相对路径，加上后来写入的验收检查
  assumptions: string[];
  startedAt: string;
  halt?: {
    reason: "budget" | "no_progress" | "unknown_run" | "all_blocked";
    detail: string;
  };
  report?: LoopReport;
}

interface Criterion extends Entity {
  loopId: string;
  order: number;
  title: string;
  detail: string;
  source: "contract" | "finding" | "user" | "regression";
  sourceRef?: string; // 用户原话片段或发现标识
  assumption: boolean;
  necessity: "required" | "optional";
  verify: {
    method: "command" | "file" | "judge" | "user";
    checkIds: string[];
    needsAuthoredCheck: boolean;
    points?: string;
  };
  dependsOn: string[];
  status:
    | "pending" | "in_progress" | "passed" | "failed"
    | "stale" | "blocked" | "waived";
  attempts: number;
  noProgress: number; // 连续没有可验证进展的次数
  definitionHash: string;
  blockedReason?: string;
  passed?: {
    grade: "program" | "judged" | "user";
    checkRunIds: string[];
    workspaceVersion: string;
    invocationId?: string;
    at: string;
  };
}

interface Check extends Entity {
  projectId: string;
  loopId: string;
  name: string;
  kind: "command" | "file";
  command?: { program: string; args: string[]; cwd: string; timeoutSec: number };
  file?: { path: string; contains: string };
  origin: "existing" | "authored" | "user";
  status: "authorized" | "rejected" | "unavailable";
  policyRule: string; // 命中的策略规则，或“用户填写”
  bindingHash: string; // 命令行、解析到的脚本文本、检查配置
  baseline?: "passed" | "failed" | "unavailable";
}

interface CheckRun extends Entity {
  checkId: string;
  loopId: string;
  runId?: string; // 被检查的执行回合
  criterionIds: string[];
  purpose: "baseline" | "criterion" | "regression" | "final";
  workspaceVersion: string;
  state: "running" | "ended" | "unknown";
  outcome?: "passed" | "failed" | "environment" | "timeout" | "unstable";
  exitCode?: number;
  outputRef?: string;
  failureSignature?: string; // 归一化输出末段的哈希，用于判断是否有进展
  durationMs?: number;
}

interface FileJournal extends Entity {
  loopId: string;
  runId: string;
  seq: number;
  path: string; // 项目内相对路径
  action: "create" | "modify" | "mkdir";
  preRef?: string; // 修改前内容的副本；新建时为空
  postHash?: string;
  restored?: "done" | "skipped_external_change";
}

interface Checkpoint extends Entity {
  loopId: string;
  criterionId: string;
  uptoRunId: string;
  workspaceVersion: string;
}

interface Finding extends Entity {
  loopId: string;
  round: number;
  lens: string;
  title: string;
  claim: string;
  evidence: (
    | { kind: "file"; path: string; quote: string }
    | { kind: "check-run"; id: string; excerpt: string }
    | { kind: "criterion"; id: string }
    | { kind: "steps"; text: string }
  )[];
  impact: string;
  status:
    | "proposed" | "invalid_evidence" | "duplicate" | "refuted" | "unverified"
    | "confirmed" | "queued" | "deferred" | "fixed" | "declined";
  duplicateOf?: string;
  scope?: "reopen" | "in-goal" | "beyond-goal";
  rank?: number;
  criterionId?: string;
}

interface LoopReport {
  outcome: "completed" | "awaiting_user" | "halted";
  blockedRequired: { criterionId: string; reason: string }[];
  judgedOnly: string[]; // 仅凭评审判定通过的条目
  assumptions: string[];
  deferredFindings: string[];
  rejectedWrites: number;
  unavailableChecks: string[];
  unrestoredFiles: string[];
  usage: {
    executorRuns: number;
    roleCalls: number;
    tokensKnown: number;
    unknownUsageCalls: number;
    wallMs: number;
  };
}
```

`Candidate`（L3）和 `Miss`（L4）的字段在对应工作包中定义。角色调用沿用现有 `invocation` 记录，增加 `loopId`、`role`、`stepId`、`materials`（材料清单）、`outputValid` 字段。

新增的记录类型名：`loop`、`criterion`、`check`、`check-run`、`file-journal`、`checkpoint`、`finding`、`candidate`、`miss`。新增的事件名：`loop.created`、`loop.phase`、`loop.halted`、`loop.closed`、`criterion.passed`、`criterion.failed`、`criterion.blocked`、`check.authorized`、`check.rejected`、`write.rejected`、`rollback.applied`。

`Snapshot` 增加 `loops`、`criteria`、`checks`，以及有界的 `checkRuns` 和 `findings`（各取最近 300 条）。

<a id="engine"></a>

## 5. 推进引擎

对应架构[第 7 节](advance-loop-architecture.md#flow)、[第 10 节](advance-loop-architecture.md#budget)、[第 11 节](advance-loop-architecture.md#recovery)。

### 5.1 结构

`src/hub/loop.ts` 中的 `LoopEngine` 由 `Hub` 持有，接口如下：

```ts
class LoopEngine {
  create(task: Task, input: ParsedTaskInput): Loop; // 在 createTask 的事务内调用
  wantsWriter(taskId: string): boolean; // tick 的准入判断
  writerSection(task: Task): unknown; // context 取任务包的 loop 段
  writerOptions(task: Task): { fresh: boolean; paths: PathPolicy; journal?: JournalSink };
  onRunEnded(run: Run): Promise<void>; // finishRun 调用
  onControl(taskId: string, action: "pause" | "cancel" | "resume"): void;
  advance(loopId: string): Promise<void>; // 选步入口
  busyPaths(): string[]; // 正在运行检查的工作区
  recover(): void; // Hub 构造时调用
  resumeAll(): void; // Hub.start 调用
  tick(): void; // 墙钟预算、未知回合的自动核对
}
```

`advance` 对每个循环串行执行：用一个以循环标识为键的 Promise 链，做法与 `Hub.eventQueue` 相同。`advance` 内部反复“读账本、调用选步函数、执行一步”，直到选步函数返回等待、收口或停止。

### 5.2 选步函数

`src/core/loop-policy.ts` 导出纯函数 `decide(state)`。输入是循环、条目、当前步骤关联的回合与检查运行、任务状态和预算；输出是下一个动作。规则按顺序匹配，先命中先执行：

| 顺序 | 条件 | 动作 |
| --- | --- | --- |
| 1 | 任务为已暂停或已取消 | 等待 |
| 2 | 当前步骤有进行中的回合、检查或角色调用 | 等待 |
| 3 | 当前步骤的回合状态未知 | 尝试自动核对（L1）；核对不到则停止，原因是未知回合 |
| 4 | 任一预算项到界 | 当前条目有在途改动时先回退（L1），然后停止，原因是预算 |
| 5 | 阶段为定约中 | 执行定约（L1）；完成后进入基线 |
| 6 | 阶段为基线 | 运行全部检查并记录基线结果；完成后进入推进 |
| 7 | 当前步骤是执行，回合正常结束 | 运行条目检查和回归检查 |
| 8 | 当前步骤是执行，回合失败或被中断（不是用户暂停） | 记一次未通过，原因是执行失败；进入第 11 行 |
| 9 | 当前步骤是检查，条目检查全部通过且没有回归 | L0：标为通过。L1 起：交给验证者 |
| 10 | 当前步骤是验证，结论为可靠或通过 | 标为通过，记检查点，清空当前步骤 |
| 11 | 检查未通过、有回归，或验证者存疑 | 尝试次数加一；按升级阶梯决定带证据重试、换新会话重试，或标为受阻 |
| 12 | 没有当前步骤，存在可选的条目 | 选条目：回归导致未通过的最先，其余按清单顺序且依赖已通过。需要先写验收检查的派发检查编写者（L1），否则派发执行者 |
| 13 | 没有可选的条目，连续受阻的条目数达到 3 | 停止，原因是没有进展 |
| 14 | 没有可选的条目，必需条目全部通过，模式为循环并改进，改进轮未用尽 | 找问题，然后分诊（L2）；有新条目则回到第 12 行 |
| 15 | 其余 | 收口 |

升级阶梯在 L0 只有两级：带证据重试，用尽后受阻。L1 加入换新会话重试，L3 加入诊断者、候选、拆分和顾问模型。

执行回合预算只限制启动下一次写入，不中断已开始回合的验证和正常收口；墙钟预算覆盖检查。连续受阻达到 3 项后先停止再选新条目。发现回归时，已有条目失效并优先重查；没有对应条目的基线回归进入专门条目，由同一检查验证。

### 5.3 步骤记录与幂等

每个步骤的去重键是 `循环标识:清单修订号:步骤种类:条目标识:尝试次数` 的哈希，保存在 `Loop.step.id`。执行一步的固定顺序是：在一个事务里把步骤写成 `pending` 并更新阶段；开始时改为 `running`；结束时在一个事务里写入结果并把步骤改为 `done`。

- 重复唤醒时，`advance` 读到 `running` 的步骤就返回，不重复执行。
- 写入者步骤的执行就是把任务改回“等待执行”，由 `tick` 派发；`wantsWriter` 只在步骤为 `pending` 且种类是执行或编写检查时返回真。派发后步骤记下回合标识并改为 `running`。
- Hub 重启后，`recover` 把 `running` 的检查运行标为未知，把 `running` 的角色调用标为未知；`resumeAll` 对每个未结束的循环调用 `advance`，由选步函数决定重跑检查或重新调用角色。写入者回合按现有规则标为未知，不重派。

### 5.4 预算与无进展

- 每次派发写入者，`spent.executorRuns` 加一；每次角色调用，`spent.roleCalls` 加一；端点返回用量时累加 `spent.tokensKnown`，否则 `spent.unknownUsageCalls` 加一。
- 墙钟时间从循环创建起计算，由 `LoopEngine.tick` 检查。
- 一次尝试满足下面任一条件，记为没有可验证的进展：回合没有改动任何文件；未通过的检查与上一次相同且失败签名相同。连续两次没有进展，直接升一级。
- 条目受阻时 `blockedStreak` 加一，条目通过时清零。
- 追加预算通过 `loop.budget` 请求完成，已用量和失败记录保留。

### 5.5 与任务状态的衔接

| 时刻 | 任务状态的变化 | 说明 |
| --- | --- | --- |
| 创建循环任务（L0） | 创建为“等待执行”，原因写“正在运行基线检查” | 引擎的步骤不是写入者，`wantsWriter` 为假，`tick` 不派发 |
| 创建循环任务（L1 起） | 创建为“草稿” | 定约和基线期间保持草稿 |
| 选出条目并需要写入者 | 待验收或草稿改为等待执行 | 现有转移表已允许待验收到等待执行；草稿到等待执行为新增 |
| 派发 | 等待执行改为执行中 | 现有 `dispatch` |
| 回合结束 | 执行中改为待验收 | 现有 `finishRun`；原因写循环进度，例如“正在检查第 3 条” |
| 回合失败或被中断 | 执行中改为需要处理，随后由引擎按选步结果改回等待执行或保持 | 现有 `finishRun` 的行为不变；引擎把它记为一次未通过 |
| 收口，必需条目全部通过 | 待验收改为已完成 | 写入验收记录，方式为 `loop-contract`，证据为各条目的通过依据 |
| 收口，有用户判定的必需条目 | 保持待验收 | 用户用现有的验收操作完成 |
| 停止 | 待验收改为需要处理 | 原因写停止原因和报告入口 |
| 用户追加预算或点继续 | 需要处理改为等待执行，随后由引擎重新选步 | 现有 `control` 的继续分支之后调用 `advance` |

### 5.6 任务包的 `loop` 段

`context` 为循环任务在现有任务包里增加下面的结构。`machineChecks` 和 `correction` 两个字段对循环任务不使用。

```json
{
  "loop": {
    "criterion": { "title": "…", "detail": "…", "attempt": 2 },
    "checks": [{ "name": "test", "command": "npm run test", "cwd": "desktop-app" }],
    "passed": ["已通过条目的标题"],
    "protected": ["tests/core.test.ts", "package.json 的 scripts 部分"],
    "failure": { "check": "test", "exitCode": 1, "outputTail": "…", "verifier": "…" },
    "rules": [
      "只实现当前条目，不处理其他条目。",
      "受保护文件不能修改，写入会被拒绝。认为检查有误时，在最终答复中另起一行，以“检查异议：”开头说明理由。",
      "不要声称已通过检查。检查由系统运行。"
    ]
  }
}
```

失败输出只放末段，长度以整个任务包不超过上限为准；放不下时缩短输出，不删除条目和规则。

### 5.7 收口与报告

收口步骤依次做：在最终工作区上运行全部可用检查；重新判定待复核的条目（L1 起）；生成 `LoopReport`；按架构[第 7.6 节](advance-loop-architecture.md#closing)的表确定任务状态；向总管对话记一条带入口的消息。报告的首屏顺序固定为：未通过的必需条目、仅凭评审判定通过的条目、所作的假设、搁置的建议。

<a id="checks"></a>

## 6. 检查：发现、策略与运行

对应架构[第 9 节](advance-loop-architecture.md#check-runner)。

### 6.1 发现

`src/hub/check-discovery.ts` 只读查找检查入口：

- 查找位置是项目根目录。根目录没有任何清单文件时，再查直属子目录，最多 8 个，跳过点开头的目录和依赖、产物目录。找到清单文件的目录就是该检查的工作目录。
- Node：读取 `package.json` 的 `scripts`。存在 `pnpm-lock.yaml` 用 `pnpm`，存在 `yarn.lock` 用 `yarn`，否则用 `npm`。命令形如 `npm run <脚本名>`。
- 其他生态按下表的固定形态生成候选。

| 标志文件 | 候选命令 |
| --- | --- |
| `pyproject.toml`、`pytest.ini`，或 `tests` 目录下有 `test_*.py` | `python -m pytest` |
| `Cargo.toml` | `cargo check`、`cargo test` |
| `go.mod` | `go vet ./...`、`go test ./...` |
| `*.sln`、`*.csproj` | `dotnet build`、`dotnet test` |

<a id="check-policy-table"></a>

### 6.2 内置策略

`src/core/check-policy.ts` 对每个候选给出“允许”或“拒绝”以及命中的规则。拒绝规则优先。

| 规则 | 内容 |
| --- | --- |
| 允许的脚本名 | `test`、`typecheck`、`type-check`、`lint`、`check`、`build`、`verify`，以及这些词后面跟冒号的名字，例如 `test:unit` |
| 拒绝的脚本名 | 名字中含 `deploy`、`publish`、`release`、`start`、`dev`、`serve`、`watch`、`package`、`install`、`clean`、`fix`、`format`、`write` |
| 拒绝的脚本内容 | 脚本文本中含 `publish`、`deploy`、`git push`、`rm -rf`、`rmdir /s`、`del /s`、`shutdown` |
| 允许的固定形态 | `node --test`、`python -m pytest`、`cargo check`、`cargo test`、`go vet ./...`、`go test ./...`、`dotnet build`、`dotnet test` |
| 参数字符 | 只接受字母、数字和 `_ @ + = : , . / \ -`；含其他字符（包括空格、引号和 `%`）的参数使整条命令被拒绝 |
| 模型提议的命令 | 必须与某个已发现的入口或固定形态完全一致；否则丢弃并记录 |
| 用户填写的命令 | 按空白拆成程序和参数；同样做参数字符校验，所以参数不能含空格和引号，需要这类参数时改用项目脚本；不做名单判断，授权依据记为“用户填写” |

以本仓库的 `desktop-app/package.json` 为例，预期结果是：`typecheck`、`test`、`build` 允许；`start`、`package` 被拒绝规则命中；`smoke` 不在允许清单内，不运行。这组结果要写成测试用例。

程序从 PATH 按名称解析，不能填写可执行文件路径。包管理器即使是用户填写，也仅能运行已声明的脚本，发布等显式拒绝仍优先。授权同时检查包管理器自动触发的前后置脚本，防止只检查主脚本而漏掉隐含入口。

检查不安装依赖。直接的包安装、还原和临时包执行入口也命中拒绝规则；Hub 为支持的包管理器关闭联网取包，并对 .NET 内置检查附加 `--no-restore`。项目自己的代码仍按架构第 9.5 节的信任边界运行。

### 6.3 运行器

`src/hub/checks.ts` 的运行步骤：

1. **定位可执行文件。** 在 `PATH`（加上设置里追加的目录）和 `PATHEXT` 中查找。找不到记为环境错误。
2. **启动。** Windows 使用内置 Windows PowerShell 作进程监护器，先把自己放进启用关闭终止的 Job Object，再启动检查；它不解释用户命令字符串。`.exe` 直接启动，`.cmd` 和 `.bat` 通过 `cmd.exe /d /s /v:off /c` 启动。批处理的整条命令行是“双引号包住的可执行文件路径，加上用空格连接的参数”，外面再包一对双引号；参数已通过字符校验。其他系统使用独立进程组。
3. **选项。** 工作目录先用现有的 `within` 核对在项目内；环境变量取现有 `childEnv()` 的结果，去掉 `CODEX_HOME`，加上 `CI=1`、`NO_COLOR=1`、`FORCE_COLOR=0`；`windowsHide` 为真；不接标准输入。
4. **输出。** 合并标准输出和标准错误，保留前 20 KB 和后 60 KB，中间丢弃并留标记；用现有的 `redact` 脱敏；按内容哈希存入数据目录的 `blobs`。
5. **限时与终止。** Windows 上超时、暂停、取消或 Hub 崩溃都会关闭监护器的输入管道；监护器退出时，Windows 终止同一 Job Object 中包括后台进程在内的子进程。其他系统终止整个进程组。5 秒后仍未退出的，检查运行记为未知，并保持工作区占用。
6. **分类。** 退出码为 0 是通过；非 0 是未通过；启动失败、退出码 9009、包管理器报告缺少脚本是环境错误；超时单列。推进中出现环境错误时重跑一次，仍然如此则把该检查标为不可用。
7. **记录。** 写入 `check-run` 记录；同时用现有的 `workTrace` 在任务 Agent 的时间线上记一条命令类工作记录，标题是检查名，包含退出码、耗时和输出末段。

失败签名的算法：取输出末段，去掉时间、耗时、绝对路径和十六进制地址之后求哈希。

Windows 启动前先持久化监护器 PID，再经管道发送命令；如果这一步中断，未取得 PID 的新检查不可能已派发。正常退出等候监护器；意外退出后仍存活的监护器保留占用，确认退出后才重跑。旧版没有监护证据的记录沿用保守处理，不能凭一个旧 PID 对新进程发送终止命令。这样避免只确认主进程消失却有派生进程留在工作区。

### 6.4 基线

循环开始时运行全部已授权的检查，每个检查得到三种基线结果之一：

- **通过。** 之后作为回归把关：任何一次改动后它未通过，都记为回归。
- **未通过。** 记为既有失败。它不用于回归把关。如果某个条目把它列为自己的检查，那么它在基线时未通过正是预期，条目通过的条件是它变为通过。
- **不可用。** 环境错误或超时。之后不再运行。

条目的检查在基线时已经通过的，L0 允许继续，但在报告中注明“基线时已通过，无法区分是否完成”。

### 6.5 工作区版本标识与副作用

- **Git 项目。** 用 [`hub/workspaces.ts`](../desktop-app/src/hub/workspaces.ts) 里现有的 Git 调用方式（禁用钩子、最小环境变量），取 `git rev-parse HEAD` 和 `git status --porcelain=v1 -z --untracked-files=all` 的输出，加上这些路径的内容哈希，合并求 SHA-256。
- **非 Git 项目。** 取本循环改动过的路径及其当前内容哈希求 SHA-256。L0 还没有写前镜像，改动过的路径取各回合文件核对记录里的变化清单。
- **检查的副作用。** Git 项目比较检查前后的版本标识；不同则说明检查改动了源文件，这个检查标为不可用并在报告中说明。非 Git 项目用现有的 `snapshotFiles` 比较；达到扫描上限时记为无法判断。

<a id="file-tools"></a>

## 7. 文件工具扩展

对应架构[第 9.4 节](advance-loop-architecture.md#check-runner)和[第 7.2 节](advance-loop-architecture.md#flow)。

### 7.1 接口

```ts
export interface PathPolicy {
  protect: string[]; // 相对路径清单；命中的文件不能被修改
  allowOnly?: string[]; // 通配；只允许写入命中的路径（检查编写者用）
  lockPackageScripts: boolean; // 拒绝改变 package.json 的 scripts
}

export interface JournalSink {
  before(path: string, content: Buffer | null): Promise<void>; // null 表示新建
  after(path: string, content: Buffer): Promise<void>;
  directory(path: string): Promise<void>;
  rejected(path: string, reason: string): void;
}

export function workspaceMcp(
  root: string,
  options: { write: boolean; paths?: PathPolicy; journal?: JournalSink },
);
```

`openDsh` 的选项增加 `paths` 和 `journal`，经 `dshModelRoute` 原样传到 `workspaceMcp`。不传这两个选项时，行为必须与现状完全一致。

### 7.2 路径策略

- **受保护清单的生成。** 循环创建时，把默认通配和用户给出的通配在项目内展开成具体的相对路径，保存在 `Loop.protectedPaths`。默认通配是：`**/*.test.*`、`**/*.spec.*`、`**/__tests__/**`、`tests/**`、`test/**`、`**/test_*.py`、`**/*_test.go`、`vitest.config.*`、`jest.config.*`、`playwright.config.*`、`pytest.ini`、`conftest.py`。只保护循环开始时已存在的文件，所以执行者之后新建的测试文件不在清单里。检查编写者写入并通过“先未通过”校验的文件随后加入清单。
- **判断时机。** `edit_file` 在读取原文之前判断；`write_file` 和 `create_directory` 在解析目标路径之后判断。
- **拒绝时的返回。** 以工具错误返回固定文字：“该文件属于验收检查，不能修改。如认为检查有误，请在最终答复中说明。”同时调用 `journal.rejected`。
- **脚本入口。** 目标文件名是 `package.json` 且开启了 `lockPackageScripts` 时，把修改前后的内容分别解析为 JSON；任一解析失败，或两者的 `scripts` 不完全相同，就拒绝这次写入。
- **检查编写者。** 设置了 `allowOnly` 时，只有命中的路径可以新建或修改，其余写入被拒绝。

### 7.3 写前镜像与回退（L1）

- **记录。** `edit_file` 在替换之前调用 `journal.before(路径, 原内容)`，成功写入之后调用 `journal.after`。`write_file` 调用 `journal.before(路径, null)`。`create_directory` 调用 `journal.directory`。同一个回合内同一路径只记第一次的原内容。原内容按哈希存入 `blobs`，记录写入 `file-journal`。
- **真实差异。** 回合结束时，对每个被修改的文件用 `src/core/diff.ts` 生成统一差异和增删行数，写进该回合的工作记录（现有 `WorkFile` 的 `patch`、`added`、`removed` 字段）。验证者的材料也用这份差异。
- **回退。** 取最近一个检查点之后属于这个条目的回合，按序号逆序处理每条记录：文件当前内容的哈希等于记录的 `postHash` 才恢复，新建的文件删除，修改的文件写回原内容（临时文件加重命名）；不相等说明有外部修改，跳过并记为 `skipped_external_change`。新建的目录在为空时删除。回退的结果写一条 `rollback.applied` 事件，没有恢复的文件进入报告。
- **边界。** 回退由 Hub 直接读写文件，不经过文件工具；每个路径都先用 `within` 核对在项目内。

实现中，写入完成的后镜像也保留到 `blobs`，因此可从当时两份内容生成真实补丁，而不是用改动后的当前文件重建历史。记录后镜像前中断时，回退不猜测写入结果；已开始回退的步骤独立落盘，重启按目标状态核对。修改后的文件、目录身份变化、链接及非空目录一律留在原处并报告。仍有未知执行时不改动工作区。

<a id="work-packages"></a>

## 8. 工作包

每个工作包除通用完成条件外，还要满足“完成的定义”一栏。标注“需开工指令”的工作包要用到真实模型或执行端。

### 8.1 L0：最小循环与假设验证

| 编号 | 目标 | 涉及文件 | 完成的定义 |
| --- | --- | --- | --- |
| L0-1 | 契约与设置 | `shared/contracts.ts` | 第 4.1～4.3 节的契约可解析；旧设置对象读入后得到默认值；循环任务固定使用 DSH；只读任务选择循环模式时创建被拒绝 |
| L0-2 | 检查发现与自动授权 | `core/check-policy.ts`、`hub/check-discovery.ts` | 策略表的每条规则都有正反用例；本仓库 `desktop-app` 的发现结果与第 6.2 节的预期一致 |
| L0-3 | 检查运行器 | `hub/checks.ts` | 退出码分类正确；输出截断并脱敏；超时后子进程及其派生的进程全部终止；程序不存在记为环境错误；`.cmd` 入口可以运行；含非法字符的参数被拒绝；子进程环境里没有密钥类变量。把采用的进程树终止方式和验证结果写进路线 |
| L0-4 | 受保护路径 | `core/glob.ts`、`adapter/dsh-files.ts`、`adapter/dsh-model.ts`、`adapter/dsh.ts`、`hub/dsh-work.ts` | 修改受保护文件被拒绝且文件未变；在同一目录新建测试文件被允许；`package.json` 改依赖被允许，改 `scripts` 被拒绝，改成非法 JSON 被拒绝；拒绝被记录；不传策略时行为与现状一致 |
| L0-5 | 选步函数 | `core/loop-policy.ts` | 第 5.2 节 L0 范围内的每一行都有用例；预算、无进展、连续受阻有用例 |
| L0-6 | 推进引擎并接入 Hub | `hub/loop.ts`、`hub/service.ts`、`hub/agents.ts` | 第 9.1 节 `loop.test.ts` 的 L0 用例全部通过；原有测试一个不少、断言不变 |
| L0-7 | 最小界面 | `ui/app.tsx`、`ui/loop.tsx`、`ui/loop.css` | 能创建循环任务；详情显示条目、检查输出、预算和报告；单次任务的界面不变；深浅色和小窗口下可用 |
| L0-8 | 账本版本、备份与诊断 | `hub/store.ts`、`hub/service.ts` | 见[第 11 节](#ledger) |
| L0-9 | 实验脚手架与任务集 | `scripts/loop-experiment.ts`、`scripts/loop-score.ts`、`experiments/advance-loop/` | 用伪执行端跑通三个组的完整流程并产出结果文件；隐藏检查不出现在任何工作区副本和任务包中，有测试断言；任务集满足[实验规程](advance-loop-experiment.md#task-set)的规则并已冻结哈希 |
| L0-10 | 真实路径验证与对照实验（需开工指令） | `scripts/loop-live.ts` | 真实 DSH 加真实模型完成小循环并自动收口；真实记录中至少出现一次“检查未通过后带证据重试”，如果每次都一次通过，就换用更难的小任务再试；按实验规程完成实验并记录结果 |

L0 的界限：没有模型角色，清单由用户给出或退化为单一条目；条目受阻时不回退，报告中注明在途改动仍在；升级阶梯只有带证据重试一级。评审判定的条目在 L0 没有验证者可用，一律受阻并注明原因；一个条目的检查全部不可用时同样受阻。

首轮 A/B 验证结果见[开发路线](roadmap.md#loop-l0-local)。此时采用[实验规程的弱检查信号分支](advance-loop-experiment.md#review)，范围仅限 L1-1、L1-4、L1-6，顺序依次实施。已有检查在基线通过但不能证明此次目标时，补写能先失败的检查或交给独立验证；不得因已有检查通过就跳过全部实现。检查编写者在隔离副本中工作，仅采纳证实先失败的新增检查；这一分支不提前实现 L1-5 的完整回退。保留用户给定清单与单次模式的入口，使用新任务集复测后再决定后续。

复测分支优先支持冻结 JavaScript 任务已有的 `node --test` 入口。程序为当前条目分配唯一测试文件，编写者只能新建该文件；同一入口必须在隔离副本先通过，再因该文件的断言而失败，语法/环境错误、超时和未发现测试均不采纳。第二次仍无法证明时，转独立评审；其他测试框架或需要未复制依赖的命令报告无法在副本中建立基线，进入同一保守分支。采纳不覆盖任何文件，并保护新增测试。此范围是信号补救，不能当作完整 L1 的多生态验收。

独立验证在本分支使用实际变化文件、当前文件和检查输出；完整写前镜像尚未接入时不虚构补丁。角色返回后重新核对工作区版本，引用必须逐字对应材料。检查异议成立时，只有循环自己采纳、且内容仍与采纳记录相符的检查可以在隔离副本修订一次；项目已有检查保持受保护，无法修订时停止相应条目。

编写检查或独立评审期间请求暂停，只有活动操作退出、没有未知检查进程后才确认停止。采纳的新测试在对应条目中显示路径及采纳前的失败回执，和最终验收结果分别呈现。

运行中检查全部因环境问题不可用时，按架构降为独立评审，并在报告列出不可用检查。编写新检查失败时，用户已明确指定且仍可运行的检查继续作为必要证据；评审补充覆盖，不覆盖这些检查明确失败的结果。新评审证据仍绑定工作区版本，收口会复核。

定约提出补写检查时，先判断基线已通过的现有检查和实现是否已经足以交付。验证者逐项引用当前实现证据且该条目的程序检查全绿时，直接记录通过，不运行检查编写者或执行者。程序检查单独通过、独立核对没有可靠结论时，仍走先失败的新检查或评审退化路径。

只读模型角色遇到连线中断或响应超时，可在剩余预算内重试一次。第一次的调用回执与未知用量保留；执行者回执未知仍按 L1-7 核对，不走此重试。

### 8.2 L1：定约与独立验证

第三轮 A/B 已达到原继续线，见[路线图](roadmap.md#loop-l1-start)。定约在没有显式清单或用户指定验收时启用；保留现有部件。项目入口摘录与有效规则仅作为材料。程序只接受已发现且授权的检查，依赖只指向此前的有效条目。不能建立定约时按角色契约退化；不增加确认卡。

完整 L1 的新循环任务以草稿开始，在定约与基线期间不走执行者派发。总管或项目讨论中明确交办修改时，按默认推进方式创建；循环任务沿用原讨论及用户原话作为授权与引用来源，直接定约。明确只读的交办使用单次路径。第三轮未达到支持线，设置默认仍为单次，用户可自行选择循环。

| 编号 | 目标 | 涉及文件 | 完成的定义 |
| --- | --- | --- | --- |
| L1-1 | 角色端口 | `hub/roles.ts`、`hub/brain.ts` | 按角色取模型配置；超时可配置；输出经 Zod 校验，无效时修复一次；并发不超过上限；限流时退避重试；每次调用留下带材料清单的记录；重启后未返回的调用标为未知并可重新调用 |
| L1-2 | 定约 | `hub/contracting.ts` | 规划、审查、修订一次、程序校验；假设被记录并显示；输出无效或没有条目时退化为单一条目且循环照常运行；全程没有等待用户的状态 |
| L1-3 | “草稿”状态与对话入口 | `core/policy.ts`、`shared/contracts.ts`、`hub/agents.ts`、界面 | 状态转移表和标签更新；默认推进模式为循环时，对话里明确开工直接创建循环任务，不产生待确认卡；单次模式的待确认卡不变 |
| L1-4 | 检查编写者 | `hub/loop.ts`、角色提示词 | 只能写入检查路径；写完后先运行必须未通过；通过校验的文件加入受保护清单；校验不过重写一次，仍不过则条目降级为评审判定 |
| L1-5 | 写前镜像、检查点、回退、真实差异 | `hub/journal.ts`、`core/diff.ts`、`adapter/dsh-files.ts` | 第 7.3 节的行为；被外部修改的文件不被覆盖；回退中断后可以继续；DSH 回合的工作记录里出现真实补丁和增删行数 |
| L1-6 | 验证者 | `hub/loop.ts`、`hub/roles.ts` | 有效性复核、评审判定、异议裁决三种调用；评审判定缺少任一要点的证据即视为未通过；验证者拿不到执行者自述 |
| L1-7 | 未知回合自动核对 | `hub/loop.ts`、`hub/dsh-work.ts` | 回合未知时自动调用现有的 DSH 核对，最多 3 次，间隔递增；核对到则继续，核对不到则循环停止；任何情况下不重派 |
| L1-8 | 用量统计 | `adapter/dsh-model.ts` | 端点返回用量时记入回合和循环；不返回时标为未知；不因此改变请求内容以外的行为 |
| L1-9 | 界面 | `ui/loop.tsx`、`ui/agents.tsx` | 清单可编辑并立即生效；假设、证据等级、报告首屏按设计显示；角色节点出现在 Agent 树并默认折叠 |
| L1-10 | 真实路径验证（需开工指令） | `scripts/loop-live.ts` | 真实模型完成从一句目标到自动收口的全过程；运行期间没有要求用户操作；[第 9.3 节](#fault-cases)中标注 L1 的场景逐项验证 |

未知的 DSH 回合按回合 ID 持久化核对次数和下一次核对时间：立即一次，未找到时分别等待 750 毫秒、2200 毫秒。三次无证据即停止，仍保留工作区占用。只有匹配终止记录才按原回合结果继续；核对不启动新的 DSH 回合。

DSH 用量只统计已转发请求返回的 JSON 或事件流数字，不改变供应商请求。单个原生回合有多个请求时分别计数；同一请求的多次用量回执以最后收到的有效数字为准，不累加重复帧。没返回数字的请求记为未知，回合和循环预算均汇总已知 token 与未知请求。

清单界面通过修订号保存新增、编辑或豁免。编辑保留已有依赖关系，受影响的下游证据失效；不会生成待确认卡。工作树将实际出现的规划、审查、编写和验证调用合并为角色节点，默认折叠，只读显示回执。

### 8.3 L2：找问题与分诊

证据包保存当前工作区版本，以及各次检查输出和实际补丁的账本引用；按角色只取有界摘录，完整输出仍可按原回执核对。程序扫描只提供位置与迹象，不直接把待办标记、空实现或占位文本转成任务。每轮找问题与分诊共享一个持久步骤；如果重启，成功的只读调用按材料版本复用，工作区或清单改变则不采用旧结论。

重开既有条目时保留它原有的全部程序检查，并由独立验证者核对发现已修复。新增项以独立评审逐项验收，不自动运行模型给出的命令。若没有可入清单的发现，或没有剩余执行预算，保留发现及原因并开始最终检查。

| 编号 | 目标 | 涉及文件 | 完成的定义 |
| --- | --- | --- | --- |
| L2-1 | 证据包与半成品扫描 | `hub/evidence.ts` | 证据包含全部检查输出、循环以来的差异、条目与依据、用户原话；扫描能找出待办标记、空函数体和占位文本，并给出位置 |
| L2-2 | 视角评审 | `hub/roles.ts`、角色提示词 | 每个视角一次调用，并行受并发上限约束；每个视角的发现不超过上限；允许返回空列表 |
| L2-3 | 分诊 | `hub/triage.ts` | 引用不成立的发现作废；重复的合并；反驳、两两排序、范围判定按预算进行；超出目标的发现不会变成条目 |
| L2-4 | 改进轮与报告 | `hub/loop.ts` | 轮数和每轮入清单数受预算约束；一轮没有新条目就收口；报告列出搁置的发现及理由 |
| L2-5 | 界面 | `ui/loop.tsx` | 发现列表显示状态、排序和去向，可展开证据 |
| L2-6 | 验证（需开工指令） | 实验脚本 | 用埋入已知缺陷的任务验证：每个任务埋入若干类型不同的缺陷，埋入的缺陷至少一半进入清单；进入清单的发现证据全部核对通过；超出目标的发现执行次数为零。用户愿意评价时另记认可比例 |

### 8.4 L3：升级阶梯

前置调查（2026-11-20）：Windows 依赖探针表明，缺失依赖的隔离目录无法解析原项目的 ESM 包；复制普通 `node_modules` 后可运行，候选改依赖文件也不影响原目录和另一份副本。目录联接虽然能加载包，但写入会穿透原目录，候选不采用联接或硬链接共享可写依赖。依赖含外链或无法隔离复制时跳过并行级，保留原因；不安装新依赖。该探针只是前置调查。L2 已按[真实验收](roadmap.md#loop-l2-live)放行，按 L3-1 开始实现。

源码核对：L1 真实对照的条目重试沿用原会话，执行端已有 `fresh` 参数但普通循环未启用。L3-1 在带证据重试用尽且执行预算仍有余量时，先保留真实失败材料，再回退此条目的在途改动；确认未覆盖外部改动后，诊断并安排一次新会话。已调用的诊断输出无效时仍可在同一权限范围用新会话重试一次；诊断模型未配置、角色预算用尽、回退未能安全完成时跳过并记录原因。暂停、修订或关闭后的旧诊断不能写入新条目。此前冻结的 L1 数据不回写。

L3-2 的候选从回退后的同一已授权源文件快照分别复制，保留原项目已存在的未提交内容作为输入，不动 Git 暂存区。候选不共享 `.git`、依赖文件或彼此目录；命令仍走既有检查策略。仅比较可归到候选文件工具的普通文件差异。整合通过既有文件工具和写前镜像逐项应用已验证的内容；原目录版本变化、任一目标文件的原内容不符或保护规则不通过时停止，已写部分只按镜像安全回退。不提交也不切换分支。

L3-3 允许规划者在现有授权检查中为同一父要求选出两个或三个可区分的子条目。各子条目沿用父条目的前置依赖，父条目等子条目通过后只重跑自己的原检查，不以子条目结果代替。没有可区分检查、预算不足或输出不合法时跳过。修改父要求时豁免旧的派生子条目、保留历史证据；子条目不能进一步拆分。

L3-4 使用已有 `advisorModel` 设置。新任务保存顾问模型和默认强度；前几个阶梯用尽后，顾问只提出诊断和做法，由原执行端新建会话尝试一次。顾问无效或不可用时不替换成别的模型；用量单列，并记录供应商返回的实际模型。若拆分后转顾问，停用旧子条目的执行资格，最终仍以父条目的原验收为准。

| 编号 | 目标 | 完成的定义 |
| --- | --- | --- |
| L3-1 | 诊断者与新会话重试 | 重试额度用尽后回退到检查点，诊断者给出至少两条互不相同的思路，执行者用新会话重试 |
| L3-2 | 并行候选 | 先查明隔离工作区如何用上项目已有的依赖目录，并把结论写进本文。候选作为子任务在隔离工作区运行，互不可见；按“全部检查通过、没有回归、改动更小、验证者比较更优”挑选；只整合选中的一个，冲突时不覆盖并把条目标为受阻；未选中的工作区在保存差异副本后移除 |
| L3-3 | 条目拆分 | 规划者把条目拆成子条目，各有检查；原条目在自己的检查通过时通过；拆分深度为 1 |
| L3-4 | 顾问模型 | 设置里配置了顾问模型才启用；用量单列；调用记录写明实际使用的模型 |
| L3-5 | 验证（需开工指令） | 取 L1 实验中受阻的条目作为固定的回放集，比较有无升级阶梯时的解决比例 |

<a id="l4-miss-learning"></a>

### 8.5 L4：漏检学习

登记与启用分开。登记时保存项目、任务、修订、用户原话、清单、发现和材料引用；仅可用登记时核对过的文件内容、已保存的检查输出和报告做回放。原工作区已变化而旧材料不足时仍保留登记，标明无法回放，不把当前内容当作旧交付。派生项单独按项目管理，不进入确定权限的显式规则；命令类只能引用同项目已有并经程序核对的授权检查，不能据模型输出新建可执行命令。

已核对现有账本的材料来源：角色调用保存材料编号及内容摘要，不保留每份文件摘录；检查输出和写前镜像有本地副本，收口报告绑定工作区版本。因此旧交付只有摘要时不能声称可完整回放。登记时优先复用已经保留的副本；补采文件之前先与该次交付的工作区版本核对。两组回放使用同一份冻结材料，并分别记录缺失或截断；用户提醒只交给归因和评分，不能随候选进入被回放环节。复核合格后才可影响同项目的新循环。

回放比较同一材料、同一原环节有无候选项；随后在至少一份该项目的其它历史交付材料上核对误报。检测到目标问题且对照没有新增无依据发现才启用；候选不得依靠提醒原话本身当成证据。没有合格的留出材料则保持待验证。

L3 于 2026-11-20 通过同条件固定回放，进入 L4。登记入口在任务的收口报告，提交绑定清单修订及任务修订；记录为本地账本中的 `miss`，可随备份恢复。登记时先保存报告、当时的清单、发现和已保存的检查／差异引用。项目目录仍匹配本次交付时，另保存经版本前后校验的脱敏材料摘录；原目录变化只影响补采，不影响登记。窗口可看到材料状态；对已切换的任务或清单修订拒绝提交。

归因在收口后单独调度，不改变原循环、验收或执行预算。只在用户登记后自动尝试一次，使用该循环的规划模型及当前已配置的供应商；格式不合格可修复一次。每次调用落账，重启不自动重发已发出但缺少回执的调用，从备份恢复的未处理归因默认暂停。用户可更正分类，旧回执失效，程序只依该分类重新派生。归因可以没有候选；命令候选只能引用原交付中同项目已有的授权检查编号，仍须通过回放才可启用。

回放输入分开保存交付材料和评分目标。基线与加入候选项的两次调用都不接收提醒原话；由独立评分核对是否命中原问题，并以程序核对文件原文或原检查输出。留出材料必须来自同一项目、不同任务的已完成交付，不能拿原样本的另一份文本替代。旧命令只能引用同一交付版本已保存的检查回执，证据缺失时不在当前工作目录重跑，也不假设命令通过。

循环收口时自动保留脱敏的版本材料供以后留出复验；只读采集失败不改变原验收结果。回放先比较原样本基线与加入候选后的结果，再在同项目不同工作和不同交付版本上做相同对照。每个候选最多四个对照步骤和两个独立评分步骤；整轮最多允许额外一次结构修复，保留原无效调用。缺材料、结构修复后仍无效、目标在基线已经发现、原问题不能核实，或留出材料新增无依据发现时均不启用。评分和候选启用与原任务的验收分开入账，重启不自动补发在途回放。

真实网关验证发现长思考有时占满回放输出。各评审对照同样最多返回三项；若输出达到 8,000 上限，只可使用已经约定的一次结构修复，并在相同模型与强度下把该次上限提高到 16,000。独立评分和放行判定不变。

经证实的项目检查项在规则页单独显示，查看来源能返回原交付。停用会立刻取消后续注入；编辑文本作废旧证明并重新回放；删除用持久标记阻止从历史备份复活。检查项作为定约或指定视角的参考，仍受原话范围和原有证据核对；旧命令仅在新任务已有相同授权绑定时才作为参考。停用、编辑或删除发生于推理中时，旧推理输出不再提交。

| 编号 | 目标 | 完成的定义 |
| --- | --- | --- |
| L4-1 | 登记 | 一键把用户的提醒记为漏检样本，保存原话和当时的清单、发现、材料引用 |
| L4-2 | 归因与派生 | 角色给出归因类别和候选的检查项；用户可以更正但不需要确认 |
| L4-3 | 回放验证 | 用保存的材料重跑相应环节，加入候选后能发现该问题才启用；在另外的历史交付上没有引入大量无关发现 |
| L4-4 | 管理 | 启用的检查项出现在规则页，可查看来源、编辑、停用、删除；停用或删除后不再注入；派生项不能突破硬限制 |

<a id="tests"></a>

## 9. 测试计划

### 9.1 测试文件与用例

| 文件 | 用例 | 阶段 |
| --- | --- | --- |
| `tests/check-policy.test.ts` | 允许名单、拒绝名单优先、内容拒绝、固定形态、参数字符、用户命令解析、模型提议的命令 | L0 |
| `tests/checks.test.ts` | 退出码分类；输出截断与脱敏；超时终止进程树；程序不存在；`.cmd` 入口；环境变量；取消 | L0 |
| `tests/dsh.test.ts`（增补） | 受保护文件、`package.json` 的三种改法、`allowOnly`、拒绝记录、不传策略时不变 | L0 |
| `tests/loop-policy.test.ts` | 选步表逐行；预算到界；无进展；连续受阻；条目选择顺序与依赖 | L0 |
| `tests/loop.test.ts` | 见下方清单 | L0 起 |
| `tests/ledger.test.ts` 或并入 `dsh.test.ts` | 版本 2 升级前备份；备份清单包含新增副本；恢复后循环为已停止 | L0 |
| `tests/roles.test.ts` | 输出校验与修复一次；并发上限；限流退避；调用记录；重启后的未知调用 | L1 |
| `tests/journal.test.ts` | 记录原内容；回退新建与修改；外部修改不覆盖；回退中断后继续；差异与增删行数 | L1 |
| `tests/triage.test.ts` | 证据核对；聚类合并；反驳结果的去向；两两排序的一致性处理；范围判定 | L2 |

`tests/loop.test.ts` 的 L0 用例：

1. 创建循环任务不产生待确认记录，直接进入基线。
2. 基线把检查分成通过、既有失败、不可用三类；不可用的不再运行。
3. 执行者声明完成但条目检查未通过：条目保持未通过，失败输出进入下一次任务包。
4. 第二次尝试通过：条目标为通过，任务自动完成，验收方式为 `loop-contract`。
5. 重试用尽：条目受阻，继续下一个条目。
6. 一次改动使基线时通过的检查未通过：记为回归，优先处理。
7. 连续三个条目受阻：循环停止，任务进入“需要处理”。
8. 执行回合预算到界：循环停止并生成报告。
9. 用户暂停时正在运行的检查被终止，继续后引擎重新选步。
10. 运行中重启 Hub：检查重新运行；写入者回合标为未知且不重派。
11. 用户修改清单：修订号递增，被修改的条目回到未开始，未受影响的保持通过。
12. 单次任务的全部既有用例不受影响。

### 9.2 伪执行端

循环只支持 DSH，而现有测试只有伪造的 Codex。测试时用一个伪执行端替换 `hub.dsh`（该属性可以直接赋值），它按 [`hub/dsh-work.ts`](../desktop-app/src/hub/dsh-work.ts) 中 `start` 的顺序更新回合和命令，然后回放事件：

```ts
class FakeDsh {
  status = { status: "ACP 就绪", version: "fake" };
  scripts: ((ctx: { task: Task; run: Run; prompt: string }) => Promise<"completed" | "failed">)[] = [];
  constructor(private hub: Hub) {}
  async start(task: Task, run: Run, command: Command, _cfg: Settings, prompt: string) {
    const threadId = "fake-" + run.id;
    run.threadId = threadId;
    run.turnId = command.id;
    this.hub.store.put("run", run);
    this.hub.store.put("command", { ...command, state: "accepted", receipt: threadId });
    // 真实实现在派发后异步推进回合；这里同样在 start 返回之后再回放事件。
    setImmediate(() => void this.play(task, run, command, prompt, threadId));
  }
  private async play(task: Task, run: Run, command: Command, prompt: string, threadId: string) {
    const emit = (method: string, params: object) =>
      this.hub.handleEvent({ method, params: { threadId, turnId: command.id, ...params } }, "dsh");
    await emit("turn/started", {});
    const status = await this.scripts.shift()!({ task, run, prompt });
    await emit("item/completed", {
      item: { type: "agentMessage", id: run.id + ":answer", text: "已完成。" },
    });
    await emit("turn/completed", { turn: { id: command.id, status } });
  }
  async probe() { return this.status; }
  async reconcile() { throw new Error("尚无匹配的结束记录"); }
  cancel() {}
  close() {}
}
```

每个脚本函数模拟执行者的一次回合，直接在 `run.workPath` 里写文件。需要同时验证路径策略和写前镜像时，让脚本函数通过真实的 `workspaceMcp`（用引擎给出的选项构造）来写。检查用 `node -e` 写成的小脚本，放在测试夹具的 `package.json` 里。

<a id="fault-cases"></a>

### 9.3 必须覆盖的故障与反例

| 场景 | 必须出现的行为 | 阶段 |
| --- | --- | --- |
| 执行者声明完成但检查未通过 | 条目保持未通过，失败证据进入下一次尝试 | L0 |
| 执行者修改已有测试或检查配置 | 写入被拒绝，文件未变，回合继续 | L0 |
| 执行者把 `package.json` 的测试脚本改成直接成功 | 写入被拒绝 | L0 |
| 修复一个条目导致另一个已通过条目的检查未通过 | 后者变为未通过并优先处理 | L0 |
| 同一条目反复未通过 | 按升级阶梯推进；用尽后受阻，不无限重试 | L0 |
| 检查命令不存在或依赖缺失 | 记为环境错误并标为不可用，不消耗条目额度，循环继续 | L0 |
| 检查超时或挂起 | 进程树被终止，结果按分类处理 | L0 |
| 检查运行中 Hub 退出 | 重启后重新运行检查，不重复派发执行回合 | L0 |
| 循环进行中用户暂停、取消或修改清单 | 立即停止选步；修改清单后自动继续，不等待确认 | L0 |
| 预算到界 | 停止并报告，不自动追加 | L0 |
| 任务其实已经完成 | 首轮检查通过后正常收口，不制造额外工作 | L0 |
| 运行期间没有要求用户操作 | 从创建到收口或停止，没有待确认卡、审批或提问 | L0 |
| 策略之外的命令 | 不运行；相应条目降级；循环不停 | L1 |
| 定约输出无效 | 退化为单一条目并继续 | L1 |
| 条目的验收检查在实现之前已经通过 | 不交给执行者；重写一次；仍然如此则降级为评审判定 | L1 |
| 实现按测试输入写死结果 | 验证者复核标为存疑，条目不通过 | L1 |
| 条目受阻 | 在途改动被回退；被外部修改的文件不被覆盖并进入报告 | L1 |
| 执行回合结果未知 | 自动核对；核对不到则循环停止，不重派 | L1 |
| 角色调用进行中 Hub 退出 | 重启后在预算内重新调用 | L1 |
| 评审者引用不存在的文件或文本 | 发现作废，不进入排序 | L2 |
| 评审提出超出目标的改进 | 搁置为建议，不转为条目 | L2 |
| 候选之间 | 互不可见；未选中的不被整合 | L3 |

### 9.4 真实路径验证

`scripts/loop-live.ts` 在 `.dev/advance-loop/<阶段>/` 下建立隔离的数据目录和临时项目，用真实 DSH 和真实模型运行一次循环，只输出阶段、数量和布尔值，不输出提示正文、模型回复或密钥。做法参照 [`scripts/verify-dsh.ts`](../desktop-app/scripts/verify-dsh.ts) 和 [`scripts/live-file-check.ts`](../desktop-app/scripts/live-file-check.ts)。它需要用户的开工指令。

`--diagnose` 使用独立的运行期回执场景：第一次交付可见检查会给出项目文件工具无法读取的工单号，后续回合据实际失败输出纠正交付。该场景只证明真实重试和收口，不改变冻结任务集、不参与评分。

<a id="ui"></a>

## 10. 界面改动

对应架构[第 13 节](advance-loop-architecture.md#ux)。

- **创建表单（`TaskForm`）。** 增加“推进模式”选择，默认取设置。选择循环后显示：条目输入框（每行一条，可留空）；检查列表，列出已发现并被策略允许的检查，默认全选，另可填写自己的命令。提交后直接创建，不出现模型确认步骤；表单里原有的模型选择对循环任务隐藏。原有的单条文件检查输入对循环任务隐藏。
- **详情（`TaskDetail`）。** 循环任务显示清单表：标题、状态、证据等级、尝试次数、最近一次检查结果。每行可以展开检查输出。另显示当前阶段、预算消耗和报告。原有的“已启动 n / 上限 次”对循环任务改为显示循环预算。L1 起清单可以直接编辑。
- **时间线。** 检查运行、被拒绝的写入、回退都作为工作记录出现在任务 Agent 的对话与过程里，复用现有的 [`WorkRecord`](../desktop-app/src/ui/work-record.tsx) 组件。
- **设置页（`SettingsPage`）。** 增加一组“循环”设置：默认推进模式、预算各项、收口方式、检查用的可执行文件目录、顾问模型。
- **Agent 树（L1 起）。** 角色节点挂在任务节点下，默认折叠。
- **通知。** 运行过程不向主对话发消息；收口或停止时发一条带入口的消息。

界面验证沿用 [`scripts/smoke.mjs`](../desktop-app/scripts/smoke.mjs) 的方式，增补循环任务的创建和详情检查。

<a id="ledger"></a>

## 11. 账本版本、备份与诊断

- **版本。** 旧程序不认识循环任务，会把它当作单次任务处理；旧的设置契约也不接受新增字段。所以 `LEDGER_VERSION` 从 2 提升到 3。旧程序打开新账本时，现有的版本判断会拒绝。
- **升级前备份。** `Store` 构造时，版本为 2 的账本先生成可恢复的备份再升级，做法与现有的 `backupBeforeDsh` 相同：`VACUUM INTO` 一份快照，复制被引用的副本，写入带哈希的清单。备份失败则不升级并报错。
- **一致性备份。** 现有 `backup` 只复制产物记录引用的副本。检查输出和写前镜像也存放在 `blobs` 里，需要一并复制并写入清单。备份的前提增加一条：没有运行中的检查。
- **恢复。** 恢复后，未结束的循环一律置为已停止，原因写“从备份恢复”，不自动继续。
- **诊断导出。** 增加循环数、条目数、各类检查结果的计数、被拒绝写入的次数、用量未知的调用数。不包含条目文字、检查输出和路径。
- **应用版本。** L0 打包时提升应用版本号，建议用 0.2.0。

<a id="release"></a>

## 12. 放行清单与记录

每个阶段放行前逐项核对：

1. 该阶段全部工作包的完成条件已满足。
2. 自动测试的数量和结果已记录；[第 9.3 节](#fault-cases)中属于该阶段及之前阶段的场景全部有对应用例。
3. 真实路径验证已完成并记录：所用的 DSH 版本、模型、时间、证据目录、失败样本。
4. 运行期间要求用户操作的次数为零。
5. 架构文档第 16 节的放行条件已满足；L0 另需达到[实验规程](advance-loop-experiment.md#thresholds)的继续线。
6. 架构文档[第 15.3 节](advance-loop-architecture.md#conventions)列出的位置已同步。
7. [第 14 节](#metrics)的度量有了第一批数据。

记录位置：验证结果写入[开发路线](roadmap.md)，每个阶段一个带日期的小节；证据放在 `.dev/advance-loop/<阶段>/`；本文和架构文档只在做法变化时修改。没有通过的项如实保留为未通过，不改门槛。

<a id="pitfalls"></a>

## 13. 现有代码中的注意点

1. `finishRun` 在采集文件变化之后会重新读取任务，因为这段时间里用户可能已经暂停或修改。交给引擎之前同样要重新读取任务和循环。
2. `tick` 每秒运行一次，并用 `scheduling` 标志防止重入。引擎的定时处理不能在其中长时间等待；检查必须异步运行。
3. `canSchedule` 靠路径重叠判断工作区是否被占用。检查运行期间要把工作区放进占用清单，否则写入者会和检查同时进行。
4. `dispatch` 每次派发都把 `task.attempt` 加一。循环任务照常累加用于审计，但 `tick` 里的 `maxRuns` 判断不能再把它置为“需要处理”。
5. `dsh-work.ts` 的 `start` 每个回合都新开一个 ACP 进程，是否续接原生会话取决于路由和规则版本是否相同。循环需要一个显式的“新会话”开关。
6. `agents.ts` 的 `next`（排队的下一轮指令）会清空任务的 `checks` 并把修订号加一。循环任务不走这条路径；用户在执行页的补充对循环任务只作为当前条目任务包里的参考内容，不改变清单。
7. `context` 生成的任务包超过 100000 字符会报错。失败输出只取末段。
8. `Brain` 的请求超时固定为 90 秒；错误是一段中文描述，HTTP 状态只出现在文字里，没有结构化字段。角色端口需要可配置的超时和能用程序识别的限流错误。
9. DSH 文件工具的限制：单个文件不超过 256 KB，只支持 UTF-8 文本；`write_file` 不能覆盖已有文件；`edit_file` 只能替换唯一的精确片段；看不到 `dist`、`build`、`node_modules`、点开头的目录和凭据类文件；没有删除和重命名。
10. `snapshotFiles` 有 5000 项、单文件 2 MB、合计 40 MB 的上限，并且跳过 `release` 等目录。不要把它当作完整的工作区哈希。
11. `backup` 要求没有未结束的回合。循环运行中不能做一致性备份。
12. `SettingsSchema`、`TaskInput` 和各个请求对象都是严格模式，未声明的字段会被拒绝。新增字段要同时加进契约。
13. `main.ts` 在转发请求之前也会用 `Request` 解析一次。新增操作只需要改契约和 `Hub.request`，不需要改预加载脚本。
14. 所有落盘的模型输出和命令输出都经过 `redact`。检查输出也要经过它。
15. Node 在 Windows 上不能直接启动 `.cmd` 文件，做法见[第 6.3 节](#checks)。
16. `store.all` 每次读取并解析整类记录。选步过程不要反复全量读取；需要按任务或循环筛选时，用 `store.db.prepare` 写带条件的查询，`agent-ledger.ts` 的 `pageLines` 是现成的例子。
17. 检查进程的 `PATH` 来自 Hub 进程的环境。用户平时在终端里临时加进 `PATH` 的目录（例如本机的 Node 目录）不在其中，所以需要设置项“检查用的可执行文件目录”。
18. 现有的 `task.revise` 在有活动回合时把任务置为“已暂停”，并要求用户在停止确认后点继续。循环任务不能沿用这一点：修订只请求停止旧回合；旧回合结束后 `finishRun` 会因修订号不符把任务置为“需要处理”，此时由引擎接手并重新选步，旧回合的结果不算作一次尝试。用户主动的暂停仍然不自动恢复。

<a id="metrics"></a>

## 14. 度量

从 L0 起持续记录下面的数据，来源是账本，不靠模型自报：

- 每次交付的人工提醒次数；运行期间要求用户操作的次数。
- 机制性虚假完成次数；实验中的隐藏检查差距。
- 条目首次通过率和平均尝试次数；各级升级的使用次数和解决比例。
- 被拒绝的写入次数；回退次数和没有恢复的文件数。
- 发现的证据无效率、被反驳率，以及用户愿意评价时的认可率。
- 各角色输出的 JSON 无效率，修复一次后的无效率。
- 各角色的已知用量和用量未知的调用数；执行回合数。
- 检查的环境错误、超时和不稳定次数。
- 从创建到收口的时长。

这些度量用来判断每个组件是否还值得保留。循环中的每个组件都对应一个“模型自己做不到”的假设；更换模型后要重新检验，能去掉的就去掉。
