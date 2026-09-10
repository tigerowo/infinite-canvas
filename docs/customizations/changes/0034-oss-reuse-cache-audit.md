# EXT-0034 OSS 复用、缓存与归档修复

## 状态与基线

基于合并提交 `c3edc5189536aad7e06be632936962f0bedbb530` 实现。初审发现的 OSS-01 至 OSS-07 已按下述方案处理，本地自动化验证通过，真实云端验收范围见文末。本轮未推送、发布或替换运行中的 3000 容器。

合并本身修复了历史字符串引用遗漏，并保留了自动同步成功后的 `storageKey` 和会话保护；本记录覆盖合并后仍存在的问题。上游合并详情见 [EXT-0035](0035-upstream-sync.md)。

## 问题与实际修改

| 编号 | 原问题 | 本次实现 |
| --- | --- | --- |
| OSS-01 | 模型签名的已知 URL 缓存跨账号复用，在途结果缺少会话检查 | 账号或 token 变化时清空内存缓存；上传、签名和交付检查原会话，旧请求不能交付给新账号 |
| OSS-02 | 历史删除可能误伤其他画布、工作台、设备仍引用的文件 | 删除历史和自动清理不再物理删除云对象，也不删除本地唯一副本；只释放当前账号可由普通 `server:` 对象重建的 Blob 缓存 |
| OSS-03 | 本地素材首次转存映射只在内存，刷新和 URL 型历史丢失身份 | 按账号持久保存本地 key、来源 URL、返回签名 URL 的摘要到 server key 映射；旧自有 S3 URL 可由鉴权 `/resolve` 恢复身份 |
| OSS-04 | 图片正文先读远程；同一对象重复申请模型签名 | `imageToDataUrl` 优先完整本地 Blob，按会话和身份合并并发，下载成功写回缓存；模型签名按 server key 和有效期复用 |
| OSS-05 | 上传每次随机 UUID，响应丢失或数据库失败产生重复对象 | 登录上传按账号、Provider、Endpoint、Bucket、前缀、MIME 和内容摘要产生稳定 ID/对象路径；已登记对象直接复用，登记失败后重试同一路径 |
| OSS-06 | 普通远程生成结果先下载到浏览器再上传后端 | 新增鉴权服务端导入接口，后端拉取 HTTP(S) 结果并写入管理员默认存储，返回 server key |
| OSS-07 | 自动同步和归档各自去重，刷新后仍可能传输 | 自动同步、归档和模型参考共享持久 server key 映射；Web Locks 协调标签页；受保护视频按账号、渠道、模型和任务身份持久复用 |

删除策略是“移除业务引用，保留文件”。浏览器无法可靠判断其他设备的引用，因此不在历史删除链路中尝试全局垃圾回收。保留云对象及本地唯一副本会增加存储占用；未来显式回收需独立设计服务端完整引用检查。本次没有扫描或删除用户已有文件。

## 素材链路

- 普通 `server:文件ID` 发给 URL 型模型：复用文件身份，只在需要时签名，不上传正文。
- 本地素材首次用于 URL 型模型：浏览器读取本地文件，后端上传一次；后续按持久映射复用。
- 普通远程生成结果：浏览器向 `/api/extensions/media-archive/import` 提交 URL 和文件名，正文在服务端下载和上传；相同账号、相同来源已有登记时不再下载。
- 必须带模型协议凭据的受保护视频：保留既有内容接口下载方式，首次取得正文后上传或保存本地；并发轮询和刷新先查持久结果，再解析本地 Blob 或签名。Gemini 自动同步关闭时保留本地保存语义。
- NewAPI 文件型接口仍按协议发送 multipart/Base64。这是发给模型的请求体，不等于再次写 OSS。
- 预览签名、模型签名和完整 Blob 是不同缓存。视频播放可能采用 Range，不强制为缓存下载完整视频。

## 扩展与必要接入

| 文件或模块 | 符号/职责 | 上游接入原因及同步检查点 |
| --- | --- | --- |
| `extensions/mediaidentity/` | 摘要、上传互斥锁及身份隔离测试 | 无上游反向依赖；保持账号、Provider 和内容隔离 |
| `extensions/mediaarchive/` | `Register`、`importRemote`、`sourceIdentity`、导入/恢复接口 | 独立扩展 API 和来源表，复用上游鉴权、存储及安全 HTTP 客户端 |
| `router/router.go` | 注册 `/api/extensions/media-archive` | 启动入口必须接入；保留 `UserAuth`，迁移失败停止启动 |
| `service/storage.go` | `UploadStorageObjectWithProvider`、`uploadedStorageObject` | 所有上传入口汇聚于此，扩展单独实现无法保证普通上传重试稳定；保留原 Provider 选择和权限规则 |
| `web/src/extensions/media-reliability/identity.ts` | 来源摘要、持久映射、同步元数据、Web Locks、导入调用 | 保存摘要、身份及媒体元数据，不保存签名 URL 或凭据正文 |
| `web/src/extensions/media-reliability/protected-media.ts` | `reuseProtectedMedia` | 保存 server 或本地结果 key；下载失败允许重试，切号旧结果不落入新账号 |
| `web/src/extensions/public-media/references.ts` | `publicImageURL`、`publicMediaURL` 及内部解析 | 参考图协议边界仍返回 URL，通过映射恢复稳定身份，不批量改写节点和历史结构 |
| `web/src/extensions/media-reliability/archive.ts` | `archiveGeneratedMedia` | 先恢复身份再归档，写回来源映射，保留失败重试和有界并发 |
| `web/src/services/image-storage.ts` | `autoSyncToCloud`、`imageToDataUrl`、远程上传、删除入口 | 正文读取和上传入口在上游；检查缓存优先级、会话检查、默认存储及安全删除语义 |
| `web/src/services/file-storage.ts` | `uploadMediaFile`、远程上传、删除/清理入口 | 下载延后到同步缓存未命中时；保持本地保存、WebDAV 和普通 Blob 上传行为 |
| `web/src/services/api/video.ts` | `videoSyncKey`、`cacheProtectedVideo`、`cacheProtectedGeminiVideo` | 受保护内容在普通归档前被下载，必须在此接入持久复用；保留协议鉴权和自动同步开关 |

