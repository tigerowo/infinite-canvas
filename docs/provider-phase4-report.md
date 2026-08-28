---
title: 连接中心第四阶段真实渠道最小验证与任务可靠性
description: 运行时调用链、任务安全预算、Mock 与真实 API 验证分级结果
---

# 连接中心第四阶段真实渠道最小验证与任务可靠性

## 结论

第四阶段的非计费可靠性工作已经完成。开始时目标分支为 `codex/provider-center-mac`，HEAD 为 `809f7116cc472f18aa507e0856a32bf6f7ec7eb5`，工作区干净，阶段三 Git bundle `/Users/danchen/infinite-canvas-provider-stage3-pre-api-809f711.bundle` 存在。

阶段开始时本机没有已配置 Provider 或 provider 类环境变量。后续用户在连接中心安全配置 RunningHub、OpenAI 兼容、Gemini 原生与通用 HTTP 渠道后，RunningHub 完成一次账户检测和一次真实工作流任务，`gpt-image-2` 与 OpenOx 的 Gemini 图片兼容模型分别完成一次最低成本生图，Gemini 原生与通用 HTTP 分别完成最低成本文本生成。每个真实请求均只提交一次，没有自动重试；需要更换模型或提高输出预算时均再次取得用户明确确认。没有读取未知钥匙串项，也没有在终端、浏览器、报告或 Git 中输出密钥。全量自动化验收提交为 `dd34c95`；其后的 STITCH 最终视觉收敛使用登录后的真实 Provider 数据完成桌面、390px、深浅色与编辑抽屉人工复核。外部条件收尾又补充了正式浅色 STITCH 变体、内联图片本地持久化、MiniMax H3 排队任务取消、可选 Redis 共享预算和浏览器 Mock 回归。最新功能性提交 `de29ac8` 进一步覆盖连接中心图片模型进入无限画布配置节点选择器，并再次通过六项全量验收。随后已用临时 Redis 和两个隔离后端实例完成共享请求预算运行时演练，并在仓库外备份 SQLite 后完成当前账号剩余旧渠道的真实迁移与明文凭据清理；两项操作均未调用模型或修改线上部署。其后 Antigravity `agy` 通过本机开发 helper 同步 14 个受控文本模型；普通文本节点首次验证在本机旧聊天渠道选择阶段失败、未到达模型，修复专用 CLI 分流后，用户确认的唯一一次 `gemini-3.5-flash-low` “只回复 OK”请求成功回写 `OK`。画布创作 Agent 随后修复为优先继承当前画布文本配置节点，并正确识别“不要执行”类请求；用户确认的同一最小请求在右侧 Agent 面板显示 `OK`，未执行画布操作。

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
8. 已连接的 Antigravity CLI 文本模型不进入旧聊天代理：画布 Agent 与普通文本节点均经 `/api/v1/providers/:id/cli/completions` 启动受控任务，再读取绑定任务状态；Agent 优先使用当前画布文本配置节点的模型和渠道；helper 负责固定参数、2 分钟 deadline、单任务并发、4 KiB 脱敏输出和取消传播。

## 页面与接口验证

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 登录 | 通过 | 使用本地忽略 `.env` 中的管理员凭据，经 Next.js 代理登录成功，`/api/auth/me` 返回管理员角色；未输出用户名、密码或 JWT。 |
| 无限画布 | 通过 | `/canvas` 正常渲染画布库。 |
| 无限画布 Antigravity 文本节点 | 通过 | 选择 `gemini-3.5-flash-low` 后，用户确认的一次“只回复 OK”请求经受控 CLI task 回写 `OK`；第一次旧路径失败未到达模型，修复后没有自动重试。 |
| 无限画布 Antigravity 创作 Agent | 通过 | 当前画布文本配置节点的 `gemini-3.5-flash-low` 经受控 CLI task 返回 `OK`；明确“不执行任何画布操作”不会再被误判为工具调用，右侧面板显示结果且未改动画布。 |
| 生图工作台 | 通过 | `/image` 正常渲染模型、接口模式、参考图、质量、尺寸和生成数量。 |
| 视频创作台 | 通过 | `/video` 正常渲染模型、参考媒体、分辨率、尺寸和任务数量。 |
| 提示词库 | 通过 | `/prompts` 正常渲染现有提示词和筛选入口。 |
| 素材库 | 通过 | `/assets` 正常渲染类型筛选、导入、导出和新增入口。 |
| 连接中心 | 通过 | 管理员登录后完成 RunningHub 与 OpenAI 兼容 Provider 配置；云端模型列表可选择并保存连接中心的 `gpt-image-2`，DTO 仅显示密钥已保存状态，不返回明文。 |
| STITCH 最终视觉复核 | 通过 | 桌面表格实测数据行 75px，长模型名单行截断；390px 使用 16px 留白与卡片间距、12px 圆角、180px 模型值截断和底部状态区；桌面抽屉 440px、窄屏全宽，页面无横向溢出。深色按正式母稿核对，浅色已补齐同一设计系统下的桌面、列表与编辑正式变体。 |
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

