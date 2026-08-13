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

后续新增表时再同步补充本文档，未实际使用的规划表不提前写入。

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

S3/R2、WebDAV 与服务端本地生成媒体共用的文件索引表，不保存画布、素材列表或生成记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 文件 ID，前端存储 key 使用 `server:<id>` |
| `provider_id` | string | 创建文件时使用的 S3/R2、WebDAV Provider ID；本地生成媒体为 `local-generated-media` |
| `bucket` | string | S3/R2 Bucket；WebDAV 为空 |
| `object_key` | string | Provider 内相对对象路径，唯一索引；本地生成媒体位于应用数据目录的 `generated-media/` |
| `public_url` | string | S3/R2 可选公开地址；WebDAV 为空并通过 `/api/files/:id/content` 读取 |
| `mime_type` | string | 媒体 MIME 类型 |
| `bytes` | number | 文件字节数 |
| `width` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `height` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `sha256` | string | 文件内容摘要 |
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
| `video_url` | text | 完成后供客户端访问的本地视频 URL |
| `upstream_video_url` | text | 上游返回的视频临时 URL，本地保存完成前用于重试下载 |
| `storage_key` | string | 本地视频对应的存储对象 key |
| `mime_type` | string | 视频 MIME 类型 |
| `bytes` | number | 视频文件字节数 |
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
| `next_poll_at` | string | 下次允许轮询时间，用于退避和限流控制 |
| `poll_attempts` | number | 已执行的轮询次数 |
| `rate_limit_count` | number | 上游返回限流的累计次数 |

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
| `thumbnail_url` | text | 服务端生成的预览缩略图 URL |
| `thumbnail_storage_key` | string | 缩略图存储对象 key |
| `width` | number | 原图宽度 |
| `height` | number | 原图高度 |
| `mime_type` | string | 原图 MIME 类型 |
| `bytes` | number | 原图文件字节数 |
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

系统配置表，只保存两行数据：`public` 放前端可读取的公开配置，`private` 放仅后端和管理员可读取的私有配置，配置值都用 JSON。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 主键：`public`、`private` |
| `value` | json | 配置内容 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`public.value` 常放前端展示和可公开读取的配置，例如模型列表、登录开关等。  
`private.value` 常放渠道密钥、登录密钥、后台内部开关等。

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
| `protocol` | string | 协议，当前支持 `openai` |
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
