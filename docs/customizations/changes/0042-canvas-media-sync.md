# EXT-0042 媒体节点交互与画布同步

## 标识与目标

- 状态：已实现并加载本地 3000 容器；单元、类型、后端、生产构建及容器双浏览器回归通过。
- 范围：视频节点选中、拖动及设置；图片/视频按实际素材比例显示；视频创作台移除首尾帧；生图和视频共用登录模型及公网素材入口；同账号跨浏览器画布及节点删除同步，排查结果消失。
- 成功标准：视频画面可拖动且播放控件正常；横竖素材外框与实际比例一致；游客无模型选项；参考素材先经现有公网 URL 服务再提交；旧浏览器不能将已删除节点或过时任务状态写回，新状态能在另一浏览器读取。

## 根因与处理

- 视频画面被节点的 PointerEvent 排除规则拦截，透明缩放角落还会覆盖播放按钮。仅原生 controls 视频排除节点拖动，自定义播放及进度控件置于缩放层之上。
- 节点外框依赖请求参数，没有在媒体加载后使用实际宽高。新 `canvas-media.ts` 复用 `fitNodeSize`，按实际图片/视频比例调整并保持中心，保留自由变形；忽略旧来源加载事件与旧生成回调。已成功且拥有内容或 storageKey 的视频不接受迟到状态覆盖。
- 画布删除接口及保存错误原先被吞掉；另一个浏览器缺少持续刷新，旧全量快照可能覆盖已完成视频或被删节点。新增持久 pending/base、版本条件保存和按 ID 三方合并；同画布保存串行，等待期间只合并新增编辑。删除胜过旧编辑，远端删除整画布时退出详情。
- 恢复媒体签名不再被当成内容修改。图片只有 storageKey、没有 content 时也能恢复；单个素材读取失败不会阻断整画布。等待媒体恢复期间发生的本地编辑参与合并。
- 同账号页面每 5 秒、重新聚焦及恢复网络时同步；首次同步配置加载失败后可重试，配置尚不可用时编辑先落本地待同步快照。同步失败显示提示。
- 旧删除标记原先 7 天后物理删除，旧客户端随后可能重新导入。清理改为清空内容、保留精简 tombstone，不增加表或字段。旧浏览器仍可读取/保存，但必须刷新加载新客户端，才能使用并发合并保护。
- `/video` 移除首尾帧入口、状态与新请求参数，保留历史类型的兼容读取。模型登录门控集中在 `useEffectiveConfig`；`ModelPicker` 不再显示无有效候选的旧值。
- `/image`、`/video` 和画布已经共用 API 服务层的 `publicImageURL` / `publicMediaURL`，本次核实并复用，未复制上传或签名逻辑。

## 扩展实现与上游接入

新增实现集中于 `web/src/extensions/media-reliability/`：`canvas-media.ts`、`project-merge.ts`、`project-sync.ts`、`use-project-sync.ts`；扩展 `snapshot.ts` 对带 storageKey 的临时 content 做持久化清理。同步数据使用 localforage `ext_canvas_sync`，key 为 `ext:media-reliability:canvas:<userId>`，不保存凭据。

| 上游路径 | 符号与必要性 | 同步检查点 |
| --- | --- | --- |
| `handler/canvas_project.go` | `SaveUserCanvasProject` 读取可选 `base_updated_at` | 保留旧客户端请求兼容与错误响应规范 |
| `service/canvas_project.go` | `SaveCurrentUserCanvasProject` 传递版本 | 鉴权仍从上下文取账号 |
| `repository/canvas_project.go` | `SaveUserCanvasProject` 原子版本条件更新；`CleanupDeletedCanvasProjects` 保留删除标记 | 必须在原数据库更新路径校验，不能仅在前端防止竞争；无表结构改动 |
| `web/src/services/api/canvas-tasks.ts` | `saveCanvasProject` 传递基准版本 | 与后端字段一致 |
| `web/src/app/(user)/canvas/stores/use-canvas-store.ts` | 保存、删除、恢复及 `syncWithRemote` 接扩展快照/合并 | 复用原项目 store 与 debounce；保存串行，错误可见，签名变化不保存 |
| `web/src/app/(user)/layout.tsx` | 调用 `useProjectSync` | 复用登录生命周期，定时器及监听器卸载清理 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 恢复、远端 revision、`applyCanvasVideoTaskUpdate`、`handleMediaLoaded`、`deleteCurrentProject` | 页面持有节点 state，需接入远端恢复和加载事件；保持用户当前视角，忽略过时异步结果 |
| `web/src/app/(user)/canvas/components/canvas-node.tsx` | PointerEvent、媒体加载事件及 `VideoNodeContent` 控件层级 | 自定义播放、节点移动、缩放不能相互遮挡 |
| `web/src/app/(user)/canvas/components/canvas-delete-projects-dialog.tsx` | `confirm` 等待服务器删除成功才移除本地 | 失败保留画布及重试入口 |
| `web/src/app/(user)/video/page.tsx` | 首尾帧 UI/状态/新请求移除，快照前配置校验 | 普通图片/视频/音频参考保留，旧日志兼容 |
| `web/src/app/(user)/video/components/kling-v26-workbench-panel.tsx` | 素材选择目标类型 | 与移除后的首尾帧接口一致 |
| `web/src/stores/use-config-store.ts` | `useEffectiveConfig` 登录门控 | 不清除持久化配置，游客各能力模型为空 |
| `web/src/components/model-picker.tsx` | 当前显示值必须对应有效候选 | 避免回显无效旧模型 |

