# 0011 独立 NewAPI 通道

EXT-0011；状态：本地实现及契约验证完成，未部署插件，未执行真实上游生成。执行计划见 [NewAPI 通道执行计划](../newapi-channel-plan.md)。上游基线 `51c4503b2c53e237b2fe67c65711b51ae5deb762`；修改前应用 HEAD `aeda5b31e2a94cec949f005dd28d747d0a7b87a5`。

## 目标与边界

软件使用显式 `newapi` 通道发送兼容请求，由 NewAPI 选择和适配上游。供应商直连保留。旧 `openai` 配置不自动变更，管理员应在完成插件安装及能力核对后主动切换。

LEC 的字段转换归 paipu 插件。软件不根据 LEC 模型名构造请求。NewAPI 的安装位置（本机或云服务器）不决定是否计费；软件价格及 NewAPI 配额仍由各自管理端配置。

## 已实现

- 全新配置及新增渠道默认 NewAPI，地址留空供用户填写。已有渠道协议不迁移；旧版仅有 Base URL、Key、模型列表的配置恢复为 OpenAI，不用 NewAPI 默认值覆盖。
- 后端显式 NewAPI 通道跳过所有供应商请求转换、路径匹配和视频响应转换。模型名称只用于选模型和分类，不决定此通道的供应商请求格式。
- 客户端删除 `web/src/extensions/lec-video/` 及调用分支。LEC 请求 JSON 转换移至可导入的 paipu 插件，软件不包含 LEC 专用字段构造。
- NewAPI 图片 POST 和画布助手失败不自动重试，不剥离参考图或降级工具格式后重新提交。视频只提交一次，轮询超过一小时停止当前等待，可凭已保存任务继续查询。
- 视频区分软件任务 ID、NewAPI 网关任务 ID、供应商任务 ID。后台下载根据用户所属的软件任务找到网关 ID；直连使用网关返回的 `id`。不根据 metadata URL 或 `remixed_from_video_id` 推断完成。
- NewAPI 通用设置不使用供应商专属音色与时长选项；工作台、画布预处理保留参考素材，由请求契约或插件明确拒绝不支持的输入。

## 请求契约

表中路径相对于网关的 `/v1`。软件账号代理的 `/api/v1` 是内部路由，不应填写为 NewAPI 地址。

| 功能 | 路径与格式 | 边界 |
| --- | --- | --- |
| 模型列表 | `GET /models`，Bearer Key，读取 `data[].id` | 分类可由 EXT-0009 覆盖，不代表获取了全部模型能力 |
| 文本/工具 | `POST /chat/completions`；显式 Responses 模式使用 `/responses` | 保留选定格式；不因模型名切到 Gemini/MiMo 原生接口 |
| 图片生成 | `POST /images/generations`，JSON `model,prompt,n,size,quality` | 非默认选项按用户配置追加，实际可接受值由网关及模型验证 |
| 图片编辑 | `POST /images/edits`，multipart；单图 `image`，多图 `image[]` | 发送实际图片字节和 MIME，不把 URL 填进文件字段；无需 S3 图片上传 |
| 其他生图模式 | 显式 Chat/Responses 模式复用对应通用端点 | 每次只生成一张；Chat 生图扩展是否支持由网关决定，不保证所有模型可用 |
| 语音合成 | `POST /audio/speech`，JSON `model,input,voice,response_format,speed,instructions?` | 返回音频字节；标准契约不支持参考音频/语音克隆 |
| 标准视频 | `POST /videos`，JSON `model,prompt,seconds,size?`；带单图时 multipart `input_reference` 文件 | 普通参考图或首帧共一张；多图、尾帧、视频、音频在提交前拒绝 |
| 视频结果 | `GET /videos/{id}`、`GET /videos/{id}/content` | 网关 `id`；明确状态；下载后沿用软件文件存储策略 |

标准视频按整数秒发送，不静默改成某模型的“最近支持时长”；像素尺寸保留，宽高比按清晰度换算。供应商专用负面词、多镜头、元素和原生音频开关不属于本次 NewAPI 契约，也不在该通道控件中提供。

### 多素材扩展

标准之外使用可选 `metadata.canvas_video`，不能把它称为所有 NewAPI 安装自带支持：

```json
{
  "model": "public-model-alias",
  "prompt": "镜头描述",
  "seconds": "15",
  "size": "1280x720",
  "metadata": {
    "canvas_video": {
      "version": 1,
      "media": [{ "type": "image", "role": "reference", "url": "https://example.org/reference.png" }]
    }
  }
}
```

