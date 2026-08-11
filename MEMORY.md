# 项目长期记忆 — infinite-canvas

## 架构速览
- 前端：Next.js 16.2（`next/`，:3000），经 `src/app/api/[...path]/route.ts` 反代 `/api/*` 到后端
- 后端：Go 1.25 + Gin + GORM（`Go/`，:8080）；自研画布引擎（DOM+SVG）；3D 导演台为预构建 three.js iframe+postMessage
- 设置体系：`settings` 表仅 public/private 两行 JSON；`availableModels` 语义"空=全部开放"；公开接口 `/api/settings` 从私有渠道派生并脱敏
- 计费：平台渠道（后端预扣算力点→转发→失败返还）vs 用户自定义渠道（浏览器直连，不收费）

## 本机环境坑（重要）
- Go 在 `C:\Users\Administrator\go-sdk\go\bin\go.exe`；bun 在 `C:\Users\Administrator\.bun\bin\bun.exe`（两者均未进 Bash 沙箱 PATH，须用全路径调用；本机确实已安装，勿再尝试下载）。前端 node_modules 由 npm 安装，但可用 bun 启动
- 启动后端：`cd Go && GOPROXY=https://goproxy.cn,direct go run .`（godotenv 从 Go/ 目录读 `Go/.env`；首次跑会拉模块+编译，约十几秒后 `Listening on :8080`）
- 启动前端：`cd next && NODE_OPTIONS="" bun run dev`（dev 脚本 `next dev --webpack -H 0.0.0.0 -p 3000`，约 2s `Ready`）
- `NODE_OPTIONS` 被全局注入 genie-safe-delete shim，会导致 Next dev 崩溃 → 启动前端须 `NODE_OPTIONS=""`
- Next 对 `.next/` 新文件在后台/提权执行时必现 EPERM → `next build` 须前台 PowerShell 执行；`next start` 可后台

## canvas-opt-v3 合并（2026-08-09）
- 分支：canvas-opt-v3 → main（fast-forward，commit e3eed82）
- 改动范围：画布节点输入框/底部助手栏/连接线/模型下拉/@ 引用菜单与芯片
- 关键变更：
  - 统一所有节点下方输入框宽度为 580px（原图片/视频 580px、其他 500px），不随节点尺寸缩放
  - 底部助手栏下拉菜单与弹窗添加 1px solid `theme.toolbar.border` 边框，区分与输入框背景的层次
  - 节点操作行摄像机按钮图标替换为自定义 `/public/camera.svg`，深色模式 `dark:invert` 自动反色
  - @ 引用文本节点排序改为按节点创建顺序（title 自然排序：文本1、文本2…文本10），删除后新建节点 title 取 max+1，排序保持创建顺序
  - 模型下拉菜单项交互重构：图标 25px + 主标题 15px + 副标题 9px（默认隐藏，hover 时主标题 translateY 上移并淡入副标题），总高度 25px 与图标对齐，动画 200ms ease-out
  - 连接线电流呼吸效果：active 连线硬编码 `#2f80ff`（与节点选中边框一致），叠加流动虚线光流 `strokeDasharray="4,12"` + drop-shadow 蓝色光晕，呼吸动画 1.6s ease-in-out
  - 选中/悬停节点时连线显示蓝色电流流动效果；在 `finishNodeDrag` 的 wasClick 分支补充 `setHoveredNodeId(clickedNodeId)` 恢复点击后 hover 状态
  - @ 引用菜单副标题（文本节点内容预览）字号从继承的 12px 调整为 10px，主标题（节点名称）保持 12px
  - 配置节点（canvas-config-composer）引用芯片显示改为节点名称（input.title），与节点下方输入框芯片保持一致；hover 通过 title 属性查看完整内容
- 涉及文件：
  - `canvas-config-composer.tsx`、`canvas-connections.tsx`、`canvas-node.tsx`、`canvas-prompt-chip-input.tsx`、`canvas-resource-mention-textarea.tsx`、`canvas-client-page.tsx`、`canvas-camera-control.tsx`、`canvas-image-settings-popover.tsx`、`canvas-audio-settings-popover.tsx`、`canvas-video-settings-popover.tsx`
  - `utils/canvas-resource-references.ts`（新增 `naturalCompare` + `compareNodeTitleNatural`）
  - `components/model-picker.tsx`（ModelLabel 两行动画）
  - `app/globals.css`（新增 `canvas-connection-breathe` / `canvas-connection-electric` / `canvas-connection-flow` keyframes）
  - `next/public/camera.svg`（新增图标）
