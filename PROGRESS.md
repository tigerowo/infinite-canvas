# PROGRESS

## 开工回执（2026-08-14）

- 目标：grok2api/xAI 渠道按协议调用图片、视频、TTS，配置协议即可直接用，不再靠模型名碰运气。
- 顺序：0 基线 -> 1 路由协议 -> 2 请求/响应归一化 -> 3 管理端目录与文档 -> 4 测试（含红绿反向验证）。
- 基线：分支 feat/grok2api-protocol，HEAD 93064d2，工作区干净；`go test ./...` 全绿；测试函数 21。
- 最大风险：xAI 媒体字段按 grok2api swagger 处理是约定，实际账号权限/模型列表需人工核对；实测不一致会写 BLOCKED.md。

## 字段映射参考

- grok2api `backend/docs/swagger.yaml`：`SwaggerImageEditRequest`（`image:{url}`、`aspect_ratio`、`n`、`resolution`、`response_format`）、`SwaggerImageGenerationRequest`（`aspect_ratio`、`n`、`resolution`、`response_format`）、`SwaggerVideoGenerationRequest`（`duration`、`image`、`reference_images:[{url}]`、`aspect_ratio`、`resolution`）及 `/v1/images/edits`、`/v1/images/generations`、`/v1/videos/generations` 路径。
- grok2api `openai_audio_handler.go` `handleOpenAISpeech`：`/audio/speech` 保持 OpenAI `input`/`voice`/`response_format`，缺省 `language=en`。
- grok2api `voice_handler.go` `ttsRequest`：`/tts` 使用 `text`/`voice_id`/`language`，POST JSON。
- DEEIX-Chat `README.md` "Protocols and adaptation"（xAI/provider-native capability differences）与 `backend/internal/infra/llm/openai.go` `buildOpenAIRequestURL`：视频端点固定 `/v1/videos/generations`、轮询 `/v1/videos/{request_id}`；`xai_images.go`/`xai_videos.go` 透传 `n`/`aspect_ratio`/`resolution`/`duration`/`response_format`。

## 状态

- 基线及中间验证均以实际命令输出为准；最终验收贴 `go test -count=1 ./...` 输出。
