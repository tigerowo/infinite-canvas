---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

## 图片生成 SSE 响应兼容

- 已支持后端持久化图片任务从 `text/event-stream` 响应的 `data:` 事件中读取 `url` 或 `b64_json`，包括 `image_generation.partial_succeeded` 事件。
- 已支持前端直连图片接口从携带图片字段的 SSE 事件中提取结果，并按 `image_index` 保留每张图片的最新事件。
- 待人工确认：为 console 渠道开启图片“流式传输”后，生图工作台和无限画布均能正常显示生成图片，失败详情中不再出现 `invalid character 'e' looking for beginning of value`。
