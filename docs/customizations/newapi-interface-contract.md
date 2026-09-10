# 微鑫画布发往 NewAPI 的接口文档

用途：接入新上游时，查清本软件会向 NewAPI 请求哪个接口、发送哪些参数和素材，再据此编写 NewAPI 侧的上游适配器或插件。本文按当前工作区中渠道协议为 `newapi` 的请求代码编写，核查日期为 2026-09-10；其他直连供应商协议不混入本文。

以下示例是 **NewAPI HTTP 入口收到的请求结构**。模型名、提示词、工具定义和素材为占位值，需替换成真实配置；可选字段仅在相应条件成立时发送。思考强度菜单已实现，但只发送当前模型能力表允许的档位；不表示所有上游均支持任意档位。

## 1. 公共约定与接口索引

示例网关根地址为 `https://newapi.example`。下表包含完整路径，实际域名由软件渠道配置决定。

| 功能 / 模式 | 方法 | NewAPI 接口 | 请求体 |
| --- | --- | --- | --- |
| 文本、Agent：Chat | POST | `/v1/chat/completions` | JSON |
| 文本、Agent：Responses | POST | `/v1/responses` | JSON |
| 图片问答 | POST | `/v1/chat/completions` | JSON，stream:true |
| 生图：Images，无参考图 | POST | `/v1/images/generations` | JSON |
| 生图：Images，有参考图 | POST | `/v1/images/edits` | multipart/form-data |
| 生图：Chat | POST | `/v1/chat/completions` | JSON |
| 生图：Responses | POST | `/v1/responses` | JSON |
| 视频：标准，无参考图 | POST | `/v1/videos` | JSON |
| 视频：标准，单张参考图 | POST | `/v1/videos` | multipart/form-data |
| 视频：Canvas v1 扩展 | POST | `/v1/videos` | JSON |
| 视频任务查询 | GET | `/v1/videos/{id}` | 无 |
| 视频文件读取 | GET | `/v1/videos/{id}/content` | 无，可带 Range 请求头 |
| 音频：语音合成 | POST | `/v1/audio/speech` | JSON |
| 模型列表 | GET | `/v1/models` | 无 |

公共请求头：

```http
Authorization: Bearer <NEWAPI_API_KEY>
Content-Type: application/json
```

multipart 的 Content-Type 为 `multipart/form-data; boundary=...`，boundary 由发送端生成；GET 无须 JSON Content-Type。Bearer 是 NewAPI 密钥。软件登录令牌、内部渠道选择头及任务包装不是插件模型请求字段；内部图片任务的 `{endpoint,request,...}` 会解包，`_canvas_*` 表单元数据会剥离。

所有创建请求都发送 `model`，值为软件选中的模型名称；NewAPI 再按渠道配置映射上游模型。查询通过路径中的网关任务 ID 定位，没有 JSON model 请求体。部分直接读取视频的路径可附 `?model=模型名`，不能要求查询必须携带它。

## 2. 文本与 Agent

### 2.1 Chat Completions

`POST /v1/chat/completions`，JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，当前文本模型 |
| messages | array | 始终发送，系统提示词和会话历史，见下表 |
| stream | boolean | Agent 固定 false |
| tools | array | 原生工具模式且有工具时发送；元素为 `{type:"function",function:{name,description,parameters}}` |
| tool_choice | string | 有原生工具时发送 auto |
| response_format | object | 结构化工具模式且有工具 Schema 时发送，结构见下文 |
| reasoning_effort | string | 非自动且模型支持时发送所选值：none、minimal、low、medium、high 或 xhigh；按模型限制，见下表 |

此构造器不主动发送 temperature、top_p、max_tokens、max_completion_tokens。省略推理字段由网关/模型决定，不等于强制关闭思考。

当前软件的能力筛选规则如下，模型名为大小写不敏感的前缀匹配；别名如果不符合这些规则，只显示自动。插件应按收到的值转换至上游字段，不要自行固定为 high。

