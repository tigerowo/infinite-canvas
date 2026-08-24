# 源码安装与基线验证报告

## 1. 范围与基线

- 主工程：`tigerowo/infinite-canvas`，完整复用上游源码，没有重新实现现有功能。
- 上游地址：`https://github.com/tigerowo/infinite-canvas`。
- 上游基线：`v0.5.5`，提交 `dc30570`（`feat: add Chat Completions image generation mode`）。
- 工作分支：`codex/provider-center-mac`。
- 当前工作区在克隆前为空。工作区及其相邻目录扫描未发现名为 `ai-canvas` 的目录；发现的 `/Users/danchen/Pictures/CanvasMind/.venvs/infinite-canvas` 未被读取、覆盖或修改。
- 第一阶段只增加本报告；未增加连接中心，未迁移其他仓库代码，未修改线上部署。

## 2. 安装环境与版本

| 项目 | 基线值 |
| --- | --- |
| 操作系统 | macOS 14.3（Build 23D56） |
| 架构 | Apple Silicon / arm64 |
| Git | 2.39.3（Apple Git-146） |
| Go | 1.25.0 darwin/arm64 |
| Bun | 1.3.14 |
| Node.js | 24.19.0，仅作为含冒号路径下运行 Next.js CLI 的 shim 运行时 |
| Next.js | 16.2.9 |
| React | 19.2.5 |
| Docker CLI / Engine | 29.6.2 |
| SQLite library | 3.43.2 |

系统原先没有全局 `go`、`bun` 或 Homebrew。为避免影响其他工程，本次把 Go 1.25.0 和 Bun 1.3.14 安装在工程外的 `/Users/danchen/.cache/infinite-canvas-baseline-runtime/`；Go 安装包按官方发布清单校验了 SHA-256。

已阅读并核对以下原生配置：

- `README.md`、`.env.example`、`AGENTS.md`
- `go.mod`、`go.sum`
- `web/package.json`、`web/bun.lock`、`web/next.config.ts`
- `Dockerfile`、`docker-compose.yml`、`docker-compose.local.yml`、`docker-entrypoint.sh`
- `.github/workflows/ci.yml`、`.github/workflows/docker-image.yml`
- 本地开发、Docker、数据库、系统设置和接口响应文档

依赖按项目锁文件安装，安装后 `go.sum` 和 `web/bun.lock` 均未变化：

```bash
GOTOOLCHAIN=local /Users/danchen/.cache/infinite-canvas-baseline-runtime/go1.25.0/bin/go mod download

cd web
/Users/danchen/.cache/infinite-canvas-baseline-runtime/bun-1.3.14/bun-darwin-aarch64/bun install --frozen-lockfile
```

## 3. 环境变量与 SQLite

根目录 `.env` 从 `.env.example` 复制后写入本地随机凭据，文件权限为 `0600`，且被 `.gitignore` 的 `.env*` 规则排除。随机值没有打印、记录到本文档或加入 Git。

| 变量 | 本地值或行为 |
| --- | --- |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | 本地随机 192-bit 十六进制值，不记录 |
| `JWT_SECRET` | 本地随机 256-bit 十六进制值，不记录 |
| `JWT_EXPIRE_HOURS` | `168` |
| `PORT` | 未设置，使用后端默认值 `8080` |
| `PUBLIC_BASE_URL` | 未设置；未验证需要公网回调的 Seedance 参考素材 |
| `API_BASE_URL` | 未设置，Next.js 开发代理使用 `http://127.0.0.1:8080` |
| `STORAGE_DRIVER` | `sqlite` |
| `DATABASE_DSN` | `data/infinite-canvas.db` |

SQLite 基线：

- 数据库文件：`data/infinite-canvas.db`，由 `.gitignore` 排除。
- 日志模式：`delete`。
- 启动迁移成功，生成 15 张业务表。
- 新库仅有 1 个管理员用户；渠道、模型设置、用户配置、画布项目、提示词、素材和生成记录均为 0。
- `settings` 表初始为 0 行，公开默认设置由 `service/settings.go` 在读取时归一化，不会在首次启动时自动写入两行设置。

## 4. 启动命令

项目文档中的原生命令是：

```bash
go run .

cd web
bun run dev
```

