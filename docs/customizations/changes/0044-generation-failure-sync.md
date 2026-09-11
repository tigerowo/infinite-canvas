# EXT-0044 生成失败与跨浏览器状态同步

## 标识与目标

- 上游基线：`7d6b2ad`，保留 EXT-0040/0042/0043 等既有未提交改动。
- 状态：代码、后端、前端单元及隔离浏览器验证通过，已更新本地 3000 容器。
- 证据：应用日志中 tejiasd2 创建返回 504，没有对应 video_tasks 记录；不存在的客户端任务被固定回答 queued/0。用户提供的上游 408 与此网关 504 分别记录，不视为同一响应。
- sora-v4-pro 请求实际为 multipart 文件，当前渠道只为 tejiasd、tejiasd2 配置 Canvas v1。
- 成功标准：创建失败在服务端可恢复；另一个浏览器可读取相同失败；迟到进行中结果不能覆盖同次失败；重试使用新任务身份；缺失任务与临时查询失败明确显示且可自动恢复；生图使用相同保护；不变更模型协议配置。

## 扩展文件

- 前端 media-reliability：`task-state.ts` 区分真实失败和可恢复查询错误；`canvas-media.ts`、`project-merge.ts` 防止同代次终态回退；`history-references.ts` 复用身份映射、OSS 地址解析和本地缓存；`adaptive-media-frame.tsx` 按真实解码尺寸展示；`use-history-refresh.ts` 共用 15 秒及 focus/visibility 同步。
- `canvas-sync.test.ts`、`oss-regression.test.ts`、`generation-failure-smoke.mjs` 为针对性回归。
- 复用已有服务端任务存储与 modelcapabilities 策略，不建表，不改 NewAPI 核心或插件。

## 上游接入清单

| 文件与符号 | 原因与同步检查点 |
| --- | --- |
| handler/video_task.go / proxyAIVideoTaskRequest | 在现有创建错误分支持久化失败，复用 CreateVideoTask，不复制上游请求实现 |
| handler/ai.go / AIVideo | 缺失任务不能伪造 queued；返回明确状态查询错误 |
| repository/video_task.go | 保留失败记录并供工作台恢复；数据库故障必须与未找到区分 |
| web/src/services/api/video.ts / createVideoGenerationTask、pollVideoGenerationTaskStatus | 共享正在提交的 Promise，避免上传/慢创建期间本浏览器提前查询不存在任务；创建结束后恢复正常轮询 |
| web/src/services/image-storage.ts / setImageBlob | 不撤销不可变 OSS 对象仍被现有卡片引用的缓存 URL；保留 WebDAV 和可替换本地缓存原行为 |
| 画布 canvas-client-page.tsx | 接入共享状态保护、查询错误显示与新重试身份 |
| 生图/视频 page.tsx | 失败历史同步、终态恢复、参考载入、结果自适应和共享刷新；视频客户端 ID 可用于关联失败历史，但不能因此被当作已绑定上游任务 |

上游接入必须留在现有任务编排、日志和缓存写入点：扩展无法在不接入这些函数的情况下观察失败、缓存替换或页面恢复。同步时核对创建错误分支、退款次数、任务身份、历史删除入口和两个工作台的回调；不复制请求实现。

## 配置、样式和数据

- 保留旧素材、数据库表结构和授权；失败记录由现有删除入口释放，不再按 10 分钟清理失败结果。任务列表仍限制最近 100 条，但包含终态以支持浏览器关闭后的恢复。
- 用户确认 sora-v4-pro 是自行漏配接口，本次不修改模型配置。
- 补充范围：历史载入参考图片按持久身份恢复并缓存；重复 OSS 图片缓存不能撤销仍被历史使用的 URL；结果按解码后的真实比例展示，图片和视频共用尺寸容器。
- 不触发收费生成，不改远程 NewAPI，不删除 OSS。

## 验证