| 模型族 | 自动以外的软件选项 |
| --- | --- |
| gpt-5.2、gpt-5.4、gpt-5.5，排除 pro | none、low、medium、high、xhigh |
| gpt-5.1 | none、low、medium、high |
| gpt-5，排除 pro | minimal、low、medium、high |
| o1、o3、o4 | low、medium、high |
| gemini-3.1-pro、gemini-3-flash | low、medium、high |
| gemini-3-pro、gemini-3.0-pro | low、high |
| 其他模型或不支持的旧选择 | 自动，即省略字段 |

没有保存新档位的旧布尔配置：开启映射 high，但仍先通过模型能力校验；关闭映射自动。切换模型后不支持的选择按自动处理。这里描述软件当前请求行为，不代替上游支持承诺。

| 消息 | 实际结构 |
| --- | --- |
| 系统 | `{role:"system",content:"..."}`，包含配置提示词及 Agent 运行说明 |
| 用户纯文本 | `{role:"user",content:"..."}` |
| 用户带图 | content 数组：文本块 `{type:"text",text:"..."}`，图片块 `{type:"image_url",image_url:{url:"data:image/png;base64,..."}}` |
| 助手历史 | `{role:"assistant",content:"..."}`，无正文时 content 可为 null |
| 助手工具调用 | 助手消息可带 `tool_calls:[{id,type:"function",function:{name,arguments}}]`，arguments 为 JSON 字符串 |
| 工具结果 | `{role:"tool",tool_call_id:"call_1",name:"...",content:"..."}`，content 为字符串 |
| 思考历史 | 助手历史存在 reasoningContent 时附带 reasoning_content，不保证每条消息都有 |

已开启推理的普通请求：

```json
{
  "model": "text-model-alias",
  "messages": [
    {"role": "system", "content": "你是创作助手。"},
    {"role": "user", "content": "帮我整理分镜。"}
  ],
  "stream": false,
  "reasoning_effort": "high"
}
```

原生工具模式在请求根追加以下字段。实际工具名、描述、参数 Schema 由软件动态提供，插件应保留结构，不写死示例名称：

```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "tool_name",
      "description": "工具用途",
      "parameters": {
        "type": "object",
        "properties": {"prompt": {"type": "string"}},
        "required": ["prompt"]
      }
    }
  }],
  "tool_choice": "auto"
}
```

结构化工具模式发送 `response_format={type:"json_schema",json_schema:{name:"canvas_agent_actions",schema:实际Schema}}`，不发送原生 tools；工具说明放在提示词。NewAPI 协议请求失败时不会自动换另一种工具协议，插件应按收到的格式处理。

软件读取 `choices[0].message.content` 或该 message 下的 tool_calls。普通回答返回 content 字符串；工具响应示例：

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_1",
        "type": "function",
        "function": {"name": "tool_name", "arguments": "{\"prompt\":\"城市街景\"}"}
      }]
    }
  }]
}
```

软件执行工具后，将助手调用与对应 role:tool 结果放入下一轮 messages；arguments 必须可解析为 JSON 对象。finish_reason 为 length、content_filter、max_tokens 时作为未正常完成处理。

### 2.2 Responses

`POST /v1/responses`，JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，文本模型 |
| instructions | string | 始终发送，系统提示词及 Agent 运行说明 |
| input | array | 始终发送，会话消息、历史输出项及工具结果 |
| store | boolean | 固定 false |
| include | string[] | 固定 `["reasoning.encrypted_content"]` |
| tools | array | 原生工具模式且有工具时发送；扁平 `{type:"function",name,description,parameters}` |
| tool_choice | string | 有原生工具时发送 auto |
| text | object | 结构化工具模式发送 `{format:{type:"json_schema",name:"canvas_agent_actions",schema:实际Schema}}` |
| reasoning | object | 非自动且模型支持时发送 `{effort:"所选值"}`，取值与文本 Chat 能力表相同；自动省略 |

当前 Agent 此分支不发送 stream、previous_response_id；在 input 中传递所需历史。文本消息 content 可以是字符串；带图时使用 input_text/input_image。已保留的 Responses 输出项原样进入后续 input，包括推理项或 function_call。

带图请求：

```json
{
  "model": "text-model-alias",
  "instructions": "你是创作助手。",
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "描述这张参考图。"},
      {"type": "input_image", "image_url": "data:image/png;base64,BASE64_IMAGE_BYTES"}
    ]
  }],
  "store": false,
  "include": ["reasoning.encrypted_content"],
  "reasoning": {"effort": "high"}
}
```

工具结果在 input 中使用 `{type:"function_call_output",call_id:"call_1",output:"工具结果字符串"}`。助手调用使用 `{type:"function_call",call_id:"call_1",name:"tool_name",arguments:"JSON字符串"}`，没有 Chat 的嵌套 function 包装。

推荐响应：

```json
{
  "status": "completed",
  "output": [{
    "type": "message",
    "role": "assistant",
    "content": [{"type": "output_text", "text": "这是整理好的分镜。"}]
  }]
}
```

工具调用返回 output 内 type 为 function_call 的项，包含 call_id、name、arguments。软件也读取根 output_text；failed、incomplete、cancelled、in_progress、queued 不会当作完成文本。

### 2.3 图片问答的流式请求

图片问答另向 `POST /v1/chat/completions` 发送 `{model,messages,stream:true}`，按配置加入 system 消息。此入口直接使用传入的 Chat 消息；带图采用 image_url 内容块，不通过 Agent 工具循环。

响应使用 text/event-stream，软件累计 `choices[0].delta.content`：

```text
data: {"choices":[{"delta":{"content":"这张图"}}]}

