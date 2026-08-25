---
title: 连接中心第四阶段真实渠道最小验证与任务可靠性
description: 运行时调用链、任务安全预算、Mock 与真实 API 验证分级结果
---

# 连接中心第四阶段真实渠道最小验证与任务可靠性

## 结论

第四阶段的非计费可靠性工作已经完成。开始时目标分支为 `codex/provider-center-mac`，HEAD 为 `809f7116cc472f18aa507e0856a32bf6f7ec7eb5`，工作区干净，阶段三 Git bundle `/Users/danchen/infinite-canvas-provider-stage3-pre-api-809f711.bundle` 存在。

阶段开始时本机没有已配置 Provider、旧 `localChannels` 或 provider 类环境变量。后续用户在连接中心安全配置 RunningHub 和 OpenAI 兼容渠道后，RunningHub 完成一次账户检测和一次真实工作流任务，`gpt-image-2` 与 OpenOx 的 Gemini 图片兼容模型分别完成一次最低成本生图。请求均只提交一次，没有自动重试。没有读取未知钥匙串项，也没有在终端、浏览器、报告或 Git 中输出密钥。本轮界面与报告收尾前的代码基线为 `bcf4079`。

## 本地环境与启动

| 组件 | 版本或配置 |
| --- | --- |
| macOS | darwin/arm64 |
| Go | 1.25.0 |
| Node.js | 24.19.0 |
| Bun | 1.3.14 |
| 前端 | Next.js 16.2.9 |
| 数据库 | SQLite；本地忽略文件 `data/infinite-canvas.db` |

实际启动命令：

```bash
GOTOOLCHAIN=local /Users/danchen/.cache/infinite-canvas-baseline-runtime/go1.25.0/bin/go run .

cd web
PATH=/Users/danchen/.cache/infinite-canvas-baseline-runtime/shims:$PATH \
  /Users/danchen/.cache/infinite-canvas-baseline-runtime/bun-1.3.14/bun-darwin-aarch64/bun run dev
```

Go 后端监听 `http://127.0.0.1:8080`，Next.js 监听 `http://127.0.0.1:3000`。后端、前端代理和 SQLite 均正常启动。

## 运行时调用链

连接中心到三个生成入口继续复用第三阶段统一链路：

1. `/providers` 通过 `/api/v1/providers` 读取用户 Provider，接口只返回脱敏视图。
2. `useEffectiveConfig` 把 Provider 模型目录投影为托管 `localChannels`，云端模式合并系统公共渠道与连接中心用户渠道；未登录或 Provider 不可用时保留旧本地配置回退。
3. 画布、生图台和视频台使用同一模型目录和渠道 ID；生成前确认框显示渠道、模型、任务类型和协议，不展示 API Key 或自定义请求头。
4. 登录用户请求通过 `X-User-Model-Channel-ID`，云端系统渠道使用 `X-Model-Channel-ID`。
5. Go handler 调用 `selectAIRequestChannel`，优先解析 Provider；Provider 不存在时继续兼容读取旧用户配置。
6. OpenAI 兼容、Gemini、通用 HTTP、RunningHub 及已有生成协议 adapter 使用现有请求转换、鉴权、响应解析和 AI 调用日志链。
7. 用户 Provider 使用 SSRF 安全 transport；DNS 解析后的回环、私网、链路本地、CGNAT 等地址被拒绝，携带凭据的重定向只允许同源。

