# LEC Seedance 请求格式适配

## 标识与目标

- EXT-0008；基线 `51c4503b2c53e237b2fe67c65711b51ae5deb762`；状态：请求构造验证通过，计费生成待验证。
- `lec-seed-2-0-900` 的官方请求为 JSON，图片为 `images` 数组，比例为 `aspect_ratio`，固定生成 15 秒。画布原先使用通用 multipart 和 `input_reference[]`，不符合该示例。
- 官方来源：https://api.paipu.net/docs/videos/lec-seed-2-0-900 。当前报错不能用于断言模型不存在或停服。

## 扩展和接入

- 实现及回归：`web/src/extensions/lec-video/`。
- 上游唯一业务接入：`web/src/services/api/video.ts` 的 `createVideoRequestBody` 调用扩展；这是登录代理与未登录直连共同的请求构造入口，必须在此接入。
- 后端已有 JSON 透传，继续使用 `/v1/videos` 创建和现有任务查询，不新增后端适配。
- 保留原模型 ID、密钥、渠道设置；无数据库或样式变更。仅 OpenAI 协议的该精确模型 ID 启用，其他模型不变。
- 最多 9 张参考图；无专用首尾帧、视频或音频参数，遇到这些输入明确拒绝，不静默丢弃。
- 参考图使用现有图片读取逻辑转成上游支持的 `data:image`；竖屏传 `9:16`，其余画幅回落到官方默认 `16:9`。不传通用的时长、分辨率和 preset 参数，该模型固定 15 秒。

## 验证

- `bun test src/extensions/lec-video/request.test.ts src/extensions/model-capabilities/classification.test.ts`：3 项通过。修复前真实视频请求入口的 JSON 断言失败，修复后通过。使用 Axios adapter 拦截实际序列化后的请求，确认 URL、JSON Content-Type、模型名、提示词、竖屏比例、图片数组及任务 ID 解析；不访问模型服务。
- `tsc --noEmit --incremental false`：仅既有 `canvas-client-page.tsx:4362` 的 TS2322 和两条 TS7031，无新增错误。
- 画布页面编译访问及 `/api/health` 均返回 HTTP 200。
- 完整上游生成未验证；修正请求格式不等于证明中转站到上游的全部配置正确。

## 提交、回退与同步

- 独立提交 `fix(ext-lec-video): 按上游文档发送 Seedance JSON 请求`，不推送。
- 回退移除扩展和接入即可，无数据迁移。同步时检查请求构造入口及参考图解析接口。
- 定制验证集中在此，不向上游 TODO 和待测试文档重复追加。
