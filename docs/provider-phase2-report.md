---
title: 连接中心第二阶段验收
description: Provider Center、RunningHub、Mac CLI helper、迁移与安全预算验收记录
---

# 连接中心第二阶段验收报告

## 1. 范围与基线

- 分支：`codex/provider-center-mac`
- 第二阶段起点：`a8fd27e`
- 平台：macOS 14.3（Build 23D56，arm64）
- Go：1.25.0 darwin/arm64
- Node.js：24.19.0，仅作为含冒号路径下执行前端 CLI 的兼容运行时
- Bun：1.3.14
- 数据库：SQLite；自动迁移和人工页面回归均使用独立临时数据库，没有修改现有 `data/infinite-canvas.db`
- 外部调用：没有调用真实模型、RunningHub、S3、WebDAV、OAuth 或线上部署接口

本阶段完整复用现有生成、画布、工作流、素材、提示词和用户配置链路，只新增 Provider 领域层、安全预算与协议 adapter，没有迁移参考仓库业务实现，也没有修改线上部署。

## 2. STITCH 与视觉基线

`preparation/stitch/` 当前只有 `README.md`，未找到桌面稿、窄屏稿、HTML/CSS、设计 token 或版本说明。现有页面不能标记为“STITCH 已确认”。详细清单见 [连接中心设计状态](design/provider-center-design-status.md)。

代码侧暂以 `preparation/03-stitch-design-brief.md` 为 `brief-fallback-2026-08-24` 基线，完成以下修正：

- 保持安静、工作台式布局，去除营销型结构和装饰性视觉。
- 桌面表格、窄屏卡片及最大 8px 圆角。
- API/CLI Tab、空态、加载态、错误态、禁用态、超时态与脱敏凭据提示。
- RunningHub 使用独立说明、引用格式和检测按钮，不混入 OpenAI 兼容模型刷新。
- CLI 可执行程序为 helper 检测后的只读字段，页面输入不会决定执行命令。
- 已连接数量为零时使用中性状态点，避免误报健康。

## 3. Provider Center 与迁移演练

连接中心提供脱敏 CRUD、默认连接、启停、连接检测、旧配置预览及显式迁移。API Key 和自定义请求头加密保存；响应只返回是否存在、掩码和请求头名称。

迁移演练使用完整 HTTP 调用链和隔离 SQLite：

1. 运行时生成随机用户、密码、JWT Secret 和旧渠道密钥。
2. 保存含顶层与渠道级明文密钥的旧 `localChannels`。
3. 只读预览确认 1 个可导入渠道和 2 处可清理密钥，响应不含密钥。
4. 使用 `cleanupLegacy=true` 在事务中导入并加密保存 Provider。
5. 确认旧明文被清除、渠道改为 `managed` 引用且能力渠道 ID 已映射。
6. 再次预览确认明文密钥和可复用旧条目均为零。

自动化结果：`TestProviderMigrationHTTPRehearsal` 通过。演练没有测试连接、没有访问真实渠道，也没有写入用户现有数据库。

浏览器人工回归使用用户确认后输入的临时账号密码及隔离 SQLite，已确认：

- 未登录访问 `/providers` 跳转 `/login?redirect=%2Fproviders`，注册后可回到目标页。
- API/CLI Tab、桌面表格、390px 窄屏卡片、加载/空/未测试/不可用状态无横向溢出。
- 无凭据 OpenAI 测试连接可创建、设为默认、编辑并显示操作菜单，全程未测试真实渠道。
- RunningHub 自动切换官方 Base URL 和四类能力，非法引用在前端阻止保存，合法 workflow 引用可保存。
- CLI executable 为只读；CLI 可登记，Codex 内置浏览器携带非回环转发来源时被拒绝，直接本机回环请求可完成固定版本检测。
- 我的画布、生图工作台、视频创作台、提示词中心和我的素材均能打开并呈现空态/基础控件，没有启动生成或上传。

回归过程中发现并修复两个问题：普通用户注册后的目标页重定向被首页重定向覆盖；CLI 表单提交时对未挂载的自定义请求头字段直接调用 `trim()`。修复后均在同一隔离环境复测通过。

## 4. RunningHub adapter

实现范围：

- 连接检测：`POST /uc/openapi/accountStatus`
- AI 应用提交：`POST /task/openapi/ai-app/run`
- 工作流提交：`POST /task/openapi/create`
- 状态查询：`POST /task/openapi/status`
- 产物查询：`POST /task/openapi/outputs`
- 本地接口：`POST /api/v1/providers/:id/runninghub/tasks` 与 `GET /api/v1/providers/:id/runninghub/tasks/:taskId`

协议约束：

- 引用只接受 `app:<6–32 位数字 ID>` 或 `workflow:<6–32 位数字 ID>`。
- Base URL 只允许 RunningHub 官方 HTTPS 主机，避免把凭据发送给任意用户地址。
- 节点参数最多 256 项；入站请求体最多 2 MiB。
- 提交最多 1 次上游请求；查询最多 2 次，并共享 4 MiB、45 秒累计预算。
- 不接收 webhook URL，不抓取产物 URL，不回显上游错误正文。
- 自动测试使用本地模拟服务，覆盖官方鉴权形状、应用/工作流引用、任务提交/查询、未知状态及累计响应体限制。

