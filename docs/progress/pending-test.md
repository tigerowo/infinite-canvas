---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- 配置 `grok2api` 或 `xai` 渠道后，画布用 grok-imagine-image / grok-imagine-video 系列模型生成图片、视频，确认路由、字段和轮询结果识别正常。
- 管理端/本地渠道协议下拉可选 `Grok2API`、`xAI`，保存后渠道协议字段正确落库。
- grok2api 渠道经 `/api/v1/tts` 调用 TTS，确认 `language` 缺省为 `en`；`/audio/speech` 保持 OpenAI 字段透传；音色列表可从 `/tts/voices` 拉取。
- 管理端 grok2api/xai 渠道“读取模型”：上游 `/models` 有结果时保留 LLM，并合并内置媒体目录；上游失败时回退内置文本+媒体目录。账号实际权限需人工核对。
- 渠道协议仍为 `openai` 但模型为 `grok-imagine-video-1.5` 时，创建视频不再 404，应映射到 `/videos/generations`。
- Grok/xAI 图片 prompt（含系统提示词）超过 8000 字符时，前端/后端应给出明确错误，不再透传上游 400。
- Grok 图生图多参考图应传 `images:[{url}]`，不再误映射为视频字段 `reference_images`；非法 `aspect_ratio`/`quality`/`size` 会被清洗。
- Grok 视频：`image` 与 `reference_images` 互斥；**首帧单图（含 video-1.5）可选 1080p**；**仅多参考图模式最高 720p**；视频 `21:9` 吸附为 `16:9`。
- 画布云端同步不再写入 `blob:` 图片地址；反代域名下应能打开 `https` 媒体链（如 grok media）。历史已同步的纯 blob 节点需在原内网打开后重生成，或启用对象存储后重新上传。
- 打开含历史 `blob:`/`image:` 节点的画布：本机有本地文件且对象存储可用时应自动上传并同步；仅云端 blob、本地无数据时应显示失效占位而非空白死链。
- 内网生成 Grok https 图后，反代域名打开同一画布应可显示；对称从反代生成后回内网也可显示。
- 未启用对象存储时：稳定 https 仍可跨域；纯本地图可本机预览并带“未上云”提示，且不会把 `blob:` 写入云端。
- 清空本机图片缓存后打开画布：若节点仍有 imageTaskId/imageTaskResultId 且服务端任务仍有 image_url，应自动回填显示并写回云端画布。
- 换浏览器同账号：仅含 server: 或稳定 https 或可任务回填的节点应可见；无 task id 的纯 blob 历史裂图仍失效。
- 确认不会把 Grok https 强制转存 WebDAV；本地上传图在 WebDAV 可用时应出现 server:。
- Safari 打开画布视频节点应能播放（不要走 /api/proxy-image）；Edge/Firefox 回归正常。