`type` 为 `image/video/audio`，`role` 为 `reference/first_frame/last_frame`；首尾帧仅为图片。顺序保留。具体插件必须对角色和数量做校验。没有对应转换的插件必须报错，不应忽略扩展字段。

启用方法：管理后台“模型与素材传输”内填写软件渠道 ID、公开模型 ID，启用 Canvas v1 并保存。渠道 ID 取自渠道配置 JSON 的 `id`，不是 NewAPI 站内渠道编号。策略键为 `<软件渠道ID>::<小写模型ID>`；更换软件渠道 ID 或模型别名后必须重新核对。相同软件渠道 ID 若改指向另一网关，应先移除扩展授权，确认新插件支持后再启用。普通用户不能修改全局策略。

策略保存于已有 `ext_model_policy.value.newapiVideoProfiles`，默认无扩展；无新表、无上游表字段。回退不删策略或素材。已有后台接口和缓存刷新机制沿用 EXT-0009。

登录后的扩展图片沿用 URL/Base64 策略；未登录图片读取本地 Data URL。扩展视频、音频可使用不带本地存储标识的公开 HTTPS URL；本地媒体需要登录并配置 S3 上传。标准图片编辑、标准视频单图和 NewAPI 画布/文本图片预处理不依赖 S3。

## Paipu 插件交付及迁移

- 正式源码：[paipu.js](../../../extensions/newapi/plugin/paipu.js)，版本 `1.1.0`；回归：[paipu.test.mjs](../../../extensions/newapi/plugin/paipu.test.mjs)。工作区根目录原 `paipu.js`、`paipu.test.mjs` 同步为相同内容，仓库副本用于版本管理。
- NewAPI 核心代码未修改。参考源码固定于 `bee45b58a3c0b77e8dc81e6b5aeb4474aa9058d1`；其 `docs/plugin-api` 仍标为未发布。使用者需确认实际安装具备该 JS 插件 API，不能只凭 `latest` 标签判断。
- 先在 NewAPI 导入/更新 paipu 插件并配置上游，然后将软件对应渠道切为 NewAPI。多参考图还需为该渠道和模型开启 Canvas v1。不要在仍使用旧透传插件时直接切换。
- 此版只对**映射后的上游 ID** `lec-seed-2-0-900` 实现 LEC 转换。公开模型别名可以不同，但 NewAPI 的模型映射必须指向该真实上游 ID；不能映射成任意字符串却期望命中同一适配器。
- LEC 转换输出 `model,prompt,aspect_ratio,images?`；单文件通过 NewAPI 宿主 `FilePlaceholder` 转完整 Data URL，多图扩展转换为 `images`。最多九张，比例 16:9/9:16，720p，按历史规格只允许 15 秒；不支持首尾帧角色、参考视频、参考音频。
- 上述 LEC 限制来自先前接入记录；本次供应商文档未取得可核验正文，尚需真实部署前核对当前规格，不能视为在线规格验证。插件拒绝其他时长，避免静默舍弃时长并错误预估用量。
- 插件模型表中的其他 34 个 ID 保留原处理；模型表不是“全部完成 Canvas v1 适配”的声明。其他上游收到 Canvas v1 会明确报不支持，新增适配只需修改插件。`lec-md-seedance-2-0-900-720p` 不在本次已实现的转换范围。
- 插件查询用供应商任务 ID，向客户端渲染网关 ID；签名视频链接的无凭证下载及过期回退沿用原逻辑。插件不执行网络 IO，文件读取、请求、轮询和计费由 NewAPI 宿主处理。

## 文件与接入点