data: {"choices":[{"delta":{"content":"展示了城市街景。"}}]}

data: [DONE]

```

非 SSE 响应会尝试读取完整 choices[0].message.content。不要将此行为写成 Agent 已使用 stream:true。

## 3. 图片生成与编辑

NewAPI 生图有 Images、Chat、Responses 三种模式。提示词先合并生图系统提示词与已配置的提示词约束；下文 prompt/text/input 是合并后的文本。

### 3.1 Images：无参考图

`POST /v1/images/generations`，JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，图片模型 |
| prompt | string | 始终发送，合并后的提示词 |
| n | number | 始终发送；数量归一到 1–15，持久化图片任务逐张提交时为 1 |
| size | string | 有具体尺寸时发送，如 1024x1024；自动或未选择时省略 |
| quality | string | 非 auto 时发送，可能为 low、medium、high、standard、hd |
| response_format | string | 开启 Base64 返回选项时发送 b64_json，否则省略 |
| stream | boolean | 开启流式图片时发送 true，否则省略 |
| partial_images | number | 开启流式图片时发送，归一到 0–3，默认 1 |

```json
{
  "model": "image-model-alias",
  "prompt": "一幅城市街景，傍晚自然光。",
  "n": 1,
  "size": "1024x1024",
  "quality": "low",
  "response_format": "b64_json"
}
```

尺寸和质量转换：

| 配置 | 实际规则 |
| --- | --- |
| 已是 宽x高 | size 原样发送 |
| 比例为 auto | Images 省略 size；Responses 工具 size 为 auto |
| 比例为 a:b | 先约分，以基准边长 B 算 `unit=round(sqrt(B²/(a*b))/16)*16`，发送 a*unit x b*unit |
| quality=low / standard | B=1024 |
| quality=medium / hd | B=2048 |
| quality=high | B=2880 |
| quality=auto，但选择了比例 | B=1024 换算尺寸，仍省略 quality |
| 质量别名 1k / 2k / 4k | 分别归一为 low / medium / high；4k 标签不表示固定发送 4096 像素 |

这是软件可能发出的值，不保证每个上游支持。插件应校验并转换，不能悄悄丢弃不支持的参数。

### 3.2 Images：有参考图

`POST /v1/images/edits`，multipart/form-data。

标量字段及发送条件与 3.1 相同，但全部转换成表单字符串，例如 n 为 "1"、stream 为 "true"、partial_images 为 "1"。

| 图片数量 | 字段 | 内容 |
| --- | --- | --- |
| 一张 | image | 图片文件字节，image/* MIME，当前文件名 reference-0 |
| 多张 | 重复 image[] | 每个字段一份图片文件，文件名 reference-0、reference-1 等 |

当前不发送 mask。文件字段不是 URL 字符串、JSON images 数组或裸 Base64；软件读取图片后转换为文件上传。插件不要依赖文件扩展名判断格式。

单张图片的 multipart 示例，boundary 与二进制内容为示意：

```http
POST /v1/images/edits HTTP/1.1
Host: newapi.example
Authorization: Bearer <NEWAPI_API_KEY>
Content-Type: multipart/form-data; boundary=example-boundary

