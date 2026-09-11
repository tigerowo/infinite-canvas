# EXT-0040 QIQI New API 视频插件

## 标识与目标

- 编号、功能名、上游基线：EXT-0040、QIQI New API 视频插件、`5a00a76302573602c14b8e012b0dd200929b25c8`。
- 需求与范围：为 New API 提供独立 QIQI 特价模型 Task Plugin，按 stock Sora 异步协议提交、轮询和下载视频，并完整透传 QIQI 的图片、视频、音频参考字段。
- 状态：1.0.2 本地插件、画布解析及归档相关回归已验证；用户确认插件已更新，本地 3000 画布容器已部署；真实生成及关页恢复尚未验证。

## 扩展文件

- `extensions/newapi/plugin/qiqi.js`：QIQI Task Plugin 源码，声明公开模型并实现 `openai_video` 协议。
- `extensions/newapi/plugin/qiqi.test.mjs`：字段透传、模型映射、状态、HTTP 错误、下载和公网 URL 约束测试。
- `extensions/README.md`：补充插件入口。

## 上游接入清单

| 上游文件与符号 | 改动内容 | 必须修改的原因及替代方案取舍 | 上游同步检查点 |
| --- | --- | --- | --- |
| `handler/video_task.go` / `pollVideoTaskFromUpstream` | NewAPI 完成直链在后端归档后再置为完成；失败保留处理中并重试 | 复用现有服务端轮询，支持关闭网页；扩展不反向导入 service | 轮询必须继续独立于浏览器运行 |
| `service/video_task.go` / `VideoTaskResponse` | 自有文件地址返回 storageKey，归档失败返回 archive_error | 现有响应出口需要暴露稳定身份和失败信息 | 完成响应不可丢失素材 ID |
| `repository/video_task.go` / `DeleteFinishedVideoTasksBefore` | 排除已归档任务的十分钟清理 | 避免关页后节点的任务 ID 失效；不增加或迁移表字段 | 自动清理必须保留自有 OSS 结果任务 |
| `web/src/services/api/video.ts` / `cacheProtectedVideo` | 已归档身份解析为当前可用地址，归档错误显式抛出 | 复用现有 OSS 读取逻辑 | 不再次调用 NewAPI 内容代理 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` / 视频轮询 | 错误显示在节点；归档失败节点继续查询后台恢复结果 | 原 catch 吞错导致无限显示创作中 | 保留任务 ID、防止旧请求覆盖新任务 |

## 配置、样式和数据

插件不保存密钥、任务或业务数据。QIQI API Key 只配置在 New API 服务端渠道中，不写入仓库或前端。

New API 后台安装步骤：

1. 在任务插件管理中导入 `extensions/newapi/plugin/qiqi.js` 并启用，插件 Key 为 `qiqi`。
2. 新建 `Task Plugin` 类型渠道并绑定 `qiqi`，Base URL 填 `https://pidoi.com`，不要追加 `/v1`。
3. 填入 QIQI API Key，选择插件声明的 7 个特价模型。通常无需模型映射；仅在对外模型别名与 QIQI Model ID 不同时配置映射。
4. 下游继续调用 New API 的 `POST /v1/videos`、`GET /v1/videos/{task_id}` 和 `GET /v1/videos/{task_id}/content`。

插件模型范围以 QIQI 特价模型列表为准：`chengfeng-3.0`、`chengfeng-480p-pro`、`chengfeng-720p-pro`、`H3video-2k`、`sora-v4-pro`、`tejiasd`、`tejiasd2`。上游调整特价模型时需同步更新 `meta.models` 和测试清单。

参考素材必须使用公网 HTTP(S) URL。1.0.1 同时接受 JSON 和 multipart 文本表单，仍拒绝实际文件上传。表单支持重复 URL 字段和 JSON 数组字符串；将画布的 `input_reference[]`、`video_reference[]`、`audio_reference[]` 转成 `reference_image_urls`、`reference_videos`、`audio_urls`，将 `resolution_name` 转成 `resolution`。也支持 Canvas v1 metadata 素材转换，首帧映射为 `image_url`，按 QIQI 文档拒绝尾帧。最终统一以 JSON 提交，不下载或重新上传媒体。