- Go 1.25：`go test ./handler ./repository ./service ./extensions/newapi` 通过。隔离数据库和 HTTP fixture 验证创建 408/504、HTTP 200 错误包、缺任务 ID、失败二次查询、跨账号拒绝、保留失败/已归档记录。
- Node：`node --experimental-strip-types --test src/extensions/media-reliability/canvas-sync.test.ts src/extensions/media-reliability/oss-regression.test.ts src/extensions/media-reliability/reference-limits.test.ts src/extensions/newapi/result.test.ts` 共 24 项通过。
- Bun 1.3.14：`bun test src/extensions/media-reliability/auto-sync.test.ts src/extensions/media-reliability/reliability.test.ts` 共 10 项通过。这两份原有测试需要支持别名的 runner，直接 Node 执行会发生模块解析错误；未修改测试或生产配置绕过该要求。
- `node node_modules/typescript/bin/tsc --noEmit`、`docker compose build app`、`git diff --check` 通过。
- 最终镜像的临时 3001 页面：`generation-failure-smoke.mjs` 验证迟到 queued、双浏览器画布失败与刷新、视频创建失败跨浏览器恢复、OSS 参考图载入和缓存且零重复上传、图片/视频真实比例、图片查询故障可见并自动恢复为可同步的真实失败。所有生成/账号/存储接口均拦截，不产生收费生成。
- 同镜像 `reference-limits-smoke.mjs` 回归通过：三个入口合计 50/51 边界保留。
- 替换后的真实 3000 容器再次运行隔离接口的 `generation-failure-smoke.mjs` 和 `canvas-sync-smoke.mjs` 均通过：新增故障恢复、原有节点拖动/播放、双浏览器慢保存和删除、配置失败恢复、游客模型与首尾帧入口均回归；3001 临时容器已移除。
- 生图后端原先已有失败持久化，本次没有把所有图片渠道改成 Canvas v1，也未修改 NewAPI 核心、QIQI 插件或 sora-v4-pro 配置。

## 本地容器与限制

- 本地容器 `infinite-canvas` 已替换，镜像 `sha256:44b7cab040ed023cc336b14f00152b418884c37cb394967fd0fe33cc0f1c5159`，重启次数 0，环境变量与挂载和旧容器一致；首页、视频、生图、画布与健康接口均 200。
- PostgreSQL 备份 `data/extensions/mediaarchive/backups/pre-failure-sync-20260910/database.dump`，1,002,990 字节，`pg_restore --list` 可读。私有容器配置同目录保存且被 Git 忽略。
- Docker 原运行镜像内容索引缺失，直接 tag/commit 不可用；改为成功导出原容器根文件系统 `runtime.tar` 并导入本地回退镜像 `infinite-canvas:rollback-before-failure-sync-20260910`，保留入口和基础运行配置。回退必须复用原挂载/环境，不自动恢复数据库覆盖后续用户数据。
- 未进行真实收费生成；真实供应商响应、长期 OSS 可用性仍需实际使用验证。老任务若从未留下服务端记录，显示“未找到任务记录、自动重新查询”，不凭空补造成功或上游错误。已丢失的纯本地原文件、没有可用 OSS 身份的旧 blob URL 不能凭空恢复，载入会提示重新上传。
- 已检查公共 todo/pending-test，无公共产品范围变更，定制验收集中在本记录。
- 提示补充：历史参考图片载入时，读取异常也明确提示“稍后重试；若原素材已删除或丢失，请重新上传”，保留错误详情；账号切换仍使用独立错误，不把网络异常直接判成文件丢失。
- 提示补充已通过类型检查、10 项 OSS/缓存回归和镜像构建，并替换本地容器为 `sha256:6a0b3ff7b73e606b21b4b6330f2b6d393357b6804c1f8a5f255e5fc87eb97423`；运行正常、重启次数 0、健康接口 200。此前镜像保留为 `infinite-canvas:rollback-before-missing-media-hint`。

## 提交、回退与同步

不提交或推送。回退本次增量或本地回退镜像，保留任务和素材数据；没有模型策略变更需要回退。