单用户活动生成任务上限继续为 8 个，创建中的预留槽位也计入；HTTP 入口还受每用户每分钟 60 次、并发 4 的请求预算。默认使用单进程计数；配置 `REQUEST_BUDGET_REDIS_URL` 后，固定窗口与并发租约由 Redis 跨实例共享，主体标识先做 SHA-256 摘要，Redis 启动或运行故障会安全失败而不静默降级。

本机运行时演练使用仅绑定回环地址的临时 Redis 7.4 容器、随机密码、隔离 DB/前缀、两个后端实例和全新临时 SQLite 数据库，不复制用户数据库、不读取 Provider，也不调用真实渠道。跨实例速率测试中前 60 次请求通过，第 61 次返回 429；四个并发租约占满后第五次返回 429，释放后恢复 200；暂停 Redis 后请求约 10 秒返回 503，恢复 Redis 后另一实例重新返回 200。演练结束后临时容器、后端进程、端口和目录均已清理，Docker Desktop 已退出。

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
| `go test ./...` | 通过；`config`、`handler`、`middleware`、`router`、`service` 及 CLI helper/签名清单契约均通过。Mac 测试夹具显式使用 `0700` 私钥目录和短 Unix Socket 路径，异步模型探测等待窗口调整为 5 秒；生产权限、签名和任务 deadline 未放宽。 |
| `vitest run` | 通过；此前 9 个测试文件、29 个测试通过；本次 Antigravity 画布增量复跑为 11 个测试文件、35 个测试全部通过，覆盖 CLI adapter 与“不执行任何画布操作”否定语义回归。 |
| `playwright test` | 通过；9 个 Chromium Mock 浏览器用例全部通过，总耗时 1.6 分钟；覆盖编辑、模型拉取、复制不继承密钥、删除确认，以及连接中心模型进入生图台、视频台和无限画布。 |
| `tsc --noEmit` | 通过；统一渠道请求头返回类型收敛为 `Record<string, string>`，修复 `fetch` 的 `HeadersInit` 类型阻断。 |
| `eslint .` | 通过；0 error、117 个既有 warning，未做无关历史清理。 |
| `next build` | 通过；首次因隔离运行时未把 Node 加入子进程 PATH 而失败，补入同一受控 Node 目录后 Next.js 16.2.9 Turbopack 编译、TypeScript、20 个静态页面生成及路由优化全部完成。 |

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
| Gemini 原生 | 使用官方 `generativelanguage.googleapis.com` 端点完成一次连接测试和一次模型拉取。首次最低成本请求使用 `gemini-2.5-flash-lite`，Google 返回该模型不再向新用户开放；未自动重试。用户再次确认后改用 `gemini-3.5-flash-lite` 发起一次文本请求，返回 `OK`、`STOP`，连接中心到 Gemini 原生生成接口的完整链路通过。 |
| 通用 HTTP | 使用 OpenOx 标准业务路径完成一次连接测试和一次模型拉取，返回 `gemini-3.1-pro-preview` 与 `gemini-3.5-flash`。最低成本请求均由用户逐次确认：8 tokens 请求到达上游但以 `length` 结束且无可见文本；64 tokens 请求遇到上游 `EOF`；最终 128 tokens 请求返回 `OK`、`stop`，通用 HTTP adapter 的真实生成链路通过，过程没有自动重试。 |

