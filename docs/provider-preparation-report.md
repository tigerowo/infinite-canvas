# Infinite Canvas 连接中心前期接入报告

> 日期：2026-08-24
> 阶段：资料阅读、源码盘点、架构分析与本地基线复核
> 结论：目标基线可启动；本阶段未实现连接中心、未迁移参考代码、未修改数据库或线上部署、未调用真实模型 API、未写入或提交密钥。

## 1. 仓库、分支与基线

### 1.1 目标工程

- 本地目录：`/Users/danchen/tigerowo:infinite-canvas`
- 上游：`https://github.com/tigerowo/infinite-canvas`
- 当前分支：`codex/provider-center-mac`
- 当前提交：`a8fd27e7f784e09d95e2825bdd9cd5a9f3f17156`，与要求的短提交 `a8fd27e` 一致。
- 本轮开始时工作树干净；未覆盖目标工程、`ai-canvas` 或其他已有目录。
- 本轮唯一计划内文件变更是本报告。Next.js 开发服务器自动改写过 `web/next-env.d.ts`，核验后已恢复为基线内容。

### 1.2 API/CLI 参考仓库

- 独立克隆目录：`/Users/danchen/infinite-canvas-api-cli-reference`
- 上游：`https://github.com/minutes9527/infinite-canvas-api-cli-`
- 分支：`main`
- 当前提交：`2cb85772fbf5436de06c7c7e1b370e9208c19d79`
- 提取源码发布提交：`e44ed4190f10d58b813b3bafd2011648ff4355df`
- 参考仓库保持干净，未执行其中任何安装、登录或 CLI 脚本。

参考仓库的 `LICENSE` 不是宽松开源许可证：明确禁止未经授权的商业封装，并要求二次开发保持开源及注明来源。目标工程为 MIT 项目，二者的分发条件存在明显冲突或不确定性。第二阶段在取得授权或完成法律确认前，只能复用交互思路、字段含义和行为清单，不能直接复制其 JavaScript、CSS、HTML、JSON 资产或 shell 脚本。

## 2. 已阅读资料与缺失项

已完整阅读：

- `preparation/README.md`
- `preparation/01-target-source-baseline.md`
- `preparation/02-api-cli-reference.md`
- `preparation/03-stitch-design-brief.md`
- `preparation/04-mac-codex-handoff.md`
- 参考仓库根目录 `EXTRACTED.md`
- `preparation/stitch/README.md`
- 参考仓库的 API 设置 HTML、CSS、JavaScript、i18n、RunningHub provider JSON、Mac/Linux CLI 脚本及许可证
- 目标工程 README、环境变量、Go 模块、前端包管理、Docker、CI、配置、鉴权、存储和 AI 请求相关源码

指定的 `infinite-canvas-security-review.md` 不在目标仓库、参考仓库或参考仓库当前 `preparation/` 文件清单中，也未能在本机相关目录中定位。因此不能声明已阅读该文件。本报告根据任务明确列出的风险主题，直接对目标提交 `a8fd27e` 的实现逐项进行了源码复核；如后续补充原安全评审文件，还需要做一次差异对照。

## 3. 本地安装环境、启动方式与测试命令

### 3.1 环境版本

| 组件 | 版本 |
| --- | --- |
| macOS | 14.3，Build 23D56，arm64 |
| Git | 2.39.3（Apple Git-146） |
| Go | 1.25.0 darwin/arm64 |
| Node.js | 24.19.0 |
| Bun | 1.3.14 |
| Next.js | 16.2.9 |
| React | 19.2.5 |
| Docker CLI | 29.6.2 |
| SQLite | 3.43.2（Python sqlite3 模块） |

Go 与 Bun 位于工程外的 `/Users/danchen/.cache/infinite-canvas-baseline-runtime/`，没有污染或覆盖其他项目运行时。项目 `.env` 权限为 `0600` 且被 Git 忽略；其中管理员密码和 JWT Secret 为本地随机值，本报告不记录实际内容。SQLite 数据库 `data/infinite-canvas.db` 被 Git 忽略，本轮通过只读 URI 成功打开并确认现有 15 张业务表，没有执行写入或迁移。