原有 stock Sora 请求参数、模型列表与时长保持不变。1.0.2 在完成任务的 data.video_url / data.url 是 HTTP(S) 文件直链时，通过 `metadata.canvas_video_result = {version: 1, url}` 返回；NewAPI 标准 OpenAIVideo DTO 不保留顶层 video_url，因此画布前后端只读取这个明确扩展，不把任意 metadata URL 当作结果。签名参数原样保留。插件制品下载也优先使用该直链和 credentialless 模式。不修改 NewAPI 核心源码。

画布账号代理任务由后台轮询触发 `mediaarchive.ArchiveVideo`，复用来源去重、账号归属与安全下载，关闭页面后仍可下载归档。任务只保存自有文件的稳定内容路径并返回 storageKey，重开时申请自有 OSS 访问链接。归档失败显示错误并由后台继续重试；上游链接过期、文件删除或 OSS 不可用仍可能无法归档。已归档任务不再被十分钟自动清理，仍可由用户明确删除任务记录。

限制：上游完成响应必须实际包含直链。若只返回鉴权 `/v1/videos/{id}/content`，插件保留原有内容接口回退；仅在浏览器取得重定向后的地址不能证明轮询响应也包含它。旧任务还可能受 NewAPI 插件版本快照、画布已清理任务记录影响，不能承诺仅替换插件自动修复所有旧任务。

## 验证

| 检查 | 命令或操作 | 结果与证据 |
| --- | --- | --- |
| TDD 红灯 | `node --test extensions/newapi/plugin/qiqi.test.mjs`（实现前） | 失败，原因是 `qiqi.js` 不存在 |
| URL 表单修复红灯 | 同下，在修复实现之前运行新增回归 | 4 项失败：表单被拒绝、Canvas v1 未转换 |
| 插件契约测试 | `node --test extensions/newapi/plugin/qiqi.test.mjs` | 14 项通过，0 失败；包含完成直链扩展及无鉴权下载 |
| 前端回归 | web 下运行 `node --test src/extensions/newapi/result.test.ts src/extensions/media-reliability/oss-regression.test.ts` | 9 项通过；独立 TypeScript 检查与 Next.js 生产构建通过 |
| 后端回归 | `go test ./extensions/newapi ./extensions/mediaarchive ./handler ./service ./repository` | Go 1.25 容器运行全部通过；覆盖直链解析、归档复用、稳定身份及 SQLite 完成任务保留 |
| 真实 QIQI 生成 | 未执行 | 未验证；避免使用用户密钥触发付费任务 |
| 线上 New API 插件宿主 | 未执行 | 未验证；本次未操作线上管理后台 |

## 2026-09-10 画布容器部署

- 按用户授权执行 `docker compose build app` 与 `docker compose up -d --no-deps --force-recreate --pull never app`，旧容器已替换，新容器名仍为 `infinite-canvas`，访问端口为 3000。
- 当前镜像：`sha256:79f0e825d90ec60e0ea9fad52141e4c67a7dc3826189b3d36888e2e9f9aa6715`。环境变量及挂载与替换前逐项比较一致。
- 原镜像保留为 `infinite-canvas:rollback-before-qiqi-20260910`；PostgreSQL 18 备份位于 Git 忽略目录 `data/extensions/mediaarchive/backups/pre-qiqi-20260910/database.dump`，`pg_restore --list` 验证可读取。
- 部署后 `/api/health` 返回 200 `ok`，首页及 `/canvas` 返回 200；容器运行中，检查时重启次数为 0。没有触发付费生成，真实视频归档和关页恢复仍待验收。
- 如需回退，可将上述回退镜像重新标记为 Compose 的 `ghcr.io/tigerowo/infinite-canvas:latest` 并以 `--pull never` 重建 app 容器；不需要恢复数据库。数据库备份不能自动恢复，以免覆盖后续数据。

## 提交、回退与同步

- 提交主题建议：`feat(ext-newapi): 添加 QIQI 视频任务插件`。本次未提交或推送；画布已按后续明确授权部署。
- 回退：插件恢复先前版本，撤回本记录列出的画布接入改动。没有新增表字段；回退任务保留规则后，旧的已归档任务记录将再次受清理策略影响，OSS 文件不会因此删除。
- 同步历史及未完成事项：插件基于当前 New API Task Plugin `openai_video` 契约。上线前需在实际 New API 版本导入插件，使用非生产或低成本模型完成一次创建、轮询和内容下载验收，并按 QIQI 最新能力矩阵复核模型列表。