--example-boundary
Content-Disposition: form-data; name="model"

image-model-alias
--example-boundary
Content-Disposition: form-data; name="prompt"

调整灯光，保留人物身份。
--example-boundary
Content-Disposition: form-data; name="n"

1
--example-boundary
Content-Disposition: form-data; name="image"; filename="reference-0"
Content-Type: image/png

<PNG 文件字节>
--example-boundary--
```

Images 两个端点的非流式返回均为下列之一，不要再在 data 外包一层 data：

```json
{"data":[{"url":"https://media.example/result.png"}]}
```

```json
{"data":[{"b64_json":"BASE64_IMAGE_BYTES"}]}
```

流式为 text/event-stream。当前解析器读取 object 为 image.generation.result / image.edit.result 的 data[]，也读取事件根 b64_json/url，并按 image_index 区分图片。可对接的结果事件：

```text
data: {"object":"image.generation.result","data":[{"b64_json":"BASE64_IMAGE_BYTES"}]}

data: [DONE]

```

### 3.3 Chat 生图

`POST /v1/chat/completions`，JSON。

| 字段 | 类型 | 当前发送内容 |
| --- | --- | --- |
| model | string | 图片模型 |
| messages | array | 一条 user；无图时 content 是提示词字符串，有图时为文本和图片块数组 |
| modalities | string[] | 固定 ["image","text"] |
| stream | boolean | 固定 false |

```json
{
  "model": "image-model-alias",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "调整画面灯光。"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,BASE64_IMAGE_BYTES"}}
    ]
  }],
  "modalities": ["image", "text"],
  "stream": false
}
```

此模式不发送 size、quality、n、response_format、partial_images；NewAPI 构造器对单次请求 n>1 报错。参考图片可以多张，每张各一个 image_url 块。界面展示了尺寸或质量控件，也不表示插件能收到对应字段。

软件要求图片位于 `choices[].message.images[].image_url.url`：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "",
      "images": [{"image_url": {"url": "data:image/png;base64,BASE64_IMAGE_BYTES"}}]
    }
  }]
}
```

url 也可为可读图片链接；只返回 Markdown 图片文本不能满足此图片解析路径。

### 3.4 Responses 生图

`POST /v1/responses`，JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，选择的模型 |
| input | string / array | 无图为提示词字符串；有图为一条 user 消息，content 含 input_text 与各图的 input_image |
| tools | array | 始终一项 image_generation 工具，嵌套字段见下列行 |
| tools[0].type | string | 固定 image_generation |
| tools[0].action | string | 无图 generate，有图 edit |
| tools[0].size | string | 始终发送，像素尺寸或 auto |
| tools[0].quality | string | 非 auto 时发送，规则同 Images |
| tools[0].partial_images | number | 开启流式图片时发送，0–3 |
| tool_choice | string | 固定 required |
| stream | boolean | 开启流式图片时发送 true，否则省略 |

```json
{
  "model": "responses-image-model-alias",
  "input": [{
    "role": "user",
    "content": [
      {"type": "input_text", "text": "调整画面灯光。"},
      {"type": "input_image", "image_url": "data:image/png;base64,BASE64_IMAGE_BYTES"}
    ]
  }],
  "tools": [{"type": "image_generation", "action": "edit", "size": "1024x1024", "quality": "low"}],
  "tool_choice": "required"
}
```

此生图请求不发送文本 Agent 的 store、include、instructions，也不发送 n 或 response_format；构造器对单次请求 n>1 报错。size、quality、partial_images 位于 tools[0]，不能按 Images 的根字段读取。