### 3.2 启动命令

项目文档的原生命令：

```bash
go run .

cd web
bun run dev
```

当前 Mac 的目标路径包含冒号，Bun 注入 `node_modules/.bin` 时会被 POSIX `PATH` 分隔规则拆开。本机实际使用工程外 shim，源码无需改变：

```bash
cd /Users/danchen/tigerowo:infinite-canvas
GOTOOLCHAIN=local \
  /Users/danchen/.cache/infinite-canvas-baseline-runtime/go1.25.0/bin/go run .

cd /Users/danchen/tigerowo:infinite-canvas/web
PATH=/Users/danchen/.cache/infinite-canvas-baseline-runtime/shims:$PATH \
  /Users/danchen/.cache/infinite-canvas-baseline-runtime/bun-1.3.14/bun-darwin-aarch64/bun run dev
```

核验时后端监听 `127.0.0.1:8080`，`GET /api/health` 返回 200；前端监听 `127.0.0.1:3000`。前端遗留开发进程曾无响应，使用相同原生命令重启后显示 Ready。首次编译画布动态路由约耗时 2.2 分钟，预热后恢复正常响应，这是本地开发体验问题，不是生产构建结论。

Docker 配置使用单一 `app` 服务、`.env`、`./data:/app/data` 和 `3000:3000`，本轮仅静态阅读，没有构建、启动或切换线上容器。

### 3.3 项目已有测试命令

后端 CI 命令：

```bash
go test ./...
```

前端 `web/package.json` 仅有：

```bash
bun run dev
bun run build
bun run start
bun run format
bun run format:check
```

项目没有 `lint`、`typecheck` 或 `test` 脚本，不应虚构这些命令。提交 `a8fd27e` 的已有基线报告记录：`go test ./...` 通过、`bun run build` 通过；构建配置会跳过 TypeScript 错误；`bun run format:check` 因 87 个既有文件不符合 Prettier 而失败。本轮没有业务代码变化，也没有重复执行会干扰正在运行开发服务器的生产构建。

## 4. 后端、前端、SQLite 与页面复核

| 检查项 | 本轮结果 | 说明 |
| --- | --- | --- |
| Go 后端 | 通过 | `GET http://127.0.0.1:8080/api/health` 返回 200。 |
| Next.js 前端 | 通过 | 重启后 Ready；核心路由均返回 200。 |
| SQLite | 通过 | 使用 `mode=ro` 打开成功，未执行迁移或数据写入。 |
| 登录 | 通过/只读 | `/login` 显示用户名、密码、登录和注册入口；本轮未提交凭据。此前同一基线已验证随机管理员账号登录与 `/api/auth/me`。 |
| 无限画布 | 通过/只读 | `/canvas` 显示画布库、导入画布、新建画布；未创建或修改画布。 |
| 生图工作台 | 通过/只读 | `/image` 显示提示词、参考图、模型、接口模式、质量、尺寸、批量数量和成果区。 |
| 视频创作台 | 通过/只读 | `/video` 显示图片/视频/音频参考、模型、清晰度、尺寸、时长、任务数量和成果区。 |
| 提示词库 | 通过/只读 | `/prompts` 正常显示空库状态。 |
| 我的素材 | 通过/只读 | `/assets` 显示文本、图片、视频、音频筛选及导入导出入口。 |
| 素材选择器 | 受限入口正常 | `/asset-library` 返回页面框架；未登录状态不加载用户素材内容。 |
| 真实生成 API | 未执行 | 当前阶段禁止调用真实 API，也没有可用第三方凭据。 |

页面检查只读取 DOM，没有输入管理员密码、上传文件、创建项目、生成媒体或修改配置。

## 5. 现有配置入口与数据结构

