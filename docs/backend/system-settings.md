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
    "availableModels": ["gpt-5.5", "gpt-image-2", "seedance-2.0"],
    "modelCosts": [
      { "model": "gpt-5.5", "credits": 1 },
      { "model": "gpt-image-2", "credits": 10 },
      { "model": "seedance-2.0", "credits": 0.66 },
      { "model": "seedance-2.0", "resolution": "720", "credits": 3 }
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
| `modelCosts` | object[] | 模型算力点配置，视频模型可按分辨率设置每秒单价；图片按张、文本和音频按次预扣，上游失败时返还；视频智能时长 `-1` 按 15 秒计算，未配置默认不扣除 |
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
| `resolution` | string | 可选，视频分辨率；同一模型可配置多条分辨率覆盖单价，未匹配时使用该模型未设置分辨率的默认单价 |
| `credits` | number | 图片每张、视频每秒、文本和音频每次调用预扣的算力点，最多保留两位小数 |

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
| `protocol` | string | 协议，支持 OpenAI、Gemini、Grok2API、MiniMax、APIMart、KIE、MiMo |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 渠道接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `parameterTranslation` | string | 渠道自定传参转译原文，按 `models` 中的真实模型名称配置；空值沿用默认调用 |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。

公开渠道信息增加 `parameterTranslationModels: string[]`，只列出已配置生成请求且允许使用的模型名，供前端选择调用入口；不公开转译原文和密钥。个人渠道原文随用户 `modelConfig.channelTranslations` 保存，每项为 `{ channelId, parameterTranslation }`，与外部 `localChannels` 的 URL、密钥和模型配置分开。

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |

## ComfyUI 服务地址

`private.comfy` 保存 ComfyUI 服务端；`comfyui` 协议渠道没有绑定 Bridge 时，由服务端直连这里的地址执行工作流。

```json
{
  "comfy": {
    "url": "https://xxxx-8188.container.x-gpu.com",
    "apiKey": "",
    "servers": [
      { "id": "comfy-a1b2c3d4e5f60718", "name": "服务端 1", "url": "https://u1151197-xxx.westd.seetacloud.com:8443", "apiKey": "" }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 默认地址，工作流没有绑定服务端时使用 |
| `apiKey` | string | 默认地址的 Bearer 鉴权密钥，服务端未开启鉴权时留空 |
| `servers` | object[] | 额外服务端，每项为 `{ id, name, url, apiKey }` |

`comfyui` 渠道的每条工作流用 `workflow.comfyServerId` 绑定服务端；绑定 ID 不存在（含服务端被删除）时自动回落到默认地址。渠道绑定了 `bridgeId` 时仍由 Bridge 执行，`comfy` 只对未绑定 Bridge 的渠道生效。

`private.comfy` 的密钥不会下发前端；公开配置只给出 `public.comfy = { url, servers: [{ id, name, url }] }` 供工作流选择服务端。
