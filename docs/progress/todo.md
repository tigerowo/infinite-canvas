---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 补齐 STITCH 桌面、窄屏、状态页与设计 token 实稿；当前仅按 2026-08-24 设计任务书完成代码侧视觉基线，尚无可核对的 STITCH 导出物。
- 使用正式 Apple Developer ID 和公证配置构建、安装并验收 Mac CLI helper 发布包；代码已提供离线 Ed25519 清单工具、universal 二进制签名发布脚本、Team ID 校验安装器、LaunchAgent、共享密钥文件和显式卸载器，但本轮没有可用签名身份，因此未生成或安装正式发布包，也未实际触发 OAuth 或模型调用。Gemini/即梦因缺少稳定非交互状态命令暂不开放。
- 继续跟进异步视频供应商的正式远端取消协议；火山方舟 Seedance 排队任务和 RunningHub ComfyUI 任务已接入各自官方取消端点，Gemini Veo、MiniMax、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes 和通用 HTTP 尚无可确认的运行中取消契约，当前仍只停止本地轮询和网络读取。
- 逐步清理前端 ESLint 兼容基线警告，并继续增加组件级与浏览器端测试；当前已有正式 lint、typecheck、Vitest 脚本和任务取消服务契约测试，但尚未引入 React 组件或浏览器测试环境。
- 多实例部署前将进程内请求速率和并发预算迁移到共享限流存储；当前单机 SQLite 运行方式无需引入外部依赖。