测试位于扩展目录的 `identity_test.go`、`archive_test.go`、`oss-regression.test.ts` 及既有 `repair-ui-smoke.mjs`。Skill 按钮接入单独记录于 [EXT-0036](0036-skill-toolbar.md)。

## 数据、兼容与回退

- 服务端新增 `ext_media_archive_sources`：`id` 为账号和规范化来源摘要，`object_id` 指向既有 `storage_objects.id`。路由初始化时 `AutoMigrate`，可重复执行，失败停止启动。无上游表字段/索引变更，见 [数据库说明](../../backend/backend-database.md)。
- 来源规范化去掉 fragment；识别 S3 签名时去掉 `X-Amz-*`，保留其他业务 query。缓存面向不可变生成结果，不适合内容持续变化的同一 URL。
- 浏览器 localforage 新增 `ext_media_identities`、`ext_protected_media`，记录键按账号和来源摘要隔离。前者保存 server key，独立 `sync:` 键还保存大小、类型、尺寸和时长，避免刷新复用丢失元数据；后者也可保存受保护视频本地 key。既有 Blob 存储和归档清单继续沿用。
- IndexedDB 不可用时允许降级，Web Locks 不支持时仍可执行。此时可能增加请求；登录服务端上传的稳定对象路径仍提供兜底。
- 已有对象 ID、Provider 和路径不迁移；首次使用时惰性恢复身份。管理员更换默认存储不迁移旧对象。匿名上传仍沿用随机身份，浏览器直传 WebDAV 不纳入服务端内容去重保证。
- 回退时撤销本记录所列接入和扩展代码，保留新表、浏览器记录和已上传对象；旧代码忽略这些扩展数据。不要把回退实现等同于删除素材。

## 验证与限制

已执行：

1. 后端全量 `go test ./...` 通过；隔离 SQLite/模拟传输测试覆盖 8 个并发导入只 GET 1 次、PUT 1 次，刷新/响应丢失后的重复调用不增加传输，跨账号隔离，以及 OSS 成功、DB 登记失败后重试同一路径。
2. 来源恢复接口覆盖同账号精确匹配、错误 host、另一账号和未登录；来源摘要覆盖签名变化及业务 query 区分。
3. 前端 `bun test` 全量 64 项通过；新增回归执行完整模块源码，模拟刷新保留磁盘，覆盖素材复用、同步元数据、正文缓存、转存后原本地 Blob 优先、账号切换、历史清理、服务端导入、受保护视频云端/本地持久结果及失败重试。
4. 独立 TypeScript 检查、Next.js 生产构建、既有 NewAPI 插件 17 项测试通过。构建的类型跳过不替代独立类型检查。
5. 隔离浏览器覆盖首页 Skill、图片和视频工作台失败恢复、归档重试不重新生成、画布操作及移动端边界；视频自动同步开启、关闭两态通过，无页面运行错误。

复现命令：根目录 `go test ./...`；`web/` 内 `bun test`、`node node_modules/typescript/bin/tsc --noEmit --incremental false`、`bun run build`；根目录 `node web/src/extensions/media-reliability/repair-ui-smoke.mjs /video`（可换 `/image`、`/canvas/fixture`，省略路径验证首页）。浏览器脚本允许通过 `EXT_MEDIA_RELIABILITY_TEST_URL`、`EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE`、`EXT_MEDIA_RELIABILITY_CHROMIUM` 指定环境，通过 `EXT_MEDIA_RELIABILITY_AUTO_SYNC=true` 验证开启状态。

尚未验证及明确边界：

- 本轮没有对真实七牛/TOS/CDN 发起计费生成或测量云端流量；模拟测试的 GET/PUT 次数不代表生产计费实测。多标签页 Web Locks 和跨设备完整真实流程仍需验收。
- 本进程合并相同上传；多后端实例可能同时 GET/PUT 同一稳定对象路径，不保证跨实例网络请求恰好一次。数据库登记失败后允许重复 PUT 同一路径；若此后永不重试，不提供主动孤儿对象回收。
- 旧 URL 恢复仅匹配当前账号自有 S3 源站的 scheme、host、path。任意 CDN URL、身份映射已清空且过期的外部 URL 不保证恢复。
- 导入接口仅 HTTP(S)、无 URL userinfo，使用既有 SSRF/DNS/重定向保护；请求体 32 KiB、文件 256 MiB、下载超时 5 分钟，仅接收完整 200、非空媒体结果。需要协议凭据的内容保留专用下载链路。
- 归档仍由页面触发，没有新增后台持久作业队列，关页不保证继续。只有成功登记的来源可无下载复用；失败来源仍可能过期。
- 3001 是新前端开发预览，API 仍转发到 3000 旧后端；它不能用于验收本轮新增导入接口。完整联调需加载配套新版后端，本轮未替换容器。
