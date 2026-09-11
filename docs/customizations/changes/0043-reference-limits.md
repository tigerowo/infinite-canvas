# EXT-0043 统一参考素材限制

## 范围与成功标准

按用户最终确认，画布、视频创作台、生图每次生成的图片、视频、音频参考素材合计最多 50 个，不再使用各模型旧的 2/3/4/9 等数量截断。音频取消原文件大小上限。保留地址准备、登录校验与现有素材类型/协议字段映射，不改变生成结果数量。图片、视频文件大小及其他模型参数本次不调整。

验证标准：混合素材合计 50 个可以完整进入请求，第 51 个被明确拦截；单独 50 张图可以提交，超限不得静默裁剪；超过旧 15MB 的参考音频可以进入上传和引用；画布与工作台行为一致。

## 实现与复用

- `web/src/extensions/media-reliability/reference-limit.ts` 提供唯一的 50 总量常量、计数和提示。普通参考、首尾帧和实际使用的元素素材占用同一预算。工作台上传/粘贴/素材选择先检查新增总量，提交快照与共用请求层再次检查，覆盖旧记录和异步添加。超限保留原输入，不按前 50 个静默截断。
- 画布节点数量不限，仅检查本次生成实际引用的媒体；超限时保留提示词，用户断开多余连接后可重试。删除普通参考素材、Kling 元素列表和元素内素材的旧截断，50 个以内完整保留。
- 取消参考音频的 15MB 检查，以及工作台单个/合计音频时长预过滤，避免数量已放开却仍按总时长丢弃素材。兼容上传接口不再用 80MB 请求体限制拦截音频；32MB multipart 参数仅为内存阈值，超出后使用临时文件。
- `extensions/mediaarchive/media_body.go` 统一远程媒体正文读取：音频不设置固定字节上限，图片/视频保留原 256MiB 归档限制；保留 MIME 检查和完整字节读取。
- 画布与工作台继续共用 `services/api/video.ts`，生图复用原图片请求服务。公网地址仍由 `extensions/public-media/references.ts` 准备，NewAPI 图片 Chat/Responses 原有正文转换保留，不扩大为全部图片请求都传公网 URL。

## 必要上游接入

本轮主要删除原有入口中的拦截，无法仅通过新增扩展取消已有截断；不复制页面或协议编码器。新增媒体正文读取和本轮前端回归放在扩展目录。

| 路径 | 符号及原因 | 上游同步检查点 |
| --- | --- | --- |
| `web/src/lib/seedance-video.ts` | `SEEDANCE_REFERENCE_LIMITS` 删除数量及音频大小 | 图片/视频大小保留 |
| `web/src/app/(user)/video/page.tsx` | `addReferences`、剪贴板/素材选择、`buildRequestSnapshot`、元素规范化和参考条 | 所有添加方式与提交均不截断；预览封面裁剪不影响真实请求 |
| `web/src/app/(user)/image/page.tsx` | `canAddReferences`、上传/剪贴板/素材/结果引用、`buildRequestSnapshot` | 共用总量提示，超限不清空提示词 |
| `web/src/app/(user)/video/components/kling-v26-workbench-panel.tsx` | 元素新增、参考图与音频按钮禁用条件 | 保留模型类型/模式支持，移除数量门槛及旧提示 |
| `web/src/app/(user)/canvas/components/canvas-node-generation.ts` | `buildCanvasVideoAdvancedContext`、`canvasReferenceLimitError` | 元素列表和每元素节点引用完整传递、合计检查 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | `handleGenerateNode` | 地址准备和任务启动前检查总量，超限返回而不创建任务 |
| `web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx` | `submit`、`onGenerate` 的可选 `onAccepted` | 通过校验才清空提示词，保持原正常提交的清空时机 |
| `web/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx` | `KlingElementListSection`、`MultiResourcePicker`、规范化函数 | 新增、选择、恢复均不得重新截断 |
| `web/src/services/api/video.ts` | `createVideoRequestBody`、CogVideo/Agnes/Kling 元素编码 | 数组协议全量编码，公网准备与任务归档复用原服务 |
| `web/src/services/api/image.ts` | `requestImages`、`createCanvasImageTask` | 直连和持久任务均在转换素材前检查上限 |
| `handler/apimart_video.go` | `apimartInputConfig`、`setAPIMartImageReference`、Kling 元素规范化、必需字段检查 | 删除固定 maxImageRefs 和 happyhorse 数量门槛，保留协议字段形状 |
| `handler/apimart_image.go` | `apimartImageConfig` | Seedream 等数组请求不再裁到 10 张 |
| `handler/media_reference.go` | `UploadReferenceMedia`、`referenceMediaTypeMaxBytes` | 音频取消文件/请求总量上限，保留格式、鉴权及临时文件清理 |