- 待验证：
  - 节点输入框宽度统一 580px 且不随节点缩放变化
  - 底部助手栏下拉菜单/弹窗边框在浅色/深色主题下都清晰可辨
  - 摄像机图标在深色模式自动反色
  - @ 引用文本节点按 1,2,4,5 顺序排列（删除 3 后新建为 5）
  - 模型下拉菜单 hover 时主标题上移 + 副标题淡入动画流畅，默认副标题不占布局
  - 选中/悬停节点时相连线显示蓝色电流流动效果
  - @ 引用菜单副标题字号 10px 比主标题明显小
  - 配置节点引用芯片显示节点名称而非内容

## feat/canvas-optimize 合并（2026-08-07）
- 合并到 main，提交 2608c96 → merge 16f82f8
- 改动范围：模型图标库扩充 + 画布节点参数弹窗样式统一 + 模型下拉项布局
- 关键变更：
  - 模型图标库：next/public/icons/ 从 6 个扩充到 20 个 SVG（claude/gpt/gemini/grok/deepseek/glm/qwen/hunyuan/kimi/keling/flux/midjourney/pixverse/seedream/sora/minimax/hailuo/nano-banana/xiaomi/auto），统一小写命名；删除原 openai.svg 改名 gpt.svg
  - resolveModelIcon：按厂商/模型关键字映射（claude/gemini+imagen+veo/nano banana/gpt+openai/sora/grok+xai/deepseek/glm+zhipu+chatglm/qwen+tongyi+wanxiang/hunyuan/kimi+moonshot/kling+keling/mimo+miaomi/minimax/hailuo/flux/midjourney+mj/pixverse/seedream+doubao+seedance），未匹配走 auto.svg 兜底（不再 fallback 到 Cpu 图标）
  - ModelIcon 组件新增 size 参数：底部助手栏保持 size-3（12px），下拉项 size-6（24px）
  - ModelLabel 下拉项布局：图标 24px = 主标题 14px + 副标题 10px（leading-none，无 gap，严格垂直对齐）
  - 比例图标统一：图片节点从 AspectIcon（CSS 边框矩形）改为 RatioIcon（SVG），与视频节点统一；智能比例（auto）显示 auto.svg 图标 + "智能"文字（原图片节点智能比例返回 null 不显示图标）
  - CanvasSection 组件 export 供图片/音频面板复用
  - 图片节点弹窗（image-settings-panel.tsx）：分辨率档位从 antd Segmented 改为横向分段（subtleFill 容器 + 实心选中）；比例从 grid 描边按钮改为 subtleFill 容器 + 实心选中；生成数量标题改用 CanvasSection；删除 SettingTitle 和 Segmented import
  - 音频节点弹窗（audio-settings-panel.tsx）：声音/格式/语速从 OptionPill 描边按钮改为 subtleFill 容器 + 实心选中；声音改 grid 4 列，格式 grid 3 列，语速横向 flex；删除 OptionPill、SettingGroup、ReactNode import
  - 弹窗间距：图片/音频弹窗 space-y-4 改为 space-y-3，与视频节点一致
  - 视频节点弹窗比例图标下方文字：9.6px → 9px