### 因缺少凭据未验证

无。当前阶段具备本地安全凭据的四类优先协议均已完成对应真实验证；报告没有把未配置协议或 Mock 结果标记为真实通过。

当前 SQLite 已保存用户配置的 Provider，凭据仅保存在被 Git 忽略的本地数据库中；`.env` 没有 provider 类变量。为避免未知钥匙串查询意外回显，本阶段没有宽泛扫描系统钥匙串。

### 因 AGENTS.md 限制未执行

无。用户已明确授权本轮执行全量 Go、Vitest、Playwright、typecheck、lint 和生产 build。未运行 Prettier 写入或批量格式化，因为不属于验收命令且会造成无关改动。

## Git 收尾检查

- `git diff --check` 通过；阶段分支包含 MiniMax H3 取消、Redis 共享请求预算、生图内联结果持久化、Playwright 回归及对应配置和阶段文档，不包含无关业务改动。
- Git 跟踪的环境变量文件只有无密钥模板 `.env.example`；本地 `.env`、SQLite `data/infinite-canvas.db`、AI 调用日志和 `web/test-results/` 均由 `.gitignore` 排除。
- 没有 Git 跟踪的 SQLite、用户素材、Playwright 报告、测试截图、trace 或本地日志；常见 OpenAI、Gemini、GitHub、AWS 和私钥格式的跟踪文件扫描结果为 0。
- 第四阶段完整 bundle 输出到仓库外的 `/Users/danchen/infinite-canvas-provider-phase4-complete.bundle`，保留此前 bundle 且不包含工作区未跟踪或被忽略的本地数据。

## 旧配置回退

前端 `use-config-store` 测试继续覆盖 Provider 托管目录优先、禁用或缺失时回退旧 `localChannels`；后端迁移 HTTP 演练继续覆盖脱敏预览、导入、清理和再次预览。最终真实迁移前已使用 SQLite 一致性备份创建仓库外文件 `/Users/danchen/infinite-canvas-phase4-before-legacy-migration-20260828-112618.db`，权限为 `0600`，完整性检查通过，SHA-256 为 `eed051f9588f3446cf3ebb3d5d088f95299b77e837312397adb66a30c5175b80`。

用户确认复用当前 `gpt image2` Provider 已保存的 Base URL 后，只修正旧 `local-default` 渠道地址并补回旧根配置中的两个模型；地址和凭据均未输出。二次脱敏预览精确得到 1 条可导入、0 条复用、0 条无效和 2 处明文凭据，随后通过现有事务迁移接口导入 1 条独立“本地直连”Provider，并清理 2 处旧明文凭据。迁移后 Provider 数量由 6 增至 7，旧候选和旧明文凭据均归零，新 Provider 凭据密文存在、状态保持 `untested`。迁移没有执行连接测试、模型拉取或生成请求，SQLite 迁移后完整性检查仍为 `ok`，Git 工作区保持干净。

## 已知限制与下一步

