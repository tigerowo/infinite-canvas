---
title: 系统配置数据结构
description: settings 表中 public 和 private 配置结构说明
---

# 系统配置数据结构

系统配置保存在 `settings` 表中，目前只使用两行：

| key | 说明 |
| --- | --- |
| `public` | 公开配置，前端可以读取 |
| `private` | 私有配置，只给后端和管理员使用 |

## public.value

```json
{
  "modelChannel": {
    "availableModels": ["gpt-5.5", "gpt-image-2"],
    "modelCosts": [
      { "model": "gpt-5.5", "credits": 1 },
      { "model": "gpt-image-2", "credits": 10 }
    ],
    "defaultModel": "gpt-image-2",
    "defaultImageModel": "gpt-image-2",
    "defaultTextModel": "gpt-5.5",
    "systemPrompt": "",
    "allowCustomChannel": true
  },
  "auth": {
    "allowRegister": true,
    "linuxDo": {
      "enabled": false
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 认证相关公开配置 |

`modelChannel` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型；保存设置时会自动合并所有已启用私有渠道的模型 |
| `modelCosts` | object[] | 模型算力点配置，后端模型接口调用前按模型预扣，上游失败时返还；未配置默认不扣除 |
| `defaultModel` | string | 默认模型，从 `availableModels` 中选择；为空或失效时优先选择文本模型 |
| `defaultImageModel` | string | 默认图片模型，从 `availableModels` 中选择；为空或失效时优先选择 `seedream`、`image`、`gpt-image` 模型 |
| `defaultVideoModel` | string | 默认视频模型，从 `availableModels` 中选择；为空或失效时优先选择 `seedance`、`video` 模型 |
| `defaultTextModel` | string | 默认文本模型，从 `availableModels` 中选择；为空或失效时优先选择非图片/视频模型 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | boolean | 是否允许用户在配置弹窗中切换为本地直连渠道，默认允许 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点 |

用户侧请求模式：

| 模式 | 说明 |
| --- | --- |
| 云端渠道 | 使用后端 `/api/v1/*` 代理接口，请求会按模型名匹配 `private.value.channels` 中的可用渠道 |
| 本地直连 | 默认可选；`allowCustomChannel` 关闭后不可选，用户在浏览器本地配置 `baseUrl`、`apiKey` 和模型列表后直接请求模型接口 |

`auth` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `allowRegister` | boolean | 是否允许用户注册，默认允许；关闭后注册入口隐藏，注册接口拒绝新用户创建 |
| `linuxDo.enabled` | boolean | 是否开启 Linux.do 登录 |

## private.value

```json
{
  "channels": [
    {
      "protocol": "openai",
      "name": "默认渠道",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-xxx",
      "models": ["gpt-5.5", "gpt-image-2"],
      "weight": 1,
      "enabled": true,
      "remark": ""
    }
  ],
  "promptSync": {
    "enabled": true,
    "cron": "0 0 * * *"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，当前支持 `openai`、`kie`、`mimo`、`grok2api`、`xai` |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 模型接口地址。`openai` 为 OpenAI 兼容地址；`grok2api`/`xai` 走 xAI/Grok 媒体资源 API；`kie`/`mimo` 走各自协议适配 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。

### protocol 说明

| protocol | 用途 | 说明 |
| --- | --- | --- |
| `openai` | OpenAI 兼容透传 | 默认协议。路径与字段基本原样转发；若模型名为 `grok-imagine-*` / `grok-voice-*`，后端仍会按 Grok 媒体能力做路径/字段适配，避免误打到错误接口 |
| `kie` | KIE 渠道 | 图片/视频创建走 `/jobs/createTask`，轮询走 `/jobs/recordInfo` |
| `mimo` | 小米 MiMo | 文本与 TTS 走 MiMo 适配；TTS 由 `/audio/speech` 转写为 MiMo chat 音频请求 |
| `grok2api` | Grok2API 网关 | 图片：`/images/generations`、`/images/edits`；视频：`POST /videos` 映射为 `/videos/generations`，轮询/content 保持 `/videos/{id}`；TTS：`/audio/speech` 保持 OpenAI 字段，`/tts` 为原生字段且缺省 `language=en` |
| `xai` | xAI 官方/兼容 | 与 `grok2api` 使用同一套媒体字段与路径映射；管理端读取模型列表返回内置 Grok 目录，不依赖上游 `/models` |

`grok2api` / `xai` 管理端内置模型目录：

- `grok-imagine-image`
- `grok-imagine-image-quality`
- `grok-imagine-image-2.0`
- `grok-imagine-image-edit`
- `grok-imagine-video`
- `grok-imagine-video-1.5`
- `grok-voice-latest`
- `grok-voice-think-fast-2.0`

参考图/音频请先上传到本项目 `/api/v1/media/references` 得到可访问 URL，再作为 `image.url` 或 `reference_images[].url` 传入。当前不支持浏览器把本地文件直接 multipart 上传到 grok2api。视频延长接口 `/videos/extensions` 暂未接入。

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |
