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
- `prompt_categories`
- `assets`
- `settings`
- `video_tasks`
- `video_generation_logs`
- `image_generation_logs`
- `canvas_image_tasks`
- `canvas_audio_tasks`
- `canvas_projects`

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

### prompt_categories

提示词分类表。把原硬编码的 8 个分类来源迁移到数据库，支持管理后台可视化增删改查。首次启动时自动写入种子数据（1 个 system 本地分类 + 7 个 GitHub 远程同步源）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `category` | string | 主键，分类 ID，如 `gpt-image-2-prompts`，创建后不可修改 |
| `name` | string | 显示名称 |
| `description` | string | 分类描述 |
| `github_url` | string | GitHub 仓库地址，远程分类必填 |
| `remote` | bool | 是否远程同步分类 |
| `enabled` | bool | 是否启用，禁用后不同步、不在用户端展示，但提示词数据保留 |
| `sort_order` | int | 排序权重，越小越靠前 |
| `last_synced_at` | string | 最后同步时间 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

删除分类时只删除分类记录，不级联删除 `prompts` 表中该分类下的提示词条目；禁用分类与删除分类的区别是禁用可一键切回 `enabled: true` 恢复展示。

所有分类共用全局 `PROMPT_SYNC_CRON` 调度，不支持分类独立 cron。

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
| `image_url` | text | 完成后图片 URL |
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
| `modelInfos` | object[] | 模型展示信息，配置下拉框副标题描述，按模型名索引 |
| `defaultImageModel` | string | 默认图片模型 |
| `defaultVideoModel` | string | 默认视频模型 |
| `defaultTextModel` | string | 默认文本模型，同时作为通用默认模型的兜底 |
| `defaultAudioModel` | string | 默认音频模型 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | bool | 是否允许登录用户自定义渠道，默认允许，关闭后登录用户只能走云端渠道或本地直连 |
| `allowUserRemoteChannel` | bool | 是否允许普通用户使用云端渠道，默认关闭，关闭后普通用户只能使用本地直连；管理员不受此限制 |
| `allowGuestConfig` | bool | 是否允许未登录用户使用配置功能，默认允许，关闭后未登录用户看不到顶栏配置入口，也无法通过模型选择器等入口触发配置弹窗 |
| `modelCapabilities` | object[] | 模型能力配置，按模型设置支持的图片比例、图片档位、视频清晰度、视频面板类型/厂商/模式/比例/能力开关等；空字段走默认值（生图全比例+仅标准档，视频 480p/720p/1080p，秒数 4-20，面板=通用） |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点，未配置默认不扣除 |

`modelInfos` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称，必须存在于 `availableModels` |
| `description` | string | 模型描述文案，作为下拉框副标题 hover 时显示；后端规整时按 30 字截断，空描述项会被剔除 |

`modelCapabilities` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称，必须存在于 `availableModels` |
| `imageAspects` | string[] | 支持的图片比例，如 `["1:1","16:9"]`；空=支持全部标准比例 |
| `imageTiers` | string[] | 支持的图片清晰度档位，取值 `standard`/`2k`/`4k`；空=仅标准档 |
| `videoResolutions` | string[] | 支持的视频清晰度，如 `["720p","1080p"]`；空=480p/720p/1080p 三档 |
| `videoSecondsMin` | int | 视频秒数下限，空=默认 4 |
| `videoSecondsMax` | int | 视频秒数上限，空=默认 20 |
| `videoPanelType` | string | 视频面板类型，空=通用面板；`kling-v26`/`kling-v3`/`seedance`/`grok`/`motion-control`/`agnes`，替代前端按模型名+渠道硬编码判断面板和请求体格式 |
| `videoProvider` | string | 视频厂商，空=不区分；`apimart`/`kie`（仅 `kling-v3`/`motion-control` 需要区分请求体格式） |
| `videoModes` | object[] | 视频模式选项（Kling `std`/`pro`/`4k`、Grok `fun`/`normal`/`spicy`），空=不支持模式选择；每项含 `value`/`label`/`desc` |
| `videoRatios` | string[] | 视频比例选项，如 `["16:9","9:16","1:1","adaptive"]`；空=通用面板走默认 sizeOptions |
| `videoSecondsPresets` | int[] | 秒数预设档位，如 `[5,10]`；空=连续 Slider，有值=按档位显示 OptionPill |
| `videoSecondsSmart` | bool | 是否支持 `-1` 智能时长（Seedance） |
| `supportsNegativePrompt` | bool | 是否支持负面提示词 |
| `supportsFirstLastFrame` | bool | 是否支持尾帧（兼容字段：勾选=首尾帧都支持，仅首帧用 supportsFirstFrame） |
| `supportsFirstFrame` | bool | 是否仅支持首帧（部分模型如 minimax-hailuo-2-3、kling-3-0-turbo） |
| `supportsMotionControl` | bool | 是否支持运动控制 |
| `supportsAudioGeneration` | bool | 是否支持音频生成 |
| `supportsWatermark` | bool | 是否支持水印开关 |
| `supportsMultiShot` | bool | 是否支持多镜头分镜 |
| `supportsElementList` | bool | 是否支持元素列表 |
| `audioRequiresMode` | string | 音频生成所需模式，如 Kling V26 要求 `pro`；空=不限 |
| `audioMaxReferences` | int | 音频生成最大参考图数量，如 Kling V26 要求 `1`；空/0=不限 |
| `maxImageReferences` | int | 参考图数量上限（Seedance 等）；空/0=走前端默认（图片 9） |
| `maxVideoReferences` | int | 参考视频数量上限（Seedance 等）；空/0=走前端默认（视频 3） |
| `maxAudioReferences` | int | 参考音频数量上限（Seedance 等）；空/0=走前端默认（音频 3） |

`videoModes` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | string | 模式值，如 `std`/`pro`/`4k`/`fun`/`normal`/`spicy` |
| `label` | string | 模式显示名，如「标准模式」/「专业模式」/「4K」 |
| `desc` | string | 补充说明，如「720P 无声」/「1080P 音频」 |

管理员未配置的模型走默认值策略：生图=全比例+仅标准档，视频=480p/720p/1080p、秒数 4-20、面板=通用。能力开关未配置（`undefined`）时前端走默认硬编码兜底，有值则按配置控制 UI 显隐与请求体字段。前端工作台按当前所选模型的能力动态渲染比例、档位、模式、面板，切换模型时若当前选项不在新模型支持范围内则自动回退。

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