## 页面与接口验证

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 登录 | 通过 | 使用本地忽略 `.env` 中的管理员凭据，经 Next.js 代理登录成功，`/api/auth/me` 返回管理员角色；未输出用户名、密码或 JWT。 |
| 无限画布 | 通过 | `/canvas` 正常渲染画布库。 |
| 生图工作台 | 通过 | `/image` 正常渲染模型、接口模式、参考图、质量、尺寸和生成数量。 |
| 视频创作台 | 通过 | `/video` 正常渲染模型、参考媒体、分辨率、尺寸和任务数量。 |
| 提示词库 | 通过 | `/prompts` 正常渲染现有提示词和筛选入口。 |
| 素材库 | 通过 | `/assets` 正常渲染类型筛选、导入、导出和新增入口。 |
| 连接中心 | 通过 | 管理员登录后完成 RunningHub 与 OpenAI 兼容 Provider 配置；云端模型列表可选择并保存连接中心的 `gpt-image-2`，DTO 仅显示密钥已保存状态，不返回明文。 |
| 活动任务 | 通过 | 视频和画布图片活动任务均为 0，新增取消路由随 Go 服务正常注册。 |
| 生成前确认 | 自动化通过 | 前端测试确认摘要只包含渠道、模型、任务类型和协议，不包含密钥；云端模式的连接中心用户渠道也显示真实渠道名称。 |

## 任务可靠性

任务状态统一对外归一为：

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `timed_out`

旧的 `pending`、`processing`、`completed`、`canceled` 等值仍可读取并映射为上述状态，不修改旧配置或执行数据库迁移。

新增取消接口：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `POST` | `/api/v1/video-tasks/:id/cancel` | 原子写入 `cancelled`，停止当前轮询网络请求并阻止陈旧轮询结果覆盖。 |
| `POST` | `/api/v1/canvas/image-tasks/:id/cancel` | 原子写入 `cancelled`，取消当前图片请求。 |
| `POST` | `/api/v1/canvas/audio-tasks/:id/cancel` | 原子写入 `cancelled`，取消当前音频请求。 |

删除活动视频或图片任务时也会先传播本地取消。同步画布图片和音频任务使用 5 分钟总体 deadline；持久化视频任务继续使用自创建起 30 分钟、360 次轮询、32 MiB 累计读取和单次 1 MiB 限制。画布任务的代理响应在写入内存 recorder 时即限制为 32 MiB，不再先缓存完整上游响应。

单用户活动生成任务上限继续为 8 个，创建中的预留槽位也计入；HTTP 入口还受每用户每分钟 60 次、并发 4 的请求预算。

## 错误映射与脱敏

| 上游状态 | 安全映射 |
| --- | --- |
| 401 | 鉴权失败，检查 API Key |
| 403 | 拒绝访问，检查套餐或模型权限 |
| 429 | 限流或额度不足 |
| 5xx | 上游暂时不可用，并保留状态码 |

结构异常、超时和超大响应继续返回固定安全错误。Bearer、常见 API Key/Token/Secret 赋值、敏感 URL 查询参数、`sk-` 与 Gemini 风格密钥会在普通日志、AI 调用日志、任务错误详情和用户可见上游错误中脱敏。

用户渠道 Base URL 仍拒绝 URL 用户信息和 fragment；自定义请求头拒绝 CR/LF 注入。安全 transport 对每次 DNS 解析结果检查 SSRF 边界，并阻止携带渠道凭据跨来源重定向。

## 验证分级

### 自动化测试通过

| 命令 | 结果 |
| --- | --- |
| `go test ./...` | 通过；`config`、`handler`、`middleware`、`router`、`service` 均通过。 |
| `bun run test` | 通过；5 个测试文件、13 个测试。 |

覆盖范围包括六态归一、取消与陈旧轮询竞态、连接/总体超时、请求和响应读取限制、并发上限、401/403/429/5xx、异常 JSON、日志脱敏、SSRF IP 分类、跨来源重定向、Header 注入和旧配置迁移演练。

### Mock 验证通过

- OpenAI 兼容：模型列表路径、Bearer 头和模型解析。
- Gemini 原生：`v1beta/models`、`x-goog-api-key` 和模型解析。
- 通用 HTTP：原样 Base URL、标准模型路径、自定义鉴权头和响应解析。
- RunningHub：沿用阶段三前已完成的本地模拟提交、查询、状态和累计读取预算测试。
- 失败场景：无效 JSON、401、403、429、502、响应过大和超时。