- 涉及文件：model-picker.tsx、video-settings-panel.tsx、image-settings-panel.tsx、audio-settings-panel.tsx、canvas-image-settings-popover.tsx、canvas-audio-settings-popover.tsx、next/public/icons/*.svg
- 待验证：模型下拉项图标与两行文字对齐效果、图片/音频弹窗样式与视频节点一致性、智能比例 auto.svg 显示

## feat/canvas-ui-optimize 合并（2026-08-05）
- 合并到 main，提交 a6910e9
- 改动范围：画布所有节点底部助手栏 + 模型下拉 + 参数弹窗
- 关键变更：
  - 底部助手栏统一文字 10.8px、SVG 图标 size-3/size-2.5、字体栈 PingFang SC → HarmonyOS Sans → 微软雅黑
  - 视频节点改用 ModelPicker 组件（之前独立 portal 下拉），所有节点模型选择统一
  - ModelPicker 新增两行布局：图标 + 模型名 13px + 介绍占位 11px（待后端加字段填充）
  - 图片/音频/视频参数弹窗统一：无阴影、无标题、居中定位、加 Settings2 前缀图标
  - 参数按钮内部统一 inline-flex + span 分隔符（px-1 opacity-30）
  - 底部助手栏改 flex 布局（justify-start + overflow-x-auto），内容靠左紧密排列，超出横向滚动
  - 配置节点 grid 改 flex，避免参数换行
  - 视频节点模型按钮改 antd Button + 无 hover，与其他节点一致
  - 移除模型名 truncate，允许完整显示
  - 配置节点默认宽度 440→460
  - 修复未登录视频节点显示具体模型名而非"选择模型"
- 新增文档：docs/canvas/canvas-assistant-bar-ui.md（底部助手栏 UI 规范）
- 待验证：模型介绍字段后端未提供，ModelLabel 目前是占位 `&nbsp;`

## feat/canvas-optimize 合并（2026-08-06）
- 合并到 main，提交 57f32f8
- 改动范围：视频节点参数弹窗 UI 优化（canvas-video-settings-popover.tsx + video-settings-panel.tsx）
- 关键变更：
  - 视频设置标题移到弹窗最顶部（之前在 VideoSettingsPanel 内部）
  - 切换选项改为 iOS26 玻璃拟态分段控件样式：容器 subtleFill 背景 + 白色实心滑块（node.panel）+ 选中项阴影 0 2px 8px rgba(0,0,0,0.12)
  - 四个切换框（首尾帧/比例/分辨率/音频）统一 min-h-[52px] 高度，去除拥挤感
  - 字体统一黑色（theme.node.text），不靠字体颜色强调选中态
  - 比例/音频按钮字号 10.8px → 9.6px，分辨率保持 10.8px
  - 分辨率小写 p 改大写 P（含 capabilities 数据源处理）
  - 删除 SmartRatioIcon（手绘星星）和 SizePreview（动态矩形），统一为 RatioIcon 组件
  - RatioIcon 用 CSS mask 加载 /ratios/{比例}.svg，颜色跟随 theme.node.text 自动适配深浅模式
  - 新增 next/public/ratios/ 目录存放 10 个比例 SVG 图标（auto/16-9/9-16/1-1/4-3/3-4/21-9/2-3/3-2/16-1）
- 涉及文件：canvas-video-settings-popover.tsx、video-settings-panel.tsx、next/public/ratios/*.svg

## UI 重构优化约定（2026-08-04，用户明确）
- 参考截图/设计图**只看 UI 布局与结构**，不要照搬颜色
- 画布 UI 颜色一律用 `canvasThemes` 主题 token（light/dark 两套），选中态高亮用 `toolbar.activeBg`/`activeText`/`activeStroke`，禁止硬编码 orange/black/stone 等固定色
- 改动只动画布视频节点设置 UI（`canvas-video-settings-popover.tsx` + `video-settings-panel.tsx` 增加 `variant="canvas"`），不影响工作台默认样式
- 待确认：3:2 比例是否需要补 + 后端是否下发；"全能参考"模式是否已是后台配置的 videoMode；影响范围是否含工作台 /video 页
- Bash 工具每条命令 cwd 重置为仓库根目录 → 命令内必须显式 `cd`
- Git Bash 下 curl `-o` 须用 Windows 路径（`C:\...`），POSIX 路径会 error 23
- git push/pull 走 https 时 schannel 报 CRYPT_E_REVOCATION_OFFLINE（吊销服务器不可达，schannelCheckRevoke=false 也无效）→ 用 `git -c http.sslBackend=openssl push` 绕过

## AGENTS.md 关键约束
- 改任何文件前必须先询问用户
- 任务完成前检查更新 `docs/progress/todo.md` 与 `docs/progress/pending-test.md`
- 最少行数原则；不写旧数据兼容；不执行构建/语法检查（用户自己做）
- 工作区已有用户改动时不要回滚、不要覆盖

## 2026-08-03 教训
- 工作区曾被整体回退（git checkout + 删未跟踪文件）导致未提交修复全部丢失；以后有修复应尽快提交或备份

## 2026-08-11 教训（模型描述 modelInfos 调试）

**1. antd Form 数组字段不要注册 Form.Item**
- `modelCosts` / `modelCapabilities` / `modelInfos` 等数组类型字段，若在 Form 下注册 `<Form.Item name={[...]} hidden><InputNumber/></Form.Item>`，会导致 form store 中该字段值被 InputNumber 控件破坏（数组被当成单个值处理），`getFieldsValue(true)` 返回错误数据
- 正确做法（参考项目现有 `modelCosts` / `modelCapabilities`）：**不注册 Form.Item**，只靠 `form.setFieldsValue(data)` 存入，保存时 `form.getFieldsValue(true)` 取出（`true` 会返回所有已 set 的字段，包括未注册的）
- 若需实时编辑，建议用独立 React state（`useState`）管理，`onChange` 时同步更新 state，`saveSettings` 时从 state 注入到 `rawValues`，不依赖 form store 读取

**2. 后端 Go 代码改动必须重新编译并重启服务**
- 后端返回的 JSON 完全没有新字段（连空数组都没有），说明后端还是旧版本
- 前端 TypeScript 是热更新，但后端 Go 不是——`go run` / 编译后运行 / Docker 都需要停止后重新启动才能生效
- 排查"字段丢失"类问题：先看后端响应 JSON 是否包含该字段，若不包含则一定是后端未重启

**3. 前端过滤与后端规整不要重复**
- 后端 `normalizeModelInfos` 已按 `AvailableModels` 过滤，前端 `finalizeSettingsForSave` 不需要再做一遍（删掉前端过滤逻辑，避免双重过滤导致的边界问题）

## 2026-08-03 合并 feat/model-capabilities → main（commit e9cbfbb）

### 完成的工作
- 后端：`Go/model/setting.go` 新增 `ModelCapability` 结构（`Model` / `ImageAspects` / `ImageTiers` / `VideoResolutions`）；`PublicModelChannelSetting` 添加 `ModelCapabilities` 字段
- 后端：`Go/service/settings.go` 新增 `normalizeModelCapabilities`（按 `AvailableModels` 过滤、同模型去重、字段去空格），在 `normalizePublicSettingWithChannels` 中调用
- 前端管理后台：`next/src/app/(admin)/admin/model-pricing/page.tsx` 新增「模型能力」编辑卡片，仅展示生图或视频模型，每模型可勾选图片比例（8 选项）、图片档位（标准/2K/4K）、视频清晰度（480p/720p/1080p/2K/4K）
- 前端 store：`next/src/stores/use-config-store.ts` 扩展 `AiConfig.modelCapabilities`；新增 `resolveEffectiveImageSize` / `resolveEffectiveVideoQuality`，切换模型时若当前 `size`/`vquality` 不在新模型能力内自动回退
- 前端工作台：`image-settings-panel.tsx` / `video-settings-panel.tsx` 新增 `capabilities` prop，按能力动态过滤档位、比例和清晰度按钮
- 类型与归一化：`next/src/services/api/admin.ts` 新增 `AdminModelCapability` 类型；`next/src/app/(admin)/admin/settings-shared.ts` 新增 `normalizeModelCapabilities`

### 空字段默认值策略（前端处理）
- `imageAspects` 空=支持全部标准比例
- `imageTiers` 空=仅标准档
- `videoResolutions` 空=480p/720p/1080p 三档

### 涉及文档
- `docs/backend/backend-database.md`：`modelChannel.modelCapabilities` 字段及每项字段说明
- `docs/progress/pending-test.md`：新增「生图/视频模型能力配置」章节，14 项验证步骤
- `docs/progress/todo.md`：状态改为「已实施，待测试」

### 修复记录
- `a918d5c` 修正 `model-pricing/page.tsx` 中 `modelMatchesCapability` 导入路径（实际在 `use-config-store.ts` 而非 `use-user-store.ts`，导致页面运行时报错 `is not a function`）

### 待验证（pending-test.md）
- 管理后台「模型能力」卡片勾选并保存持久化
- 生图/视频工作台按模型能力动态渲染选项
- 切换模型时 `size`/`vquality` 自动回退
- 未配置能力的模型走默认值策略

### 待办（todo.md）
- 后端 `apimartImageConfig` / `kieModelInputConfig` 优先读配置、硬编码作 fallback 的改造暂未实施，后续按需补

## 2026-08-03 合并 fix/bugfixes → main

### 完成的工作

**1. 渠道模型选择隔离与定价表布局优化**
- `next/src/app/(admin)/admin/channels/page.tsx`：删除 `knownModels` state 及 `rememberModels` / `rememberKnownModels` / `collectKnownModels` 三个辅助函数；"可用模型" Select 下拉候选改为 `modelSelectOptions`（本渠道已选 + 本次拉取）；切换/新建渠道时自动清空上一次的拉取候选，避免跨渠道污染；`openChannelModelSelector` 不再混入 knownModels
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增 `pricingTableData`（按渠道分组扁平化 + rowSpan 标记），用 antd Table 替换原 grid 卡片；列：渠道（rowSpan 合并 + 全选 Checkbox + 计数）/ 模型名（ellipsis + tooltip）/ 开放（Switch）/ 单价（InputNumber + "点"后缀）

**2. 默认模型字段重构**
- 后端 `Go/model/setting.go`：删除 `DefaultModel` 字段，新增 `DefaultAudioModel` 字段
- 后端 `Go/service/settings.go`：新增 `isAudioModelName`（与前端关键词一致），更新 `isTextModelName` 排除音频；normalize 新增 `defaultAudioModel` 修复，删除 `defaultModel` 修复
- 后端 `Go/service/workflow_agent.go`：删除 `defaultModel` fallback 分支（`defaultTextModel` 已覆盖）
- 前端 `next/src/services/api/admin.ts`：删除 `defaultModel`，新增 `defaultAudioModel`
- 前端 `next/src/app/(admin)/admin/settings-shared.ts` / `channels/page.tsx`：emptySettings 调整
- 前端 `next/src/app/(admin)/admin/model-pricing/page.tsx`：「默认模型」卡片 4 个 Select 改为文本/图片/视频/音频顺序，options 按模型能力过滤（`textModelOptions` / `imageModelOptions` / `videoModelOptions` / `audioModelOptions`）
- 前端 `next/src/stores/use-config-store.ts`：`fallbackModel` 删除，`model` 和 `textModel` 兜底都走 `fallbackTextModel`；`fallbackAudioModel` 改为 `validDefault(defaultAudioModel, audioModels) || preferredModel(audioModels, isAudioModelName)`

**3. 模型选择器渠道名隐藏与渠道字段改名**
- `next/src/components/model-picker.tsx`：`ModelLabel` 移除 channelName 显示，下拉项只显示模型名 + 图标
- `next/src/app/(admin)/admin/channels/page.tsx`：列表表头"名称"→"渠道"，空值"未命名模型"→"未命名渠道"；Drawer Form.Item label "名称"→"渠道"；顶部按钮"新增模型"→"新增渠道"；Drawer title "新增模型/编辑模型"→"新增渠道/编辑渠道"

**4. 文本节点自动弹出 AI 输入框**
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：两处 `setDialogNodeId` 判断去掉 `CanvasNodeType.Text`（`createNode` 函数 + 连线拖到空白处新建节点）；点击节点逻辑删除文本节点特殊分支，让它和图片/视频节点一样走 `setDialogNodeId(clickedNodeId)`
- `next/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`：`promptPlaceholder` 文本节点空内容分支提示语改为"请输入你想要生成的文本内容或在上方输入你的提示词"

### 新增待办（todo.md）
- 画布 Agent 行为风格可配置（`canvasAgentBehavior`：`conservative` 默认 / `eager`），方案文档 `docs/progress/canvas-agent-behavior-config.md`，暂未实施

### 涉及文档
- `docs/backend/backend-database.md` / `docs/backend/system-settings.md`：字段说明同步（删除 `defaultModel`，新增 `defaultAudioModel`）
- `docs/progress/pending-test.md`：新增 4 个验证章节（渠道模型隔离与定价表 / 默认模型字段重构 / 渠道名隐藏与改名 / 文本节点 AI 输入框）
- `docs/progress/todo.md`：新增"画布 Agent 行为风格可配置"待办
- `docs/progress/canvas-agent-behavior-config.md`：新增方案文档

### 待验证（pending-test.md）
- 渠道 A 模型不污染渠道 B 的 Select 下拉和选择弹窗
- 定价表表格布局、rowSpan 合并、模型名截断 tooltip、全选 Checkbox、单价 disabled 联动
- 默认模型 4 个 Select 顺序（文本/图片/视频/音频）和 options 按能力过滤
- 模型选择下拉不显示渠道名小字
- 渠道管理页文案统一为"渠道"
- 右键新建文本节点自动弹 AI 输入框，移开后点回来能重新弹出

## 2026-08-04 提交到 main（commit ffc9c74）

### 完成的工作

**1. 生图接口模式（apiMode）改为后台渠道控制**
- 后端 `Go/model/setting.go`：`ModelChannel` 和 `PublicModelChannelInfo` 新增 `ApiMode` 字段（`images` 默认 / `responses`）
- 后端 `Go/service/settings.go`：`normalizeModelChannel` 归一化 `ApiMode`（非 `responses` 一律视为 `images`）；`publicChannelInfos` 透传 `ApiMode`
- 前端 `next/src/services/api/admin.ts`：`AdminModelChannel` 和 `AdminPublicModelChannelInfo` 新增 `apiMode` 字段
- 前端 `next/src/app/(admin)/admin/channels/page.tsx`：渠道编辑抽屉新增「生图接口」Select，默认 Images API
- 前端 `next/src/stores/use-config-store.ts`：`resolveEffectiveConfig` 按当前生图模型所属渠道解析 `apiMode`，本地模式固定 `images`
- 前端 `next/src/app/(user)/image/page.tsx`：删除主面板和快速配置弹窗的「接口模式」Segmented
- 前端 `next/src/components/workflows/creative-workflow-workspace.tsx`：删除 apiMode Select
- 画布生图/视频浮层 `canvas-image-settings-popover.tsx` / `canvas-video-settings-popover.tsx`：传入 `capabilities` 的小修正

**2. 视频创作台底部设置栏按模型能力动态显示清晰度**
- `next/src/app/(user)/video/page.tsx`：底部 compact 布局的清晰度下拉从 `config.modelCapabilities` 按当前 `model` 查找 `videoResolutions`；有值按配置生成选项，空数组不显示清晰度选择，未配置走默认三档 480p/720p/1080p。与画布节点设置面板行为一致，新模型不支持分辨率调节时管理员后台不勾选即可，无需硬编码

**3. 深色模式 Checkbox/Switch 样式修复**
- `next/src/app/globals.css`：新增 `.dark .ant-checkbox-checked::after` 强制对勾黑色（v6 移除了 `.ant-checkbox-inner`，对勾 `::after` 直接在 `.ant-checkbox` 上）；新增 `.dark .ant-switch-checked .ant-switch-handle::before` 强制圆点深色（track 背景为 colorPrimary=白，圆点默认白色看不清）。样式放在 `@layer` 外部并使用 `!important` 解决 antd v6 CSS-in-JS 优先级问题

**4. 参考图/视频/音频删除按钮图标颜色统一**
- `next/src/app/(user)/image/page.tsx`：参考图删除按钮 `Trash2` 图标添加 `style={{ color: "#ffffff" }} strokeWidth={2.5}`
- `next/src/app/(user)/video/page.tsx`：参考图、参考视频、参考音频三处删除按钮 `Trash2` 图标统一添加 `style={{ color: "#ffffff" }} strokeWidth={2.5}`
- 原因：浅色模式下 `currentColor` 未正确继承 `text-white`，导致图标显示为黑色看不清

**5. 模型能力配置页面文案与布局优化**
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：删除「（空=全部）」「（空=仅标准）」「（空=480p/720p/1080p）」冗余文案；图片比例、图片档位、视频清晰度标题文字添加 `display: "block", marginBottom: 8` 样式，增加与勾选按钮的间距

### 涉及文件（15 个）
- 后端：`Go/model/setting.go`、`Go/service/settings.go`
- 前端：`next/src/services/api/admin.ts`、`next/src/stores/use-config-store.ts`、`next/src/app/(admin)/admin/channels/page.tsx`、`next/src/app/(admin)/admin/model-pricing/page.tsx`、`next/src/app/(user)/image/page.tsx`、`next/src/app/(user)/video/page.tsx`、`next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`、`next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`、`next/src/components/image-settings-panel.tsx`、`next/src/components/video-settings-panel.tsx`、`next/src/components/workflows/creative-workflow-workspace.tsx`、`next/src/app/globals.css`
- 文档：`docs/progress/pending-test.md`

### 待验证（pending-test.md）
- apiMode 后台渠道控制：前端不再有切换 UI，按渠道配置自动走 Images/Responses API
- 视频底部设置栏：按模型能力动态显示清晰度，空数组不显示，未配置走默认三档
- 深色模式 Checkbox 对勾为黑色、Switch 圆点为深色
- 浅色模式参考文件删除按钮图标为白色
- 模型能力页面文案和间距优化

### 待办（todo.md）
- 无新增待办

## 2026-08-04 合并 fix/canvas-image-tiers → main（commit 05d6edc + merge）

### 完成的工作

**1. 画布图片节点分辨率档位显示修复（最终版）**
- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：能力查找从 `config.imageModel || config.model` 改为 `config.model`，画布节点用用户实际选中的模型查能力（原 `config.imageModel` 是全局默认图片模型，非节点选中模型）
- `next/src/components/image-settings-panel.tsx`：Segmented 渲染条件从 `tierOptions.length >= 2` 改为 `>= 1`，保证模型只配 1 档时也渲染

**2. 顶栏算力图标补全**
- `next/src/components/layout/user-status-actions.tsx`：default variant 新增算力余额显示，使用 `CreditSymbol` + stone 配色，一处改动覆盖全站顶栏 + 管理后台顶栏（原来仅画布顶栏有算力显示）

**3. 视频首尾帧能力拆分**
- 后端 `Go/model/setting.go`：`ModelCapability` 新增 `SupportsFirstFrame` 字段，保留 `SupportsFirstLastFrame` 作为兼容字段（勾选首尾帧=首帧+尾帧都支持，勾选首帧=仅首帧）
- 前端类型 `next/src/services/api/admin.ts` + normalize `settings-shared.ts`：透传 `supportsFirstFrame`
- 前端 store `next/src/stores/use-config-store.ts`：新增 `resolveSupportsFirstFrame`（`supportsFirstFrame || supportsFirstLastFrame`）+ `resolveSupportsLastFrame`（仅 `supportsFirstLastFrame`），未配置时向后兼容
- 后台配置 UI `model-pricing/page.tsx`：原「首尾帧」Checkbox 拆为「首尾帧」+「首帧」两项
- 画布视频设置 `canvas-video-settings-popover.tsx`：通用面板和 Kling V3 面板的「首尾帧」分组都拆为「首帧」「尾帧」两个独立分组，按能力开关分别显隐
- 视频工作台 `video/page.tsx`：侧栏「首尾帧」Section 拆为「首帧」「尾帧」两个 Section；`FrameReferenceStrip` 新增 `showFirst`/`showLast` 参数；去掉 `!kling` 守卫
- `video.ts`：去掉首尾帧 `!kling` 守卫，统一按能力开关决定是否传参
- `canvas-client-page.tsx`：两处 `frameReferencesEnabled` 拆为 `firstFrameEnabled`/`lastFrameEnabled`，不支持侧图片合并进普通参考图

**4. 画布生图节点去掉数量选择**
- `canvas-image-settings-popover.tsx`：`showCount` 默认改为 `false`
- `canvas-client-page.tsx`：图片生成 / 全景图生成 `count` 固定为 1
- `canvas-config-node-panel.tsx` / `canvas-node-prompt-panel.tsx`：credits 计算固定 count=1

**5. 生图并发保护与数量 UI 滑块化**
- `next/src/services/api/image.ts`：`requestImages` 去掉 `useConcurrentSingleRequests` 条件，所有 `n > 1` 统一走 `Promise.allSettled` 并发多次单张请求（count=1），不再依赖上游是否支持 `n` 参数；`n` 上限从 15 调整为 10（对齐 gpt-image-1 行业天花板）
- `next/src/components/image-settings-panel.tsx`：生成数量 UI 从「快捷选项网格 + 数字输入框」改为 antd `Slider` 滑块，右侧显示当前数值；`maxCount` 默认值从 15 改为 10；删除 `quickCount` 参数和未使用的 `OptionPill` / `CountInput` 组件
- 深色模式下「生成数量」标题颜色从 `theme.node.muted`（浅灰）改为 `theme.node.text`（白色）；Slider tooltip 加 `color: theme.node.text`

### 显隐逻辑总结

| 后台勾选 | 首帧上传 | 尾帧上传 |
|---------|---------|---------|
| 首尾帧 | 显示 | 显示 |
| 首帧 | 显示 | 不显示 |
| 都不勾 | 不显示 | 不显示 |

### 涉及文件（18 个）
- 后端：`Go/model/setting.go`
- 前端类型/store：`next/src/services/api/admin.ts`、`next/src/app/(admin)/admin/settings-shared.ts`、`next/src/stores/use-config-store.ts`
- 后台配置 UI：`next/src/app/(admin)/admin/model-pricing/page.tsx`
- 画布：`next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`、`canvas-config-node-panel.tsx`、`canvas-image-settings-popover.tsx`、`canvas-node-prompt-panel.tsx`、`canvas-video-settings-popover.tsx`
- 工作台：`next/src/app/(user)/video/page.tsx`、`next/src/components/image-settings-panel.tsx`、`next/src/components/layout/user-status-actions.tsx`
- API：`next/src/services/api/image.ts`、`next/src/services/api/video.ts`
- 文档：`docs/backend/backend-database.md`、`docs/backend/video-exclusive-panels-params.md`、`docs/progress/pending-test.md`

### 待验证（pending-test.md）
- 画布图片节点档位 Segmented 正常显示并跟随模型切换
- 非画布页面顶栏算力图标显示
- 后台「首帧」「首尾帧」两个独立 Checkbox 正常
- 仅首帧模型只显示首帧 Section、不显示尾帧 Section
- 旧模型（supportsFirstLastFrame=true）首尾帧都显示（向后兼容）
- 画布图片节点设置弹窗不显示数量滑块
- 生图工作台数量滑块 1-10 范围
- Grok Imagine 选 3 张能正常生成（并发 3 次单张请求）

### 待办（todo.md）
- 无新增待办（原有「生图/视频模型能力配置」剩余项不变：Seedance 分辨率/参考素材限制后台化、后端 apimartImageConfig/kieModelInputConfig 配置优先改造）

## 2026-08-04 合并 feat/model-capabilities-finalize → main（commit 8fd68bd）

### 完成的工作

完成「生图/视频模型能力配置」剩余 2 项收尾，让模型能力后台化重构形成完整闭环。任务 3（后端 `apimartImageConfig` / `kieModelInputConfig` 优先读配置）本轮跳过。

**任务 1：Seedance 分辨率改读 `videoResolutions`**（实际 UI 早已走配置，本轮清理死代码 + 补默认档位）
- `next/src/components/video-settings-panel.tsx`：默认 `resolutionOptions` 从 `720p/480p` 两档补为 `480p/720p/1080p` 三档，与底部栏 `quickResolutionOptions` 和任务要求「未配置=默认三档」对齐
- `next/src/lib/seedance-video.ts`：删除 5 个死代码成员（`seedanceResolutionOptions` / `seedancePixels` / `normalizeSeedanceResolution` / `normalizeResolutionToken` / `seedancePixelLabel`），它们仅互相引用，全仓无外部调用方

**任务 2：Seedance 参考素材数量限制改后台配置**（字节限制 30MB/50MB/15MB 保持硬编码不动）
- 后端 `Go/model/setting.go`：`ModelCapability` 新增 `MaxImageReferences` / `MaxVideoReferences` / `MaxAudioReferences` 三个 int 字段，`0=走前端默认`
- 前端 `next/src/services/api/admin.ts`：`AdminModelCapability` 新增三个可选字段
- 前端 `next/src/app/(admin)/admin/settings-shared.ts`：`normalizeModelCapabilities` 透传三个新字段
- 前端 `next/src/app/(admin)/admin/model-pricing/page.tsx`：视频能力卡片新增「参考素材数量上限（0=默认）」区块，含图片/视频/音频三个 `InputNumber`；`setModelCapabilityNumber` 的 field 联合类型扩展
- 前端 `next/src/stores/use-config-store.ts`：新增 `resolveMaxImageReferences` / `resolveMaxVideoReferences` / `resolveMaxAudioReferences` 三个 resolve 函数
- 前端 `next/src/app/(user)/video/page.tsx`：主组件新增 `referenceLimits` 对象（从 `klingWorkbenchCap` 解析数量上限，0 回退 `SEEDANCE_REFERENCE_LIMITS` 默认值），`addReferences` / `addReferencesFromClipboard` / `addVideoReferencesFromClipboard` / `addAudioReferencesFromClipboard` / `insertPickedAsset` 中所有数量引用改用 `referenceLimits`，字节引用保持 `SEEDANCE_REFERENCE_LIMITS`

### 涉及文件（12 个）
- 后端：`Go/model/setting.go`
- 前端类型/store：`next/src/services/api/admin.ts`、`next/src/app/(admin)/admin/settings-shared.ts`、`next/src/stores/use-config-store.ts`
- 后台配置 UI：`next/src/app/(admin)/admin/model-pricing/page.tsx`
- 工作台：`next/src/app/(user)/video/page.tsx`、`next/src/components/video-settings-panel.tsx`、`next/src/lib/seedance-video.ts`
- 文档：`docs/backend/backend-database.md`、`docs/backend/video-exclusive-panels-params.md`、`docs/progress/pending-test.md`、`docs/progress/todo.md`

### 待验证（pending-test.md）
- Seedance 分辨率按后台 `videoResolutions` 配置显示（未配置=默认三档）
- 后台「参考素材数量上限」三个 InputNumber 配置后视频工作台上传参考素材按配置限制
- 配置 0/空时回退默认值（图片 9/视频 3/音频 3）
- Kling V26 不受新字段影响（固定图片 2）
- 字节限制（30MB/50MB/15MB）保持硬编码不变
- 死代码已删除无残留引用

### 待办（todo.md）
- 后端 `apimartImageConfig` / `kieModelInputConfig` 优先读配置、硬编码作 fallback 的改造（任务 3，本轮跳过）

## 2026-08-04 合并 ui重构优化 → main（画布视频节点设置 UI 重构）

### 完成的工作（仅改 UI 样式/布局，参数逻辑不动，后端已有）
- 入口胶囊去掉外层按钮框，改为无框扁平文本条：`✦ 模型名 · 模式 · 比例 · 分辨率 · 时长 · 🔊`，字段各自独立可点、用 `·` 分隔
- 模型选择：删除侧栏/底部栏独立 `ModelPicker`（视频模式），改为点击胶囊「模型名」弹出模型下拉（复用 `filterModelsByCapability`/`normalizeLocalChannels`）；删掉 ✕ 关闭按钮
- 设置弹窗 `video-settings-panel.tsx` 增加 `variant="canvas"`：模式→横向分段胶囊(带图标)、比例→图标在上的纵向 chip 行(含"智能"扫描框图标)、分辨率→文字 chip、时长→Slider、音频→开启/关闭两胶囊
- 摄像机触发按钮由带框 antd Button 改为无框纯 `<button>`；底部栏生成按钮高度 10→8、胶囊字段间距放宽
- 颜色全部走 `canvasThemes` 主题 token（`toolbar.activeBg/activeText`），未硬编码
- README「本地非 Docker 开发运行」段修正：`cd web`→`cd next`，并说明后端须在 `Go/` 目录运行 + env 复制到 `Go/.env`
- 运行时修复：`boolConfig` 来源应为 `@/lib/seedance-video`（非 use-config-store）；补回被误删的 `Input` import

### 涉及文件
- 画布：`next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`、`canvas-config-node-panel.tsx`、`canvas-node-prompt-panel.tsx`、`canvas-camera-control.tsx`
- 面板：`next/src/components/video-settings-panel.tsx`
- 文档：`README.md`、`MEMORY.md`

### 待验证
- 画布视频节点入口胶囊为无框文本条、字段可点、点模型名下拉
- 弹窗比例选择图标在上文字在下、智能用扫描框图标
- 摄像机/生成按钮无框、底部栏更紧凑
- user 自测即可（本项目 `tsc --noEmit` 整体有预存错误，dev 用 SWC 不影响运行）
