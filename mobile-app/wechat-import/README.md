# 星引 · 微信聊天文件

**备选方案，未发布。** 当前 Android 默认包不含微信 SDK 和此小程序入口。日用路径已改为微信的「用其他应用打开 → 星引」。以下是此前小程序候选及中转的记录，原 Android 连接代码保存在 `android-reference/`；仅填写属性不会给当前包开启小程序。

在星引讨论点「＋ → 微信聊天文件」，跳到微信选择器，由用户选择文件传输助手或其他聊天。微信决定哪些文件仍可用，不提供预选对话参数。每批最多 3 份，每份不超过 4 MiB；确认上传前不传输。「回到星引」按钮未唤起时，手动切回也会在原讨论领取。

## 本地核对

微信开发者工具导入**本目录**（含 `project.config.json`），填自己的小程序 AppID。`miniprogram/` 是发布根目录，中转服务和测试不打入小程序。独立打开时没有导入请求，不启动传输。

用 Node.js 24 在本目录运行 `node --test import.test.mjs`。测试执行实际小程序页面代码，微信 API 由夹具提供，HTTP 请求发往真实本地中转；核对两份同名文件的内容、丢回执重试、凭据隔离和过期。项目根目录运行 `node mobile-app/android/tools/check-ui.cjs .dev/mobile-v1/wechat-ui` 检查生产手机页面。2026-11-24 以上通过；微信 WXML/WXSS 编译、Android 构建、lint 和 APK 签名检查通过。没有登记、部署或使用私人微信文件；尚未完成真实微信与官方模型验收。

## 微信登记和运行配置

1. 在微信公众平台注册小程序，记下 **AppID** 和**原始 ID**（`gh_…`）。填写隐私保护指引，说明选中文件的用途、接收方、保留时间和删除方式；给测试微信账号体验或开发资格。
2. 在微信开放平台登记并通过审核的**移动应用**下配置 Android 包名 `app.alcor.mobile` 和实际 APK 的签名。移动应用 AppID 与小程序 AppID 不通用。[微信接入说明](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Launching_a_Mini_Program/Launching_a_Mini_Program.html)
3. 准备微信和手机都可访问、证书有效的 HTTPS 域名。在服务器用 Node.js 24 运行 `node relay.mjs`，从服务环境安全提供 `ALCOR_IMPORT_KEY`（32～128 位随机可打印字符）及可选 `PORT`（默认 8787）。进程仅监听回环地址。HTTPS 反向代理原样转发 `/v1/imports` 及子路径，允许至少 4 MiB 加表单开销，不缓存、不记录请求头、文件和凭据。单用户服务最多 8 批同时待领，内存暂存，重启后须重选；不用桌面 Hub。
4. 将 `miniprogram/config.js` 的 `origin` 设为该 HTTPS 来源（无路径、查询或尾斜杠），在微信后台把同一域名配置为 `request` 和 `uploadFile` 合法域名。小程序不保存签发导入请求的服务口令，不接触 DeepSeek Key。
5. 填写本地 Gradle 属性，重新构建并以已登记签名安装。未配置时 APK 仍可使用其他功能，微信入口明确提示未接入。

```properties
alcorWechatAppId=<已审核的移动应用AppID>
alcorWechatMiniId=<小程序原始ID>
alcorImportOrigin=<与小程序相同的HTTPS来源>
alcorWechatMiniType=2
```

微信环境：0 正式版，1 开发版，2 体验版；默认 0。Android 构建见[手机说明](../README.md)。在手机「微信聊天文件」页输入部署者提供的导入口令，手机使用 Android Keystore 加密保存。口令不能放进 Gradle、源码或小程序。

## 文件如何使用

手机持领取凭据，小程序只持上传凭据。完整确认一批文件后手机才能读取；文件按请求和序号保存到本机私有目录。原讨论落盘后再通知中转删除，未领取的文件 10 分钟过期。App 重开按原请求核对，不挂到其他讨论。

导入不调用模型。勾选并发送问题时，该轮使用手机现有的**官方 DeepSeek Key 和 `deepseek-flash`**；普通聊天仍用原配置。UTF-8 的 TXT、MD、CSV、JSON、LOG 每份不超过 128 KiB；JPEG、PNG、GIF、WebP 按图片处理，超过 1 MiB 时走官方 Files API。PDF、Word、PowerPoint 走官方文字解析（不含嵌图），Excel 走表格输入。上传到 DeepSeek Files 的文件设置 1 小时有效期。其他格式可导入，问答会提示不支持。附件不会自动派给电脑；可以从材料页移除本机副本。

## 真机验收

- 给文件传输助手发一份未另存的测试报价单和一张带独有图形的照片。从星引讨论发起，在微信选取、确认、切回；确认没选的文件不会出现。另测取消、过期文件及双开微信。
- 切换讨论或重开 App，核对文件只回到发起讨论，没有自动调用模型。模拟上传中断、回执丢失、中转重启；不能出现半批或重复附件。
- 分别只勾选照片、报价单，核对回答中的图形关系和报价金额，再核对 Markdown 原文。真实模型消耗和微信真机结果单独记录。