## 验证与限制

- `canvas-sync.test.ts`、`oss-regression.test.ts`、`newapi/result.test.ts`：共 15 项通过，覆盖远端删除、视频完成状态、保存冲突、离线 pending、配置不可用暂存、单调版本、实际宽高及已有 OSS/公网 URL 链路。
- `repository/canvas_sync_test.go` 使用隔离 SQLite：版本条件更新、相同版本拒绝、账号隔离、删除及清理后旧数据不可复活；Go 1.25 下 `go test ./repository ./service ./handler` 通过。
- `node node_modules/typescript/bin/tsc --noEmit` 与 Next.js 生产构建通过。Next 构建配置跳过类型检查，因此另行运行 TypeScript。
- `canvas-sync-smoke.mjs` 在 3001 源码生产预览及新 3000 容器均通过：使用两个独立浏览器上下文及共享模拟 API，加载实际视频/SVG，检查节点选中/拖动/播放、横竖比例、慢保存期间并发编辑和删除、跨浏览器刷新、项目删除失败、游客模型与首尾帧。另覆盖配置接口失败后恢复。运行时通过 `EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE`、`EXT_CANVAS_TEST_VIDEO` 指定测试依赖/视频；`EXT_MEDIA_RELIABILITY_TEST_URL` 可指定容器地址。
- 浏览器测试拦截 API，不删除真实作品、不触发付费生成。本轮未复现用户原来那次视频消失的完整过程，不能据此承诺恢复所有旧结果；上游结果已过期且未归档、OSS 对象被删仍需单独排查。
- 未扩大为实时协同编辑系统：轮询有约 5 秒延迟，离线要待网络与账号可用后同步；同字段同时修改按合并策略取本地编辑，删除优先。无有效登录的冷启动沿用原登录保护。
- 已检查公共 `docs/progress/todo.md` 与 `pending-test.md`；本轮定制验证集中于此，不重复修改上游待办。

## 部署与回退

- 按已有授权执行 `docker compose build app` 与 `docker compose up -d --no-deps --force-recreate --pull never app`，替换 `infinite-canvas` 容器，端口仍为 3000。
- 运行镜像 `sha256:490eb4874f4a72a81bbe12b49a76f73ec869f47d369e023b22648373759bf6ed`；`/api/health`、首页、`/canvas` 均 200，重启次数 0，启动日志无 panic/fatal/启动失败。环境变量哈希、数据挂载及重启策略与替换前一致。
- 回退镜像 `infinite-canvas:rollback-before-canvas-sync-20260910`；PostgreSQL 18 dump 保存在 Git 忽略目录 `data/extensions/mediaarchive/backups/pre-canvas-sync-20260910/database.dump`，大小 1,001,028 字节，`pg_restore --list` 验证可读。
- 无数据库结构迁移；回退程序无需还原数据库，不能自动恢复备份覆盖用户后续数据。恢复旧程序会恢复旧的同步/删除标记清理行为。需要回退时将回退镜像标记为 Compose 的镜像名，再使用 `--pull never` 重建 app。
- 两个浏览器都应刷新加载新前端后验收。原 3001 临时预览已停止。本轮不改 NewAPI 插件、存储权限，不提交或推送 Git。