| 文件或目录 / 符号 | 原因及同步检查点 |
| --- | --- |
| `extensions/newapi/` | 协议标识、严格视频结果解析、可导入插件及测试；定制实现主目录 |
| `web/src/extensions/newapi/` | 默认渠道、协议识别、图像/视频请求与回归；不依赖 LEC 模型名 |
| `extensions/modelcapabilities/policy.go`、前端 `model-capabilities/policy.ts,policy-panel.tsx` | 扩展现有独立策略存储和管理入口；检查默认关闭、管理员写入及版本校验 |
| `service/model_protocol.go` / registry、`matchModelProtocol` | 原协议注册表是模型列表/测试/鉴权入口，必须注册并优先识别 NewAPI；检查 Bearer 和 `/v1` 拼接 |
| `handler/model_protocol.go` / 请求及响应包装函数 | 现有适配器只在此收敛；NewAPI 跳过供应商钩子，保留直连原顺序 |
| `handler/ai.go` / `resolveAIProxyPath,resolveAIProxyURL,AIVideoContent` | 原 HTTP 分流与内容路由入口；必须在供应商匹配前隔离 NewAPI |
| `handler/newapi.go` | 同包最小 HTTP 接入，复用账号、任务归属、渠道选择和输出封装；不能反向导入 handler 到扩展包，解析业务调用扩展 |
| `handler/video_task.go` / 提交及轮询解析 | 获取实际渠道后选解析器，跳过 provider video ID 替换；复用原任务持久化和扣点机制 |
| `handler/newapi_test.go` | 跨路径、名称、鉴权及响应边界回归 |
| `web/src/lib/model-channel.ts` 及测试 | 两个设置面板共享的协议选项；检查默认顺序和原直连选项 |
| `web/src/stores/use-config-store.ts` / `defaultConfig,merge` | 首次配置默认 NewAPI；检查旧版缺少 localChannels 时仍用历史 OpenAI 配置 |
| 管理端 `admin/settings/page.tsx`、`layout/app-config-modal.tsx` | 新建渠道模板处改默认；不批量改已保存配置 |
| `web/src/services/api/image.ts` | 生成、编辑、账号任务请求与模型列表入口调用扩展；复用解析/鉴权/日志，禁止 NewAPI POST 自动重试 |
| `web/src/services/api/video.ts` | 统一提交、轮询和内容下载调用扩展；移除客户端 LEC 分支，检查 ID、文件和超时 |
| `web/src/services/api/audio.ts` | 语音入口绕开 GLM/MiMo 模型名，发送通用字段并验证文件响应 |
| `web/src/services/api/canvas-agent.ts` | NewAPI 参考图本地读取，错误直接返回；不自动剥图/换工具模式重发 |
| `web/src/components/video-settings-panel.tsx,audio-settings-panel.tsx` | 通用控件与实际发送字段一致，原服务商控件继续保留 |
| `web/src/app/(user)/video/page.tsx` / `buildRequestSnapshot,buildVideoConfig` | 工作台在请求层之前有参数与素材筛选，NewAPI 必须优先保留完整输入 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 节点调用、首尾帧及 Agent 时长/音色入口；检查通道上下文传到素材预处理和校验 |
| `canvas/components/canvas-node-generation.ts` | NewAPI 节点素材预处理读取图片字节，不提前强制 S3 |
| `canvas/components/canvas-video-settings-popover.tsx,canvas-audio-settings-popover.tsx` | 首尾帧及音频配置弹窗；检查所显示字段与通用请求对应 |

表内上游接入点是现有调用链或框架组件的唯一入口，无法只新增扩展文件就改变其提前分流。未修改 NewAPI 核心、供应商直连实现、上游数据库表或计费规则。

## 验证与限制

- `go test ./...` 通过；后端构建通过。
- Bun 定向回归：NewAPI、原渠道选项、原模型分类，共 13 项通过。覆盖真实 Axios/fetch 入口、multipart 图片字节、角色保留、未知状态、失败只发一次、旧配置以及画布素材预处理；均为本地拦截，不访问模型服务。
- `node --test extensions/newapi/plugin/paipu.test.mjs`：15 项通过；同一标准请求经过不同上游模型分支得到各自描述，LEC 转换、文件占位符、扩展拒绝、签名内容及任务映射均覆盖。不是两个真实供应商的在线验收。
- `tsc --noEmit --incremental false` 仍有原有画布音频截取 Slider 的 TS2322 和两条 TS7031；无新增类型错误。未以此声称全量类型检查通过。
- Playwright：1440×1000 与 390×844 视频页、配置弹窗可渲染，无 pageerror/新增水平溢出；新增 NewAPI 默认项与旧配置恢复的 OpenAI 协议、原地址已在浏览器验证。HTTP `/api/health` 与首页 200。
- 未执行真实 NewAPI 插件安装、付费模型生成、跨上游在线对比、生产构建/部署、实际算力扣点或 S3 成品播放。上线前按实际安装版本和模型完成这些验证。
- 已检查上游 TODO / pending-test 的职责；本定制的剩余验收集中在这里，不重复写入上游待办。`web/next-env.d.ts` 为原先已有生成改动，不属于本项业务修改。

## 回退

恢复旧版本的应用和 paipu 插件即可回退；不删除渠道、任务、素材或 `ext_model_policy`。如果旧 LEC 配置依赖 EXT-0008，需要一并恢复该历史客户端分支和对应透传插件，不能只回退一端。上游更新时按上表逐一核对，尤其是渠道序列化、视频 ID、请求重试和图片文件类型。