### 5.1 系统渠道配置

主要代码入口：

- 数据结构：`model/setting.go`
- 两行 JSON 持久化：`repository/setting.go` 的 `settings.public` / `settings.private`
- 默认值、归一化、渠道选择、模型发现和连接测试：`service/settings.go`
- 后端接口：`handler/settings.go`、`router/router.go`
- 管理界面：`web/src/app/(admin)/admin/settings/page.tsx`
- 前端 API：`web/src/services/api/admin.ts`

`ModelChannel` 当前字段为：

```text
id, protocol, name, baseUrl, apiKey, models[], weight,
timeout, enabled, remark
```

公开配置含可用模型、默认图片/视频/文本模型、模型成本、脱敏渠道信息、系统提示词以及是否允许自定义/远程渠道。私有配置含完整渠道密钥、提示词同步、AI 日志、OAuth 和存储配置。系统渠道 ID 在缺失时由渠道属性生成稳定值；指定 `X-Model-Channel-ID` 时精确选择，否则按权重选择可用渠道。

### 5.2 用户配置

- 数据结构：`model/user_config.go`
- 持久化：`repository/user_config.go`
- 业务层：`service/user_data.go`
- 接口：`handler/user_data.go`
- 前端同步：`web/src/services/api/user-config.ts`
- 前端 store：`web/src/stores/use-config-store.ts`
- 现有配置 UI：`web/src/components/layout/app-config-modal.tsx`

`user_configs` 以 `user_id` 为主键，包含 `model_config`、`storage_provider`、`image_history` 和 `asset_data` 四个文本 JSON 字段。浏览器还把完整 `AiConfig` 保存到 localStorage 键 `infinite-canvas:ai_config_store`。

当前 `AiConfig.localChannels[]` 保存 `id`、`protocol`、`name`、`baseUrl`、`apiKey` 和 `models[]`；完整模型配置同步到后端时，用户 API Key 会作为明文 JSON 进入 `user_configs.model_config`。连接中心设计必须先解决密钥边界，不能仅把现有表单换皮。

当前前端协议枚举：

```text
openai, gemini, grok2api, metaso, apimart, kie, mimo
```

### 5.3 存储与同步配置

- 系统存储配置位于 `PrivateSetting.Storage.Providers[]`，支持 S3/R2 与 WebDAV，包含 Endpoint、Region、Bucket、Access Key、Secret、用户名、密码、权重、容量状态等。
- 用户存储配置位于 `user_configs.storage_provider`。
- 提示词远程同步位于 `PrivateSetting.PromptSync`，由后台定时任务和管理员接口触发。
- 这些配置包含敏感字段和远程资源访问能力，不能与普通 Provider 列表的公开 DTO 混用。

## 6. 现有 AI 请求调用链

```text
页面 / 画布节点
  -> useEffectiveConfig / channelIdForActiveModel
  -> services/api/image.ts | video.ts | audio.ts | canvas-agent.ts
  -> aiApiUrl + aiHeaders
  -> Next.js web/src/app/api/[...path]/route.ts
  -> Gin router + 鉴权中间件
  -> handler/ai.go
  -> service.SelectModelChannelForModel
     或 service.SelectUserLocalModelChannelForModel
  -> BuildModelChannelURL + SetModelChannelAuthHeader
  -> 上游 API
  -> 响应透传 / 异步任务轮询 / 日志与算力点
```

现有三种模式：

1. 游客本地直连：浏览器直接向用户配置的上游发送 API Key；部分 KIE/APIMart 请求先通过 `/api/ai/direct-request` 获取转译参数。
2. 登录用户自定义渠道：前端发 JWT 与 `X-User-Model-Channel-ID`，后端从 `user_configs.model_config.localChannels` 读取 Base URL 和 API Key 后代为请求。
3. 系统远程渠道：前端发 JWT 与可选 `X-Model-Channel-ID`，后端从 `settings.private.channels` 选择渠道并请求上游。

