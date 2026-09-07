# 素材公网 URL 与模型能力策略

## 标识与目标

- EXT-0009；基线 `51c4503b2c53e237b2fe67c65711b51ae5deb762`；状态：已实现，完整兼容验证待补。
- 模型引用素材时，默认将图片、视频和音频转换为 S3 HTTPS 签名链接；管理员可以把图片切换为 Base64，视频和音频继续使用 URL。
- 管理员按模型 ID 覆盖文本、图片、视频、音频分类，影响前端选择和后端默认模型判断；不会改变上游模型实际能力或请求协议。
- 视频任务完成后取回结果文件属于后续 [EXT-0010](0010-video-content.md)，与这里的参考素材输入处理分别记录。

## 扩展文件

- `extensions/publicmedia/urls.go`：校验素材归属及 S3 配置，生成有效期 24 小时的 GET 签名 URL。
- `extensions/modelcapabilities/policy.go`：策略校验、独立表初始化、读取及管理员保存接口。
- `web/src/extensions/public-media/references.ts`：参考素材上传、签名 URL 获取、图片 Base64 转换及 Gemini 图片字段构造。
- `web/src/extensions/model-capabilities/policy.ts`、`policy-panel.tsx`、`use-policy-sync.ts`：策略状态、后台“模型与素材传输”面板、页面聚焦及定时刷新。
- 历史 `web/src/extensions/lec-video/` 曾将 EXT-0008 接入统一图片传输；该目录已由 EXT-0011 删除。

## 上游接入清单

| 文件与符号 | 改动、必要原因及同步检查点 |
| --- | --- |
| `router/router.go` / `New` | 注册策略和素材链接接口；扩展需挂到现有路由。保持策略写入的管理员鉴权及素材接口的用户鉴权 |
| `service/storage.go` / `StorageProviderForObject`、`DownloadStorageObject`、`downloadPublicStorageObject` | 提取已有对象的存储配置解析供签名复用；避免扩展复制存储业务。检查对象所有者配置、全局配置和原下载回退行为 |
| `service/settings.go` / `isVideoModelName`、`isImageModelName`、`isTextModelName` | 优先采用分类覆盖；后端默认值修复必须与前端一致，保留无覆盖时的原分类 |
| `web/src/stores/use-config-store.ts` / 模型分类函数 | 调用 `modelTypeOverride`；现有列表和默认值依赖这些入口，检查覆盖优先级与原识别回退 |
| `web/src/components/layout/app-providers.tsx` / `AppProviders` | 调用 `usePolicySync`，使后台策略变更能刷新现有前端分类 |
| `web/src/app/(admin)/admin/settings/page.tsx` | 插入 `ModelPolicyPanel`；沿用管理后台路由，保留面板独立保存行为 |
| `web/src/services/api/image.ts` / 图片编辑、生成及画布任务构造函数 | 将参考图读取替换为 `publicImageURL` / `geminiPublicPart`；请求体在这里构造，需逐协议检查 URL 与 Base64 字段兼容性 |
| `web/src/services/api/video.ts` / 参考素材辅助函数、`createGeminiVeoRequestBody` | 接入图片和媒体 URL；保留各协议字段及限制，原生 Veo 参考图限制见下文 |
| `web/src/services/api/audio.ts` / `referenceAudioDataUrl` | 参考音频改为 `publicMediaURL`；函数旧命名保留，检查语音克隆等实际请求格式 |
| `web/src/services/api/canvas-agent.ts` / `normalizeAgentImages`、`requestGeminiCompletion` | 对话图片与 Gemini 字段接入统一转换；检查工具调用和文本消息不受影响 |
| `web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx` / `sendMessage` | 助手发送参考图时转换素材，避免绕过公共传输策略 |
| `web/src/app/(user)/canvas/components/canvas-node-generation.ts` / `hydrateNodeGenerationContext` | 转换普通参考图及首尾帧；节点构造入口必须传入模型可访问的素材 |
| `go.mod`、`go.sum` | 增加 AWS SDK 签名器相关依赖，避免手写预签名算法；同步时保留构建所需依赖 |

## 接口、配置与数据

