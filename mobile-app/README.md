# 手机端 App 开发

首版面向 Android：打开即与总管对话或继续项目讨论；电脑全离线时，手机仍可使用 DeepSeek 对话、搜索和制作文本。需电脑执行的工作交给原项目中的 Codex 或 DSH，结果回到原讨论。

当前公开范围为 Android 0.1.0 预览版。见[首发范围和验证状态](../docs/roadmap.md)。

已交付首版的体验与验收见[首版体验与跨端架构](../docs/mobile-manager-v1.md)和[首版验收记录](../docs/roadmap.md#mobile-manager-v1)；下一阶段按下面的开发入口推进。

## 开发入口

下一阶段把手机端扩为个人助手（记一笔、新对话、工具、记忆、提醒等），这些功能尚未验收；M1 文字记录闭环已实现；M2 对话地基和 M3 工具循环第一切片已实现，真实接口完成一次联网工具调用，语音、写入类工具和系统权限页未开工。按顺序读：

1. [手机个人助手：范围与实施设计](../docs/mobile-assistant-v2.md)：下一步做什么、交互和功能边界。
2. [手机端代码架构与开发规范](../docs/mobile-code-architecture.md)：代码分层、数据归属、桥契约和规范。
3. [路线图：手机个人助手](../docs/roadmap.md#mobile-assistant-v2)：阶段交付与通过条件。
4. [个人助手网页设计原型](prototype-v2/README.md)：视觉与交互对照。

当前优先级：成品可用 → 交互流畅 → 还原原型 → 代码可维护。测试按风险选择，不追求全覆盖；界面改动以原型为准，改设计先改[界面设计建议](../docs/mobile-assistant-v2.md#v2-ui)。完整文档入口见[文档地图](../docs/README.md)。

2026-11-25 已完成代码整理和 M1 文字记录闭环：`AlcorApp`/`AppContainer`、`Notes` v3（收件箱/已归入/已归档）、`NativeBridge`/`MobileService` 拆桥、资源子目录白名单；WebView 新增 `features/notes` 收件箱、检索、详情、编辑、挂项目、Markdown 导出和转新对话材料，输入框与抽屉都能记一笔；系统分享文字、图标快捷方式和一行小组件已接入。JVM 测试、Debug APK、androidTest APK 和 lint 通过；生产 WebView 浏览器检查通过。真机全项取证和 M1.5 语音尚未完成。

M2.3 会话库迁移已实现并在既有版本的迁移测试中验证：`assistant.db` 升到 v4，一次性导入旧 `discussions.json` 并保留逐字节备份，之后会话和草稿只写数据库；迁移失败会留在旧文件并说明。M2.5 用量与花费、M2.1 官方会话标题、M2.2 挂靠项目、M2.4 上下文压缩已实现：答复下显示命中/未命中/输出/思考 token 与估算金额，新对话首轮取官方标题并在缺失时回退；未挂项目的手机对话可挂到已同步项目，只同步之后的消息，挂靠前不生成交接；长对话超出预算会整理成前情摘要，原文保留，摘要卡可查看原文或带摘要开新对话。解析单测和浏览器检查通过，真实模型和真实电脑未核对。结果见[路线图](../docs/roadmap.md#mobile-assistant-v2)。

## 当前能力

**离线记一笔。** 分享图片到星引并保存时，若应用在写入途中被强停，重开会清理尚未保存的副本；已有笔记和图片保留，重新分享后可以正常保存。用合成图片从系统分享进入「记一笔」，在复制一半时强停；重开后检查收件箱，再分享并保存，收件箱应只有一条，图片应能正常打开。V2338A 已验证小组件、系统分享和中断恢复；无需模型 Key。本次同步只覆盖离线记录，长录音和正式转写仍待验收。

**备份预览。** 中断预览后，星引重开时会清理遗留的解压副本，所选 ZIP 保留。可在「应用锁与备份」里选择一份带图片的合成备份，看到核对页后强停并重开，再选择原文件完成合并，检查照片和笔记原文。此路径在隔离 Android 16 上验证；实体手机通过系统选择器恢复仍待复验。

微信、QQ 文件在来源 App 里下载好后用「用其他应用打开 → 星引」；星引会先存到最近讨论的草稿。手机的「＋」也可选择本机文件和相册。收到文件后可以本地预览、换到新讨论，或点「总结要点」「整理成 Markdown」发送勾选的材料。ZIP 可读目录、受支持的 UTF-8 文本以及一张受限大小的图片，不运行其中的代码。电脑、小程序和中转均非必需。[早期小程序工程](wechat-import/README.md)只作备选，不随 Android 包构建。

在输入框上方点模型名可选 V4.1 Flash、V4 Pro 或自定义模型，思考强度可选 Low、High、Max 或关闭。手机默认 V4.1 Flash / High；官方聊天使用接口名 `deepseek-flash`。官方 Pro 不接收图片；遇到不兼容的材料会说明原因。附件只有在发送问题后才离开手机。

回复旁的导出按钮、工作回执和产物预览都可保存 Markdown 或用系统分享。「复制」保留正文；「复制导出内容」与文件内容一致，正文后附出处。最近预览过的桌面产物可在电脑离线时打开手机副本。

交互与视觉对齐用的[网页原型](prototype/README.md)（2026-11-24）覆盖首版四个体验目标的 10 个场景，含 App 图标与特殊图标；它只模拟回执，不能作为跨端验收证据。

下一阶段的界面见[个人助手网页设计原型](prototype-v2/README.md)（2026-11-25）：46 个场景，覆盖首版界面和 M1～M7，含小引、全景总览和设计规范。它同样只模拟回执，不是实现。

新应用源码位于 [android](android)，应用 ID 为 `app.alcor.mobile`，Android 8.0 及以上。DSH 原 Android 工程使用独立包名，可与星引并装；旧工程及数据保留在本机。

## 首次接入

1. 首次发送时，在「接入 DeepSeek」填自己的 Key。官方服务可直接填 Key；自定义网关在「模型与网关」填写完整 HTTPS Chat Completions 地址和模型名。例如，已有自定义端点用户可配置 `https://api.example.invalid/v1/chat/completions` 与 `deepseek-flash`。
2. 官方 DeepSeek 配置可以直接用同一把 Key 联网搜索。自定义网关可在「电脑 → 联网搜索」单独配置 Brave Search Key。来源可打开；未配置或请求失败时，星引保留原话并说明原因。
3. 手机和电脑接入同一网络。在桌面 0.2.1 的「设置 → 手机接入」选择可从手机访问的地址和要共享的项目，生成配对码，再到手机「配对一台电脑」粘贴。入口使用 TCP 49424；桌面可以撤销配对或关闭入口。电脑离线时仍可使用手机助手和本机记录。

附件问答使用工具时，后续请求仍在原问题处带同一份材料；已确认的文档上传只在本轮沿用。删除附件或撤销连接后，本轮不再发送。用生产界面回归和 Android 原生夹具复验；供应商上传以合成回执验证。

## 构建与验证

构建需要 JDK 17、Android SDK 36 和 Gradle 8.13。在项目根目录运行 `gradle -p mobile-app/android :app:assembleDebug`，生成 `mobile-app/android/app/build/outputs/apk/debug/app-debug.apk`。单测运行 `gradle -p mobile-app/android :app:testDebugUnitTest`；`NotesMigrationCheck` 和 `ChatImportCheck`（会话库迁移、备份字节核对、快照/提交往返、损坏文件拒绝）随 `MaterialsCheck` 在设备上执行。界面改动先跑 `node mobile-app/android/tools/check-ui.cjs`；协议改动再在 `desktop-app` 用 Node 24 跑 `node --import tsx --test tests/mobile.test.ts tests/dsh-desktop.test.ts`。两者按需运行，不替代真机验收。

需要验证原生键盘、返回、密钥库、TLS 固定证书和本地恢复时，在已启动的干净独立模拟器上安装签名调试 APK，再从 `desktop-app` 运行 `node --import tsx scripts/mobile-android-smoke.ts <ADB绝对路径> <ADB服务端口> <emulator-序列号>`。使用占位密钥和隔离 Hub，不访问真实模型；不是每次改动必跑。