软件消费 output 内 image_generation_call 的 Base64 结果，推荐返回：

```json
{
  "status": "completed",
  "output": [{"type": "image_generation_call", "status": "completed", "result": "BASE64_IMAGE_BYTES"}]
}
```

流式预览使用 type 为 response.image_generation_call.partial_image 的 partial_image_b64；最终结果可通过完成事件的 response.output 交付：

```text
data: {"type":"response.image_generation_call.partial_image","partial_image_index":0,"partial_image_b64":"BASE64_PREVIEW_BYTES"}

data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"image_generation_call","status":"completed","result":"BASE64_IMAGE_BYTES"}]}}

data: [DONE]

```

插件须交付最终图片或明确失败，不能只交付 partial。软件当前 partial 回退过宽的问题列入修复文档 AUD-02，不应当作插件的成功协议。

## 4. 视频

### 4.1 标准文生视频

`POST /v1/videos`，无参考素材时为 JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，去除首尾空白的视频模型名，空值软件侧报错 |
| prompt | string | 始终发送，生成提示词 |
| seconds | string | 始终发送，配置必须为整数 1–15，实际为 "5"、"10" 等字符串 |
| size | string | 具体像素尺寸时发送，auto 或空值时省略 |

```json
{
  "model": "video-model-alias",
  "prompt": "镜头缓慢向前推进。",
  "seconds": "10",
  "size": "1280x720"
}
```

比例与清晰度转换：

| 配置 | 发送结果 |
| --- | --- |
| 已是 1280x720 等像素值 | 原样发送 size，清晰度不再单独影响它 |
| 比例 auto | 省略 size |
| 16:9 + 720p | size=1280x720 |
| 9:16 + 720p | size=720x1280 |
| 1:1 + 720p | size=720x720 |
| 16:9 + 1080p | size=1920x1080 |
| 清晰度别名 low / medium / high / auto | 换算短边分别为 480 / 720 / 720 / 720 |

其他正整数比例按短边分辨率换算，宽高分别四舍五入到偶数。视频 high 与图片 quality=high 的尺寸规则不同。

当前 NewAPI 视频构造器不发送独立 quality、resolution、aspect_ratio、duration、n、seed、negative_prompt、generate_audio。上游需要 duration/aspect_ratio/resolution 时，插件从 seconds/size 转换；上游额外必填项需插件配置或扩展软件，不能假设现有请求会带上。

### 4.2 标准图生视频

仍为 `POST /v1/videos`，改为 multipart/form-data。

