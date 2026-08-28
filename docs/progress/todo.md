---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 使用正式 Apple Developer ID 和公证配置构建、安装并验收 Mac CLI helper 发布包；个人自用的隔离开发安装模式已完成安装、登录状态检查及一次端到端 Codex CLI 最小真实调用。本轮没有可用签名身份，因此仍未生成或验收正式发布包。Gemini/即梦已补固定版本检测与无限画布安全边界测试；取得稳定的非交互登录、生成命令和结构化结果协议前仍不开放真实画布调用。
- 继续跟进异步视频供应商的正式远端取消协议；火山方舟 Seedance、RunningHub ComfyUI 和 MiniMax H3 排队任务已接入各自官方取消端点，Gemini Veo、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes、其他 MiniMax 协议和通用 HTTP 尚无可确认的运行中取消契约，当前仍只停止本地轮询和网络读取。
- 逐步清理前端 ESLint 兼容基线警告，并继续扩展浏览器端测试；当前已有正式 lint、typecheck、Vitest 脚本、任务取消服务契约测试、连接中心 React 组件状态测试，以及覆盖基础状态、API 抽屉、迁移预览、生图/视频/画布模型来源、连接测试、编辑、复制和删除的 Playwright Mock 回归。
- 正式多实例部署前配置持久受控 Redis、独立前缀、容量与可用性监控、告警和运维故障演练；本机临时 Redis 双后端运行时验收已通过，不替代生产环境验证。