本机工作区绝对路径包含冒号：`/Users/danchen/tigerowo:infinite-canvas`。POSIX `PATH` 同样以冒号分隔，Bun 注入 `web/node_modules/.bin` 后该路径会被拆开，原生命令因而报告 `next: command not found`。没有修改项目脚本；本次仅在工程外建立绝对路径 CLI shim，实际启动命令为：

```bash
GOTOOLCHAIN=local /Users/danchen/.cache/infinite-canvas-baseline-runtime/go1.25.0/bin/go run .

cd web
PATH=/Users/danchen/.cache/infinite-canvas-baseline-runtime/shims:$PATH \
  /Users/danchen/.cache/infinite-canvas-baseline-runtime/bun-1.3.14/bun-darwin-aarch64/bun run dev
```

启动结果：

- Go / Gin 后端监听 `http://127.0.0.1:8080`。
- Next.js 16.2.9 开发服务器监听 `http://localhost:3000`。
- `web/src/app/api/[...path]/route.ts` 将 `/api/*` 代理到 `API_BASE_URL`，本地默认是 `http://127.0.0.1:8080`。
- 直接访问后端和经过 Next.js 代理访问 `/api/health` 均返回 HTTP 成功和 `ok`。

## 5. 页面和接口验证结果

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 登录 | 通过 | `/login` 正常渲染账号密码表单；使用随机管理员密码调用前端代理 `POST /api/auth/login` 返回 `code=0`、管理员角色和 JWT；随后 `GET /api/auth/me` 鉴权成功。凭据和 JWT 均未输出。 |
| 无限画布 | 通过 | `/canvas` 正常加载画布库；创建“无限画布 1”并进入 `/canvas/<id>`，编辑器工具栏、侧栏、缩放和节点工具正常渲染；创建文本节点后节点计数从 0 变为 1。游客画布按现有设计保存在浏览器本地，因此 SQLite 的 `canvas_projects` 仍为 0。 |
| 生图工作台 | 部分通过 | `/image` 正常渲染提示词、参考图、模型、Images / Responses / Chat 模式、质量、尺寸、批量数量和结果区。新库没有渠道或 API Key，未向第三方发起真实生图请求。 |
| 视频创作台 | 部分通过 | `/video` 正常渲染图片/视频/音频参考素材、模型、分辨率、尺寸、秒数、任务数和成果区。新库没有渠道或 API Key，未向第三方发起真实视频请求。 |
| 提示词库 | 通过 | `/prompts` 正常渲染，空库显示 0 条；`GET /api/prompts` 返回 `code=0`，包含 `items`、`categories`、`tags` 和 `total`。没有执行远程提示词同步。 |
| 服务器素材库 | 通过 | `/asset-library` 路由返回 HTTP 200；公开 `GET /api/assets` 与鉴权后的 `GET /api/admin/assets` 均返回 `code=0`，包含 `items`、`tags` 和 `total`。新库为空。 |
| 我的素材 | 通过 | `/assets` 正常渲染文本、图片、视频、音频筛选及导入导出入口；空库显示 0 条。 |
| 用户配置 | 通过 | 鉴权后的 `GET /api/v1/user-config` 返回 `code=0` 和同步能力声明。 |
| 画布同步 | 通过 | 鉴权后的 `GET /api/v1/canvas/projects` 返回 `code=0` 和空列表。 |
| 图片/视频记录 | 通过 | 鉴权后的图片和视频 generation logs 接口均返回 `code=0` 和空列表。 |
| 管理员设置 | 通过 | 鉴权后的 `GET /api/admin/settings` 返回 `code=0`，响应包含 `public` 和 `private`；服务层会把渠道 API Key、存储 Secret/密码及 OAuth Client Secret 清空后再返回。 |

新库的公开设置基线：

- 系统渠道 0 个，可用系统模型 0 个，默认系统模型均为空。
- `allowCustomChannel=true`，允许用户配置本地渠道。
- `allowUserRemoteChannel=false`，普通用户默认不能使用系统远程渠道；管理员可以使用，但当前没有已配置渠道。
- `allowRegister=true`，Linux.do 登录未启用。
- 前端本地默认模型仍是 `gpt-image-2`、`grok-imagine-video`、`gpt-5.5` 和 `gpt-4o-mini-tts`，但没有 API Key 时只用于展示，不代表请求可用。

## 6. 测试与构建结果

### Go

原生 CI 命令通过：