| 表单字段 | 类型 | 当前发送内容 |
| --- | --- | --- |
| model | 文本 | 视频模型 |
| prompt | 文本 | 提示词 |
| seconds | 文本 | 同标准 JSON |
| size | 文本，可省略 | 同标准 JSON |
| input_reference | 图片文件 | 单张参考图或首帧字节，image/* MIME，文件名 reference-image |

普通参考图与首帧合计最多一张；尾帧、多图、参考视频/音频在标准模式软件侧报错。首帧同样放入 input_reference，不另发 first_frame 字段，插件不能据此判断来自哪个 UI 槽位。

multipart 请求体示例，请求头同 3.2，但路径为 /v1/videos：

```text
--example-boundary
Content-Disposition: form-data; name="model"

video-model-alias
--example-boundary
Content-Disposition: form-data; name="prompt"

镜头缓慢向前推进。
--example-boundary
Content-Disposition: form-data; name="seconds"

10
--example-boundary
Content-Disposition: form-data; name="size"

1280x720
--example-boundary
Content-Disposition: form-data; name="input_reference"; filename="reference-image"
Content-Type: image/png

<PNG 文件字节>
--example-boundary--
```

### 4.3 Canvas v1 扩展：多素材、首尾帧

管理员按“渠道 + 模型”启用 canvas-v1 后，软件向同一个 `/v1/videos` 发送 JSON。这是本软件的扩展约定，NewAPI 接收方需专门适配。

根 model、prompt、seconds、size 与 4.1 相同，另外发送：

| 字段 | 类型 | 内容 |
| --- | --- | --- |
| metadata.canvas_video.version | number | 固定 1 |
| metadata.canvas_video.media | array | 素材列表；无素材也发送空数组 |
| media[].type | string | image / video / audio |
| media[].role | string | 图片为 reference / first_frame / last_frame；视频、音频为 reference |
| media[].url | string | 图片为可读 URL 或完整 Data URL；视频、音频为可读 URL |

顺序为普通参考图片、首帧、尾帧、参考视频、参考音频，同组保持原顺序。示例展示字段位置，不保证任意上游支持全部类型混合使用：

```json
{
  "model": "video-model-alias",
  "prompt": "保持人物一致，并参考给定运动和声音。",
  "seconds": "10",
  "size": "1280x720",
  "metadata": {
    "canvas_video": {
      "version": 1,
      "media": [
        {"type": "image", "role": "reference", "url": "data:image/png;base64,BASE64_IMAGE_BYTES"},
        {"type": "image", "role": "first_frame", "url": "https://media.example/signed-first.png"},
        {"type": "image", "role": "last_frame", "url": "https://media.example/signed-last.png"},
        {"type": "video", "role": "reference", "url": "https://media.example/signed-reference.mp4"},
        {"type": "audio", "role": "reference", "url": "https://media.example/signed-reference.mp3"}
      ]
    }
  }
}
```

登录状态下图片按策略选择 URL/Base64，未登录图片路径转换为 Data URL。URL 可能带签名和有效期，需保留完整查询参数，并在上游读取期间有效；不能提交浏览器 blob: 地址。插件按目标模型校验媒体类型、角色、数量和组合，不支持时明确报错，不能静默丢弃素材。

### 4.4 返回、轮询、视频内容

创建返回至少有字符串 id 与已知 status，推荐：

```json
{
  "id": "gateway_video_123",
  "object": "video",
  "model": "video-model-alias",
  "status": "queued",
  "progress": 0
}
```

软件随后请求 `GET /v1/videos/gateway_video_123`，使用 NewAPI Bearer，无请求体，不重发 prompt 或参考图。id 是 NewAPI 可查询的网关任务 ID；供应商 ID 的关联由网关/插件维护。

| 返回字段 | 软件读取要求 |
| --- | --- |
| id | 非空字符串，不能只返回 task_id 或 video_id |
| status | queued、pending、processing、in_progress、completed、failed、cancelled、canceled；后端归一为排队/处理中/完成/失败 |
| progress | 可选进度信息 |
| error.message | 失败原因，建议失败时提供 |
| video_url / url | 可选，未 completed 不作为成功；账号代理仍通过 content 读取成品 |

完成与失败示例：

```json
{"id":"gateway_video_123","status":"completed","progress":100}
```

```json
{"id":"gateway_video_123","status":"failed","error":{"message":"上游不支持该分辨率"}}
```

完成后请求 `GET /v1/videos/gateway_video_123/content`，返回视频字节，通常 video/mp4。只有查询响应中的 video_url、没有可用 content 接口，不能覆盖软件当前账号代理路径。请求可能带 Range、If-Range，需正确返回完整内容或所支持的 206 分段及对应响应头，不将视频字节包装为 JSON。

此调用链未提供向 NewAPI 取消视频生成的请求；停止页面等待不等于调用取消接口。

## 5. 音频：语音合成

`POST /v1/audio/speech`，JSON。

| 字段 | 类型 | 当前发送规则 |
| --- | --- | --- |
| model | string | 始终发送，音频模型 |
| input | string | 始终发送，朗读文本，字段名不是 prompt |
| voice | string | 始终发送，从本地选项归一，未知值回退 alloy |
| response_format | string | 始终发送，mp3 / wav / opus / aac / flac / pcm，未知值回退 mp3 |
| speed | number | 始终发送，保留两位小数后限制到 0.25–4，非有限值回退 1 |
| instructions | string | 配置去除首尾空白后非空才发送 |

voice 选项：alloy、ash、ballad、coral、echo、fable、nova、onyx、sage、shimmer、verse、marin、cedar。这是软件发送的名称，不保证上游有同名音色，插件需映射或明确拒绝。

```json
{
  "model": "speech-model-alias",
  "input": "欢迎来到微鑫画布。",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1,
  "instructions": "自然、清晰地朗读。"
}
```

成功返回非空音频字节及相符 MIME，例如 MP3 为 audio/mpeg。软件拒绝 JSON/text MIME 的成功结果，不能用 URL JSON 或异步 task_id 代替音频。上游只有异步任务时，适配层需完成等待和取回，再满足 speech 字节响应。

当前 NewAPI 分支遇到参考音频在软件侧报错，不发送参考音频文件，也不调用 `/v1/audio/transcriptions`、`/v1/audio/translations`。音乐生成、音色克隆、转写不能仅凭界面有音频入口就写成此接口已支持。

## 6. 插件输入速查

| 上游需要的输入 | 软件发往 NewAPI 的来源 |
| --- | --- |
| 模型 | 各创建请求的 model，随后按 NewAPI 模型映射处理 |
| 文本上下文 | Chat 的 messages；Responses 的 instructions + input |
| Agent 工具 | Chat 的 tools[].function；Responses 的 tools[] 扁平定义 |
| 思考强度 | Chat 的 reasoning_effort；文本 Responses 的 reasoning.effort；按能力发送菜单所选值，自动省略 |
| 图片提示词 | Images 的 prompt；Chat 的 user content；Responses 的 input |
| 图片参考素材 | Images 的 image / image[] 文件；Chat 的 image_url.url；Responses 的 input_image.image_url |
| 图片尺寸、质量 | Images 根 size/quality；Responses 的 tools[0].size/quality；Chat 生图不发送 |
| 视频时长、尺寸 | seconds 字符串、size 像素字符串 |
| 标准视频参考图 | multipart 的 input_reference 文件 |
| 扩展视频素材 | metadata.canvas_video.media，保留 type、role 与次序 |
| 语音文本、音色、速度 | input、voice、speed；可选 instructions |

同一 /chat/completions 或 /responses 可用于文本或生图，需结合 modalities、tools 类型和模型判断，不能只按 URL 分类。素材转换按上游契约处理：文件读取字节，Data URL 保留前缀，签名 URL 保留完整查询串；不是所有路径都先传 OSS 再提交公网链接。

插件需同时处理“请求转换”和“返回转换”。本文定义的是 HTTP 契约，不定义 NewAPI 插件宿主的 JavaScript 函数、文件占位符或上下文变量；这些需对照届时使用的 NewAPI 版本。四种媒体类型不保证共用同一种任务插件生命周期。

`GET /v1/models` 无请求体，软件读取 `{data:[{id:"model-alias"}]}`；名称列表不能替代尺寸、工具调用、音色等能力配置。

## 7. 源码依据与维护

| 内容 | 源码 |
| --- | --- |
| 文本、推理字段、工具转换 | [canvas-agent.ts](../../web/src/services/api/canvas-agent.ts) |
| 图片请求、模式与编辑文件 | [newapi/image.ts](../../web/src/extensions/newapi/image.ts) |
| 图片尺寸换算、问答与返回解析 | [api/image.ts](../../web/src/services/api/image.ts) |
| 视频字段、尺寸、扩展及状态 | [newapi/request.ts](../../web/src/extensions/newapi/request.ts) |
| 视频调用 | [api/video.ts](../../web/src/services/api/video.ts) |
| 后端视频状态与内容 | [video.go](../../extensions/newapi/video.go)、[newapi.go](../../handler/newapi.go) |
| 音频请求及字节响应 | [api/audio.ts](../../web/src/services/api/audio.ts) |
| 音频枚举和默认值 | [audio-generation.ts](../../web/src/lib/audio-generation.ts) |
| 代理鉴权和内部任务解包 | [ai.go](../../handler/ai.go)、[canvas_task.go](../../handler/canvas_task.go) |

请求改动后同步本文，尤其是思考档位、图片参数及视频扩展。待修问题集中在[修复文档](ux-storage-simplification-design.md)，本文不混入供应商特定模型规则。依据为当前代码核查，未对真实 NewAPI 或付费上游完成四类在线联调。
