---
title: 连接中心
description: Provider 数据边界、接口和现有 AI 调用链接入说明
---

# 连接中心

连接中心统一登记用户 API 与 CLI Provider。它扩展现有模型渠道，不替换图片、视频、音频或画布生成实现。

## 接口

以下接口均位于 `/api/v1` 并要求用户 JWT：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/providers?kind=api|cli` | 返回当前用户的脱敏 Provider 列表 |
| `GET` | `/providers/migration-preview` | 只读预览旧 `localChannels`，不返回密钥、不写库 |
| `POST` | `/providers` | 新建或更新 Provider；请求体带 `id` 时更新 |
| `POST` | `/providers/migrate` | 显式导入旧渠道；可选 `cleanupLegacy` 清理旧明文配置 |
| `POST` | `/providers/:id/default` | 设为同类型默认 Provider |
| `POST` | `/providers/:id/test` | 测试连接；`refreshModels=true` 时保存模型列表 |
| `POST` | `/providers/:id/cli/detect` | 仅本机回环请求可触发受控 CLI 版本检测 |
| `POST` | `/providers/:id/runninghub/tasks` | 提交 RunningHub 应用或工作流任务 |
| `GET` | `/providers/:id/runninghub/tasks/:taskId` | 查询 RunningHub 状态；成功时读取产物元数据 |
| `DELETE` | `/providers/:id` | 删除无历史引用的 Provider |

API 响应不包含 `apiKey` 或自定义请求头值，只返回 `hasApiKey`、固定 `apiKeyMasked`、`hasHeaders` 和请求头名称。更新时 API Key 或 `headers` 缺失表示保持原值；显式 `clearApiKey` / `clearHeaders` 才会清空。

## AI 调用链接入

登录用户在前端选择托管 Provider 后继续发送 `X-User-Model-Channel-ID`。后端 `SelectUserLocalModelChannelForModel` 优先按当前用户和 Provider ID 读取连接、解密凭据并构造现有 `ModelChannel`；找不到时才读取旧 `user_configs.model_config.localChannels`。

画布、生图台和视频台共用同一份连接中心模型目录。前端 Provider store 是登录用户的权威数据源，`AiConfig.localChannels` 只保存不含密钥的运行时投影和旧配置回退；Provider 新增、编辑、启停、删除、设为默认或迁移后都会同步刷新该投影。退出登录时会移除托管投影，未登录用户仍可使用浏览器中的旧本地直连配置。

托管 API Provider 的 Base URL 标记为用户输入，所有请求使用按 Base URL 约束的安全客户端：禁止环境代理、私网/回环/链路本地/CGNAT 地址和非 HTTP(S) 重定向，固定拨号到已检查的 DNS 结果，并阻止携带渠道凭据跨来源重定向。

## 统一协议 adapter

连接中心的统一模型调用支持以下基础协议：

| 协议 | URL 规则 | 鉴权 | 模型列表契约 |
| --- | --- | --- | --- |
| `openai` | Base URL 末尾没有版本时追加 `/v1` | `Authorization: Bearer <API Key>`，显式自定义 Authorization 优先 | `GET /models`，读取 `data[].id` |
| `gemini` | 使用原生 `/v1beta` 模型与生成路径 | `x-goog-api-key`，显式自定义请求头优先 | 原生分页 `models[].name` |
| `http` | Base URL 按原样追加业务路径，不隐式增加 `/v1` | API Key 默认使用 Bearer；也可完全使用加密自定义请求头 | `GET /models`，支持 `data[].id`、`models[].id`、`models[].name` 或字符串模型数组 |

通用 HTTP adapter 是“路径保持、请求体保持”的受控协议，不提供任意脚本、模板表达式或动态代码执行。画布、生图台和视频台仍发送项目现有的标准业务路径及请求体，上游需要实现相应 HTTP 契约。

## RunningHub adapter

RunningHub 使用独立协议，不会作为 OpenAI 兼容模型渠道同步。连接中的模型项填写 `app:<数字 ID>` 或 `workflow:<数字 ID>`，Base URL 只允许官方 `https://www.runninghub.ai` 或 `https://www.runninghub.cn`。

连接检测调用账户状态接口；任务提交与查询分别使用 RunningHub 应用/工作流、状态和产物接口。每次提交最多 1 个上游请求，每次查询最多 2 个上游请求并共享 4 MiB、45 秒预算；返回的产物 URL 只作为元数据交给调用方，不由后端继续抓取。适配器不接收 webhook URL，也不回显上游错误正文或凭据。

## CLI 边界

受控 Mac CLI helper 默认关闭，仅当 `CLI_HELPER_ENABLED=true`、请求来自本机回环地址且运行于 macOS 时可用。它只在固定候选名中检测 Codex、Gemini 或即梦 CLI，并执行固定的 `--version` 参数；用户保存的可执行程序字段不参与命令选择。

helper 不安装或登录 CLI，不读取 shell profile，不执行真实模型调用或任意参数。执行具有 5 秒超时、2 个并发槽位、16 KiB 输出上限和敏感词脱敏；可执行文件必须位于受控目录，解析后的普通文件不得允许组或其他用户写入。工作目录当前只作为元数据保存，不用于版本检测。

## 旧配置

旧 `localChannels` 继续兼容读取；同名、同协议和同 Base URL 的连接中心 Provider 存在时优先使用 Provider，避免模型选择器出现重复渠道。连接中心会显示只读迁移预览，用户确认后才在单个数据库事务中导入：

- 默认模式复制旧渠道并加密保存密钥，旧配置不变，便于回退。
- 去重同时比较名称、协议、规范化 Base URL 和密钥摘要；摘要只在内存中计算，不持久化或返回。
- `cleanupLegacy=true` 会将已导入或已复用的旧条目替换为托管引用，更新各能力的渠道 ID，并清除旧渠道及顶层配置中的明文 API Key；无效条目原样保留。
- 迁移本身不测试连接、不拉取模型，也不会调用真实渠道 API。
