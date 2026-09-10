# EXT-0035 上游 AutoDL 与媒体同步合并

## 标识与目标

- 上游基线：`163771b8e6de5d8ea65225fc4d6340457eb45bca`，包含 `eebf893` 的 AutoDL 视频/音频工作流和 `163771b` 的自动云同步及未引用文件清理。
- 本地恢复基准：`08333c8`；同步分支：`sync/upstream-163771b`。
- 状态：冲突已处理，自动化验证通过；真实 AutoDL、外部存储与完整引用删除场景待验收。运行中的应用容器未替换。
- 保留 NewAPI 默认渠道、模型能力策略、微鑫品牌、玻璃界面、管理员默认存储、私有缓存和归档失败重试。

## 合并接入与取舍

| 文件与符号 | 合并结果与同步检查点 |
| --- | --- |
| `service/settings.go` / 模型分类；`web/src/stores/use-config-store.ts` / `modelMatchesCapability`、`selectableModelOptions` | 保留定制分类与可选模型过滤；增加 AutoDL 分类，选项携带 protocol/baseUrl 供工作流名称查询。 |
| `web/src/app/(admin)/admin/settings/page.tsx` | 保留 NewAPI、模型策略和默认存储草稿；接入工作流名称与 `autoSyncAllAssets`。 |
| `web/src/components/model-picker.tsx`、`video-settings-panel.tsx` | 保留焦点处理、主题及 NewAPI 参数边界；合入工作流名称、AutoDL 时长规则。 |
| `web/src/app/(user)/canvas/components/canvas-{config-node-panel,node-prompt-panel,audio-settings-popover,video-settings-popover}.tsx` | 节点配置使用实际解析出的模型判断 AutoDL；保留定制弹层与参考音频选择，修复已删除 defaultModel 变量的合并残留。 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`、`web/src/app/(user)/video/page.tsx` | 保留归档和任务恢复，接入 AutoDL 参考素材及可空提示词；画布历史裁剪与卸载清理沿用上游实现。 |
| `web/src/services/api/{image,video,audio}.ts` | 保留 NewAPI 请求格式及视频任务身份；接入 AutoDL 和媒体同步。生成图片/视频的新增上传分支必须显式使用管理员默认存储。 |
| `web/src/services/{image-storage,file-storage}.ts` | 保留账号隔离的私有缓存及元数据读取；修复上传第三参类型冲突；自动同步、失败回退与读取配置后均校验原会话，换账号异常继续抛出。 |
| `web/src/components/layout/client-root-init.tsx`、`web/src/stores/use-asset-store.ts` | 保留配置恢复和媒体持久化快照，接入自动同步失败提示及上游清理参数；历史/Skill 读取失败停止清理，校验原会话。媒体 key 收集补齐历史字符串引用。 |
| `docs/backend/api-response.md` | 合并保留私有签名接口和 AutoDL 接口说明。 |

以上修改均是现有上游调用点的合并兼容处理；不复制业务到扩展目录。新增回归位于 `web/src/extensions/media-reliability/auto-sync.test.ts`，并更新已有模型能力测试与浏览器复测脚本。

## 配置与数据

新增上游配置 `private.storage.autoSyncAllAssets` 默认关闭，开启后覆盖上游支持的媒体自动同步，包括音频。原定制图片/视频自动归档仍按 EXT-0031 工作，不受这个开关关闭影响。生成图片/视频固定使用管理员默认存储；普通素材上传保留既有个人 Provider 规则。

自动同步成功的 `storageKey` 传到工作台及画布后，定制归档跳过已有 `server:` 对象。失败保留原内容及重试能力。去重仍是当前页面内保证，跨刷新、跨标签及上传响应丢失的重复对象不在本次保证范围内。

本轮没有执行生产数据库迁移、真实模型生成、云对象删除或容器替换；没有修改真实凭据。保留现有扩展表和本地数据。

## 验证

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端 | `go test ./...`，使用 `.runtime/go` | 通过。 |
| 前端类型 | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 通过；单独执行，未依赖 Next.js 跳过类型检查的构建配置。 |
| 前端回归 | `.runtime/bun` 执行 `bun test` | 56 项通过，覆盖 AutoDL、NewAPI、私有缓存、归档去重、失败重试、会话切换、默认存储及历史媒体引用。 |
| NewAPI 插件 | `node --test extensions/newapi/plugin/paipu.test.mjs` | 17 项通过。 |
| 生产构建 | `node node_modules/next/dist/bin/next build` | 通过，20 个静态页面生成成功。 |
| 隔离浏览器 | `repair-ui-smoke.mjs` 首页、图片、视频、画布、管理员设置 | 通过。图片/视频分别检查自动同步关闭和开启；保存失败后重试不重新生成，失败删除保留历史；检查模型焦点、Skill 弹层、默认单选、ESA 字段及相关手机布局。 |

浏览器使用虚构账号并拦截 API，不代表真实 AutoDL 和云存储验收。设置 `EXT_MEDIA_RELIABILITY_AUTO_SYNC=true` 可复测新开关；脚本等待历史同步响应后再核验数据，避免仅凭按钮隐藏判断完成。

## 未完成与回退

- 真实 AutoDL 元数据、视频生成、参考音频工作流，以及实际渠道计费待验收。
- 已发现原有删除保护缺口：工作台删除历史时只检查当前工作台剩余引用和“我的素材”，未统一检查其他画布/工作台引用。该逻辑在合并双方已存在；本轮没有扩展为全局引用系统，也未执行真实删除。需独立补齐共享对象引用检查及跨设备并发场景。本轮已修复历史字符串 key 遗漏，并在历史/Skill 引用读取失败时停止自动清理。
- 上游画布清理会读取图片/视频历史、素材、项目与 Skill；完整引用集合及撤销历史淘汰场景仍需真实数据验收，不宣称云清理已全面安全验证。
- 本地合并提交可用本记录路径查找；需要回退时先保存后续工作，再对该合并提交按第一父提交执行 revert。`08333c8` 保留合并前源码；撤销代码不会恢复已经删除的云文件或自动恢复数据库。