连接中心需要接在渠道选择和能力解析层，而不是绕开 `image.ts`、`video.ts`、`audio.ts`、`canvas-agent.ts` 重新实现生成能力。

## 7. API/CLI 参考源码可复用清单

### 7.1 可作为行为与数据设计参考

- Provider 列表、启用/停用、编辑、删除、排序、默认 Provider 与推荐 Provider 流程。
- 协议识别和字段显隐：OpenAI、APIMart、Gemini、Volcengine、RunningHub、Jimeng、Codex、Gemini CLI。
- 模型发现、连接测试、异步探测、能力分组、模型显示名和模型默认值。
- API Key 保存/清除、遮罩展示与连接状态反馈的交互语义。
- RunningHub 的应用、工作流、字段定义、素材上传、工作流提交和状态展示结构。
- CLI 的安装状态、帮助、登录状态、额度、启动命令和错误状态等状态机概念。
- 中英文文案覆盖面及空态、加载态、成功态、错误态清单。

参考静态 JavaScript 预期的接口包括：

```text
/api/providers
/api/providers/fetch-models
/api/providers/test-connection
/api/providers/probe-async
/api/runninghub/*
/api/jimeng/*
/api/codex/*
/api/gemini-cli/*
/api/ai/upload
```

这些接口在目标 Go 项目中并不存在；`EXTRACTED.md` 提及的 `server.mjs` provider bridge 也不属于当前提取包或目标 Go 路由，不能作为已实现能力。

### 7.2 不应直接复用

- 约 202 KB 的 DOM 驱动 `api-settings.js`、静态 HTML 与 CSS：需要转为目标 React/TypeScript/Ant Design 组件和 store/service 结构。
- 参考仓库里的固定 URL、Provider JSON 和 UI 资产：许可证未确认，且字段与目标数据模型不一致。
- CLI shell 脚本：包含远程 `curl | sh`、全局 npm 安装、读取 shell profile、扫描用户主目录、交互式登录、写入 `API/.env` 和日志等行为，不适合由浏览器或远程 Go 服务直接执行。
- Windows/WSL 路径与脚本：本阶段目标是 Mac，不应带入。

## 8. 需要适配的部分

1. 将参考仓库的 Provider 概念映射到现有 `ModelChannel` 和 `AiConfig.localChannels`，合并已有 OpenAI/Gemini/APIMart/KIE/MiMo 能力，避免重复实现。
2. 为 RunningHub、Volcengine 和 CLI 类连接定义独立 adapter；RunningHub 工作流不能硬塞进单一 `models[]` 字段。
3. 建立集中能力声明，例如 image/video/text/audio、sync/async、upload、responses/chat/images、模型发现和连接测试，而不是继续依赖模型名猜测。
4. API Key 只写入后端或 Mac Keychain/受控 secret store；列表响应只返回 `hasSecret`、掩码或 secret reference，不能回传明文。
5. 用户提交的 Base URL 必须统一经过服务端 URL 校验、安全 DNS 解析、重定向检查和出站策略；不能继续使用普通 `http.Client`。
6. CLI 必须有 Mac 本地受控执行边界。推荐先设计本地 helper/sidecar 的允许命令、权限、日志脱敏和安装确认机制；浏览器页面只能调用受限 IPC/API，不能执行任意 shell。
7. 把参考 JavaScript 的状态机拆成可测试的 React hooks、API service 与 Go handler/service/repository；沿用目标项目的统一响应和鉴权约定。
8. 增加旧字段兼容读取和幂等迁移，先双读或转换，再切换写入格式，不能一次性覆盖用户 JSON。

## 9. 连接中心建议代码落点