实现依据为 RunningHub 官方 OpenAPI 文档：

- 总览与任务调用模式：<https://www.runninghub.ai/runninghub-api-doc-en/>
- 账户状态：<https://www.runninghub.ai/runninghub-api-doc-en/api-425761030>
- 任务状态：<https://www.runninghub.ai/runninghub-api-doc-en/api-425761033>
- AI App 提交与产物示例：<https://www.runninghub.ai/runninghub-api-doc-en/doc-8287470>
- Workflow 提交与产物示例：<https://www.runninghub.ai/runninghub-api-doc-en/doc-8287471>

真实账号检测和任务生命周期未执行，需用户另行提供沙盒凭据、调用预算和明确授权。

## 5. 受控 Mac CLI helper

helper 由 `CLI_HELPER_ENABLED=false` 默认关闭，仅在以下条件全部满足时运行：

- macOS；
- 已登录用户；
- 请求远端地址、Host、Origin、转发 Host 和转发客户端地址均为回环；
- 协议为固定 allowlist：Codex、Gemini CLI 或即梦 CLI；
- 固定候选程序名，固定参数仅为 `--version`。

helper 不安装、更新或登录 CLI，不读取 shell profile，不使用用户填写的 executable，不执行任意参数或真实模型请求。版本检测限制 5 秒、并发 2、输出 16 KiB并脱敏；解析后的程序必须处于受控目录、为普通文件且不可被组或其他用户写入。

自动测试覆盖固定名称、软链接解析、可写文件拒绝、macOS 版本探测、超时边界、输出上限与敏感词脱敏。本阶段没有设计远程命令执行接口；后续如需任务型 helper，应采用独立本机伴随进程、签名/哈希版本清单和一次性授权，而不是扩展当前 Web 路由接受任意命令。

## 6. 安全预算收口

第二阶段同时完成以下安全项：

- 用户 Provider SSRF 防护，禁止私网、回环、链路本地、CGNAT、环境代理和危险重定向。
- 图片/AI 代理拒绝同源 HTML/SVG，并限制入站与上游响应体。
- OAuth state 签名、时效、HttpOnly SameSite Cookie 绑定，以及 URL 一次性交换码替代 JWT。
- WebDAV、S3/R2 和提示词同步的总请求数、总字节与总体 deadline。
- 工作流 Agent、模型探测、后台探测和生成协议 adapter 的成功响应累计读取限制。
- API JSON、媒体上传、同步、生成、下载的入站体积、速率与并发预算。
- 视频、画布图片和画布音频的每用户活动任务上限及持久化轮询预算。

预算明细见 [上游读取预算](backend/upstream-read-budgets.md)、[入站请求读取预算](backend/inbound-request-budgets.md) 和 [请求速率与并发预算](backend/request-rate-budgets.md)。

## 7. 前端正式脚本与验收

新增标准脚本：

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

结果：

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Vitest | 通过 | 2 个测试文件，5 个测试；覆盖 Provider 协议和登录安全重定向 |
| TypeScript | 通过 | `tsc --noEmit`，并移除 Next 构建期 `ignoreBuildErrors` |
| ESLint | 通过 | 0 error、117 warning；warning 为既有兼容基线 |
| Next build | 通过 | TypeScript、20 个页面生成和 standalone 生产构建通过 |
| 新增/本阶段关键文件 Prettier | 通过 | 连接中心、Provider、配置与修复文件单独校验通过 |
| 全仓 `format:check` | 未通过 | 82 个既有文件未符合 Prettier；本阶段不做整仓无关重排 |

当前工作区路径包含冒号，POSIX 会把 Bun 注入的 `.bin` PATH 拆开。本机验收继续使用工程外临时 shim；标准脚本本身保持可移植，不写入本机绝对路径。

## 8. Go 全量验收

以下命令均通过：

```bash
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

RunningHub、CLI helper、回环来源校验和迁移演练的聚焦测试也全部通过。Go 的 `./...` 会额外发现 `web/node_modules/flatted/golang/pkg/flatted`，该第三方包没有测试文件，不影响项目测试结果。

## 9. 已知问题与后续项

- STITCH 正式设计稿仍缺失，不能完成像素级设计确认。
- 真实 RunningHub 联调缺少沙盒凭据和调用授权。
- 全仓仍有 117 条 ESLint warning 和 82 个 Prettier 基线文件，建议分批治理，不与功能提交混合重排。
- 受控 CLI helper 当前只做版本发现；任务执行需要另行威胁建模、伴随进程协议、用户逐次授权和审计日志。
- 进程内速率/并发预算适合当前单机模式；多实例部署前需改为共享限流存储。

## 10. 提交策略

第二阶段整理为一个功能与安全基线提交，包含 Provider Center、迁移、RunningHub、Mac CLI helper、安全预算、前端测试工具链和文档。提交前执行 `git diff --check`、敏感文件检查和仅报告位置的 secret pattern 扫描；不包含 `.env`、SQLite、运行时 shim、测试密码或 API Key，也不推送远端。
