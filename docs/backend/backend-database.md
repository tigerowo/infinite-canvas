---
title: 数据库说明
description: 当前后端主要数据表与字段说明
---

# 数据库说明

本文档只记录后端当前已经使用的主要数据表。

## 数据库

后端使用 GORM 管理数据库连接和表结构迁移。

支持的存储驱动：

- `sqlite`
- `mysql`
- `postgresql`

当前启动时执行 `AutoMigrate`，自动维护以下表：

- `users`
- `credit_logs`
- `prompts`
- `agent_skills`
- `agent_skill_files`
- `assets`
- `settings`
- `video_tasks`
- `video_generation_logs`
- `image_generation_logs`
- `canvas_image_tasks`
- `canvas_audio_tasks`
- `canvas_projects`
- `user_configs`
- `storage_objects`
- `ext_model_policy`（定制路由初始化时单独迁移）
- `ext_storage_access`（私有 OSS/CDN 访问配置初始化时单独迁移）
- `ext_media_archive_sources`（远程媒体导入路由初始化时单独迁移）

后续新增表时再同步补充本文档，未实际使用的规划表不提前写入。

### ext_model_policy

定制模型分类与图片传输策略表，由 `extensions/modelcapabilities/policy.go` 的 `RegisterPolicy` 初始化，独立于上游 `settings` 表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uint | 主键，当前固定使用 1 保存全局策略 |
| `value` | text | 非空 JSON；`imageTransfer` 为 `url` 或 `base64`，`overrides` 为模型 ID 到 `text`、`image`、`video`、`audio` 的映射；可选 `newapiVideoProfiles` 将 `<软件渠道ID>::<小写模型ID>` 映射为 `canvas-v1`，默认未启用，见 [EXT-0011](../customizations/changes/0011-newapi-channel.md) |

启动时执行 `AutoMigrate` 并读取记录；无记录时使用内存默认策略，管理员保存时写入。代码回退不会自动删除此表。权限、默认值、迁移失败处理和验证范围统一见 [EXT-0009](../customizations/changes/0009-public-media.md)。本表不保存存储密钥、素材文件或签名 URL。

### ext_storage_access

