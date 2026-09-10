# EXT-0028 模型选择与对话布局修复

## 目标与范围

日期：2026-09-09。沿用当前工作区和既有 NewAPI、私有 OSS 架构。

本轮修复模型候选列表与实际可用模型不一致、节点提交按钮重叠、右侧文本模型入口缺失。只读检查 NewAPI 派谱插件、历史日志和上游文档；补齐本地插件的 MD 转换，不自动修改远程配置或发起计费生成。

## TODO 与验收

- [x] 复现未公开模型出现在下拉框中，选择后回退的问题。
- [x] 确认节点工具栏固定宽度且不换行导致提交按钮重叠。
- [x] 统一候选模型过滤，验证鼠标和键盘选择后值持久保留。
- [x] 节点工具栏换行并为提交按钮保留空间，验证窄面板。
- [x] 右侧对话显示文本模型，明确普通 API 与 Codex 模式。
- [x] 核对 NewAPI 插件请求格式、历史错误与 S3/CORS 的边界。
- [x] 本地 paipu 1.1.1 增加 MD 模型格式转换与回归测试。
- [x] Go、Bun、TypeScript、生产构建和浏览器回归。

## 已核实的原因

`ModelPicker` 按渠道模型构造选项，未与 `config.models` 中的公开模型取交集；`resolveModelForCapability` 则会拒绝未公开项。浏览器夹具已复现点击未公开 `sora-2` 后仍显示 `sora-video`。

节点工具栏的模型、参数、摄像机与提交按钮均有固定最小宽度；父级没有换行规则。右侧原“Codex”按钮表示切换目的地，并非当前模型；当前 API 对话使用全局文本模型，但没有就近的模型选择入口。

## 实际修改与接入点

| 文件、符号 | 修改及必要性 | 上游同步检查点 |
| --- | --- | --- |
| `web/src/stores/use-config-store.ts` / `selectableModelOptions` | 共享候选列表与公开模型取交集，排除停用渠道，保留同模型不同渠道身份；复用原能力识别，避免组件另建过滤规则 | 列表与生成解析必须使用相同可用模型范围 |
| `web/src/components/model-picker.tsx` / `ModelPicker` | 调用统一候选函数，补充能力名称，隔离 Escape；原共享组件是全部模型入口，必须就地接入 | Escape 仅关闭下拉框并恢复焦点，不关闭节点参数窗 |
| `web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx` / `CanvasNodePromptPanel` | 工具栏换行，提交按钮自动靠右，移除旧的内层不换行容器 | 窄面板中的模型、参数、摄像机和提交按钮不能交叠 |
| `web/src/app/(user)/canvas/components/canvas-assistant-composer.tsx` / `CanvasAssistantComposer` | 增加就近文本模型入口；更新原配置 store，工具栏可换行 | 普通 API 与 Codex 控件不重复渲染，保留既有工具参数 |
| `web/src/app/(user)/canvas/components/canvas-assistant-panel.tsx` / `CanvasAssistantPanel` | API 模式显示“文本对话”，Codex 改成有名称的切换图标；请求按文本能力解析，缺模型时打开配置；侧栏不超过视口宽度 | 保留现有 Agent 工具执行能力，不把标题修改误认为删除工具；检查小屏发送按钮 |
| `web/src/extensions/model-capabilities/classification.test.ts` | 覆盖未公开候选、重复项、不同渠道身份、停用渠道和空列表 | 继续使用模型 ID，不以数组下标隐藏数据问题 |
| `extensions/newapi/plugin/paipu.js` / `buildSubmitRequest`, `buildLecImageVideoBody` | 本地插件升至 1.1.1；复用图片引用转换，增加 MD 的 `seconds -> duration`、`size -> aspect_ratio`、文件引用转 JSON；画布无 Paipu 分支 | Seed 固定 15 秒；MD 5/10/15 秒、五种比例、720p；其他型号仍按原实现处理 |
| `extensions/newapi/plugin/paipu.test.mjs` | 用实际失败请求形状覆盖 multipart、别名映射、MD 合法参数和拒绝路径 | 先观察新增两项失败，再实现并验证 17 项全通过 |

上述 UI 修改必须发生在现有共享组件的选项、事件和布局位置；未复制组件，未新增后端接口或数据库表。

## 真实环境诊断

通过用户 Chrome 登录态只读核验，没有提交新生成任务或保存远程配置。