```bash
go test ./...
```

`config`、`handler`、`service` 包测试通过；根包、`middleware`、`model`、`repository`、`router` 当前没有测试文件。

### 前端

`web/package.json` 只提供以下脚本：`dev`、`build`、`start`、`format`、`format:check`。项目没有提供 `lint`、`typecheck` 或 `test` 脚本，因此没有虚构或执行这些命令。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `bun run build` | 通过 | Next.js 16.2.9 生产构建成功，生成 19 个 App Router 路由。 |
| 类型检查 | 未提供 | 构建输出明确显示 `Skipping validation of types`；`web/next.config.ts` 设置了 `typescript.ignoreBuildErrors=true`。 |
| lint | 未提供 | `package.json` 无 `lint` 脚本，也没有 ESLint 配置。 |
| test | 未提供 | `package.json` 无 `test` 脚本，源码中未发现前端测试文件。 |
| `bun run format:check` | 失败 | 这是额外执行的现有脚本；Prettier 报告 87 个文件不符合格式，包括 `public/director` 构建产物和大量既有源码。本阶段未运行 `--write`，避免产生大范围无关修改。 |

仓库 CI 当前只执行 `go test ./...` 和 `bun run build`，与上述通过项一致。

## 7. 现有配置与 API 请求调用链

### 7.1 系统渠道和模型配置

- 数据模型：`model/setting.go` 的 `PublicSetting` / `PrivateSetting` / `ModelChannel`。
- 持久化：`repository/setting.go` 在 `settings` 表使用 `public`、`private` 两行 JSON。
- 归一化与渠道选择：`service/settings.go`。
- 管理接口：`handler/settings.go` 与 `router/router.go` 的 `/api/admin/settings*`。
- 管理前端：`web/src/app/(admin)/admin/settings/page.tsx` 和 `web/src/services/api/admin.ts`。
- 当前前端本地渠道协议枚举为 `openai`、`gemini`、`grok2api`、`metaso`、`apimart`、`kie`、`mimo`。
- 系统渠道只有在启用、Base URL 与 API Key 完整、并声明目标模型时才可选；指定 `X-Model-Channel-ID` 时精确选择，否则后端按 `weight` 加权随机。

### 7.2 用户配置

- 浏览器模型配置由 Zustand store `web/src/stores/use-config-store.ts` 保存到本地存储键 `infinite-canvas:ai_config_store`。
- 登录 token 由 `web/src/stores/use-user-store.ts` 保存到本地存储键 `infinite-canvas-auth-token-v1`。
- 配置弹窗位于 `web/src/components/layout/app-config-modal.tsx`；登录用户点击保存时调用 `POST /api/v1/user-config/model`。
- 后端 `handler/user_data.go`、`service/user_data.go`、`repository/user_config.go` 将完整模型配置 JSON 保存到 `user_configs.model_config`。
- 现有完整模型配置包含 `localChannels`，其中包括 Base URL、API Key 和模型列表；这是第二阶段设计连接中心时需要明确处理的现有敏感数据边界。
- S3/R2 与 WebDAV 配置保存在同一用户配置行的 `storage_provider`；同步开关仍位于模型配置 JSON。

### 7.3 三条 AI 请求路径

1. 游客或未登录用户的本地直连：页面使用 `useEffectiveConfig()`，`web/src/services/api/image.ts`、`video.ts`、`audio.ts` 根据当前本地渠道直接请求上游 Base URL，并在浏览器发送上游 API Key。KIE / APIMart 可先调用 `/api/ai/direct-request` 取得参数转译方案；该转译接口明确拒绝接收 API Key 和内嵌文件数据。
2. 登录用户的本地渠道：前端仍请求 `/api/v1/*`，发送 JWT 与 `X-User-Model-Channel-ID`；后端从当前用户的 `user_configs.model_config.localChannels` 读取 Base URL 和 API Key，再代理到上游。
3. 系统远程渠道：前端请求 `/api/v1/*`，发送 JWT 与可选 `X-Model-Channel-ID`；后端从 `settings.private.channels` 选择匹配渠道，按渠道协议构造 URL 与鉴权头，执行请求并记录调用日志/算力点。

主调用链如下：