扩展内部接入：`web/src/extensions/newapi/request.ts`、`web/src/extensions/newapi/image.ts` 共用总量校验；`extensions/mediaarchive/archive.go` 复用正文读取。测试接入：`handler/reference_limits_test.go` 新增回归；`handler/media_reference_test.go` 与 `handler/model_protocol_direct_test.go` 更新旧限额预期。无数据库表结构或持久数据迁移。

## 验证与边界

- `reference-limits.test.ts` 新增 4 项通过：通用视频和 Canvas v1 完整传递 34 图、8 视频、8 音频，51 个在转换前拒绝；生图 50 图通过、51 图拒绝；画布连接与元素计入同一总量。与同步、OSS、NewAPI 结果回归共 19 项通过，独立 TypeScript 检查通过。
- Go 1.25 下 `go test ./handler ./extensions/mediaarchive ./repository ./service` 通过。兼容参考上传接口实际接收 81MiB 音频；远程正文测试验证音频大小分支及视频限制保留，未据此声称完成超大音频真实 OSS 上传。
- Next.js 生产构建通过。`reference-limits-smoke.mjs` 在临时 3001 镜像预览和新 3000 容器均通过：视频工作台 42 图、4 视频、4 音频（合计 50，含 16MiB 音频）完整提交公网 URL，新增第 51 个拦截；生图 50 图通过、第 51 个拦截；画布 51 个拒绝且保留提示词，断开一个连接后完整提交 50 个。浏览器模拟账号和存储服务并拦截生成，无真实收费请求。
- 新 3000 容器的 `canvas-sync-smoke.mjs` 回归通过：视频交互与实际比例、双浏览器删除/刷新、慢保存并发、配置失败恢复、游客模型与首尾帧入口。临时 3001 测试容器已停止并移除。
- 不把单值协议字段改成数组：NewAPI 标准视频请求的单图字段、88API 单视频字段及首尾帧/驱动音频字段仍按其协议处理。多素材 NewAPI 渠道使用 Canvas v1；AutoDL 按工作流实际声明的插槽处理，工作流变化后读取新配置。模型本身仍可拒绝超出支持范围的请求。
- 本次不改变生成结果数量、图片/视频大小、视频时长/分辨率或支持格式。软件取消音频固定上限不代表浏览器内存、网络、存储服务或上游不存在限制。
- 已检查公共 todo/pending-test 文档，定制验收集中于本记录。模型素材使用文档、真实模型多素材生成留待后续，不将建议的模型能力写成事实。

## 部署

- 按已有授权替换 `infinite-canvas` 容器，运行镜像 `sha256:41e9d92954497128de7ffca6f6abbe242945d8e15c6f126a9e0929ca03dca05c`。环境变量、数据挂载和重启策略与旧容器一致，重启次数 0；健康接口、首页、画布、视频和生图页面均返回 200，启动日志未出现 panic/fatal/启动错误。
- 回退镜像 `infinite-canvas:rollback-before-reference-limits-20260910`；PostgreSQL 备份 `data/extensions/mediaarchive/backups/pre-reference-limits-20260910/database.dump`，1,000,923 字节，`pg_restore --list` 验证可读。容器配置备份位于同目录，包含私有环境配置，不纳入 Git 或对外分享。
- 无数据库迁移。回退时重用旧镜像并重建 app 即可，不自动恢复数据库覆盖后续数据。浏览器需要刷新加载新前端；旧客户端没有新增的合计 50 校验。本次合计规则用于应用生成入口，不作为外部调用者的服务端配额机制。
