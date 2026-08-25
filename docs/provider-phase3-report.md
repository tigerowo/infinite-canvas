---
title: 连接中心第三阶段离线接入
description: 统一渠道接入、旧配置兼容和 Mock 契约测试结果
---

# 连接中心第三阶段离线接入

## 完成范围

- OpenAI 兼容、Gemini 原生和通用 HTTP 三类基础 adapter 已接入现有 `ModelChannel` 请求链。
- 画布、生图台和视频台共用连接中心 Provider 模型目录；前端旧 `localChannels` 仅作为脱敏运行时投影和兼容回退。
- Provider 加载、新增、更新、启停、删除、默认切换和迁移会统一刷新模型目录；退出登录会移除托管目录。
- 后端继续优先按 Provider ID 解析渠道，找不到 Provider 时兼容读取旧 `user_configs.model_config.localChannels`。
- 迁移仍由用户显式触发；同名、同协议和同 Base URL 的旧渠道在模型目录中自动去重，不删除原数据。

## 协议边界

- OpenAI 兼容协议按现有规则补齐 `/v1`，使用标准 Bearer 鉴权。
- Gemini 使用原生模型列表、`v1beta` 生成路径和 `x-goog-api-key`。
- 通用 HTTP 不隐式增加版本路径，直接在 Base URL 后追加项目标准业务路径；支持 API Key 或加密自定义请求头，不支持动态脚本和任意请求模板。
- 三类用户 Provider 均继续使用 SSRF 安全客户端和既有响应读取预算。

## 离线验证

本阶段没有调用真实 API。Go Mock 覆盖三类协议的模型列表 URL、鉴权头和响应解析，并覆盖无效 JSON、401、超过读取限制和超时。前端测试覆盖连接中心 Provider 到统一模型目录的脱敏映射。

| 命令 | 结果 |
| --- | --- |
| `go test ./...` | 通过 |
| `bun run test` 对应的 Vitest runner | 3 个测试文件、8 个测试通过 |

按项目 `AGENTS.md`，本轮未执行前端 typecheck 或生产构建，由用户在后续验收节点运行。

真实 API 验证必须在本阶段本地提交和 Git 备份完成后，由用户提供或确认沙盒凭据并明确授权。STITCH 实稿仍可在第三阶段 UI 对稿前补充，不阻塞当前适配器和数据源接入。