- `GET /api/extensions/model-policy`：公开读取非敏感策略；`PUT` 同路径：管理员保存，字段为 `imageTransfer` 和 `overrides`；EXT-0011 增加可选 `newapiVideoProfiles`，契约见该记录。
- `GET /api/extensions/public-media/files/:id/url`：需要登录，仅素材所有者或管理员可以取得链接；复用 `/api/v1/files` 上传素材。
- 独立表 `ext_model_policy`：`id` 为 uint 主键，当前使用 1；`value` 为非空 text，保存策略 JSON。详细字段见 [数据库说明](../../backend/backend-database.md)。
- 路由初始化时调用 GORM `AutoMigrate`，再加载已有策略；无记录时使用 URL 和空覆盖表，不立即插入默认行。重复启动复用同表同记录；迁移或加载失败会使路由初始化报错并终止启动。
- 保存策略写入该独立表，不给上游表增加字段。前端策略保存在内存；每次聚焦、每 60 秒刷新，普通读取缓存 5 秒。没有新增扩展专属持久化文件或浏览器存储。
- 素材上传沿用原存储对象和文件机制；签名 URL 不写入策略表。引用处理缓存对象标识，已有已知链接剩余有效期超过 5 分钟时可复用，否则重新申请，不保证每次调用都重新签名。
- 签名有效期为 24 小时，持有链接即可在有效期内读取文件；不修改桶 ACL，签名密钥留在后端。

## 当前行为与兼容限制

- 公共参考素材入口先检查登录，再判断 URL/Base64；因此本地直连引用素材和图片 Base64 模式也要求登录。这里只描述引用素材路径，不表示所有纯文本请求都要求登录。
- 默认 URL 模式要求素材最终存于 S3，Endpoint 为公网 HTTPS；WebDAV 或非 S3 对象不能直接由此签名。已有外部 URL 也可能先被读取并上传，不能理解为所有 URL 都原样透传。
- 当前 `createGeminiVeoRequestBody` 无条件拒绝原生 Gemini Veo 的普通参考图、首帧和尾帧，图片切换 Base64 也不会解除这个检查。
- 图片编辑原来的 multipart 文件字段已改为 URL/Base64 字符串；是否被某渠道接受需要实际验证。统一素材转换不等于所有 OpenAI、Gemini 或其他渠道都支持同一种传输格式。
- 当前 NewAPI 通道由 [EXT-0011](0011-newapi-channel.md) 管理：标准编辑发送真实文件、节点及文本图片预处理无需 S3；LEC 专用 JSON 在插件构造。上述公共素材入口的登录限制仍适用于直接调用该入口的旧协议及部分扩展媒体上传，不代表所有 NewAPI 请求都必须登录。

## 验证与待办

- 原记录：相关 Go 扩展包和 service 测试已执行；前端类型检查仍有画布 Slider 的基线错误。此为历史记录，不作为本次重新测试的结论。
- 本次文档同步：核对提交 `b72aaa0`、当前扩展源码及上游接入点，确认上述接口、表结构、策略和限制已实现；未执行付费生成、后台策略操作或真实签名链接读取。
- 用户在后续视频修复后反馈当前使用流程可用，见 EXT-0010；不扩大为本项所有渠道通过。
- 待验证：登录后的真实签名链接读取、图片 URL/Base64 切换、分类覆盖保存及重启恢复、图片/视频/音频/助手的实际请求兼容性。原生 Veo 参考图限制与未登录素材路径的后续处理需结合使用需求决定，当前未修复。
- 已检查上游 TODO 和待测试文档；定制待办集中在此，避免重复维护。

## 提交、回退与同步

- 实现提交：`b72aaa0 feat(ext-public-media): 默认通过 S3 公网链接传递素材`。后续结果视频缓存修复见 EXT-0010；本次是记录同步，不追加业务改动。
- 回退需同时撤销本项路由、请求转换、分类和管理面板接入，再移除扩展实现；保留 EXT-0006 的 TOS 兼容与 EXT-0007 的别名分类。EXT-0008 依赖这里的图片转换，撤销时需恢复其先前实现。
- 代码回退不会自动删除 `ext_model_policy`、已上传素材或恢复旧数据；默认保留这些数据，不执行表或素材删除。同步上游时逐项检查调用符号、鉴权、请求字段及依赖，不能以无 Git 冲突代替兼容验证。
