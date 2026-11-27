# 文档地图

> 类型：阅读入口与文档状态
> 更新：2026-11-25（Asia/Shanghai）
> 用法：先看“现在要做什么”，再进对应专题；历史归档不作为新功能入口

## 状态说明

- **当前**：正在做或马上要做，内容会继续改。
- **已交付**：有真机、构建或运行证据；改动前先看验收范围。
- **规划**：方向已定，代码未完成或未验收。
- **原型**：只对齐交互与视觉，不是实现或验收证据。
- **历史**：保留追溯，不再按它推进新功能。

## 现在要做什么

| 目的 | 先读 | 状态 |
| --- | --- | --- |
| 手机下一步做什么、为什么 | [手机个人助手：定位、功能范围与实施设计](mobile-assistant-v2.md) | 当前 |
| 代码怎么分层、数据和桥怎么定、开发规范 | [手机端代码架构与开发规范](mobile-code-architecture.md) | 当前 |
| 每个阶段交付什么、怎么算通过 | [路线图：手机个人助手](roadmap.md#mobile-assistant-v2) | 当前 |
| 界面和交互长什么样 | [个人助手网页设计原型](../mobile-app/prototype-v2/README.md) | 原型 |
| 当前手机源码、构建与联调 | [手机端 App 开发](../mobile-app/README.md) | 当前 |

## 架构与跨端

- [架构入口与实施基线](architecture.md)：当前架构、已交付桌面边界、唯一维护位置。
- [开发路线与首版验收](roadmap.md)：手机首版、桌面交付、历史实验证据。
- [手机总管首版](mobile-manager-v1.md)：已交付的手机体验与跨端设计。
- [R3 设计沿革](r3-design-baseline.md)：跨端身份与原生归属的基础约束。

## 桌面

- [桌面端 App 开发](../desktop-app/README.md)：源码、构建、配置与测试。
- [桌宠「小引」](desktop-pet.md)：造型、动作与回执的对应、素材生成。
- [桌面架构详细方案](../mobile-app/from-home/docs/alcor-desktop-architecture.md)：桌面实施契约与历史基线。

## 规范与协作

- [项目协作约定](../AGENTS.md)：记录、实施和授权约定。
- [Git 推送与仓库维护规范](git-push.md)：提交、推送和清理范围。
- [原型自检](../mobile-app/prototype-v2/README.md#自检)：界面改动的截图与点击链检查。

## 历史归档

以下文档保留设计过程和实验证据，不再作为新功能的开发顺序。

- [推进循环架构](advance-loop-architecture.md) · [实施指南](advance-loop-implementation.md) · [角色契约](advance-loop-roles.md) · [实验规程](advance-loop-experiment.md)
- [原生循环目标架构](native-loop-target.md)
- [早期微信导入工程](../mobile-app/wechat-import/README.md)：备选，不随 Android 包构建。
- 首版网页原型：[mobile-app/prototype](../mobile-app/prototype/README.md)。

## 维护规则

- 新增文档先在本页登记，写清状态、入口和适用阶段；不把一次性记录放进当前入口。
- 当前主线只留一条：手机个人助手。旧循环、旧实验和旧工程放历史归档。
- 需求、设计、实现、验收分开写；只有真机或可核对证据支持的能力才标“已交付/已验收”。
- 文档之间用相对链接；改标题或锚点时同步搜索旧引用。