| 层级 | 建议位置 | 职责 |
| --- | --- | --- |
| 入口/UI | 新增 `web/src/app/(user)/providers/page.tsx`，并从 `app-config-modal.tsx` 跳转 | API/CLI 分栏、列表、编辑、状态和空态；现有配置弹窗保留兼容入口。 |
| 前端类型 | 新增 `web/src/lib/provider.ts` | Provider、capability、protocol、secret status、connection status 的集中类型。 |
| 前端状态 | 在 `web/src/stores/` 新增 provider store，逐步收敛 `use-config-store.ts` 的渠道逻辑 | 选择、缓存、能力过滤与兼容映射。 |
| 前端 API | 新增 `web/src/services/api/providers.ts` | 只调用目标 Go API，不移植参考仓库 fetch 代码。 |
| Go 模型 | 新增 `model/provider.go`，或先扩展现有 setting/user config DTO | 区分系统/用户、API/CLI、协议、能力、secret reference 与状态。最终方案需先定迁移策略。 |
| Go 持久化 | `repository/` 新增 provider repository | 独立实体、排序、版本、软删除/引用检查；不建议继续无限扩张两个大 JSON。 |
| Go 服务 | 新增 `service/provider.go` 与 `service/provider_adapters/` | 归一化、校验、模型发现、连接测试、能力适配、密钥解析。 |
| Go 接口 | 新增 `handler/provider.go`、扩展 `router/router.go` | 用户/管理员权限分离，DTO 脱敏，请求体和响应体限额。 |
| AI 调用 | 收敛 `service/settings.go`、`service/user_data.go`、`handler/ai.go` | 通过统一 provider resolver 取代两套渠道选择，不重写已有生成流程。 |
| Mac CLI | 独立受控 helper，位置和交付形态需先做架构决策 | allowlist 命令、显式安装确认、超时、并发限制、日志脱敏、Keychain。不能直接放进浏览器。 |
| 文档/测试 | `docs/backend/`、Go 单测、前端新增正式 test/typecheck/lint 基线 | 记录协议、迁移、安全边界和回归矩阵。 |

UI 文件名是建议而非已确认设计；实际路由和布局应等待 STITCH 交付或用户明确允许按 brief 实施后再定。

## 10. 旧配置迁移风险

1. **双数据源冲突**：浏览器 localStorage 与 `user_configs.model_config` 都保存完整 `AiConfig`，登录同步可能覆盖较新的本地修改。
2. **明文密钥迁移**：用户渠道 API Key 已存在于完整 JSON；迁移时既要去明文化，又不能通过 API 响应或日志泄露原值。
3. **渠道 ID 稳定性**：系统渠道存在稳定 ID 推导，用户渠道常用 `local-<timestamp>`。更换 ID 会破坏默认渠道、当前模型选择和请求头引用。
4. **历史任务引用**：视频任务、生成日志和调用日志中存在系统/用户渠道 ID；删除或合并 Provider 前必须检查引用，保留展示快照或别名。
5. **协议语义不等价**：参考仓库的 `openai-responses`、`openai-json`、`openai-video-proxy`、RunningHub workflow 和 CLI 不是目标 `protocol` 字段的一一映射。
6. **系统/用户权限边界**：系统 Provider、用户自定义 Provider、游客浏览器直连和 CLI 本地凭据的可见性与执行位置不同，不能共用同一个公开 DTO。
7. **默认模型回退**：迁移模型清单时可能让默认 image/video/text/audio 模型失效，需按 capability 修复默认值并显示迁移结果。
8. **回滚与幂等性**：迁移需要版本号、备份/导出、dry-run、幂等执行和失败回滚；当前阶段未修改数据库。
9. **目标尚未上线不等于无数据**：本地数据库已有管理员及历史验证痕迹，后续即使允许直接改表，也应按有数据系统处理。

## 11. 安全风险复核

### 11.1 关键风险

