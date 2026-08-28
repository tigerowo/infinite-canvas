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
| `POST` | `/providers/:id/cli/detect` | 仅本机回环请求可触发受控 CLI 检测；Antigravity 同时只读拉取模型 |
| `POST` | `/providers/:id/cli/auth-status` | 仅本机回环请求可逐次授权检查受支持 CLI 的登录状态 |
| `POST` | `/providers/:id/cli/login` | 仅本机回环请求且请求体 `confirmed=true` 时可启动 Codex 浏览器 OAuth |
| `POST` | `/providers/:id/cli/model-probe` | 仅本机回环请求且请求体 `confirmed=true` 时可启动一次 Codex/Antigravity 固定最小调用 |
| `POST` | `/providers/:id/cli/completions` | 仅本机回环请求可为无限画布启动一次受控 Antigravity 文本任务 |
| `POST` | `/providers/:id/cli/model-probe/:taskId/status` | 读取当前用户与 Provider 绑定的最小调用状态 |
| `POST` | `/providers/:id/cli/model-probe/:taskId/cancel` | 取消当前用户与 Provider 绑定的最小调用 |
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

受控 Mac CLI helper 默认关闭，仅当 `CLI_HELPER_ENABLED=true`、请求来自本机回环地址且运行于 macOS 时可用。启用时还必须配置绝对路径 `CLI_HELPER_MANIFEST`、绝对路径 `CLI_HELPER_SOCKET`，以及公钥和共享密钥。开发环境可直接使用 `CLI_HELPER_PUBLIC_KEY` 与 `CLI_HELPER_SHARED_SECRET`；正式安装优先使用权限为 `0600` 的 `CLI_HELPER_PUBLIC_KEY_FILE` 与 `CLI_HELPER_SHARED_SECRET_FILE`，避免把凭据正文放进 LaunchAgent、命令行或环境文件。它只在固定候选名中检测 Codex、官方 Antigravity `agy` 或即梦 CLI，并执行 allowlist 中的固定参数；用户保存的可执行程序字段不参与命令选择。

Web 后端不再直接启动本机 CLI。独立伴随进程入口为 `cmd/infinite-canvas-cli-helper`，只监听本机 Unix Socket；Socket 所在目录必须已存在且权限不向组或其他用户开放，Socket 启动后固定为 `0600`。先启动伴随进程，再启动 Go Web 后端：

```bash
go run ./cmd/infinite-canvas-cli-helper
go run .
```

helper 不安装 CLI、不读取 shell profile，也不接受任意命令。伴随进程允许固定 `--version` 检测、Codex `login status`、用户确认后的固定 `codex login`，以及受控模型调用；Antigravity 额外允许只读 `agy models`，其成功结果同时作为非交互登录状态并保存最多 64 个受校验模型名。可执行文件必须位于受控目录，解析后的普通文件不得允许组或其他用户写入，文件大小不得超过 256 MiB，并且 SHA-256 必须与签名清单一致。工作目录字段只作为元数据保存，模型调用始终进入新建私有临时目录。

每次 Web 请求只生成一个 `version`、`auth-status`、`login-start`、`model-probe-start`、`completion-start`、`model-probe-status` 或 `model-probe-cancel` 动作授权，授权正文绑定用户 ID、Provider ID、协议、动作及必要的任务 ID；completion 还绑定受校验模型名和最多 24 KiB 的画布提示词。Web 后端使用共享密钥对“Unix 时间戳、随机 nonce、请求体 SHA-256”生成 HMAC-SHA256；伴随进程要求时间偏差不超过 30 秒，并在内存中保留已使用 nonce 两分钟。响应体同样绑定请求 nonce 并使用 HMAC-SHA256 签名，Web 后端验证后才读取结果。请求与响应均限制为 32 KiB，启动动作只负责启动受控后台进程，进程由伴随进程生命周期托管。

Codex 最小调用固定执行 `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --output-last-message <临时文件> <固定提示词>`。Antigravity 最小调用和画布文本任务固定使用 `agy --print <提示词> --output-format json --model <已拉取模型> --effort low --print-timeout 90s --disable-slash-commands --mode plan --sandbox`；仅画布入口接受受限的结构化画布上下文，不接受命令、执行路径或额外 CLI 参数。全局只允许一个活动调用，deadline 为 2 分钟，最终输出脱敏并限制为 4 KiB；完成状态保留 10 分钟，取消会终止本地 CLI 子进程。

可信清单是一个不超过 64 KiB 的 JSON envelope：

```json
{
  "payload": "<Base64 编码的清单 JSON 原始字节>",
  "signature": "<对 payload 原始字节生成的 Base64 Ed25519 签名>"
}
```

解码后的 payload 结构如下；`expiresAt` 必须为未来的 RFC 3339 时间，`sha256` 为解析软链接后实际可执行文件的小写十六进制摘要：

```json
{
  "version": 1,
  "expiresAt": "<未来的 RFC 3339 时间>",
  "executables": [
    { "protocol": "codex", "candidate": "codex", "sha256": "<64 个十六进制字符>" }
  ]
}
```

清单不保存私钥、登录凭据或 API Key。私钥只用于离线签名，不应放入项目目录、环境文件或 Git。清单签名错误、过期、缺少当前协议或文件哈希不一致时，helper 返回不可用且不会启动 CLI。

仓库提供离线清单工具 `cmd/infinite-canvas-cli-manifest`，以及 `scripts/macos/` 下的 Developer ID 发布、当前用户安装和显式卸载脚本。安装器验证 Apple 代码签名与 Team ID，注册 LaunchAgent，并生成只包含配置路径的 `backend.env`。完整流程见 [Mac CLI helper 安装与签名发布](cli-helper-macos.md)。

共享密钥属于本机进程凭据，只能保存在权限为 `0600` 的共享密钥文件、被忽略的本地 `.env`、受保护的启动环境或系统钥匙串中，不得写入文档、日志或 Git。安装只通过用户显式运行的本机脚本完成，Web UI 和 helper API 不开放安装动作。页面不接收 API Key、Access Token 或 OAuth 授权码。Antigravity 登录仍由用户直接在官方 CLI 完成；无限画布只能选择 `agy models` 返回并保存的模型。即梦缺少稳定结果协议，因此不开放登录或模型调用动作。

## 旧配置

旧 `localChannels` 继续兼容读取；同名、同协议和同 Base URL 的连接中心 Provider 存在时优先使用 Provider，避免模型选择器出现重复渠道。连接中心会显示只读迁移预览，用户确认后才在单个数据库事务中导入：

- 默认模式复制旧渠道并加密保存密钥，旧配置不变，便于回退。
- 去重同时比较名称、协议、规范化 Base URL 和密钥摘要；摘要只在内存中计算，不持久化或返回。
- `cleanupLegacy=true` 会将已导入或已复用的旧条目替换为托管引用，更新各能力的渠道 ID，并清除旧渠道及顶层配置中的明文 API Key；无效条目原样保留。
- 迁移本身不测试连接、不拉取模型，也不会调用真实渠道 API。