### 真实 API 验证通过

| 协议 | 结果 |
| --- | --- |
| RunningHub | 一次账户检测成功；模型拉取不适用于 App/Workflow 引用模式；一次真实 `workflow:1997246493079834625` 图片任务成功，任务只提交一次并返回 1 个 PNG。 |
| OpenAI 兼容 | `gpt-image-2` 完成一次连接测试、模型拉取和最低成本生图，连接中心到生图台的完整链路成功。OpenOx 的 `gemini-3.1-flash-image-preview` 返回 Markdown 包裹的图片 Data URL；解析兼容问题修复并重启 Go 后端后，真实 UI 复验成功，页面显示 1 张图片，单次任务耗时约 1 分 10 秒。 |

### 因缺少凭据未验证

| 协议 | 连接测试 | 模型拉取 | 最低成本请求 |
| --- | --- | --- | --- |
| OpenAI 兼容 | 已通过 | 已通过 | `gpt-image-2` 与 OpenOx Gemini 图片兼容模型均已通过 |
| Gemini 原生 | 未执行 | 未执行 | 未执行 |
| RunningHub | 已通过 | 不适用引用模式 | 已通过 |
| 通用 HTTP | 未执行 | 未执行 | 未执行 |

当前 SQLite 已保存用户配置的 Provider，凭据仅保存在被 Git 忽略的本地数据库中；`.env` 没有 provider 类变量。为避免未知钥匙串查询意外回显，本阶段没有宽泛扫描系统钥匙串。

### 因 AGENTS.md 限制未执行

- 未运行 `bun run build`。
- 未运行 `bun run typecheck`。
- 未运行 `bun run lint`，也未清理历史 ESLint warning。
- 未运行 Prettier 写入或批量格式化。

本阶段用户明确要求的 Go、前端、Mock 和安全测试均已运行；构建、类型检查和 lint 留给用户验收。

## 旧配置回退

前端 `use-config-store` 测试继续覆盖 Provider 托管目录优先、禁用或缺失时回退旧 `localChannels`；后端迁移 HTTP 演练继续覆盖脱敏预览、导入、清理和再次预览。当前用户数据库没有旧渠道，因此本轮没有写入、清理或迁移真实用户配置。

## 已知限制与下一步

- Gemini 原生和通用 HTTP 的最低成本真实请求仍待验证；已通过的 OpenOx Gemini 图片请求属于 OpenAI 兼容协议，不替代 Gemini 原生协议验证。准备凭据时应写入被 Git 忽略的本地配置或系统钥匙串，不应粘贴到对话中。
- 生图工作台结果区已优化成功、生成中和失败状态层级，结果图片改为完整比例展示；连接中心增加连接数量、已连接数量和请求防护状态概览。该视觉调整不改变生成协议或数据结构。
- OpenOx 本次返回的是临时 Data URL，完成时可以显示，但未主动同步到云端或素材库的结果不会随账号历史长期保存；刷新后历史卡片会保留成功记录并明确提示“临时结果未同步”，不再误报为生成失败。
- 通用视频上游没有统一取消协议。本阶段能停止本地轮询和当前网络读取，但已提交的异步上游任务可能继续运行；需要按供应商 adapter 增加显式 cancel API 后才能保证远端终止。
- 前端已提供取消 API service，但当前主要交互仍以删除任务/记录为主；如需保留 `cancelled` 卡片，应增加独立“取消任务”按钮。
- 生成前确认框已经接入画布、生图台、视频台及重试入口；正式有渠道后需人工确认渠道名称、模型和任务类型与实际请求一致。
- Next.js 开发模式在生图台报告一次既有 hydration warning：浮动工作流按钮的服务端默认位置与浏览器保存位置不同；页面仍可使用，本阶段没有顺带修改该无关状态恢复逻辑。
- 不开始 Tauri，不修改线上部署，不推送分支。