| 等级 | 风险 | 当前源码证据 | 第二阶段最低要求 |
| --- | --- | --- | --- |
| 严重 | 用户渠道 SSRF | `service/user_data.go` 从 `user_configs.model_config.localChannels` 取用户 Base URL；`service/settings.go` 的 `HTTPClientForChannel` 使用普通 `http.Client`，没有复用 `SafeProxyHTTPClient` 的私网/DNS/重定向防护。已登录用户可让后端请求内网或云元数据地址。 | 所有用户控制的 URL 使用统一安全 transport；只允许 http/https；解析并固定公网 IP；每次重定向复核；禁止代理环境变量；可配置出站 allowlist。 |
| 高 | 代理返回同源 HTML | `handler/storage.go` 的 `ProxyImage` 对非图片响应保留上游 `Content-Type` 并直接写回；`handler/ai.go` 的上游响应代理也大量透传响应头和正文。恶意上游可让应用同源返回 HTML/脚本化内容。 | 图片代理仅接受经 sniff 验证的图片；拒绝 HTML/SVG 等主动内容；设置 `X-Content-Type-Options: nosniff`；AI 代理采用允许的 Content-Type/Content-Disposition 策略并过滤危险头。 |
| 高 | 响应体和请求体缺少统一大小限制 | `ProxyImage`、AI 请求读取、OAuth、提示词同步、工作流 agent 等多处使用无上限 `io.ReadAll` 或 `io.Copy`；部分错误体虽有限额，但成功响应没有。 | 在入口、上游读取、解码和落盘各层使用 `MaxBytesReader` / `LimitReader(limit+1)`；按图片、视频、JSON、SSE 分别设上限；加入总时长和总字节预算。 |
| 高 | OAuth state 与 URL Token | `LinuxDoAuthorizeURL` 的 state 只是 redirect 的 Base64，不含随机 nonce、签名、会话绑定或过期；回调后把 JWT 放到 `/login?token=...`。 | 服务端保存或签名 state，加入 nonce、会话绑定、短过期和一次性消费；如支持则使用 PKCE；JWT 改为 Secure/HttpOnly/SameSite Cookie，或用一次性短码经 POST 交换。 |
| 高 | CLI 任意命令与供应链风险 | 参考脚本包含 `curl | sh`、全局安装、shell profile、Home 扫描、交互登录和 `.env` 写入。若直接接到 Web UI，会把远程网页升级为本机命令执行面。 | 设计独立本地 helper；命令 allowlist；参数结构化；无 shell 拼接；下载校验/固定版本；安装与登录需用户确认；最小权限、超时、并发限制和脱敏日志。 |

### 11.2 WebDAV、S3 与提示词同步资源限制

- WebDAV 使用了 `SafeProxyHTTPClient`，这是正确基础；但目录容量测量递归没有深度、条目数、请求数、总字节或总耗时预算，恶意/循环目录会造成资源耗尽。
- S3 使用了安全 HTTP client，但分页列举没有页数、对象数或总耗时预算；单页响应虽有固定读取上限，却没有明确的 `limit+1` 超限判断，错误表现不清晰。
- 提示词同步 URL 当前为固定 GitHub raw 地址，SSRF 风险较低；但单文件读取无大小上限，一次同步也没有文件数、总字节和总体 deadline 预算。
- 用户文件上传、AI multipart、OAuth JSON、模型发现/连接测试、工作流响应等也需要同一套资源限制审计，不能只修一条代理路由。

### 11.3 已有正向防护

`service/ssrf.go` 已实现较好的安全 transport：禁用环境代理、限制 http/https、解析所有 DNS 地址并拒绝 loopback/private/link-local/multicast/unspecified/CGNAT，实际拨号固定到已检查 IP，并限制重定向次数。第二阶段应复用和增强这套实现，而不是另写普通 client。

## 12. STITCH 设计状态

`preparation/stitch/` 当前只有 `README.md`，没有任何实际 STITCH 导出设计稿，也没有版本号或交付记录。因此设计尚未确认。

缺失清单：

- 桌面版主界面
- 窄屏/移动版主界面
- API tab
- CLI tab
- 编辑 Provider 状态
- loading / empty / success / error / unavailable 状态
- HTML/图片/设计源文件
- design tokens、组件规格和交互说明
- 设计版本与交付日期