私有 OSS 读取和 EdgeOne Type B 配置，由 `extensions/storageaccess/handler.go` 初始化。每个已保存的全局 S3 Provider 对应一行；Provider 的 Endpoint 或 Bucket 变化后不会复用原访问配置。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider_id` | string | 主键，对应 `settings.private.storage.providers[].id` |
| `scope` | text | Endpoint 和 Bucket 快照，用于配置隔离 |
| `value` | text | JSON；包含允许来源、读取方式、CDN 域名和后端 Token B 密钥 |

Token B 密钥只在后端数据库保存，管理接口只返回 `hasTokenKey`，不会返回密钥正文。数据库备份和访问权限仍需按生产密钥标准保护。

### ext_media_archive_sources

由 `extensions/mediaarchive/archive.go` 的 `Register` 执行 `AutoMigrate`，可重复执行，失败停止路由初始化和应用启动。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string(64) | 主键，账号 ID 与规范化来源 URL 的 SHA256 摘要，不保存 URL 或凭据正文 |
| `object_id` | string | 非空，关联既有 `storage_objects.id`；成功导入后登记 |

用于同账号重复导入不可变生成结果时复用已登记对象；读取时仍验证文件权限。源对象记录缺失时可重新导入，默认存储切换不迁移历史文件。无上游表变更，回退代码保留本表及对象。迁移、浏览器映射及重试边界见 [EXT-0034](../customizations/changes/0034-oss-reuse-cache-audit.md)。

### users

系统用户表。用户基础信息、角色、算力点余额和第三方登录标识放在该表中。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `username` | string | 用户名，唯一索引 |
| `password` | string | 密码哈希 |
| `email` | string | 邮箱 |
| `display_name` | string | 昵称 |
| `avatar_url` | string | 头像地址 |
| `role` | string | 角色：`user`、`admin` |
| `credits` | number | 算力点余额 |
| `aff_code` | string | 用户自己的邀请码，唯一索引 |
| `aff_count` | number | 已邀请用户数量，冗余统计字段 |
| `inviter_id` | string | 邀请人用户 ID |
| `github_id` | string | GitHub 用户 ID |
| `linux_do_id` | string | Linux.do 用户 ID |
| `wechat_id` | string | 微信用户 ID |
| `status` | string | 用户状态：`active`、`ban` |
| `last_login_at` | string | 最近登录时间 |
| `extra` | json | 扩展信息，第三方资料按平台命名空间保存，如 `linuxDo` |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### user_configs

用户级配置和同步数据表。每个用户一行，模型配置、用户存储配置及其他同步数据继续保存在原有 text 字段中。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 用户 ID，主键 |
| `model_config` | text | 模型与偏好配置 JSON；S3/R2 和 WebDAV 的自动同步开关分别为 `syncStorageConfig`、`syncWebDAVStorageConfig` |
| `storage_provider` | text | 用户存储配置 JSON，内部结构为 `{ "s3": {...}, "webdav": {...} }`，两类配置可保留但不能同时启用 |
| `image_history` | text | 用户图片历史同步数据 |
| `asset_data` | text | 用户素材同步数据 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`storage_provider.s3` 保存 Endpoint、Region、Bucket、Access Key、Secret、公开域名和路径前缀；`storage_provider.webdav` 保存 WebDAV 地址、远程目录、用户名和密码/应用密码。自动同步开关不重复写入 Provider；后端下载和删除旧媒体时仍会读取已保存但已停用的 Provider。

### storage_objects

S3/R2 与 WebDAV 共用的媒体文件索引表，不保存画布、素材列表或生成记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 文件 ID，前端存储 key 使用 `server:<id>` |
| `provider_id` | string | 创建文件时使用的 S3/R2 或 WebDAV Provider ID |
| `bucket` | string | S3/R2 Bucket；WebDAV 为空 |
| `object_key` | string | Provider 内相对对象路径，唯一索引 |
| `public_url` | string | S3/R2 可选公开地址；WebDAV 为空并通过 `/api/files/:id/content` 读取 |
| `mime_type` | string | 媒体 MIME 类型 |
| `bytes` | number | 文件字节数 |
| `width` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `height` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `sha256` | string | 文件内容摘要 |
| `direct` | boolean | 是否由登录用户的浏览器直接上传至 WebDAV |
| `created_by` | string | 创建用户 ID |
| `created_at` | string | 创建时间 |
| `deleted_at` | string | 预留字段；当前删除链路直接删除索引记录 |

### prompts

提示词表。用于保存公开提示词、内置 GitHub 系统提示词、分类和预览内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `cover_url` | string | 封面图 |
| `prompt` | string | 提示词内容 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `preview` | text | Markdown 展示内容，可包含文本、图片、视频链接等 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`github_url` 仅用于接口返回，不写入数据库。

### agent_skills

画布 Agent 可选择 Skill 表。系统预设与登录用户上传的 Skill 使用同一张表，通过来源和所有者隔离；未登录用户的 Skill 只保存在浏览器 `localforage`，不写入该表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `owner_user_id` | string | 用户 Skill 的所有者 ID；系统预设为空 |
| `source` | string | 来源：`system`、`user` |
| `name` | string | Skill 名称 |
| `description` | string | Skill 简介 |
| `cover_url` | text | Skill 封面图片地址 |
| `cover_storage_key` | string | 现有图片存储系统中的对象标识；直接填写图片链接时为空 |
| `content` | text | 完整 Markdown 或文本内容，最多 20000 字 |
| `enabled` | boolean | 是否启用；停用的系统预设不向画布返回 |
| `sort` | number | 系统预设排序值 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

用户接口只能读写和删除当前账号自己的 `source=user` 记录；管理员 Skill 页面只维护 `source=system` 记录。Skill 编辑后直接使用最新内容，不保存历史版本。

### agent_skill_files

系统预设 Skill 的附属目录和文本文件表。根 `SKILL.md` 不在本表重复保存，仍以 `agent_skills.content` 为唯一内容来源。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `skill_id` | string | 所属系统 Skill ID，与 `path` 组成联合主键 |
| `path` | string | Skill 包内安全相对路径 |
| `kind` | string | `folder` 或 `file` |
| `content` | text | 文件正文；文件夹为空，每个文件最多 20000 字 |
| `sort` | number | 同一目录内的显示顺序 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

后台保存系统 Skill 时会在同一数据库事务中替换该 Skill 的附属目录记录；普通用户 Skill 仍然只允许单文件内容，不写入本表。Agent 只在当前激活的系统 Skill 明确引用附属文件时按路径读取，不会把整个目录每轮注入模型上下文。

### assets

素材表。当前用于后台素材库。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `type` | string | 素材类型：`text`、`image`、`video` 等 |
| `cover_url` | string | 封面图 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `description` | string | 描述 |
| `content` | text | 文本或 Markdown 内容 |
| `url` | string | 图片、视频等媒体地址 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### video_tasks

视频生成任务表。后端创建视频任务后写入该表，后台轮询器每 5 秒统一查询未完成任务并更新进度、完成地址或失败详情；前端刷新、切换页面或关闭浏览器不会影响后端继续轮询。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID，优先使用上游 task ID |
| `user_id` | string | 用户 ID |
| `user_display_name` | string | 用户显示名 |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `channel_name` | string | 模型渠道名称 |
| `source` | string | 任务来源：`video-workbench`、`canvas` |
| `source_id` | string | 来源内 ID，画布任务记录画布节点 ID，视频创作台为空 |
| `upstream_task_id` | string | 上游任务 ID |
| `upstream_video_id` | string | 上游视频 ID，例如 Agnes 的 `video_...` |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度，0-100 |
| `seconds` | string | 视频秒数 |
| `size` | string | 视频尺寸 |
| `video_url` | text | 完成后的视频临时 URL |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情或最近一次轮询错误详情 |
| `request_body` | text | 创建任务时的请求摘要 |
| `response_body` | text | 创建任务时的响应摘要 |
| `last_response` | text | 最近一次状态响应摘要 |
| `credits` | number | 创建任务时预扣算力点 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 上游开始时间 |
| `completed_at` | string | 完成时间 |
| `last_polled_at` | string | 最近轮询时间 |

后台轮询器按 `status + created_at` 查询未完成任务；旧数据库中如果残留废弃列，不再参与代码查询。

### video_generation_logs

视频创作台成果历史表。该表保存用户视频生成成果卡片的完整 JSON，并用独立字段做多设备去重、软删除和查询；它不是运行态轮询表，运行态仍由 `video_tasks` 负责。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，对应前端生成记录 ID |
| `user_id` | string | 用户 ID，多用户数据隔离 |
| `task_id` | string | 后端或上游视频任务 ID |
| `video_id` | string | 上游视频 ID 或生成结果 ID |
| `status` | string | 记录状态：`生成中`、`成功`、`失败` |
| `payload_json` | text | 完整成果卡片 JSON。删除记录会清空该字段 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除 |

删除成果记录时只软删除当前用户对应记录，并清空该行 `payload_json`；软删除记录保留 7 天用于阻止旧浏览器缓存把已删除记录恢复回来。

### image_generation_logs

生图工作台成果历史表。当前先提供后端表和接口，前端生图工作台后续再接入；字段设计和软删除策略与 `video_generation_logs` 一致。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，对应前端生成记录 ID |
| `user_id` | string | 用户 ID，多用户数据隔离 |
| `task_id` | string | 图片任务 ID，可为空 |
| `image_id` | string | 图片结果 ID、存储 key 或 URL |
| `status` | string | 记录状态 |
| `payload_json` | text | 完整成果卡片 JSON。删除记录会清空该字段 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除 |

### canvas_image_tasks

画布图片生成任务表。只用于画布节点生成恢复，不影响生图工作台原接口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID |
| `user_id` | string | 用户 ID |
| `source` | string | 固定为 `canvas` |
| `source_id` | string | 画布来源 ID |
| `node_id` | string | 画布节点 ID |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度 |
| `prompt` | text | 提示词 |
| `generation_type` | string | `generation` 或 `edit` |
| `image_url` | text | 完成后图片 URL或第一张图片 URL |
| `image_urls` | JSON | 完成后全部图片 URL，第一项与 `image_url` 一致 |
| `storage_key` | string | 存储对象 key |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 开始时间 |
| `completed_at` | string | 完成时间 |

索引：`idx_canvas_image_tasks_user_source_node (user_id, source, source_id, node_id)`

### canvas_audio_tasks

画布音频生成任务表。只用于画布节点生成恢复，不影响原 `/audio/speech` 接口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID |
| `user_id` | string | 用户 ID |
| `source` | string | 固定为 `canvas` |
| `source_id` | string | 画布来源 ID |
| `node_id` | string | 画布节点 ID |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度 |
| `prompt` | text | 提示词 |
| `audio_url` | text | 完成后音频 URL |
| `storage_key` | string | 存储对象 key |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 开始时间 |
| `completed_at` | string | 完成时间 |

索引：`idx_canvas_audio_tasks_user_source_node (user_id, source, source_id, node_id)`

### canvas_projects

画布项目表。一条画布项目对应一行，完整项目 JSON 保存在 `project_data`，包含节点、连线、聊天会话、画布设置和视口；不拆节点表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 所属用户，与 `id` 组成主键 |
| `id` | string | 画布项目 ID |
| `project_data` | text | 完整 `CanvasProject` JSON |
| `created_at` | string | 项目创建时间 |
| `updated_at` | string | 项目更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除；超过 7 天由启动时和每天定时任务物理清理 |

索引：`idx_canvas_projects_user_deleted_updated (user_id, deleted_at, updated_at)`、`idx_canvas_projects_deleted_at (deleted_at)`


### settings

系统配置表。`public` 放前端可读取的公开配置，`private` 放仅后端和管理员可读取的私有配置；`agent-skills-initialized` 是默认 Skill 首次初始化标记，避免管理员删除后被启动流程重新创建。配置值都用 JSON。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 主键：`public`、`private`、`agent-skills-initialized` |
| `value` | json | 配置内容 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`public.value` 常放前端展示和可公开读取的配置，例如模型列表、登录开关等。  
`private.value` 常放渠道密钥、登录密钥、后台内部开关等。
`private.value.storage.autoSyncAllAssets` 为“全部素材云端同步”开关，默认 `false`，控制前端新增媒体和生成结果的自动转存；使用现有配置 JSON 保存，不增加数据表。

当前系统设置接口会按后端结构体序列化和反序列化已知字段；数据库 JSON 中额外存在的旧字段会被忽略。

`public.value` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 公开登录配置 |

`modelChannel` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型列表 |
| `modelCosts` | object[] | 模型算力点配置 |
| `defaultModel` | string | 默认模型 |
| `defaultImageModel` | string | 默认图片模型 |
| `defaultVideoModel` | string | 默认视频模型 |
| `defaultTextModel` | string | 默认文本模型 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | bool | 是否允许用户自定义渠道，默认允许，关闭后前端只提供走后端渠道的模式 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点，未配置默认不扣除 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启 Linux.do 登录 |

`private.value` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道配置列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `auth` | object | 私有登录配置 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，支持 OpenAI、Gemini、Grok2API、MiniMax、APIMart、KIE、MiMo |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 渠道接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 渠道可用模型列表 |
| `weight` | number | 渠道权重，同一模型命中多个渠道时按权重随机 |
| `enabled` | bool | 是否启用 |
| `remark` | string | 备注 |

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string | Linux.do OAuth App Client ID |
| `clientSecret` | string | Linux.do OAuth App Client Secret，后台返回时隐藏 |

后端请求模型时，先按模型名筛选启用且包含该模型的渠道，再按 `weight` 加权随机选择一个渠道。

### credit_logs

用户算力点变更流水表。当前记录后台手动调整、模型调用预扣和模型调用失败返还。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `user_id` | string | 关联用户 ID |
| `type` | string | 类型：`admin_adjust`、`ai_consume`、`ai_refund` |
| `amount` | number | 本次变动数量，增加为正，扣减为负 |
| `balance` | number | 变动后的用户算力点余额 |
| `related_id` | string | 关联业务 ID，可为空 |
| `remark` | string | 备注 |
| `extra` | json | 扩展信息 |
| `created_at` | string | 创建时间 |

`type` 当前取值：

| 值 | 说明 |
| --- | --- |
| `admin_adjust` | 后台手动调整 |
| `ai_consume` | 调用后端模型接口消费 |
| `ai_refund` | 后端模型接口调用失败返还 |
## StorageObject 与私有 OSS

私有 OSS 读取复用现有 `StorageObject` 索引和存储 Provider 配置，不新增表或字段，也不修改 NewAPI 数据库。文件正文保留在 OSS，数据库保存对象 ID、Provider、Bucket、ObjectKey 和媒体元数据。

私有对象通过后端鉴权后签发短时 GET URL，浏览器直接读取 OSS；WebDAV、本地缓存和旧公开 URL 继续使用各自的兼容路径。

## 定制扩展数据

### 素材生命周期（EXT-0045，实现中）

`repository.DB` 在上游表迁移之后依次调用 `medialifecycle.Migrate`、`Backfill` 和 `BackfillTaskAttempts`。新增结构均在 `extensions/media-lifecycle/`，没有给上游业务表增加生命周期列。迁移失败阻止启动；建表可重复执行，业务回填以 `policies.migrated_at` 防重，任务恢复元数据只补缺失行，不重置已存在的次数或状态。生产启用前仍需完成三数据库和真实范围核对，进度见 [EXT-0045](../customizations/changes/0045-media-lifecycle.md)。

以下表统一以 `ext_media_lifecycle_` 为前缀，时间使用服务端 Unix 毫秒：

| 表后缀 | 关键字段与约束 | 用途 |
| --- | --- | --- |
| `policies` | `id=1`；`mode`、`days`、`execution`、`version`、`epoch`、`serial`、`clearing`、`storage_reviewed`、`migrated_at` | 保留策略、清空代次和短事务串行锁；初始 retention/30/observe |
| `files` | `id` 主键；`scope`、`hash`、`state`、`bytes`、`mime`、`activity`、`created`、`protection`、`version`、`epoch`、`object_json`、`delete_worker`、`delete_until` | 物理文件身份、期限、跨批次删除租约和恢复定位；失租不能确认删除或清掉定位 |
| `dedup` | 范围与字节哈希摘要 `id` 主键；`file_id`、`token`、`lease_until` | 并发上传唯一位置与租约；防止多个进程同时 PUT 相同内容 |
| `materials` | 随机分享 `id` 主键；`owner + file_id` 唯一；`name`、`state`、`activity`、`epoch` | 用户独立分享身份；与是否存在素材库保留关系分开 |
| `entities` | `entity_key` 主键，由 owner/kind/id 派生；`state`、`fingerprint`、`activity`、`created`、`protection`、`version`、`epoch` | 业务单位、草稿与提交保护，版本校验及防复活状态 |
| `references` | `entity_key + file_id` 联合主键 | 业务单位到必要文件的依赖；更新和业务保存在同一事务内 |
| `operations` | 账号与操作标识摘要 `id`；`entity_key`、`fingerprint`、`result`、`created`、`epoch` | 幂等活动与原响应；旧操作重放不能取得较新的版本或作用到其他位置 |
| `batches` | `id`；`kind`、`state`、`policy_version`、`epoch`、`created`、`updated`、`error`、`worker`、`lease_until` | 预览及固定批次、执行租约和部分失败状态 |
| `batch_items` | `batch_id + kind + target` 联合主键；`version`、`state`、`bytes`、`error` | 文件和业务清理明细，保留失败定位和重试依据 |
| `settlements` | 账号与操作标识摘要 `id`；`owner`、`amount`、`state`、`created`、`epoch` | pending/settled/refunded/unknown；与余额及账务流水事务防重，结果不明待核对 |
| `task_attempts` | `id` 同业务 entity key；`owner`、`kind`、`task_id`、`state`、`worker`、`lease_until`、`started`、`epoch`、`result_json`、`archive_started`、`archive_attempts`、`next_attempt`、`last_error`、`manual_retry`、`recovery_version`、`recovery_at` | 提交标记、结果、归档预算和单次恢复；恢复版本仅给不早于 recovery_at 的快照，重试不续期 |
| `request_leases` | `id`；`epoch`、`until` | 跟踪经过 Guard 的在途写请求，清空执行前检查 |

`files` 使用 active/uploading/deleting/deleted。`entities` 保留删除墓碑，拒绝旧客户端覆盖；现阶段尚未完成控制元数据压缩，不能宣称所有辅助表已经按保留期收敛。`task_attempts` 区分 queued/submitting/polling/result/done/unknown/archive_failed；归档结果持久化后独立重试，未拿到结果的中断提交进入 unknown，不自动重新生成。

当前业务映射与边界：

| 生命周期 kind | 上游表或字段 | 清理单位及保留边界 |
| --- | --- | --- |
| `canvas` | `canvas_projects.project_data` | 一个项目及其当前节点、连线和必要媒体；保留防复活控制状态 |
| `image-task` / `audio-task` / `video-task` | `canvas_image_tasks` / `canvas_audio_tasks` / `video_tasks` | 一个任务、结果、当前输入引用与恢复记录；必要账务状态保留 |
| `image-history` / `video-history` | `image_generation_logs` / `video_generation_logs` | 一条生成历史，按自身活动与必要文件依赖处理 |
| `user-assets` / `legacy-history` | `user_configs.asset_data` / 历史 JSON 对应字段 | 按条目 ID 清理；同表模型、存储等账号配置保留，禁止整行删除 |
| `asset` | `assets` | 管理员素材库条目属于业务数据 |
| `workflow` | `creative_workflows` | 用户工作流及必要媒体依赖 |
| `skill` | 用户来源的 `agent_skills`、`agent_skill_files` | 用户自建内容纳入清理，系统预设保留；包文件路径清理尚需补齐 |
| `ai-log` | `ai_call_logs` | 表记录已登记；既有本地日志文件还需纳入同一清理批次 |
| `upload` / `library` / `draft` / `request` | 扩展素材、引用与实体 | 普通移除只释放对应引用；提交保护与草稿释放顺序由事务保证 |

保留 `users` 中的账号、权限和余额、`settings`、`user_configs` 的配置字段、系统来源 Skill、公共 `prompts` 及维持结算一致性的控制状态。账务历史展示、旧来源归档映射、凭证身份映射、OSS 未索引对象与控制表压缩仍需完成对应的清理实现和验证，不能仅凭这张映射表开启全量清空。

图片/视频历史通过扩展 `history.go` 在生命周期锁内保存/删除，历史 ID、任务 ID、输出 ID 建立 `entities` 控制别名，避免删除后换 ID 复活；跨账号主键冲突拒绝覆盖。旧 `user_configs.image_history` 迁移与字段 CAS 清空在同一事务，不整行覆盖模型及存储设置。数据库查询错误和坏 JSON 明确报错并保留原文。

保留规则预览使用 `operations.entity_key=policy-preview` 的控制 receipt，15 分钟有效，绑定策略版本、epoch、候选身份/版本和 scope。缩短期限、forever 转 retention、observe 转 enforce 保存前重新核对；receipt 不可当作删除批次执行。控制记录压缩仍属 TODO。

浏览器草稿使用 localforage 的 `ext_media_lifecycle_drafts`，key 包含账号和输入位置。图片/视频历史及生图分类在原 store 中使用 `ext:media-lifecycle:history:<账号>:<epoch>:` 键，按账号及代次读取/删除；旧无归属记录保留为本机恢复副本，不自动归属当前账号。清空代次不匹配时不能重放旧历史；缓存、签名刷新和无变化恢复不续期。代码回退不能恢复已删除 OSS 文件。

- `ext_video_task_identity`：`extensions/taskidentity/identity.go` 按需迁移。`task_id`、`user_id` 为联合主键，`source` 为 user/admin/local，仅记录视频创建的凭证来源，不存密钥。旧任务无记录时走兼容查询；新记录冲突不覆盖原来源。
- `ext_storage_access`：存储访问扩展的既有配置表。默认上传以 `__default_upload_provider__` 独立配置行保存 Provider ID，scope 为 default；不修改上游 Provider 表字段，也不迁移旧存储对象。

浏览器 IndexedDB 使用 `ext_pending_history` 与 `ext_media_archive` 保存待同步历史与归档状态，`ext_media_identities` 保存来源摘要到 server key 的映射，`ext_protected_media` 保存受保护视频任务到云端或本地 key 的映射，均按账号隔离。这些不是服务端持久后台作业，不保证关页后继续执行。