- RunningHub、OpenAI 兼容、Gemini 原生与通用 HTTP 的本阶段最小真实验证均已完成。后续新增凭据仍应写入被 Git 忽略的本地配置或系统钥匙串，不应粘贴到对话中。
- 生图工作台结果区已优化成功、生成中和失败状态层级，结果图片改为完整比例展示；连接中心增加连接数量、已连接数量和请求防护状态概览。该视觉调整不改变生成协议或数据结构。
- 连接中心正式 STITCH 设计已形成 `provider-center-v1`：包含深浅色桌面连接列表与编辑抽屉、深浅色 390px 渠道列表和编辑表单、状态与反馈规范、HTML 导出、设计 token 和交付说明。新增浅色变体使用同一设计系统和生成会话 `12504138825416016201`，屏幕 ID、PNG、HTML 与 SHA-256 元数据已归档；STITCH HTML 仅作视觉参考，没有直接迁入生产代码。
- OpenOx 返回的内联 Data URL 会在写入日志前转存到浏览器 localforage，同一浏览器刷新后可按 `storageKey` 恢复，账号历史不再写入长 Base64。该本地副本不等于云端素材；跨设备或清理浏览器数据后仍需依赖对象存储或素材库。
- Gemini 原生连接已完成一次连接测试和模型拉取；测试后模型目录会立即同步回编辑表单，避免抽屉内下拉仍显示空列表。本轮未因此重复请求上游。
- 编辑 Gemini 原生连接并保存新的默认模型曾把刚通过的连接状态重置为 `untested`；更新逻辑已改为仅在协议、Base URL、密钥或请求头变化时清除测试状态。修复前已被重置的本地状态不会伪造恢复，报告仍按实际调用记录连接和模型拉取已通过，本轮没有为了恢复 UI 标签重复测试。
- Gemini 原生模型目录仍包含已不再向新用户开放的 `gemini-2.5-flash-lite`；模型拉取成功不等于当前账号拥有生成权限。真实请求应优先使用已验证的 `gemini-3.5-flash-lite`，并保留上游模型不可用错误的明确提示。
- 通用 HTTP 的 `gemini-3.5-flash` 在极低 8-token 预算下可能只消耗内部处理预算并以 `length` 结束；128 tokens 已验证能返回短文本。OpenOx 曾有一次连接 `EOF`，由用户确认后的独立请求成功，不应在代码中增加隐式自动重试。
- 通用视频上游没有统一取消协议。现已为火山方舟 Seedance、MiniMax H3 排队任务和 RunningHub ComfyUI 任务接入各自官方取消端点；Gemini Veo、KIE、APIMart、OpenAI/grok2api、CogVideoX/Agnes、其他 MiniMax 协议和通用 HTTP 尚无可确认的运行中取消契约，取消仍只能停止本地轮询和当前网络读取，已提交的异步上游任务可能继续运行。
- 画布图片、视频和音频运行节点，以及生图台、视频台运行任务卡已提供独立“取消任务”按钮；取消后保留记录并明确显示“已取消”，删除任务/记录仍沿用先取消再删除的既有行为。
- 生成前确认框已经接入画布、生图台、视频台及重试入口；正式有渠道后需人工确认渠道名称、模型和任务类型与实际请求一致。
- 连接中心 Playwright 浏览器 Mock 回归已覆盖登录会话持久化、加载转空、错误重试、禁用与不可用、停用确认、响应式断点、API 抽屉必填校验与协议切换、模型保存、旧配置迁移风险与确认参数、编辑、模型拉取、复制、删除，以及连接中心模型进入生图台、视频台和无限画布的跨页面链路；完整 9 个用例已在独占 Next 测试服务下全部通过。全部流程均拦截 API，不点击生成、不调用真实渠道、不修改数据库；迁移提示已改用 Ant Design 6 的 `Alert.title`，复跑不再出现该废弃警告。
- 多实例共享预算实现、跨实例 Mock 契约和本机双后端真实 Redis 运行时演练均已完成。正式多实例部署仍需配置持久受控 Redis、独立前缀、容量与可用性监控、告警和故障演练；本机临时容器结果不替代生产环境验收。
- 生图台浮动工作流按钮已统一服务端与浏览器首次渲染坐标，并在客户端恢复保存位置后再显示，避免原有位置差异触发 hydration warning 或首屏闪跳。
- 不开始 Tauri，不修改线上部署。阶段分支已在用户授权后推送到个人 fork；本报告收尾不执行线上部署。
- Mac CLI helper 的版本探测已移入独立 Unix Socket 伴随进程，并增加逐次 HMAC/nonce 防重放授权、签名响应、Ed25519 清单、过期时间和二进制 SHA-256 强校验。Codex 已完成开发 helper 安装、OAuth 登录和一次用户确认的真实最小调用。官方 Antigravity `agy 1.1.22` 已完成安装和 Google OAuth，模型列表只读检查返回可用 Gemini、Claude 与 GPT OSS 模型；本轮新增签名清单绑定、`agy models` 模型同步、headless JSON 固定最小调用和无限画布文本 completion adapter，沿用禁用斜杠命令、plan 模式、私有临时目录、沙箱、2 分钟 deadline、单任务并发、4 KiB 脱敏输出、状态轮询与取消传播。普通文本节点原先误走旧聊天代理并被拒绝，现已改用同一受控 CLI task；画布 Agent 也会优先继承文本配置节点，明确不执行操作时可展示纯文本回复。用户确认的 `gemini-3.5-flash-low` “只回复 OK”分别在普通节点和 Agent 面板成功返回 `OK`，没有自动重试。相关前端 Vitest 已增量复跑通过 11 个文件、35 个用例；Go 与 Playwright 未因本次增量改动重跑。即梦仍只允许固定版本检测。本轮没有 Apple 签名身份，因此没有生成或安装正式发布包。