`03-stitch-design-brief.md` 只能作为后续出图 brief：连接中心需有 API/CLI 分栏、列表操作、字段编辑、完整状态、桌面/窄屏方案、克制的工具型视觉和不超过 8px 的圆角。它不等同于已经确认的设计稿。

## 13. 第二阶段实施顺序

建议按以下门禁顺序推进：

1. **先决策再编码**：补齐 STITCH 或确认允许按 brief 实施；确认参考仓库许可证/授权；确认 CLI 是本地 helper 还是暂缓；取得缺失安全评审文件并做差异核对。
2. **先修安全底座**：统一安全 HTTP client、请求/响应大小限制、内容类型策略、OAuth state/Token 方案和 secret 存储边界。
3. **确定 Provider 领域模型**：定义 API/CLI、system/user/local、protocol、capabilities、models、secretRef、status、version 和引用规则。
4. **设计并评审迁移**：扫描现有 JSON/ID/任务引用，产出 dry-run、幂等迁移、兼容读取和回滚方案；获确认后才修改数据库。
5. **实现 Go Provider API**：脱敏 DTO、权限、CRUD、排序、模型发现、连接测试和 adapter 接口；先覆盖已有协议。
6. **接入现有 AI 链路**：用 provider resolver 替换分散的系统/用户渠道解析，保持图片、视频、音频和画布调用行为兼容。
7. **实现 React 连接中心**：按照已确认设计完成 API tab、状态和配置迁移入口；不要复用参考 DOM 脚本。
8. **单独实现 CLI 能力**：本地 helper、允许命令、安装/登录确认、Keychain、超时与日志；不与 Web Provider CRUD 混成任意命令接口。
9. **回归与安全验收**：Go 单测、前端正式 typecheck/lint/test、构建、迁移测试、SSRF/大响应/OAuth/文件同步专项测试及六个核心页面回归。

## 14. 预计开发时间

以下为 1 名熟悉 Go/Next.js 的工程师、STITCH 和产品决策及时可用、不含外部授权等待的估算：

| 工作包 | 估算 |
| --- | --- |
| 设计/安全/许可证决策与详细技术方案 | 1–3 人日 |
| 安全 HTTP、资源限额、OAuth 与 secret 基础设施 | 3–5 人日 |
| Provider 模型、持久化、迁移与 Go API | 4–7 人日 |
| 现有协议 adapter 与 AI 调用链接入 | 3–5 人日 |
| React 连接中心与兼容配置入口 | 3–6 人日 |
| RunningHub/Volcengine 等新增 API 适配 | 3–6 人日 |
| Mac CLI helper、安装/登录/状态与安全边界 | 5–9 人日 |
| 自动化测试、迁移演练、安全与页面回归 | 3–5 人日 |

- 仅 API 连接中心 MVP（复用已有协议、暂不含 CLI/RunningHub）：约 10–15 人日。
- 完整 API + Mac CLI + 新协议 + 安全整改：约 25–40 人日，即单人约 5–8 周。
- STITCH、许可证授权、OAuth 产品决策或真实 Provider 测试凭据缺失会增加等待时间；真实 API 联调还需单独的受控测试预算和凭据。

## 15. 阶段结论

目标提交 `a8fd27e` 的 Go 后端、Next.js 前端和 SQLite 基线可用，六个核心产品区域在不写数据、不调用真实模型的前提下完成了页面复核。目标工程已经有完整的渠道选择与 AI 请求骨架，第二阶段应在其上增加统一 Provider 领域层和安全边界，不应替换或重复实现现有生成能力。

进入编码阶段前仍有四个明确门禁：STITCH 实稿/brief 授权、参考代码许可证确认、CLI 本地执行架构确认、缺失安全评审文件补齐或确认以本报告源码审计为准。本阶段在此暂停，等待确认。