- 本地 AI 日志 `2026/9/9 21:44:52`：`minimax_h3-768p` 请求包含非空 `model`、`seconds=15`、`size=1280x720` 和约 2.2 MB 的 `input_reference` PNG 文件。返回 `fail_to_fetch_task` 包装的上游 `new_api_error`“模型为空”。请求 ID 与用户截图相符。因此不能把该错误解释成画布漏传模型或 S3 未配置。
- `21:39:53` 文本日志：`gpt-5.5` 返回 503，原因是 NewAPI `default` 分组没有可用渠道。相邻 Gemini 文本和图片日志为 200；它们是历史成功记录，不代表本次重新生成验收。
- 线上 paipu 插件为 **1.0.1**，上传文件时直接返回 multipart；没有本地 1.1.0 的 Seed JSON 转换，更没有本次 1.1.1 的 MD 转换。
- NewAPI LEC 渠道 `#8` 指向 `https://api.paipu.net`、绑定 `paipu`，配置三个模型：`lec-md-seedance-2-0-900-720p`、`lec-seed-2-0-900`、`lec-gt-seedance-2-0-mini`。地址和绑定存在，不是完全没接通。
- `minimax_h3-768p` 配置在普通 OpenAI 类型的 `#6 wan` 渠道，地址为 `https://snumom.com`，不在 paipu 渠道中。这里需要独立核对该上游的视频协议与模型映射；更新 paipu 插件不能修复此渠道。此前将 MiniMax 与 Paipu 参数作比较仅用于说明协议差异，不代表可以直接使用 Paipu 的型号名替换它。
- 官方 [MD 文档](https://api.paipu.net/docs/videos/lec-md-seedance-2-0-900-720p) 要求 JSON 中的 `model,prompt,duration,aspect_ratio,images?`，支持 5/10/15 秒、五种比例、最多九张图片；与旧插件 multipart 透传不匹配。
- 官方 [Seed 文档](https://api.paipu.net/docs/videos/lec-seed-2-0-900) 仍为固定 15 秒、横竖两种比例。官方 [MiniMax 文档](https://api.paipu.net/docs/videos/lec-minimax-h3-768p) 使用 `lec-minimax-h3-768p`，只支持 HTTPS 图片/音频引用，不能直接复用 MD 的文件转 Data URL 方案。
- 七牛 `wxsh6` 控制台显示私有空间、无自定义 CORS 规则；其跨域页注明默认允许跨域，自定义规则添加后按匹配规则限制。不能仅凭“未配置”认定跨域失败；此处未验证实际 S3 端点响应头及完整签名读取。

## 三轮验证

1. 复现候选模型选择回退与工具栏拥挤，完成列表、对话入口及布局修改。
2. 浏览器复核发现 Escape 关闭父参数窗、375px 对话栏仍保持 464px 导致发送按钮出屏，已修复并复测。
3. 最终类型检查、生产构建、接口与浏览器回归；核对真实日志并给本地 MD 插件增加先失败后通过的契约测试。

| 验证 | 结果 |
| --- | --- |
| `go test ./...`（Docker Go 测试环境） | 全部通过 |
| `bun test`（Bun 1.3.14，9 文件） | 40 项通过，0 失败 |
| `tsc --noEmit --pretty false -p web/tsconfig.json` | 最终前端源码通过 |
| Next.js 生产构建 / Docker 重建 | 编译与页面生成通过，前端修复已在本地容器运行 |
| `node --test extensions/newapi/plugin/paipu.test.mjs` | 最终 17 项通过，0 失败；不是线上插件宿主或计费请求验收 |
| 图像/视频工作台、节点模型、右侧文本模型 | 隔离浏览器鼠标选择通过，图像/视频键盘选择通过；真实 Chrome 文本切换到 `gpt-5.4` 后保持，随后恢复原 Gemini 选择 |
| 无文本模型 | 隔离浏览器提示并打开配置；只出现配置读取请求，没有发出 AI 请求 |
| Escape / 音频模型 | 下拉框关闭后节点窗口保留，焦点回到“视频模型”；音频切换保持 |
| 窄面板及响应式 | 面板 280/360/440/622px 工具按钮无重叠；375/768/1280px 面板不越界；对话发送按钮在视口内 |
| 主题 / 控制台 | 浅色、深色截图已查看；隔离浏览器无新增控制台错误，包含 reduced-motion 浏览器环境 |
| `/api/health` | 200，正文 `ok` |
| 未授权管理员设置与 AI 日志 | 均返回 401 |
| `git diff --check` | 通过；仅有现有文件的 LF/CRLF 提醒，无空白错误 |

## 交付与剩余限制

- 前端入口：`http://localhost:3000`。本地容器重建后可能需要重新登录；没有更改数据库或用户密码。
- 要上传到 NewAPI 的独立插件为仓库 `extensions/newapi/plugin/paipu.js`，版本 **1.1.1**。它不会因画布容器重建而自动更新线上插件。
- 线上更新前保留当前插件版本，核对宿主 `FilePlaceholder` 支持；更新后先用 MD 的 720p、5/10/15 秒和合法比例做一次独立验收。提交结果未知时查询已有任务，避免重复提交。
- 本轮没有更新线上插件、调整 NewAPI 路由、修改七牛/EdgeOne 设置或执行计费请求。因此不能声称全部视频型号已连通；MiniMax 路由、其他型号适配、S3 实际签名读取仍待验证。
- 用户旧画布里的错误节点与历史 `Failed to fetch` 消息不会被自动清除；应以新请求日志判断修复后的结果。
