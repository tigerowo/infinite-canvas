# 通过 NewAPI 发送 LEC Seedance 特定请求体

> 历史记录：本项客户端实现已在 [EXT-0011](0011-newapi-channel.md) 删除，LEC 转换迁至 paipu 插件。下面保留当时实现与验证，不能作为当前客户端行为说明。

## 标识与目标

- EXT-0008；基线 `51c4503b2c53e237b2fe67c65711b51ae5deb762`；状态：已实现；历史请求构造验证通过，真实使用反馈与待验证范围见下文。
- 调用链路为画布 → 配置的 NewAPI → NewAPI 所接的中转/上游。此项只修改画布发出的请求体，没有修改 NewAPI 服务端，也没有让画布绕过 NewAPI 直连 LEC。
- `/v1/videos` 是沿用的接口路径，不表示所有模型的请求体相同。此项针对 `lec-seed-2-0-900`，将原通用 multipart、`input_reference[]` 改为 JSON、`images` 数组和 `aspect_ratio`。
- 当时依据的上游示例：[LEC 模型文档](https://api.paipu.net/docs/videos/lec-seed-2-0-900)。原记录称该模型固定 15 秒；当前代码不发送时长，实际时长由上游决定，本次文档同步未重新查询供应商规格。
- 新站提供同一模型 ID 和请求协议时，可以更换 Base URL 与 API Key；只有模型名相同或都使用 NewAPI，不能证明参数与结果格式完全兼容。本项代码不绑定某个站点域名。

## 扩展和接入

- 实现及回归：`web/src/extensions/lec-video/`。
- 上游唯一业务接入：`web/src/services/api/video.ts` 的 `createVideoRequestBody` 调用扩展；这是登录代理与未登录直连共同的请求构造入口，必须在此接入。
- 后端已有 JSON 透传，继续使用 `/v1/videos` 创建和现有任务查询，不新增后端适配。
- 保留原模型 ID、密钥、渠道设置；无数据库或样式变更。仅 OpenAI 协议的该精确模型 ID 启用，其他模型不变。
- 最多 9 张参考图；无专用首尾帧、视频或音频参数，遇到这些输入明确拒绝，不静默丢弃。
- 参考图现通过 [EXT-0009](0009-public-media.md) 的 `publicImageURL` 处理：默认 S3 HTTPS URL，管理员可切换图片 Base64。这替代了本项初版固定转 `data:image` 的行为，并继承该入口的登录要求。
- `9:16`、`720x1280`、`1080x1920` 传 `9:16`，其余传 `16:9`；不发送通用时长、分辨率或 preset 参数。

## 验证

- `bun test src/extensions/lec-video/request.test.ts src/extensions/model-capabilities/classification.test.ts`：3 项通过。修复前真实视频请求入口的 JSON 断言失败，修复后通过。使用 Axios adapter 拦截实际序列化后的请求，确认 URL、JSON Content-Type、模型名、提示词、竖屏比例、图片数组及任务 ID 解析；不访问模型服务。
- `tsc --noEmit --incremental false`：仅既有 `canvas-client-page.tsx:4362` 的 TS2322 和两条 TS7031，无新增错误。
- 画布页面编译访问及 `/api/health` 均返回 HTTP 200。
- 上述为本项初版的历史验证；后续 EXT-0009 修改了图片传输和对应测试，本次仅核对当前实现，未重新执行这些测试或付费生成。
- 用户在 [EXT-0010](0010-video-content.md) 后反馈“ok了已经”，确认当时使用流程可用；未记录该次具体模型、渠道模式及请求样本，不能据此将本项所有输入或云端扣点路径标记为通过。

## 提交、回退与同步

- 独立提交 `fix(ext-lec-video): 按上游文档发送 Seedance JSON 请求`，不推送。
- 回退移除扩展和接入即可，无数据迁移。同步时检查请求构造入口及参考图解析接口。
- 定制验证集中在此，不向上游 TODO 和待测试文档重复追加。