### 视频供应商远端取消审计

| 供应商 / 协议 | 审计结果 | 当前行为 |
| --- | --- | --- |
| 火山方舟 Ark Seedance | 官方提供 `DELETE /contents/generations/tasks/{id}`；排队任务可取消，完成任务调用同一路径属于删除语义 | 仅本地最后状态为 `queued` 时传播；单次请求限制 64 KiB / 10 秒，远端失败仍保留本地取消 |
| RunningHub App / Workflow | 官方提供 `POST /task/openapi/cancel`，请求包含 `apiKey` 与 `taskId` | Provider API 新增独立取消入口；单次请求限制 512 KiB / 20 秒 |
| Gemini Veo | 官方视频文档仅确认长任务查询，未确认视频任务取消方法 | 只停止本地轮询与当前网络读取 |
| MiniMax H3 | 官方 v2 H3 接口提供 `DELETE /v2/video_generation/{task_id}`，且只允许取消排队任务 | 仅本地最后状态为 `queued` 时传播；运行中任务不调用删除端点 |
| 其他 MiniMax 视频协议 | 当前没有可安全绑定到现有 adapter 的正式取消契约 | 只停止本地轮询与当前网络读取 |
| KIE / APIMart | 官方任务文档确认创建与状态查询，未确认运行中取消方法 | 只停止本地轮询与当前网络读取 |
| OpenAI Videos / grok2api | OpenAI 的删除接口面向已完成或失败的视频资源，不作为运行中取消使用 | 不猜测调用删除端点；只停止本地轮询与当前网络读取 |
| CogVideoX / Agnes / 通用 HTTP | 当前没有可确认且能安全绑定到现有 adapter 的正式取消契约 | 只停止本地轮询与当前网络读取 |

审计依据为供应商正式文档和官方客户端所公开的协议；后续只有取得明确的运行中取消契约后才扩展 adapter，避免把资源删除、批处理取消或其他产品线接口误用为视频任务取消。

主要依据：火山方舟 [API 文档中心](https://api.volcengine.com/api-docs/?serviceCode=ark&version=2024-01-01) 与官方 [Ark CLI 生成任务参考](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-gen/references/gen-meta.md)、RunningHub [取消任务文档](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749015)、Gemini [Veo 视频文档](https://ai.google.dev/gemini-api/docs/video)、MiniMax [H3 取消任务文档](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete)、KIE [任务查询文档](https://docs.kie.ai/market/common/get-task-detail)、APIMart [任务状态文档](https://docs.apimart.ai/cn/api-reference/tasks/status) 和 OpenAI [Videos API 参考](https://developers.openai.com/api/reference/cli/resources/videos)。

### 仍需外部条件

- Apple 签名与公证：本机钥匙串检查结果为 0 个有效代码签名身份，因此不能生成可验证的 Developer ID 发布包，也不能完成 Gatekeeper、公证和真实安装验收；需要 Apple Developer Team、Developer ID Application 证书和公证凭据。
- 正式多实例环境：本机 Redis 双实例运行时演练已通过，但生产部署仍需提供持久 Redis、隔离前缀、可观测性、告警和运维故障演练。
- 线上部署、推送部署动作与 Tauri 桌面化不属于第四阶段；本阶段只整理分支、提交和仓库外 Git bundle。