```text
页面/画布节点
  -> useEffectiveConfig / channelIdForActiveModel
  -> services/api/image.ts | video.ts | audio.ts | canvas-agent.ts
  -> aiApiUrl + aiHeaders
  -> Next.js /api/[...path] 透明代理
  -> Gin router + UserAuth
  -> handler/ai.go
  -> service.SelectModelChannelForModel 或 SelectUserLocalModelChannelForModel
  -> 上游模型接口
  -> 响应透传、任务轮询、生成记录与 AI 调用日志
```

普通业务 API 使用 `web/src/services/api/request.ts` 的 Axios 包装，以 `{ code, data, msg }` 中的 `code` 判断业务成功；Next.js 代理保留业务请求头，移除 hop-by-hop / 长度相关头，并把后端不可达转换为 HTTP 502 与统一业务响应。

## 8. 已知问题

1. 当前工作区路径包含冒号，Bun 注入的 `node_modules/.bin` 路径会被 POSIX `PATH` 拆分，原生 `bun run dev`、`bun run build` 和 `bun run format:check` 无法直接解析 CLI。源码无关；换到不含冒号的路径或保留工程外 shim 即可。
2. `/image` 首次渲染出现 React hydration mismatch：悬浮“工作流”按钮的服务端位置是 `left:24px; top:320px`，客户端从已保存状态得到不同坐标。页面仍可使用，但控制台会报错。
3. 首次读取尚不存在的 `user_configs` 行时，业务正确返回默认值，但 GORM 会把预期的 `record not found` 记录成红色错误日志。
4. `format:check` 在上游基线失败，涉及 87 个文件；不应在第一阶段批量格式化。
5. 前端没有 lint、typecheck、test 脚本；生产构建还显式跳过 TypeScript 错误，当前“构建通过”不能替代类型安全基线。
6. SQLite 数据库文件当前权限为 `0644`。数据库会保存密码哈希，并可能在后续保存用户渠道/存储凭据；共享机器上应收紧权限或调整创建策略。
7. 新库没有模型渠道和第三方 API 凭据，因此本阶段只验证工作台 UI、路由、配置解析和内部接口，没有执行会产生费用的真实图片/视频生成。
8. `settings` 表首次启动不落默认行；管理端首次保存前，实际默认值只存在于服务层归一化结果中。
9. `docs/backend/system-settings.md` 对当前结构有轻微滞后：源码已有渠道 `id`、`timeout`、公开渠道列表、`allowUserRemoteChannel`、系统提示词分组、AI 日志和存储配置等字段。
10. Next.js 开发服务器会把受版本控制的 `web/next-env.d.ts` 从 `.next/types/routes.d.ts` 自动改为 `.next/dev/types/routes.d.ts`，生产构建又会改回；本次提交前已恢复上游内容，但后续本地启动可能再次产生这项工作树噪声。
11. Docker 配置已静态检查，但本阶段按原生源码方式验证，没有修改或切换线上部署；项目自身仍把 Docker 静态资源路径列为待办风险。

## 9. 第二阶段建议修改位置

第二阶段若实现 Provider Center / 连接中心，建议在现有配置和请求链上演进，不复制或替换现有功能：

- 连接中心 UI 入口：`web/src/components/layout/app-config-modal.tsx`，或在明确交互方案后新增独立页面并从现有配置弹窗跳转。
- 前端渠道类型、默认值、能力过滤和选中逻辑：`web/src/stores/use-config-store.ts`。
- 用户配置读写：`web/src/services/api/user-config.ts`、`handler/user_data.go`、`service/user_data.go`、`repository/user_config.go`。
- 系统渠道管理：`web/src/app/(admin)/admin/settings/page.tsx`、`web/src/services/api/admin.ts`、`model/setting.go`、`service/settings.go`。
- 图片、视频、音频和画布调用接入点：`web/src/services/api/image.ts`、`video.ts`、`audio.ts`、`canvas-agent.ts`、`direct-ai.ts` 与 `handler/ai.go`。
- 路由与代理边界：`router/router.go`、`web/src/app/api/[...path]/route.ts`。
- 数据结构文档：`docs/backend/system-settings.md`、`docs/backend/backend-database.md`。

进入第二阶段前建议先确定：系统渠道与用户渠道是否统一数据模型、API Key 是否继续随完整用户配置同步、连接测试/模型发现是否统一走后端、协议能力如何集中声明，以及迁移策略是否允许直接调整尚未上线的数据结构。
