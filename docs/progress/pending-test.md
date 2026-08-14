---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- 配置 `grok2api` 或 `xai` 渠道后，画布用 grok-imagine-image / grok-imagine-video 系列模型生成图片、视频，确认路由、字段和轮询结果识别正常。
- 管理端/本地渠道协议下拉可选 `Grok2API`、`xAI`，保存后渠道协议字段正确落库。
- grok2api 渠道经 `/api/v1/tts` 调用 TTS，确认 `language` 缺省为 `en`；`/audio/speech` 保持 OpenAI 字段透传。
- 管理端 grok2api/xai 渠道“读取模型”返回内置 Grok 目录，账号实际权限需人工核对。
- 渠道协议仍为 `openai` 但模型为 `grok-imagine-video-1.5` 时，创建视频不再 404，应映射到 `/videos/generations`。

- Grok/xAI 图片 prompt（含系统提示词）超过 8000 字符时，前端/后端应给出明确错误，不再透传上游 400。
- Grok 图生图多参考图应传 `images:[{url}]`，不再误映射为视频字段 `reference_images`；非法 `aspect_ratio`/`quality`/`size` 会被清洗。
