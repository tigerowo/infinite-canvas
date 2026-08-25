---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 补齐 STITCH 桌面、窄屏、状态页与设计 token 实稿；当前仅按 2026-08-24 设计任务书完成代码侧视觉基线，尚无可核对的 STITCH 导出物。
- 为受控 Mac CLI helper 设计安装、交互登录、登录状态和真实模型调用的独立动作与确认界面；独立 Unix Socket 伴随进程、逐次 HMAC/nonce 防重放授权、响应签名、签名清单和二进制 SHA-256 校验已接入固定 `--version` 检测，当前仍不执行安装、登录或模型调用。
- 继续跟进异步视频供应商的正式远端取消协议；火山方舟 Seedance 排队任务和 RunningHub ComfyUI 任务已接入各自官方取消端点，Gemini Veo、MiniMax、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes 和通用 HTTP 尚无可确认的运行中取消契约，当前仍只停止本地轮询和网络读取。
- 逐步清理前端 ESLint 兼容基线警告，并继续增加组件级与浏览器端测试；当前已有正式 lint、typecheck、Vitest 脚本和任务取消服务契约测试，但尚未引入 React 组件或浏览器测试环境。
- 多实例部署前将进程内请求速率和并发预算迁移到共享限流存储；当前单机 SQLite 运行方式无需引入外部依赖。
