# EXT-0029 媒体任务、缓存与恢复可靠性

## 标识与目标

状态：代码已实现，本地自动化验证通过；真实云端、完整双设备流程和性能基准待验收。覆盖 AUD-01 至 AUD-10、AUD-12，AUD-10 的可见区域懒加载尚未实施。

## 扩展与接入

共享缓存、历史待同步队列、媒体快照和归档规则位于 `web/src/extensions/media-reliability/`，Responses 完成校验位于 `web/src/extensions/newapi/response-state.ts`。

- `extensions/taskidentity/identity.go` 保存新视频任务的凭证来源；`service/video_task.go` 创建时记录，`handler/video_task.go` 和 `handler/newapi.go` 查询、下载按所有者和原渠道读取凭证。管理员切换 Key 模式后明确拒绝身份不一致的任务，不静默替换为另一身份。
- `image-storage.ts`、`file-storage.ts` 对 server Blob 使用账号命名空间，切换账号清理内存 URL，丢弃跨会话在途结果；配置请求失败后可重新请求，成功删除后清缓存并释放 URL。视频元数据读取限时 15 秒，完成或失败后释放 video 资源。
- `use-asset-store.ts` 用 storageKey 恢复图片、视频和音频，持久化快照剔除可重建的 Blob 和签名地址。
- 图片 Responses 同时校验流式和 JSON 失败状态，不再把 partial 或单个 output_item.done 当作最终完成。
- 图片、视频历史只同步当前变更，失败保留账号隔离的 IndexedDB 待传记录，重试先补传再拉取，批次最多 100 条；删除先等待后端成功。历史初始化限制同时处理的记录数量为 4。
- 视频重试播放重新申请签名；存储位置区分 server 云端对象、本地缓存、临时链接及归档状态。

## 验收清单

- Go 全量测试通过，`handler/video_identity_test.go` 使用隔离数据库验证两个用户的 Key 选择、模式变更拒绝和来源不可覆盖。
- Bun 29 项通过，包括失败缓存重试、私有缓存隔离、在途会话切换、Responses 状态、持久化快照、并发上限及 NewAPI 请求契约。
- TypeScript 检查通过。Playwright 隔离浏览器验证图片和视频的存储失败、历史同步失败及恢复重试；重试后生成任务数量保持 1，历史改为 server 对象。
- Next.js 生产构建通过；未请求真实模型、上传真实对象、删除真实素材或修改厂商控制台。

## 数据与回退

不增加上游业务表字段。新增独立表 `ext_video_task_identity`，以 task_id、user_id 联合主键保存 source，不保存 Key。旧任务没有来源记录时沿用兼容查询，不能追溯证明创建时的 Key 模式。

旧无账号归属的 server Blob 不复用，也不删除；非 server 的旧本地缓存和历史元数据仍沿用原有结构，本次不宣称全部浏览器数据已经迁移为账号隔离。恢复旧版本代码不会删除新增扩展数据。

未完成：真实双账号浏览器全流程、跨设备媒体恢复、签名到期与 Range 联调、长期内存测量、100/500/1000 条历史耗时基准、可见区域懒加载。后端 upsert 响应仍可能返回全量历史；本轮优化的是前端保存请求及重复解析，不宣称响应体或 FPS 已优化。

## 复测与同步检查

已合入上游 `163771b`，同步检查见 [EXT-0035](0035-upstream-sync.md)。自动同步和本地回退新增原会话校验，避免吞掉换账号异常；私有缓存、失败重试及相关隔离浏览器回归通过。新增云文件清理的真实共享引用场景仍待验收。

浏览器脚本：`web/src/extensions/media-reliability/repair-ui-smoke.mjs`。先启动当前前端，再使用安装了 Playwright 和 Chromium 的 Node 环境运行：

```sh
node web/src/extensions/media-reliability/repair-ui-smoke.mjs
node web/src/extensions/media-reliability/repair-ui-smoke.mjs /image
node web/src/extensions/media-reliability/repair-ui-smoke.mjs /video
node web/src/extensions/media-reliability/repair-ui-smoke.mjs /canvas/fixture
node web/src/extensions/media-reliability/repair-ui-smoke.mjs /admin/settings
```

`EXT_MEDIA_RELIABILITY_TEST_URL` 默认 `http://127.0.0.1:3001`；可用 `EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE` 和 `EXT_MEDIA_RELIABILITY_CHROMIUM` 指定现有依赖路径。截图写入系统临时目录的 `huabu-repair-smoke`，可用 `EXT_MEDIA_RELIABILITY_ARTIFACT_DIR` 覆盖。脚本使用独立浏览器、虚构账号，并拦截全部 `/api/` 请求，视频内容是故意无效的测试数据，用于失败和保存流程，不代表播放成功。

上游同步时重点核对：存储服务的解析/上传/删除入口仍通过 scopedMediaStore；素材 store 的恢复和持久化两端仍调用快照规则；工作台保存、恢复、删除必须同时保留队列和错误状态。视频身份接入必须覆盖创建、轮询及内容下载，不能只迁移其中一条路径。这些入口持有原有任务和页面状态，故保留必要接入，通用逻辑集中在扩展中。
