---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 补齐 STITCH 桌面、窄屏、状态页与设计 token 实稿；当前仅按 2026-08-24 设计任务书完成代码侧视觉基线，尚无可核对的 STITCH 导出物。
- 为受控 Mac CLI helper 设计安装动作和分发流程；独立 Unix Socket、逐次授权、签名清单、固定版本检测、Codex 只读登录状态、浏览器 OAuth 及逐次确认的最小模型调用已接入，尚未实现 CLI 安装、helper 签名发布或真实人工验收。Gemini/即梦因缺少稳定非交互状态命令暂不开放。
- 继续跟进异步视频供应商的正式远端取消协议；火山方舟 Seedance 排队任务和 RunningHub ComfyUI 任务已接入各自官方取消端点，Gemini Veo、MiniMax、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes 和通用 HTTP 尚无可确认的运行中取消契约，当前仍只停止本地轮询和网络读取。
- 逐步清理前端 ESLint 兼容基线警告，并继续增加组件级与浏览器端测试；当前已有正式 lint、typecheck、Vitest 脚本和任务取消服务契约测试，但尚未引入 React 组件或浏览器测试环境。
- 多实例部署前将进程内请求速率和并发预算迁移到共享限流存储；当前单机 SQLite 运行方式无需引入外部依赖。
