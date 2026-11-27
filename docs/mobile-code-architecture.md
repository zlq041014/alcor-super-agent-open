# 手机端代码架构与开发规范

> 类型：代码架构、开发规范与实施顺序
> 状态：当前主线；第一步代码整理已完成（2026-11-25）；M1 文字闭环已实现并通过浏览器检查，待真机全项取证；M2.3 会话库迁移已实现并在 V2338A 完成一次真实数据迁移；M2.1 官方标题、M2.2 挂靠项目、M2.4 上下文压缩和 M2.5 用量与花费已实现，浏览器检查与解析单测通过；M3.1/M3.2/M3.3 工具循环、联网搜索、读网页和日期提醒已实现，真实接口完成一次工具调用和最终答复；工具后下一轮、M3.4 写入和 M3.5 系统权限未完成，M2/M3 均不记通过。
> 更新：2026-11-25（Asia/Shanghai）
> 适用：`mobile-app/android` 的 M1～M7；桌面 Hub 只在协议边界出现

功能范围和验收条件以[手机个人助手](mobile-assistant-v2.md)和[路线图](roadmap.md#mobile-assistant-v2)为准。本文只回答：代码怎么分层、数据由谁写、新功能按什么规范加。

<a id="mobile-code-priority"></a>

## 先定优先级

1. **成品可用。** 主路径能在真机完成；失败有原因、有出路，不出现死路。
2. **体验流畅。** 输入、滚动、切换不卡；状态不跳；断网有缓存和明确标识。
3. **还原设计。** 以 `mobile-app/prototype-v2/` 为准，布局、间距、颜色、图标和文案尽量一致。
4. **代码可维护。** 单一写入口、按功能分包、契约清楚；够用即可，不追求形式完美。
5. **测试按风险。** 只测容易坏、坏了用户会遇到的；不追求全覆盖、不堆流程。

一句话：先把用户能走的路径做通，再补边界；规范和测试服务于交付，不反过来挡住可交付版本。

<a id="mobile-code-status"></a>

## 现状

2026-11-25 核对源码的结果，不是验收结论。

- 单 `Activity` + `WebView`。界面和大部分会话逻辑在 `assets/`：`app.js` 1000 行、`views.js` 36 KB、`model.js` 430 行，样式集中在 26 KB 的 `styles.css`。
- 会话状态已从 `discussions.json` 迁到原生 `assistant.db` v4：`ChatStore` 一次性导入旧文件并保留逐字节备份，之后 WebView 启动取快照、每次保存整体提交；旧文件不再写入，只作一个版本的迁移来源和回退备份。聊天回合仍在 JS 里组装，M2.4 再迁。
- 数据库统一为 `core/db/Database`（`assistant.db` v4），`Notes` 不再自己持有 helper；表为 `notes`、`dialogs`、`messages`、`decisions`、`work`、`peers`、`projects`、`artifacts`、`meta`。迁移失败时 `ChatStore.stateJson()` 返回 `~原因`，WebView 本次会话退回旧文件并在首页说明，旧数据不动。
- 原生职责已拆开：`AppContainer` 管共享依赖，[MobileService.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/MobileService.java) 管不需要 Activity 的桥操作，[NativeBridge.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/bridge/NativeBridge.java) 只做 JS 入口；`MainActivity` 保留窗口、WebView、状态、选择器/导出和 Host 回调。[Network.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/Network.java) 仍同时处理模型流、搜索和电脑协议，M2/M3 再拆。
- 笔记已从首片扩到可用收件箱：[NoteActivity.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/NoteActivity.java) 负责文字/图片/分享的轻量记录，[Notes.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/Notes.java) 为数据库 v3（`box` 收件箱/已归入/已归档），[NoteWidget.java](../mobile-app/android/app/src/main/java/app/alcor/mobile/NoteWidget.java)、快捷方式和文字分享已接入口；桥上有 `notes.list/get/add/update/attach/box/delete/branch`、`note.capture`、`note.preview`，写操作后发 `notes.changed`。笔记保存只写 SQLite 和私有文件，不联网、不调模型。
- WebView 新增 [features/notes.js](../mobile-app/android/app/src/main/assets/features/notes.js)：收件箱、状态筛选、本地文字检索、详情、编辑、归档、挂项目、Markdown 导出和转新对话材料；对话框里的来源行可点回原笔记。原 `views.js`、`app.js` 只做接线，没有继续把笔记逻辑堆进去。
- 测试：JVM 迁移/资源白名单测试、`NotesMigrationCheck`（v1→v3、检索、编辑、挂项目、归档、删除）、Debug APK、androidTest APK 和 lint 通过；生产 WebView 浏览器检查覆盖离线记一笔、收件箱检索、详情编辑、导出、归档/取消归档、转新对话和来源回跳。真机全项取证与语音 M1.5 尚未完成。
- 构建是一个 `:app` 模块，Java 17，依赖 `androidx.core` 和测试用 JUnit；没有 Kotlin、Compose、Room 或前端构建链。

已处理：数据库迁移路径、共享容器、桥拆分、资源子目录白名单、笔记桥和恢复界面。还没处理：会话状态仍只有 JS 一份，`views.js`、`app.js` 仍偏大，这两项放到 M2。

<a id="mobile-code-target"></a>

## 架构

把手机端看成一个本机小后端 + Web 客户端，边界在进程内。

```text
┌──────────────────────────────────────────────┐
│ WebView UI（assets/）                         │
│ screens · components · store · router        │
└───────────────┬──────────────────────────────┘
                │ bridge：请求/响应 + 事件
┌───────────────▼──────────────────────────────┐
│ Native bridge（校验、版本、限额、错误转换）    │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ feature/*（notes、chat、tools、work、…）      │
│ 用例、状态机、策略、事务边界                   │
└───────┬───────────────────────┬──────────────┘
        │                       │
┌───────▼─────────┐   ┌─────────▼──────────────┐
│ core            │   │ platform               │
│ db net security │   │ notify widget share    │
│ events errors   │   │ alarm job boot         │
└─────────────────┘   └────────────────────────┘
```

- 原生持有耐久数据和所有系统能力；WebView 只做呈现和输入。
- 所有写操作先落库，再发事件，再更新界面；UI 不持有唯一副本。
- 只有 `bridge/` 能出现 `@JavascriptInterface`；Android 组件（`MainActivity`、`NoteActivity`、`NoteWidget`）放在根包，只做接线和生命周期。

### 数据归属

| 数据 | 唯一写者 | 读法 | 说明 |
| --- | --- | --- | --- |
| 对话、消息、决定、回合 | 原生 `feature/chat` 的 `ChatStore` | 桥取快照 + 整体提交 | M2.3 已从 JSON 迁入；回合组装仍在 JS |
| 笔记、记忆、提醒、摘要 | 各自 feature | 桥查询 | 笔记、提醒按模式查询与修改，记忆另按项目隔离；摘要随各自对话保存 |
| 每轮用量 | 随 assistant 消息保存在 `ChatStore` | 快照 + 界面汇总 | 金额按公布单价估算，标单价日期；专用用量表未建 |
| 草稿 | `ChatStore` 的会话行 | 随快照返回 | 输入防抖后整体提交 |
| 凭据、令牌、配对密钥 | `SecretStore` | 仅原生内部 | 不进数据库、WebView、日志和备份 |
| 附件、网页缓存、产物副本 | 原生文件层 | 桥返回引用 | 数据库只存相对引用和元数据 |
| 滚动位置、浮层、临时输入 | WebView 内存 | 本地 | 不进数据库 |

### 两条主流程

**对话（M2.3 起）。** WebView 启动调 `AlcorNative.state()`，原生 `ChatStore` 首次打开时把 `discussions.json` 导入 `assistant.db`、生成逐字节备份并核对计数，然后返回快照；以后每次保存把整份状态提交回原生，单事务替换行，旧文件不再写入。导入失败返回 `~原因`，本次会话退回旧的 `read/save` 文件路径并在首页说明，旧记录不丢；下次启动重试。M2.4 把上下文组装、压缩、用量和流式回合也迁到原生后，再改成按回合的查询与事件。

**记一笔。** 图标长按、小组件或分享进入 `NoteActivity`，不加载 WebView → 校验长度，图片复制进私有目录，一个事务写 `notes` → 发 `notes.changed`。保存过程不联网、不调模型。

<a id="mobile-code-layout"></a>

## 目录

目标结构如下。旧类不要求一次搬完：新文件按目标包名创建，触碰旧文件时顺带迁移；M2 前完成 `core` / `feature` 分层。

```text
mobile-app/android/app/src/main/
  java/app/alcor/mobile/
    AlcorApp.java                 # Application：容器、通知渠道
    AppContainer.java             # 手工装配：数据库、执行器、HTTP、各 feature
    MainActivity.java             # WebView 壳：窗口、返回、Intent
    NoteActivity.java  NoteWidget.java
    bridge/      NativeBridge.java  BridgeContract.java
    core/        db  net  security  events  errors
    feature/     notes  chat  tools  work  memory  reminders  life  settings
    platform/    notify  share  files
  assets/
    index.html  app.js
    core/        bridge.js  store.js  router.js  dom.js  copy.js
    features/    chat  notes  work  settings  memory  reminders  life
    ui/          components.js  icons.js  markdown.js  reading.js  pet.js
    styles/      tokens.css  base.css  components.css  screens.css
```

- `core/` 不引用 `feature/`；feature 之间只调对方的公开 API，不直接读别人的表。
- 每个屏幕一个 JS 文件；`views.js` 按 feature 拆完就删，不再继续变大。
- 资源仍只走内置 `https://appassets.androidplatform.net`。新增子目录时同步更新 `shouldInterceptRequest` 白名单并校验规范化路径，不用 `.*` 放行。

<a id="mobile-code-decisions"></a>

## 关键决策

| 决策 | 选择 | 理由 | 什么时候重审 |
| --- | --- | --- | --- |
| 界面技术 | 原生壳 + WebView | UI 已真机验证；原型是 HTML/CSS；功能面大、单人维护 | 聊天列表持续掉帧、无障碍不通过或 WebView 兼容问题修不了时，只重写问题屏幕 |
| 原生语言与模块 | Java 17，单 `:app` 模块 | 现有代码和构建链都是 Java；拆模块只增加配置 | 出现第二个长期维护者，或构建明显拖慢迭代 |
| 数据库 | 系统 SQLite + `SQLiteOpenHelper` | 表不多，SQL 直观，迁移可控 | 表超过约 15 个或迁移频繁时再评估 Room |
| 会话状态 | M2 起由原生持有 | 进程死亡可恢复；单一写入口；密钥不出 WebView。M2.3 先做快照+整体提交，M2.4 再改成按回合查询与事件 | 整体提交在真实长会话里出现卡顿时 |
| 前端 | ES modules + 模板字符串 + 事件委托 | 不引入 Node 构建链；CSP 和资源拦截简单；原型可直接对照 | 屏幕复杂度导致不可维护时，只在新屏幕试点轻量方案 |
| 网络与定时 | 平台 HTTPS、`AlarmManager`、`JobScheduler` | 现有 SSE 和固定证书已工作；需求是“尽量送达” | 连接复用或后台可靠性实测不够时，再评估 OkHttp/WorkManager |

<a id="mobile-code-data"></a>

## 数据与桥

### 数据库

- 唯一业务库沿用 `assistant.db`，`AppContainer` 持有一个 helper；开启 WAL 和外键。表名、列名用 snake_case。
- 时间存 epoch 毫秒（UTC），桥上也用毫秒，显示时再格式化。ID 用应用生成的稳定字符串，不暴露自增主键。
- JSON 列只放不参与查询的载荷（工具参数/结果、思考内容、原始回执）；核心字段建列。
- 每次 schema 变化升版本并新增迁移；`onUpgrade` 按版本顺序执行，不抛“没有升级路径”。迁移失败回滚、保留旧数据并说明原因；数据库版本高于 App 时拒绝打开，不静默建空库。
- M2 从 `discussions.json` 迁入前先备份；导入按来源 ID 幂等，核对对话数、消息数、决定版本、待发命令和回执游标；旧文件保留一个版本周期。M2.3 已实现一次性导入、逐字节备份、计数核对和失败回退；回退到 M2 之前的 APK 后，旧版只能看到迁移前的文件，不包含之后写进库的内容。
- 快照包含 `dialogs`、`messages`、`decisions`、`work`、`peers`、`projects`、`artifacts`、`last`、`lastDiscussion` 和未识别根字段；消息区分本地与桌面同步正文，会话决定带稳定的头和版本。每次提交在单事务里替换行并核对计数，失败回滚。
- 凭据只进 `SecretStore`；数据库、备份、日志、导出文件都不得出现 Key、令牌或配对密钥。附件先复制到私有目录，数据库只存引用。

### Bridge

统一信封，避免“成功返回值、失败返回字符串”：

```json
{"id":"req-1","ok":true,"data":{}}
{"id":"req-1","ok":false,"error":{"code":"NETWORK","message":"暂时无法连接，请检查网络","retryable":true}}
```

事件由原生主动推送：`{"type":"chat.delta","seq":42,"turnId":"t-1","data":{"text":"..."}}`。

- 操作按命名空间：`app`、`notes`、`chat`、`memory`、`reminders`、`work`、`settings`、`security`、`diag`。操作名 `domain.verb`。
- 请求上限 256 KB，响应上限 4 MB；大列表分页，二进制只传引用。
- 流式事件带 `turnId` 和递增 `seq`，按约 50 ms 或 1 KB 合并；UI 丢弃旧回合事件。
- 事件在数据库提交后发；UI 收到后按需重取，不把事件当唯一数据源。
- 对话写笔记先保存带固定笔记编号的本机卡片，再调用 `notes.add`（`source: "assistant"`，带 `id`）；恢复时只在用户点击后用同一编号核对。 `notes.undoAdd` 只删除该编号下尚未变更的助手笔记；卡片状态与工具协议分开，不导出、不随讨论同步。
- `reminders` 的时间用 epoch 毫秒。原生存储和闹钟归 `feature/reminders`；桥提供列表、详情、按编号创建、带修订修改及取消。下一次到期统一调度，启动、重启及定时权限变化时重建；系统通知用提醒编号定位，通知点击只传编号。
- 模式为 `work` 或 `life`。对话快照保留模式（未标注的旧记录归工作），笔记和提醒在 v6 按模式查询、修改和创建；文件收件持有接收时的模式和目标对话。会话和工具使用开始时的归属；桌面同步只读写工作一侧，跨模式仅传待处理圆点状态。
- v7 `memories` 存在 `assistant.db`，由原生记忆库写入；按模式和项目读取，候选不进入请求。删除清除正文和来源并保留编号墓碑。备份恢复先合并墓碑，再插入有效记忆。
- `app.info` 返回 `appVersion`、`bridgeVersion`、`dbVersion`；不匹配时明确提示，不猜测兼容。
- 错误码起点：`INVALID`、`NOT_FOUND`、`CONFLICT`、`AUTH`、`TLS`、`NETWORK`、`TIMEOUT`、`RATE_LIMIT`、`CONTEXT_OVERFLOW`、`PERMISSION_DENIED`、`CANCELLED`、`STORAGE_FULL`、`DB_VERSION`、`INTERNAL`。`message` 是给用户看的一句短话。

### 模型与工具

- 只依赖一份能力声明：流式、工具调用、看图、思考强度、用量、标题。DeepSeek 的 `thinking`、`reasoning_effort`、`latest_reminder` 等字段只出现在接入层；上层用统一事件。
- 上下文顺序固定：系统提示（固定规则 + 人格）、记忆摘要、历史、`latest_reminder`、本轮材料、用户消息。稳定内容在前，易变内容在后。
- 人格偏好保存在本机快照根字段 `persona`；`features/persona.js` 生成限长风格段与本地预览。只给用户答复的提示词拼上人格，固定规则放在后面；状态与交接文案由程序继续生成。
- 超出预算把最早一段压成摘要，摘要单独存表并标覆盖范围，原文不动；摘要失败退回最近若干条并说明；接口返回超长 400 时压缩一次再试一次。
- 工具按“名称、类别、所需权限、是否写入、结果上限”注册。执行前检查模式、权限、沾染标记和每轮次数/时长上限（起点 8 次、90 秒）。读过外部内容后，写类工具改为待确认卡片；“交给电脑”不是工具，仍走交接卡；删除只由用户在界面上做。
- 每轮用量随答复消息落库，金额是估算并标单价日期；`features/usage.js` 只做汇总和格式化，不参与请求。摘要调用用量记在摘要记录里，也计入当日估算。
- 上下文预算按字符估算并以上次接口 `prompt_tokens` 校准；默认 8 万 token，`features/context.js` 负责裁剪和摘要提示。摘要存在会话派生层 `summaries`，带覆盖消息编号、条数和版本，原文不动；暂不建独立摘要表。

<a id="mobile-code-standards"></a>

## 开发规范

### 代码

- 入口只接线；一个类只做一件事。文件大到难读就拆，不设行数硬门槛。
- 复用现有 helper、平台 API 和标准库，再考虑新写；不建空接口、空仓库、空 `Manager`，不为假想未来加抽象。
- 删除被替换的代码和资源，不留死分支和 TODO 占位。
- 命名清楚优先于简短；标识符英文，用户文案中文；注释写“为什么”和约束。

### 错误与线程

- 不吞错：不用空 `catch`、默认值吞错或把失败写成成功。边界转成错误码 + 一句可行动的用户提示；未知是显式状态。
- 主线程只做 UI；数据库、文件、网络、图片解码都离开主线程。`AppContainer` 持有执行器：数据库写单线程，网络 2～4 线程，回调回主线程。
- 先落库再发事件、再更新 UI；进程随时可能被杀。启动时把 `streaming` 标 `interrupted`、`running` 的工具调用标 `unknown`，只显示原因，不自动重发。
- 写操作失败不自动重试；用户点重试才产生新请求。读请求也不做无限重试。

### 安全

- 凭据只进 `SecretStore`（Android Keystore）；不上 WebView、不进数据库、不进备份、不进日志。Key 输入框只写不读。
- 外部连接只允许 HTTPS；配对电脑只认配对时记录的证书指纹。禁止明文、用户信息和跨主机重定向。
- WebView 只加载内置资源：关闭文件/内容访问，禁止外部导航，CSP 保持 `default-src 'none'`；发布版不开 WebView 调试。
- Markdown 关闭原始 HTML；所有插值经 `esc()`；模型输出、网页、笔记都按不可信数据处理。外链只允许 `https`，交给系统浏览器。
- `web_fetch` 拒绝回环、私网、链路本地地址和非 HTTPS；限制重定向、大小和时长。读过外部内容的回合，写入走待确认。
- 分享/导出用 `FileProvider` 只读授权；应用锁开启时先解锁；备份排除凭据；剪贴板只在用户点击时写入。
- `feature/security/AppLock` 只在原生 Activity 里消费 Android 系统认证结果；每个 Activity 单独持有解锁会话。开启后外出返回重锁、冷启动不预加载 WebView、锁定时桥拒绝读写；闹钟接收器不依赖界面会话。
- `LocalBackup` 只用业务表的白名单字段和引用文件生成 ZIP，不访问凭据库。读取时校验大小、引用和模式，在私有缓存准备预览；确认后事务合并，异常回滚并撤掉本次复制的附件。恢复期间桥冻结会话提交，成功后 WebView 重新读库。
- 工作通知与回执分离：回执、游标和未读随 `ChatStore` 同次提交；只有提交之后才向原生投递未读快照。v8 `work_notice_delivery` 持久登记每项工作的系统投递序号，在调用 Android 之前领取。不复制任务正文，不随备份恢复，进程异常时优先不重复弹出，应用内未读仍保留。
- `agents` 是只读手机协议；Hub 先核对设备与项目共享，再投影账本的节点、状态、可核实会话及本手机对应的回执编号。手机按项目存结构缓存，撤销共享时移除；设为目标只组装原交接草稿。
- `features/pet.js` 从工作账本和流式会话状态驱动 Canvas；工作姿态在回执刷新时计算，不随动画帧遍历账本。帧尺寸、行号和帧率取自与原型共用的精灵表元数据。
- 架构图使用 npm `mermaid@12.3.0` 的官方 `dist/mermaid.min.js` 原样随包，附 MIT 许可，保留产物内的依赖许可说明。只在首次遇到图表时加载。源码拒绝自定义配置与 HTML，SVG 再核对节点、事件、外链和尺寸，只作为本地图片载入。预览和 PNG 来自同一缓存结果；保存和分享沿用 Android 文档选择器和只读文件授权。
- PPT 使用独立的 `features/slides.js`，先验证 `alcor-slides` 的长度、页数与字段类型，再由同一份结构生成预览和 Markdown。不加文件格式库，也不修改会话存储或 Android 导出协议。

### 界面与还原

- `mobile-app/prototype-v2/` 是视觉与交互的唯一来源。布局、间距、字号、圆角、颜色、图标、文案密度都以它为准；不临时改设计。
- 优先复用原型的 class 和组件样式。app 的 `styles/` 按 `tokens/base/components/screens` 拆，但 class 名、变量值和关键布局与原型对齐，不另起一套视觉语言。
- 颜色、间距、字号只用 `styles/tokens.css` 的变量；四套主题（工作/生活 × 浅/深）与原型一致；系统字体，不加载网络字体。
- 按阶段还原对应屏幕，不一次做 46 屏。M1 先还原：首页（工作/生活）、抽屉、快速记一笔、收件箱/笔记详情。
- 关键交互要对齐：输入框右侧“记一笔”和发送两个出口、左上抽屉、右上待处理、模式开关、小引位置和大小、答复上方的工具行、下方的来源/记忆/费用行。
- 必做状态：加载、空、错误、离线、缓存过期。没有回执不显示“执行中”，缓存不冒充实时，失败不显示成功。
- 流畅：本地操作点击到有反馈 < 100 ms；输入、滚动、切屏不掉帧；流式文本按帧合并，不整页重绘；长列表分页或虚拟化；键盘顶起、返回先关浮层。
- 无障碍：图标按钮有可读名称，触控目标至少 48 dp，正文对比度至少 4.5:1，支持系统字体缩放和减少动态效果。
- 还原检查：390 px 和 320 px 宽、浅色和深色，对照原型截图看首页、抽屉、记一笔、交接卡、等待、回执、小引、设置。用 `check-ui.cjs` 和原型 `shoot.cjs` 出图，并排看；不要求像素级一致，但不接受明显走样。
- 如果实现必须和原型不同，先改 `mobile-assistant-v2.md` 的界面小节和原型，再改代码。

### 测试

- **必测**：数据库迁移/恢复、派工与回执状态、上下文压缩、权限与外部内容写入、凭据不进日志/备份。这些坏了会丢数据或骗用户。
- **主路径**：每个阶段用真机走 3～5 条用户路径，记录通过/未通过；浏览器检查只做界面回归和还原对照，不作为跨端验收证据。
- **选测**：纯展示、简单 getter、每个桥操作的独立 fixture 不强制；契约变更和容易回归的逻辑再补。
- **不要求**：全覆盖、每个状态转移矩阵、每个历史版本迁移、固定性能数字、每次改动全量回归。
- 自动测试用假 SSE/固定响应，不调用真实模型；真实模型和执行端按项目约定等开工指令。

**什么算阻塞缺陷。** 崩溃/ANR、主路径走不通、丢数据、重复派发或重复扣费、Key/隐私泄漏、主界面明显偏离原型。其余问题记录后排期，不挡当前版本。

### 发布前看五条

- [ ] 主路径能走通，失败有原因和下一步。
- [ ] 没有崩溃、ANR；输入、滚动、切屏流畅。
- [ ] 关键界面与原型对照过（390/320，浅/深）。
- [ ] 升级不丢数据；Key、令牌不进日志和备份。
- [ ] 没验证的照实写，不把“看起来对”记成通过。

<a id="mobile-code-plan"></a>

## 分阶段

### M1：记一笔（现在）

- 聊天继续用现有 `discussions.json`，不改聊天状态机，不给 JSON 加新字段。
- 原生侧已完成笔记数据库 v3、`onUpgrade`、`AppContainer`、`NativeBridge`，以及 `list/get/add/update/attach/box/delete/branch`、图片预览、快速记录 Activity、系统分享文字、图标快捷方式和一行的桌面小组件。写操作提交后发 `notes.changed`。
- WebView 的笔记界面放在 `features/notes.js`：收件箱/已归入/已归档、离线文字检索、详情、编辑、归档、挂项目、Markdown 导出、转新对话材料，以及对话里的来源回跳。输入框右侧新增「记一笔」；抽屉里可进笔记。
- 通过条件按[路线图 M1](roadmap.md#mobile-assistant-v2)。已完成文字记录、分享文字/链接、图片记录、收件箱、检索、转对话、挂项目、导出和杀进程后重开的实现；语音 M1.5 尚未开工，真机全项取证见路线图。
- 本文不把 M1 记为完成，直到语音和真机各项条件分别有证据。

### M2：对话地基

- [x] 建 `dialogs/messages/decisions/work/peers/projects/artifacts/meta` 表，完成 JSON 导入、计数核对、逐字节备份和失败回退；`Database` 统一到 v4，`Notes` 共用同一个 helper。
- [x] 会话和草稿改由原生 `ChatStore` 持有；WebView 用快照 + 整体提交，不再写 `discussions.json`。
- [x] 用量与花费：SSE 最后一个内容块的 usage 解析成输入/命中/未命中/输出/思考，金额按 2026-11-25 公布单价估算，显示本轮和当日累计。
- [x] 官方标题：首轮请求带 `title.enabled`，服务端标题优先，缺失时回退用户消息开头；只对官方端点发送该扩展字段。
- [x] 挂靠项目：手机对话可改绑到已同步项目，编号和交接引用一起更新；挂靠前不产生交接，挂靠后只推送之后的消息。浏览器假桥验证通过，真实电脑未验证。
- [x] 长对话：取消最近 12 条限制，按字符预算带历史；超预算把较早一段压成会话派生的 `summaries` 记录（覆盖范围、条数、版本），原文不动；摘要卡可查看原文并带摘要开新对话；摘要失败时只带最近一段并提示；接口超长时压缩一次重试。浏览器假桥验证通过，真实模型未验证。预算暂固定 8 万 token；已同步到电脑的对话只裁剪并提示，暂不在手机生成摘要。
- [ ] 会话、上下文、压缩迁到原生；WebView 改成按回合“查询 + 订阅事件”，拆 `views.js` 和 `app.js`。
- 通过条件按[路线图 M2](roadmap.md#mobile-assistant-v2)；重点验证迁移不重复派发、进程死亡可恢复、长对话不断片。用量、标题和挂靠还需要真实官方请求与真实电脑核对，M2 不记为通过。

**M2.3 第一切片（2026-11-25）。** `ChatStore` 导入 12 个会话、18 条消息、4 个决定、2 项交接、5 台电脑、6 个项目，备份与迁移前文件 SHA-256 一致，旧文件未被改写；真机在隐藏旧文件后强制重启仍能显示原会话。证据在 .dev/mobile-v1/m2-migration/result.json。

**M2.5 与官方标题（2026-11-25）。** 新增 `core/net/ChatSse` 解析流式帧，`Network.chat` 返回最后一块的 usage 和标题；`features/usage.js` 按公布单价估算本轮和当日金额；`views.js` 在答复下方显示。JVM 16 项、浏览器检查通过，证据在 .dev/mobile-v1/m2-usage/result.json。

**M2.2 挂靠项目（2026-11-25）。** 手机对话挂到已同步项目时改绑对话编号，交接和最近使用同步更新；挂靠页按电脑列出项目，挂靠前拦截「交给电脑」，挂靠后只推送之后的消息。浏览器假桥检查通过，证据在 .dev/mobile-v1/m2-attach/result.json。

**M2.4 上下文与摘要（2026-11-25）。** `features/context.js` 按字符预算裁剪，用上一轮 `prompt_tokens` 校准字符/token 比；超预算时把较早一段交给模型整理成会话派生的 `summaries` 记录，保留覆盖范围、条数和版本，原文不动。界面显示摘要卡，可查看被压缩原文、带摘要开新对话；摘要失败只带最近一段并提示；接口返回超长时压缩一次后重试。浏览器假桥用 34 条长消息触发压缩并验证原文、摘要和失败回退，证据在 .dev/mobile-v1/m2-context/result.json。真实模型的长对话记忆和摘要质量未验证。

### M3 工具循环（第一切片，2026-11-25）

- [x] 原生流式解析：`ChatSse` 暴露 `reasoning_content` 和 `tool_calls` 片段，`Network.chat` 按 index 聚合参数并返回；请求体可带 `tools`；`/v1/tools/fetch` 经 `Network.fetch` 读取正文，限制 2 MiB / 120k 字。
- [x] JS 工具循环：官方模型按权限声明 `web_search`、`web_fetch`、`note_search`；执行结果交回模型，每轮最多 8 次/90 秒；工具行可展开显示参数、耗时、结果和来源，联网调用每次约 ¥0.005 计入当日估算。
- [x] 日期提醒：每轮用户消息前插入 `latest_reminder`，北京日期、星期、空位置、App、中文。
- [x] 助手能力页：四项工具开关保存在会话状态根字段 `toolPrefs`；关闭后不声明也不执行对应工具。权限页分别列出已声明的系统权限和暂未申请的能力。
- [x] 对话记笔记：原文直存、外部资料后的逐项确认、撤销与重开后的同编号核对。写入和撤销进入原生 SQLite，助手写入的卡片只在本机。
- [ ] 工具后下一轮的真实请求稳定性；自动判断不搜索、引用准确性、多工具并行、工具超时/失败上限的完整界面。
- [ ] 提醒类工具，以及真实模型对写入、拒绝和关闭能力的行为核对；M3 不能记为通过。
- 真实验证：普通请求 usage/标题、Search 5 条、Fetch 5,929 字、一次 `web_search` 调用后的最终答复成功；另一次工具回合在最终答复前卡住。浏览器假桥与真机安装见 .dev/mobile-v1/m3/result.json。

### M3 以后

1. 在设计文档补范围、数据、权限和验收；需要新桥操作就先写契约。
2. 建表/加列 + 迁移；新建 `feature/<name>` 和 `assets/features/<name>`；只调公开 API。
3. 补主路径和失败路径的真机走查；更新路线图；删除被替换的旧实现。

工具、记忆/模式/应用锁、提醒/生活、工作通知/中继、成果/相册分别按 M3～M7 推进，不提前建空模块。

### 第一步已完成（2026-11-25）

- [x] **迁移路径。** 新增 `core/db/MigrationPlan` 和 `Migrations`；`Notes` 升到 v2，`onUpgrade` 按版本执行，v1→v2 增加 `notes_project_recent` 索引。
- [x] **容器。** 新增 `AlcorApp`/`AppContainer`，全应用共享 `Notes`、文件层和执行器；`NoteActivity` 不再每次 `new Notes()`。
- [x] **拆桥。** 新增 `bridge/NativeBridge`、`bridge/Host` 和 `MobileService`；`MainActivity` 从 457 行降到 332 行，只留窗口、状态、选择器/导出和 Host 回调。
- [x] **资源白名单。** 新增 `core/web/AssetPaths`，允许根目录及 `core/`、`features/`、`ui/`、`styles/`、`assets/` 的已知类型，拒绝 `..` 和未知扩展名。
- [x] **最小测试。** 加 JUnit；`MigrationPlanTest` 6 项、`AssetPathsTest` 3 项；`NotesMigrationCheck` 覆盖 v1→v2 真库迁移。

验证：`testDebugUnitTest` 9 项通过；`assembleDebug`、`assembleDebugAndroidTest`、`lintDebug` 通过；v1 笔记和 v2 索引用 SQLite 实测保留。未在真机跑 `NotesMigrationCheck`。

### 接下来

- M2 主体已落地；下一轮做真实环境核对：用真实官方请求核对用量、服务端标题和长对话摘要，用配对电脑核对挂靠后的推送与历史。这些都要用户开工指令。
- 真机按路线图 M1 核对文字、链接、图片、小组件/快捷方式、检索、转对话和杀进程边界；语音 M1.5 等用户开工指令后实现。
- 长会话整体提交出现卡顿时，把提交拆成按会话/按消息的增量；M2.4 的摘要目前存在会话派生层，若需要独立查询再升表。

<a id="mobile-code-non-goals"></a>

## 不做

- 不整体改写 Kotlin/Compose，不引入 React/Vue/Vite 构建链。
- 不拆多 Gradle 模块，不做插件系统、通用事件总线、通用 ORM。
- 不预装 Room、Hilt、Retrofit、WorkManager、OkHttp；有实测需求再逐项评估。
- 不做 iOS、鸿蒙、平板/横屏。
- 不做后台模型调用、常驻前台服务、系统级悬浮窗。
- 不做静默重试、静默降级、默认值吞错。
- 不接厂商推送、统计、崩溃上报 SDK。
- 不为 M3～M7 提前建空包、空接口或 feature flag。

<a id="mobile-code-open"></a>

## 待确认

每项给出默认做法；用户没有另行指示时按默认推进。

| # | 事项 | 默认 |
| --- | --- | --- |
| 1 | 继续 WebView 混合，还是整体改原生 UI | 继续混合；只重写有实测问题的屏幕 |
| 2 | 会话状态何时迁到原生 | M2 与数据库迁移一起做；M1 不动聊天 |
| 3 | 数据库文件名 | 沿用 `assistant.db`，不因改名再做迁移 |
| 4 | 原生语言 | 本阶段保持 Java 17，不引 Kotlin/Compose |
