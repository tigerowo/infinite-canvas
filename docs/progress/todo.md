---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

- 使用正式 Apple Developer ID 和公证配置构建、安装并验收 Mac CLI helper 发布包；代码已提供离线 Ed25519 清单工具、universal 二进制签名发布脚本、Team ID 校验安装器、LaunchAgent、共享密钥文件和显式卸载器，但本轮没有可用签名身份，因此未生成或安装正式发布包，也未实际触发 OAuth 或模型调用。Gemini/即梦因缺少稳定非交互状态命令暂不开放。
- 继续跟进异步视频供应商的正式远端取消协议；火山方舟 Seedance、RunningHub ComfyUI 和 MiniMax H3 排队任务已接入各自官方取消端点，Gemini Veo、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes、其他 MiniMax 协议和通用 HTTP 尚无可确认的运行中取消契约，当前仍只停止本地轮询和网络读取。
- 逐步清理前端 ESLint 兼容基线警告，并继续扩展浏览器端测试；当前已有正式 lint、typecheck、Vitest 脚本、任务取消服务契约测试、连接中心 React 组件状态测试，以及覆盖基础状态、API 抽屉、迁移预览、生图/视频模型来源、连接测试、编辑、复制和删除的 Playwright Mock 回归，后续再覆盖画布模型选择链路。
- 在正式多实例环境配置共享 Redis，并用至少两个后端实例执行运行时限流演练；共享速率和并发预算代码、跨实例 Mock 契约与安全失败策略已完成，当前本机单实例未配置真实 Redis。
- 修正当前账号剩余的无效旧渠道 Base URL 后执行真实迁移；本轮已在仓库外创建 SQLite 一致性备份并完成脱敏预览，但候选因 Base URL 无效不可导入，未猜测修正或清理明文密钥。
