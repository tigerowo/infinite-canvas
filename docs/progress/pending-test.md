---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

## 选中节点的连线改为流动虚线动效

### 可测试变更

- `canvas-connections.tsx`：active 连线（选中/悬停单个节点时的相连线 + 被选中的连线）从「实心蓝线 3px + 稀疏电流点（2,18）」改为「淡蓝基线（35% 透明度）+ 流动虚线 overlay」：
  - 虚线规格 `strokeDasharray="6,14"`（疏朗不密集）、圆角端点、1.2s 线性流动
  - 复用现有 `canvas-connection-flow` keyframes（dashoffset -20 与 6+14 周期 20 对齐，无缝循环）
  - 光晕降为 6px/40% 透明度，整体更轻
- `canvas-connections.tsx` 的 `ActiveConnectionPath`（从节点拖拽连线出去的预览线）：同步为同款规格——`strokeDasharray` 5,5→6,14、线宽 3→2.5、动画 0.6s→1.2s、光晕与已建成连线一致
- `globals.css`：删除不再使用的 `canvas-connection-electric` keyframes（与 flow 重复）

### 验证步骤

1. 单击选中一个有连线的节点，确认相连线变为流动虚线（疏朗、不密集），淡蓝基线 + 蓝色虚线向目标方向流动
2. 悬停节点时同样触发；多选节点时不触发（与原有行为一致）
3. 单击选中连线本身，同样有流动虚线效果
4. 从节点拖拽连线出去时，预览线与选中态的流动虚线规格一致（6,14 疏朗虚线、同样流速和光晕）
5. 深色/浅色主题下虚线和光晕都清晰可辨

## 图片节点默认智能比例、模型下拉项加大、上传框 60×90

### 可测试变更

- 新增图片节点默认智能比例：`canvas-client-page.tsx` 的 `createNode` 和 `createConnectedNode`（连线拖出新建）创建图片节点时写入 `metadata.size: "auto"`，不再跟随全局默认尺寸
- 模型下拉项加大（`model-picker.tsx` 的 `ModelLabel`）：图标 25px→30px，主标题 15px→16px（leading 18px），副标题 9px→12px（leading 14px），无 gap，选项内容高 34px（两行行盒 18+14=32，底部留 2px）；行高略大于字号避免 g/p/y 等下伸字母被 overflow-hidden 纵向截断；悬停上移动画偏移 8px（(34-18)/2，保持主标题默认垂直居中）；下拉弹层宽度 280→320，避免长模型名被横向截断成省略号
- 上传框比例 50×90 → 60×90（`canvas-node-image-upload.tsx` 的 BOX_WIDTH/BOX_HEIGHT，展开宽度 (n+1)×60）；输入框文字起点 100→80（普通面板 `paddingLeft: 80` + `placeholderIndent: 68`，配置面板 `paddingLeft/left: 80`）

### 验证步骤

1. 新建图片节点（菜单/双击/连线拖出），打开输入框确认参数按钮默认显示「智能比例」
2. 打开任意节点的模型下拉，确认每个选项内容高 34px（图标 30px、主标题 16px、副标题 12px），长模型名（如 gemini-3.1-flash-image-preview）完整显示不截断，含 g/p/y 的模型名（如 agnes、gpt-image）下伸字母不被纵向裁切，悬停时主标题上移 + 副标题淡入动画正常
3. 确认上传框为 60×90，多图展开每张 60px 宽；输入框提示文字和正文从 80px 位置开始，不穿过上传框

## 图片比例 auto 文案与图片信息默认开启

### 可测试变更

- `next/src/components/image-settings-panel.tsx`：`imageSizeLabel("auto")` 返回「智能比例」（原样返回 "auto"），图片节点底部助手栏参数按钮、画布助手配置 chip 等所有 `imageSizeLabel` 消费处统一生效；设置面板选项内部原本就显示「智能」，不变
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：图片信息（showImageInfo）默认改为打开——初始 state `true`，项目恢复时 `project.showImageInfo ?? true`（老项目存过 false 的尊重原设置，未存过的默认开）

### 验证步骤

1. 图片节点底部助手栏参数按钮在比例为 auto 时显示「智能比例」，不再是 "auto"
2. 画布助手输入条的图片比例 chip 同步显示「智能比例」
3. 新建画布项目，不点任何设置，确认图片节点的信息（尺寸/体积等）默认显示
4. 手动关闭图片信息后刷新，确认保持关闭（用户选择被持久化）
5. 老项目（之前关过图片信息的）打开后仍保持关闭

## 节点输入框图片上传组件

在文本/图片/全景图/视频/配置节点的输入框面板左上角新增图片上传交互组件（音频节点除外），上传后在目标节点左侧创建图片节点并自动连线作为参考图。组件同时展示连线进来的上游资源：所有连线的图片和文本节点都在堆叠区展示（@ 引用芯片功能保持不变）。

### 可测试变更

- 新增 `next/src/app/(user)/canvas/components/canvas-node-image-upload.tsx`：
  - 基础尺寸 50×90，整体 `rotate(-6deg)` 歪斜，通过 `left` + `opacity` 过渡（200ms）控制展开折叠
  - 组件定位在输入框面板内部左上角（普通节点面板 left:14/top:10，配置节点面板 left:14/top:50 避开标题栏），不溢出面板；`offset` prop 可调整
  - 空状态：实线边框上传框 + 居中「+」，悬停时 `scale(1.1)` 并填充 `toolbar.activeBg`，移出恢复透明
  - 单张图片：50×90 缩略图（object-cover 不溢出），图片右下角有圆形「+」小按钮；悬停时宽度 50→100，图片保持 left:0，右侧 left:50 淡入同款上传框
  - 多张图片：默认不规则叠加（净角度左右交替 +5/-8/+7/-6…，已补偿整体 -6deg 歪斜避免全部倒向一边）；悬停时每张图依次排开（left = index×50）且保持左右交替倾斜，最右侧上传框从最后一张图的位置滑出并淡入，总宽度 (n+1)×50；移出恢复叠加
  - 展开时整体旋转从 -6deg 平滑过渡到 0deg（每行保持水平，图片再多也不会向右翘起溢出输入框），每张图净朝向不变、过渡连续
  - 展开后单图悬停：该图回正并 scale(1.15) 放大 + 投影 + 置顶（弹性缓动 cubic-bezier(0.34,1.56,0.64,1)），图片右上角显示圆形 X 删除按钮，移走恢复；点 X 直接删除对应图片节点（复用 deleteNodes，连线/存储同步清理）
  - 上传框悬停反馈（空态和展开态一致）：scale(1.1) + 填充 `toolbar.activeBg` + 边框/图标高亮，移出恢复
  - 颜色全部走 `canvasThemes` token，适配浅色/深色主题
- 输入区域固定避让：有上传框时编辑器本体加 `paddingLeft: 100`（`px-3` 被内联样式覆盖），提示文字同步从 100px 位置开始（`canvas-prompt-chip-input.tsx` 新增 `placeholderIndent` prop，普通面板传 88，配置面板直接设 left:100），输入正文和提示文字都不再穿过上传框区域
- 融合连线资源展示（`canvas-client-page.tsx` 的 `stackItemsByNodeId`）：
  - 堆叠数据源改为 `buildNodeMentionReferences` 的全部上游图片 + 文本引用（含经配置节点间接引用、手动连线的图片），不再仅限本组件上传的图片
  - 文本引用显示为 50×90 文本卡片（FileText 图标 + 节点名）；图片卡片底部显示节点名小标签，与提示词中的 @ 标签对应
  - X 删除分两类：本组件上传的图（有 `inputUploadFor` 标记）删除整个图片节点；手动连线的图/文本只移除连线
  - X 移除引用时同步清理提示词中的悬空 @ 标签（`handleRemoveStackItem`）：普通/全景节点按标签文本剥离（正则转义 + `(?!\d)` 防误伤"图片10"，多余空格折叠），配置节点剥离 `@[node:id]` token；不会再出现芯片退化成纯文本标签的悬空引用
  - @ 引用芯片功能完全保留（输入框内芯片、图片预览、@ 菜单均不变），堆叠区是额外的展示入口
- `next/src/app/(user)/canvas/types.ts`：`CanvasNodeMetadata` 新增 `inputUploadFor` 字段，标记由该组件上传的图片节点归属于哪个目标节点
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：
  - 新增 `uploadNodeInputImage`：上传图片 → 在目标节点左侧 80px 处创建图片节点（打标 `inputUploadFor`）→ 自动连线到目标节点（不抢选中、不关输入框面板）
  - 新增 `stackItemsByNodeId`：按上游引用收集每个节点的堆叠图片/文本
- `canvas-node-prompt-panel.tsx` / `canvas-config-composer.tsx`：面板根节点改 `relative`，左上角挂载组件（音频模式不显示）

### 验证步骤

1. 分别创建文本/图片/全景图/视频/配置节点，点击节点弹出输入框，确认左上角有歪斜（-6deg）的 50×90 上传框且不溢出输入框面板，音频节点没有
2. 空状态悬停：上传框放大 1.1 并填充主题色，移出恢复透明；输入框提示文字和输入正文都从 100px 位置开始，不穿过上传框区域
3. 点击上传框选择图片：上传成功后在节点左侧出现图片节点并自动连线，组件切换为单图状态（缩略图 + 右下角圆形「+」）
4. 单图状态悬停：组件展开为 100px，右侧上传框从图片位置滑出；悬停右侧上传框有放大+填充反馈；点击圆形「+」或右侧上传框可继续上传
5. 上传 2 张以上：默认叠加态左右交替歪斜（一张向右、一张向左），悬停展开为 (n+1)×50px 平铺且每张仍保持左右交替倾斜，整行保持水平（不向右翘起、不溢出输入框），最右侧上传框滑出淡入，移出恢复叠加
6. 展开后逐个悬停图片：当前图片回正放大（scale 1.15）+ 投影 + 置顶，右上角显示 X 删除按钮；点 X 后对应图片节点和连线从画布删除，组件中该图片消失；移走鼠标恢复倾斜平铺
7. 用挂载着上传图片的节点执行生成，确认上传的图片作为参考图参与生成（连线即引用）
8. 手动把一个图片节点连线到目标节点（不通过上传框），确认连线图片也出现在堆叠区；悬停点 X 只移除连线、图片节点保留在画布上
9. 连线一个文本节点，确认堆叠区出现文本卡片（FileText 图标 + 节点名）；点 X 移除连线后卡片消失
10. 在输入框输入 @ 选择引用，确认编辑器中插入芯片保持不变（图片芯片可点击预览），堆叠区同步展示该引用
11. 删除某个上传的图片节点或连线，确认组件中对应图片消失
12. 连线图片后在输入框 @ 引用它，再在堆叠区点 X 移除，确认提示词中的"图片1"标签同步被清掉，不会留下悬空纯文本；提示词中若有"图片10"等更长标签不受影响
13. 切换浅色/深色主题，确认边框、图标、悬停填充色适配

## 视频节点底部输入条按钮分区调整

按用户要求，将视频节点底部提示词面板（`canvas-node-prompt-panel.tsx` video 模式）的底部行调整为 5 个按钮分区：提示词库、模型选择、参数选择、摄像机、提交按钮。仅调整 `CanvasVideoSettingsPopover` 的触发区结构，不改 props 与数据流。

### 可测试变更

- `next/src/components/model-picker.tsx`：导出 `resolveModelIcon` 函数，供视频设置 popover 复用模型自带图标
- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：
  - 触发区由「Sparkles 图标 + 所有 segments 用 `·` 分隔平铺」改为两个独立按钮
  - **模型按钮**：带模型自带图标（`resolveModelIcon`，如 glm/gpt/claude 等）+ 模型名，图标与模型名一体，点击弹模型下拉；无模型自带图标时回退到原 `buttonIcon` 或 `Sparkles`
  - **参数按钮**：把非模型 segments（模式 · 比例 · 分辨率 · 时长 · 音频）合并成一个整体按钮，文字用 `·` 拼接，无外框（无边框无背景，仅 `theme.node.muted` 文字色），点击弹出原视频设置面板
  - 移除不再使用的 `Fragment` import
- `CanvasPromptLibrary`（提示词库）、`CanvasCameraControl`（摄像机）、提交按钮：本次未改动

### 验证步骤

1. 进入画布，创建视频节点，确认底部输入条从左到右：提示词库图标、模型按钮（带模型图标+模型名）、参数按钮（模式 · 比例 · 分辨率 · 时长...）、摄像机、提交按钮
2. 确认模型按钮的图标随模型变化（如选 GLM 显示 glm.svg，选无图标模型回退 Sparkles）
3. 点击模型按钮，确认弹出模型下拉，选择后模型名和图标更新
4. 点击参数按钮，确认弹出视频设置面板（模式/比例/分辨率/时长等），修改后参数按钮文字更新
5. 确认参数按钮无外框（无边框无背景），仅文字
6. 确认摄像机、提交按钮功能不受影响
7. 切换浅色/深色主题，确认模型按钮、参数按钮颜色适配

## 画布底部助手输入条 UI 优化（可灵风格）

参考可灵 Canvas 底部输入条样式，重做画布助手输入条为单行紧凑布局 + 可灵风格设置弹窗，仅改样式与布局，不修改 props 接口和数据流。

### 可测试变更

- 助手输入框高度从 `h-20` 缩减为 `h-16`
- 底部操作行改为可灵风格单行紧凑布局（`min-h-8`，`gap-1.5`）：
  - 左侧：`+` 添加素材按钮（图标化，去掉原 antd `Button` 圆形样式）+ 三个配置 chip
  - 三个配置 chip：图片比例（`imageSizeLabel`）/ 视频比例（`videoSizeRatioLabel`）/ 视频清晰度（`videoResolutionLabel`），点击对应 chip 弹出设置弹窗
  - 右侧：发送按钮改为可灵风格胶囊形（`rounded-full` + `px-3 py-1.5`），闪电图标 + 上箭头，主题反色（`background: theme.node.text`，`color: theme.toolbar.panel`）
- 新增 `ComposerOptionChip` + `ComposerOptionPopover` 两个内部组件实现可灵风格弹窗：
  - 弹窗浮在 chip 上方（`fixed` 定位，`createPortal` 到 body）
  - 灰底 list 容器（`theme.node.fill`，圆角）+ 选项横向排列
  - 选中项高亮：`theme.toolbar.activeText` + `theme.toolbar.panel` 背景
  - 点击外部自动关闭，滚动/resize 自动同步位置
- 所有颜色使用 `canvasThemes` token，不硬编码，适配浅色/深色主题
- 配置 chip 选项常量内联在文件中（图片比例 9 项 / 视频比例 5 项 / 视频清晰度 3 项），选中后通过现有 `onAgentConfigChange` 写入 `agentConfig`
- 移除未使用的 `useEffectiveConfig` / `useMemo` / `CanvasImageSettingsPopover` / `CanvasVideoSettingsPopover` / `Button` / `Upload` / `FolderOpen` / `Menu` 等 import 和死代码 `imageConfig` / `videoConfig`
- `CanvasAssistantComposerProps` 接口完全不变，`agentConfig` 数据结构不变，调用方无需改动

### 涉及文件

- `next/src/app/(user)/canvas/components/canvas-assistant-composer.tsx`：重写主组件 + 新增 `ComposerOptionChip` / `ComposerOptionPopover` 内部组件

### 验证步骤

1. 进入画布，展开右侧助手面板，确认底部输入条为可灵风格单行紧凑布局
2. 确认输入框高度比之前略小（`h-16`），placeholder 正常显示
3. 确认底部行从左到右：`+` 添加素材按钮、图片比例 chip、视频比例 chip、视频清晰度 chip、占位、发送按钮（胶囊形 + 闪电 + 上箭头）
4. 点击 `+` 按钮，确认弹出"上传文件 / 我的素材"菜单，功能正常
5. 点击图片比例 chip，确认上方弹出可灵风格弹窗（灰底 list + 横向选项），当前选中项高亮
6. 选择不同比例，确认弹窗关闭，chip 文字更新为所选比例
7. 点击视频比例 chip / 视频清晰度 chip，确认弹窗正常弹出和选择
8. 点击弹窗外部，确认弹窗自动关闭
9. 拖动画布或滚动，确认已打开的弹窗位置自动跟随 chip
10. 输入框为空时发送按钮 disabled（半透明），输入文字后可点击发送
11. 运行中发送按钮变为停止按钮（方块图标）
12. 切换浅色/深色主题，确认输入条、chip、弹窗、发送按钮颜色全部适配主题（无硬编码黑白）
13. 确认引用素材 chip（`AssistantReferenceChip`）仍正常显示和删除

## 文本节点自动弹出 AI 输入框

让右键新建文本节点与图片/视频节点行为一致，自动弹出下方 AI 输入框；输入框 placeholder 根据节点内是否有内容动态变化，空内容时提示用户可生成或在上方直接编辑。

### 可测试变更

- `createNode` 和连线拖到空白处新建节点的 `setDialogNodeId` 判断去掉 `CanvasNodeType.Text`，新建文本节点后自动弹出下方 `CanvasNodePromptPanel`
- `CanvasNodePromptPanel` 的 `promptPlaceholder` 在文本节点 + 节点内无内容时，提示语改为"请输入你想要生成的文本内容或在上方输入你的提示词"；有内容时保持"请输入你想要将本段文本修改成什么"

### 涉及文件

- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：两处 `setDialogNodeId` 判断去掉 `CanvasNodeType.Text`
- `next/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`：`promptPlaceholder` 文本节点空内容分支提示语调整

### 验证步骤

1. 进入画布，右键空白处选择"文本生成"，确认新建文本节点后自动弹出下方 AI 输入框（与图片/视频节点行为一致）
2. 确认节点内无文字时，输入框 placeholder 显示"请输入你想要生成的文本内容或在上方输入你的提示词"
3. 在节点内输入任意文字后，确认 placeholder 切换为"请输入你想要将本段文本修改成什么"
4. 从已有节点拖出连线到空白处，选择新建文本节点，确认同样自动弹出 AI 输入框
5. 点击空白处取消选中后，再次单击该文本节点，确认 AI 输入框重新弹出（与图片/视频节点行为一致）
6. 双击文本节点，确认仍可进入节点内直接编辑文字（原有功能不受影响）
7. 右键新建图片/视频/音频节点，确认行为不受影响（图片/视频仍自动弹面板，音频仍不弹）

## 模型选择器渠道名隐藏与渠道字段改名

隐藏 ModelPicker 下拉项右侧的渠道名标签（普通用户不需看到管理员侧的来源命名），并把模型管理页的"名称"字段统一改为"渠道"，与"模型开放与定价"页的渠道列命名保持一致。

### 可测试变更

- `ModelPicker` 下拉项不再显示右侧渠道名小字，只显示模型名 + 模型图标
- `admin/channels` 列表表头"名称"改为"渠道"，空值显示"未命名渠道"
- `admin/channels` 渠道编辑 Drawer："名称" Form.Item label 改为"渠道"，校验提示"请输入渠道名"
- `admin/channels` 顶部按钮"新增模型"改为"新增渠道"，Drawer title "新增模型/编辑模型"改为"新增渠道/编辑渠道"

### 涉及文件

- `next/src/components/model-picker.tsx`：`ModelLabel` 移除 channelName 显示
- `next/src/app/(admin)/admin/channels/page.tsx`：列表表头、Form.Item label、按钮、Drawer title 文案统一为"渠道"

### 验证步骤

1. 进入画布或生图/视频/音频工作台，打开模型选择下拉，确认下拉项只显示模型名 + 图标，不再显示右侧的渠道名小字
2. 进入 `/admin/channels`，确认列表表头为"渠道"，空名称行显示"未命名渠道"
3. 点"新增渠道"，确认 Drawer 标题为"新增渠道"，第一个字段 label 为"渠道"，留空时提示"请输入渠道名"
4. 编辑现有渠道，确认 Drawer 标题为"编辑渠道"
5. 进入 `/admin/model-pricing`，确认"模型开放与定价"表格的"渠道"列与 channels 页命名一致

## 默认模型字段重构

合并 `defaultModel` 到 `defaultTextModel`（市面 AI 厂商共识：默认模型即默认文本模型），并新增缺失的 `defaultAudioModel` 配置项，使管理员后台与普通用户配置弹窗（已有 4 个默认模型）保持一致。

### 可测试变更

- 后端 `PublicModelChannelSetting`：删除 `DefaultModel` 字段，新增 `DefaultAudioModel` 字段
- 后端 `normalizePublicSetting`：删除 `defaultModel` 修复逻辑，新增 `defaultAudioModel` 修复逻辑
- 后端 `isAudioModelName`：新增函数，与前端 `isAudioModelName` 关键词一致（audio/tts/speech/voice/music/sound/elevenlabs/suno/lyrics/vocal/midi/wav）
- 后端 `isTextModelName`：更新为排除图片/视频/音频模型
- 后端 `workflow_agent.go`：选模型兜底逻辑删除 `defaultModel` 分支（`defaultTextModel` 已覆盖）
- 前端 `AdminPublicModelChannelSettings` 类型：删除 `defaultModel`，新增 `defaultAudioModel`
- 前端 `emptySettings`（settings-shared.ts、channels/page.tsx）：删除 `defaultModel`，新增 `defaultAudioModel: ""`
- 前端 `model-pricing` 页面"默认模型"卡片：4 个 Select 改为「默认图片/视频/文本/音频模型」
- 前端 `resolveEffectiveConfig`：`fallbackModel` 删除，`model` 兜底改用 `fallbackTextModel`；`fallbackAudioModel` 改为 `validDefault(defaultAudioModel, audioModels) || preferredModel(audioModels, isAudioModelName)`

### 涉及文件

- `Go/model/setting.go`：删除 `DefaultModel`，新增 `DefaultAudioModel`
- `Go/service/settings.go`：新增 `isAudioModelName`，更新 `isTextModelName`，调整 normalize 逻辑
- `Go/service/workflow_agent.go`：删除 `defaultModel` fallback 分支
- `next/src/services/api/admin.ts`：类型字段调整
- `next/src/app/(admin)/admin/settings-shared.ts`、`next/src/app/(admin)/admin/channels/page.tsx`：emptySettings 调整
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：默认模型卡片改 4 个 Select
- `next/src/stores/use-config-store.ts`：`resolveEffectiveConfig` 兜底逻辑调整
- `docs/backend/backend-database.md`、`docs/backend/system-settings.md`：字段说明同步

### 验证步骤

1. 进入 `/admin/model-pricing`，确认"默认模型"卡片显示 4 个 Select：默认图片/视频/文本/音频模型（不再有"默认模型"）
2. 在"默认音频模型"Select 中选择一个音频模型（如 `gpt-4o-mini-tts`），点"保存设置"，刷新确认持久化
3. 进入画布，打开配置弹窗，确认音频节点的默认模型使用了管理员设置的"默认音频模型"
4. 进入画布，确认文本节点和工作流 agent 的默认模型使用了"默认文本模型"（原 `defaultModel` 的兜底语义已合并）
5. 调用工作流 agent 草稿接口，确认文本模型选择走 `defaultTextModel` 兜底（后端 `workflow_agent.go` 已删除 `defaultModel` 分支）
6. 数据库中旧的 `defaultModel` 值不再被读取，确认无报错

## 渠道模型选择隔离与定价表布局优化

修复新建渠道时"可用模型"下拉和"选择模型"弹窗混入其他已保存渠道模型的问题，并将"开放与定价"页面从卡片网格改为表格布局。

### 可测试变更

- `admin/channels` 渠道编辑 Drawer：
  - "可用模型" Select 下拉候选只显示本渠道已选模型 + 本次拉取的模型，不再混入 `knownModels`（其他渠道/availableModels/modelCosts 的模型）
  - 切换/新建渠道时自动清空上一次的拉取候选，避免跨渠道污染
  - "选择模型"弹窗未拉取时只显示"已有的模型" Tab（本渠道已选），拉取后显示"新获取的模型" Tab
- `admin/model-pricing` "模型开放与定价"卡片：
  - 由按渠道分组的网格布局改为单个 Table
  - 列：渠道（rowSpan 合并，含全选 Checkbox + 已开放计数）/ 模型名（ellipsis 截断，悬浮 tooltip 显示完整名）/ 开放（Switch）/ 单价（InputNumber + "点"后缀）
  - 模型名超长不再换行，表格紧凑对齐

### 涉及文件

- `next/src/app/(admin)/admin/channels/page.tsx`：删除 `knownModels` state 及 `rememberModels` / `rememberKnownModels` / `collectKnownModels`；Select options 改为 `modelSelectOptions`（本渠道已选 + 本次拉取）；`openChannelModelSelector` 不再混入 knownModels
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增 `pricingTableData`（按渠道分组扁平化 + rowSpan 标记），用 antd Table 替换原 grid 卡片

### 验证步骤

1. 进入 `/admin/channels`，新增渠道 A，填写接口地址和 API Key 后点"拉取模型列表"，确认弹窗"新获取的模型"只显示本次拉取的模型
2. 在 A 中选择部分模型并保存
3. 再点"新增模型"打开渠道 B，点"可用模型" Select 下拉，确认**不显示** A 的模型（应为空）
4. 在 B 点"选择模型"按钮，确认弹窗"已有的模型"为空、"新获取的模型"为空（未拉取时）
5. 在 B 点"拉取模型列表"，确认只显示 B 本次拉取的模型，不含 A 的模型
6. 编辑 A（点"编辑"），确认 Select 下拉只显示 A 已选的模型 + 本次拉取的，不含 B 的
7. 进入 `/admin/model-pricing`，确认"模型开放与定价"显示为表格：渠道列合并、模型名单行截断、开放 Switch、单价输入框
8. 鼠标悬浮截断的模型名，确认 tooltip 显示完整名称
9. 点渠道列的全选 Checkbox，确认该渠道下所有模型开放状态同步切换
10. 切换某模型开放开关为关闭，确认单价输入框变为 disabled
11. 修改单价后点"保存设置"，刷新确认持久化

## 提示词分类管理后台化

把原硬编码的 `promptCategories` 迁移到数据库 `prompt_categories` 表，支持管理后台可视化增删改查。详细方案见 [prompt-category-refactor.md](./prompt-category-refactor.md)。

### 可测试变更

- 后端首次启动时自动创建 `prompt_categories` 表并写入 8 条种子数据（1 个 system 本地分类 + 7 个 GitHub 远程同步源）
- 新增管理后台页面 `/admin/prompt-categories`，支持：
  - 查看全部分类列表（分类 ID、显示名称、类型、GitHub 地址、启用状态、排序、最后同步时间）
  - 新增分类（填写分类 ID、名称、描述、GitHub 地址、远程/本地、启用、排序）
  - 编辑分类（分类 ID 不可改，仅可改名称、描述、启用、排序）
  - 删除分类（二次确认，提示词数据保留不级联删除）
  - 启用/禁用分类（Switch 直接切换）
  - 同步单个远程分类、同步所有启用的远程分类
- 管理后台侧边栏新增「提示词分类」入口（位于「AI 日志」和「提示词管理」之间）
- 定时同步任务改为从数据库读取启用的远程分类，同步完成后更新 `last_synced_at`
- 原 `/admin/prompts` 页面不受影响（接口契约不变）

### 涉及文件

后端：
- `Go/model/prompt.go`：`PromptCategory` 新增 `enabled`、`sort_order`、`last_synced_at`、`created_at` 字段
- `Go/repository/db.go`：注册 AutoMigrate + `seedPromptCategoriesIfEmpty` 种子迁移
- `Go/repository/prompt.go`：分类查询改为读数据库，新增 `SavePromptCategory`、`DeletePromptCategory`、`ListEnabledRemotePromptCategories`、`UpdatePromptCategorySyncedAt`
- `Go/service/prompts.go`：新增 `CreatePromptCategory`、`UpdatePromptCategory`、`DeletePromptCategory`
- `Go/service/prompt_sync_scheduler.go`：定时同步改为读 `ListEnabledRemotePromptCategories`
- `Go/service/prompt_fetch.go`：`SyncPromptCategory` 改用 `PromptCategoryByCode`，同步后更新 `last_synced_at`
- `Go/handler/admin.go`：新增 `AdminCreatePromptCategory`、`AdminUpdatePromptCategory`、`AdminDeletePromptCategory`
- `Go/router/router.go`：注册 `POST/PUT/DELETE /api/admin/prompt-categories` 路由

前端：
- `next/src/services/api/request.ts`：补充 `apiPut`
- `next/src/services/api/admin-prompt-categories.ts`：新增，封装分类 CRUD API
- `next/src/services/api/admin.ts`：移除已迁移到新文件的类型和函数
- `next/src/app/(admin)/admin/prompt-categories/page.tsx`：新增管理页面
- `next/src/app/(admin)/admin/prompt-categories/use-admin-prompt-categories.ts`：新增页面 hook
- `next/src/app/(admin)/admin/layout.tsx`：侧边栏新增入口
- `next/src/app/(admin)/admin/prompts/use-admin-prompts.ts`：改从新文件导入分类 API

### 验证步骤

1. 启动后端，确认 `prompt_categories` 表自动创建且 8 条种子数据写入
2. 启动前端，访问 `/admin/prompt-categories`，确认默认展示 8 个分类
3. 测试新增分类（远程和本地各一个）
4. 测试编辑分类（修改名称、描述、排序、启用状态）
5. 测试删除分类（确认提示词数据保留）
6. 测试启用/禁用 Switch 切换
7. 测试「同步」单个远程分类和「同步所有」按钮
8. 确认原 `/admin/prompts` 页面分类筛选和同步功能不受影响

## 删除 Linux.do 登录功能

移除项目中的 Linux.do OAuth 登录能力，仅保留账号密码登录与注册。

### 可测试变更

- 用户登录页 `/login` 移除「使用 Linux.do 登录」按钮，副标题文案改为「使用账号密码登录或注册。」
- 管理后台设置页 `/admin/settings` 移除「Linux.do 登录」配置卡片（含开启开关、Client ID、Client Secret）
- 管理后台用户列表 `/admin/users` 移除「Linux.do」列
- 后端移除 `/api/auth/linux-do/authorize`、`/api/auth/linux-do/callback` 路由及对应处理器与 service 函数
- 后端 `model.User` 移除 `LinuxDoID` 字段，`config` 移除 Linux.do URL 配置项，`repository` 移除 `GetUserByLinuxDoID`
- 系统配置模型 `PrivateAuthSetting` 清空，`PublicAuthSetting` 仅保留 `AllowRegister`
- 删除静态资源 `next/public/icons/linuxdo.svg`
- README 移除 Linux.do 社区推广链接

### 涉及文件

后端：
- `Go/config/config.go`：删除 3 个 LinuxDo URL 配置项
- `Go/model/user.go`：删除 `LinuxDoID` 字段
- `Go/model/setting.go`：`PublicAuthSetting` 删除 `LinuxDo` 字段，删除 `PublicLinuxDoAuthSetting`、`PrivateLinuxDoAuthSetting`，清空 `PrivateAuthSetting`
- `Go/repository/user.go`：删除 `GetUserByLinuxDoID`
- `Go/service/auth.go`：删除 `LinuxDoAuthorizeURL`、`LoginWithLinuxDo` 等函数及相关结构体
- `Go/service/settings.go`：删除 `keepPrivateAuthSecrets` 及 `hidePrivateAPIKeys` 中 LinuxDo 处理
- `Go/handler/auth.go`：删除 `LinuxDoAuthorize`、`LinuxDoCallback`
- `Go/router/router.go`：删除 Linux.do 登录路由

前端：
- `next/src/app/(user)/login/page.tsx`：移除 Linux.do 登录按钮、`linuxDoEnabled` 状态、副标题文案
- `next/src/app/(admin)/admin/users/page.tsx`：移除用户表格「Linux.do」列
- `next/src/app/(admin)/admin/settings/page.tsx`：移除 LinuxDo 默认配置、配置卡片、normalize 函数中 linuxDo 处理
- `next/src/services/api/admin.ts`：移除 `AdminUser.linuxDoId`、`AdminPublicSettings.auth.linuxDo`、`AdminPrivateSettings.auth`
- `next/public/icons/linuxdo.svg`：删除

### 验证步骤

1. 启动后端，确认编译通过，无 LinuxDo 相关报错
2. 访问 `/login`，确认只显示账号密码登录/注册，无 Linux.do 登录按钮
3. 访问 `/admin/settings` 可视化编辑页，确认不再显示「Linux.do 登录」配置卡片
4. 访问 `/admin/users`，确认用户表格不再显示「Linux.do」列
5. 保存系统配置，确认不报错

## 首页 Banner 资源本地化

将首页 banner 从 jsdelivr CDN 远程加载改为本地 `next/public/banners/` 资源。

### 可测试变更

- `HOME_BANNERS` 配置中 3 个 banner 的 `imageUrl` 和 `videoUrl` 从 `https://gcore.jsdelivr.net/gh/tigerowo/infinite-canvas@v0.5.0/...` 改为本地路径 `/banners/xxx.webp`、`/banners/agent.webm`
- 本地资源（agent.webp、agent.webm、panorama.webp、3ddirector.webp）已存在于 `next/public/banners/`，与远程文件一一对应

### 涉及文件

- `next/src/app/(user)/page.tsx`：`HOME_BANNERS` 数组改用本地路径

### 验证步骤

1. 启动前端，访问首页 `/`
2. 确认 3 个 banner 正常显示（agent 动态封面 + panorama 静图 + 3ddirector 静图）
3. 点击激活的 agent banner，确认弹窗中 webm 视频可正常播放
4. 打开浏览器网络面板，确认 banner 资源从本地 `/banners/...` 加载，不再请求 `gcore.jsdelivr.net`

## 工作流模块独立化

把生图工作台内嵌的「创作工作流」抽离为导航下拉模块，与生图工作台彻底解耦。原「创作工作流」改名为「生图工作流」。详细方案见 [workflow-module-refactor.md](./workflow-module-refactor.md)。

### 可测试变更

- 顶部导航在「视频创作台」之后新增「工作流」项；当前只有一个子项「生图工作流」，导航项本身渲染为可点击 Link，直接跳转 `/workflows`
- 后续若新增子项（如提示词生成、AI 换装），`children.length ≥ 2` 后会自动切换为 antd Dropdown 下拉菜单（hover 触发）
- 移动端导航抽屉同步适配：单子项时为单行 Link；多子项时平铺渲染，子项缩进一级
- 生图工作台 `/image` 移除右下角悬浮「工作流」按钮、右侧抽屉、3 个工作流回调（`handleWorkflowTaskStarted/Success/Failure`）、按钮拖拽逻辑、`WORKFLOW_BUTTON_POSITION_KEY` 持久化
- 生图工作台后端任务轮询 `listCanvasImageTasks` 的标签数组从 `["image-workbench", "workflow"]` 改为 `["image-workbench"]`，不再拉取工作流任务
- 生图工作台与工作流彻底解耦：工作流产出不再写入生图历史，只在 `/workflows` 页面内查看
- 工作流组件 `CreativeWorkflowWorkspace` 移除 `embedded` 和 `hideTaskList` 参数及所有相关分支，统一为独立页样式
- 原「创作工作流」改名「生图工作流」（页面标题与副标题）
- 历史日志中的工作流字段（`workflowId` / `workflowName` / `workflowInputs` / `workflowTaskId`）及「工作流 xxx」青色 Tag 展示**保留不动**，避免破坏历史数据

### 涉及文件

前端：
- `next/src/constant/navigation-tools.ts`：改造为 `NavLink | NavDropdown` 联合类型，新增 workflows 下拉分组；导出 `navigationSlugs` 用于 active 判断
- `next/src/components/layout/app-top-nav.tsx`：渲染逻辑适配（link / 单子项直跳 / 多子项 Dropdown）；`activeToolSlug` 改用 `navigationSlugs`
- `next/src/components/layout/mobile-nav-drawer.tsx`：移动端渲染适配（link / 单子项直跳 / 多子项平铺缩进）
- `next/src/app/(user)/image/page.tsx`：移除悬浮按钮、抽屉、3 个回调、拖拽逻辑、相关 ref/state/常量；后端任务轮询去掉 "workflow" 标签；移除未使用的 `WandSparkles`、`Drawer`、`ReactPointerEvent`、`CreativeWorkflowWorkspace`、`WorkflowExternalTask*` 导入
- `next/src/components/workflows/creative-workflow-workspace.tsx`：移除 `embedded` / `hideTaskList` 参数及所有相关分支；副标题统一为「把固定提示词和参数沉淀成模板，每次只填写变量即可批量复用。」；「创作工作流」改名「生图工作流」

### 验证步骤

1. 启动前端，确认顶部导航在「视频创作台」后出现「工作流」项，点击直接跳转 `/workflows`（无下拉菜单）
2. 确认 `/workflows` 页面标题为「生图工作流」，副标题为「把固定提示词和参数沉淀成模板，每次只填写变量即可批量复用。」
3. 在 `/workflows` 页面测试创建、运行、查看结果等核心功能
4. 访问 `/image` 生图工作台，确认悬浮按钮和抽屉已消失
5. 在生图工作台执行单次生图，确认功能正常，结果区正常显示
6. 查看生图历史，确认历史中已有的工作流产出仍能正常显示「工作流 xxx」青色标签
7. 切换到移动端视图，打开导航抽屉，确认「工作流」项显示为单行 Link，可点击跳转
8. 临时在 `navigation-tools.ts` 的 `workflows.children` 数组追加一个测试子项，确认导航自动切换为 Dropdown 下拉菜单（hover 弹出子菜单），验证完成后删除测试子项

## 未登录用户配置入口开关

新增 `allowGuestConfig` 公开配置字段，用于控制未登录用户是否能看到顶栏配置按钮及触发配置弹窗，便于引流期到变现期的切换。

### 可测试变更

- 后端 `PublicModelChannelSetting` 新增 `AllowGuestConfig *bool` 字段，`service/settings.go` 在字段为 nil 时默认置为 true（兼容旧配置）
- 前端 `AdminPublicModelChannelSettings` 类型同步新增 `allowGuestConfig: boolean`
- 管理后台 `/admin/settings` 公开配置卡片新增「是否允许未登录用户使用配置功能」开关，默认开启；关闭后未登录用户看不到顶栏配置入口，也无法通过模型选择器等入口触发配置弹窗
- 顶栏 `UserStatusActions` 在未登录用户且 `allowGuestConfig === false` 时隐藏配置按钮；已登录用户不受影响
- `AppConfigModal` 新增拦截 useEffect：未登录用户且开关关闭时，无论从哪个入口（模型选择器、画布、视频/生图工作台等）触发 `openConfigDialog`，都会立即关闭弹窗并提示「请登录后使用配置功能」

### 涉及文件

后端：
- `Go/model/setting.go`：`PublicModelChannelSetting` 新增 `AllowGuestConfig` 字段
- `Go/service/settings.go`：新增 `AllowGuestConfig` 默认值处理（nil 时设为 true）

前端：
- `next/src/services/api/admin.ts`：`AdminPublicModelChannelSettings` 新增 `allowGuestConfig` 字段
- `next/src/app/(admin)/admin/settings/page.tsx`：`emptySettings` 默认值、开关 Form.Item、`normalizePublicSetting` 中 `allowGuestConfig` 处理
- `next/src/components/layout/user-status-actions.tsx`：根据 `allowGuestConfig` 和登录状态控制顶栏配置按钮显示
- `next/src/components/layout/app-config-modal.tsx`：新增 useEffect 拦截未登录且开关关闭时的弹窗打开

文档：
- `docs/backend/backend-database.md`：新增 `allowGuestConfig` 字段说明

### 验证步骤

1. 启动后端，访问 `GET /api/settings`，确认返回的 `modelChannel.allowGuestConfig` 为 `true`
2. 登录管理后台 `/admin/settings`，确认公开配置卡片显示「是否允许未登录用户使用配置功能」开关且默认开启
3. 关闭开关并保存，刷新页面确认开关仍为关闭状态
4. 退出登录（或打开无痕窗口），确认顶栏不显示配置按钮（齿轮图标）
5. 在未登录状态下，进入生图/视频工作台，点击模型选择器中可能触发配置弹窗的入口，确认弹窗不打开并提示「请登录后使用配置功能」
6. 重新登录普通账号，确认顶栏配置按钮恢复显示，配置弹窗可正常打开
7. 登录管理后台重新开启开关并保存，退出登录，确认未登录用户顶栏配置按钮恢复显示且弹窗可正常打开

## 配置弹窗三 Tab 布局

把原「配置与用户偏好」弹窗从「渠道模式 + 通用偏好项」两层结构改为顶部 Segmented 三 Tab 切换：本地渠道 / 平台渠道 / 偏好设置。

### 可测试变更

- 顶部用 Segmented 替换原「渠道模式」Form.Item，三个选项：本地渠道 / 平台渠道 / 偏好设置
- 名称调整：原「本地直连」→「本地渠道」，原「云端渠道」→「平台渠道」（Tab 与平台渠道说明文案同步改名）
- Tab 可见性按权限控制：
  - admin 且同时开启 `allowCustomChannel` 和 `allowUserRemoteChannel`：三个 Tab 全可见，切换本地/平台 Tab 时同步 `channelMode`
  - 普通用户仅本地：显示「本地渠道」+「偏好设置」
  - 普通用户仅云端：显示「平台渠道」+「偏好设置」
  - 「偏好设置」Tab 始终可见
- 「本地渠道」Tab 内容：原「本地模型渠道」新增/列表块 + 「模型列表」块（自动同步开关、拉取全部渠道按钮）
- 「平台渠道」Tab 内容：平台渠道说明文案 + 默认生图/视频/文本/音频模型 ModelPicker（从偏好设置移入）
- 「偏好设置」Tab 内容：画布默认生图张数、音频声音/格式/语速、流式/Base64/Codex 三个开关、用户 S3/R2 存储配置、默认音频指令、系统提示词（仅本地渠道模式下显示）；不再包含默认模型选择
- 本地渠道 Tab 不单独放默认模型选择：本地渠道拉取模型列表后自动选第一个可用模型作为默认
- ModelPicker 选择框全局由胶囊形（rounded-full）改为矩形圆角（rounded-md），影响配置弹窗、画布、生图/视频工作台
- 弹窗打开时默认激活当前 `effectiveMode` 对应的渠道 Tab（local→本地渠道，remote→平台渠道）
- 未登录用户拦截逻辑保留：未登录且 `allowGuestConfig=false` 时弹窗仍被拦截，不影响

### 涉及文件

- `next/src/components/layout/app-config-modal.tsx`：
  - 新增 `activeTab` state（`"local" | "remote" | "preferences"`）
  - 新增 `visibleTabs` 计算逻辑（按权限决定可见 Tab）
  - 新增弹窗打开时根据 `effectiveMode` 重置默认 Tab 的 useEffect
  - 替换 Form 内容为 Tabs 结构：本地渠道/平台渠道/偏好设置
  - 默认模型选择 ModelPicker 从偏好设置移入「平台渠道」Tab
- `next/src/components/model-picker.tsx`：SelectTrigger 圆角由 `rounded-full` 改为 `rounded-md`（全局矩形化）

### 验证步骤

1. 登录管理后台（admin），同时开启 `allowCustomChannel` 和 `allowUserRemoteChannel`，打开配置弹窗，确认顶部显示三个 Tab：本地渠道 / 平台渠道 / 偏好设置
2. 默认激活 Tab 与当前渠道模式一致（本地模式→本地渠道，云端模式→平台渠道）
3. 切换到「本地渠道」Tab，确认显示本地模型渠道新增/列表块 + 模型列表块，可正常新增/删除/拉取渠道
4. 切换到「平台渠道」Tab，确认显示平台渠道说明文案 + 默认生图/视频/文本/音频模型选择（ModelPicker 选择框为矩形圆角，非胶囊形）
5. 切换到「偏好设置」Tab，确认不再显示默认模型选择，显示画布默认生图张数、音频设置、流式/Base64/Codex 开关、S3 存储、默认音频指令、系统提示词（仅本地模式时显示系统提示词）
6. 在「平台渠道」Tab 修改默认生图模型，点击「完成」保存，重新打开弹窗确认修改生效
7. 切换 admin 的 `allowCustomChannel` 关闭（仅保留 `allowUserRemoteChannel`），重新打开弹窗，确认只显示「平台渠道」+「偏好设置」两个 Tab
8. 登录普通用户 tester（仅本地渠道），打开配置弹窗，确认显示「本地渠道」+「偏好设置」两个 Tab，本地渠道 Tab 拉取模型后自动选第一个作为默认
9. 退出登录（未登录状态且 `allowGuestConfig` 开启），打开配置弹窗，确认显示「本地渠道」+「偏好设置」两个 Tab，拦截逻辑不受影响
10. 关闭 `allowGuestConfig` 开关，未登录状态下点击配置入口，确认弹窗被拦截并提示「请登录后使用配置功能」
11. 打开画布、生图工作台、视频创作台，确认 ModelPicker 选择框均为矩形圆角（非胶囊形）

## 空画布引导浮层

在新建空画布或从首页 agent 会话框进入新空画布时，画布视口中心显示引导浮层，帮助用户快速了解使用方式。

### 可测试变更

- 空画布（`nodes.length === 0`）时在画布视口中心显示两层引导浮层：
  - 上层：黑色圆角提示按钮（鼠标右键 SVG + "鼠标右键"文案），纯提示无功能
  - 下层：4 个快捷按钮（上传素材/生成图片/生成视频/让 Agent 创建），有实际功能
- 浮层固定在视口中心，不随画布平移/缩放移动（`absolute inset-0 flex items-center justify-center`）
- 浮层容器 `pointer-events-none`，按钮 `pointer-events-auto`，不阻挡画布右键/拖拽操作
- 快捷按钮功能：
  - 上传素材 → 触发 `handleUploadRequest()`
  - 生成图片 → `createNode(CanvasNodeType.Image)`
  - 生成视频 → `createNode(CanvasNodeType.Video)`
  - 让 Agent 创建 → 展开右侧助手面板（`setAssistantMounted(true)` + `setAgentPanel open:true`）
- 画布创建任意节点后（`nodes.length > 0`）浮层自动隐藏
- 快捷按钮颜色使用 `theme.node.text` / `theme.node.muted`，适配浅色/深色主题

### 涉及文件

- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：在 `</InfiniteCanvas>` 后新增空状态引导浮层 JSX

### 验证步骤

1. 新建空白画布，确认视口中心显示黑色"鼠标右键"提示按钮 + 下方 4 个快捷按钮
2. 确认黑色提示按钮点击无响应（纯提示）
3. 点击「上传素材」按钮，确认触发文件上传流程
4. 点击「生成图片」按钮，确认画布创建图片节点，浮层消失
5. 删除节点使画布再次为空，确认浮层重新出现
6. 点击「生成视频」按钮，确认创建视频节点，浮层消失
7. 点击「让 Agent 创建」按钮，确认右侧助手面板展开
8. 从首页 agent 会话框输入内容进入新画布，确认浮层显示（pendingAgentRequest 消费前画布为空）
9. 在画布空白处右键，确认右键菜单正常弹出（浮层不阻挡右键操作）
10. 拖拽/缩放画布，确认浮层始终固定在视口中心不移动
11. 切换浅色/深色主题，确认浮层文字和图标颜色适配主题

## 生图/视频工作台按钮与输入框圆角统一

把生图/视频工作台里的质量、尺寸、张数、清晰度、秒数、任务数量等按钮和输入框统一改成方框带圆角（`rounded-md`），替换原胶囊形（`rounded-full`）和较大圆角（`rounded-xl`/`rounded-lg`）。

### 可测试变更

- 生图工作台 `ImageSettingsPanel`：
  - 质量按钮（自动/高/中/低）和生成张数按钮（1-10 张）的 `OptionPill` 圆角 `rounded-full` → `rounded-md`
  - W/H 尺寸输入框 `DimensionInput` 容器圆角 `rounded-xl` → `rounded-md`
  - 自定义张数输入框 `CountInput` 圆角 `rounded-full` → `rounded-md`
- 视频工作台 `VideoSettingsPanel`（side 布局实际使用的面板）：
  - 清晰度按钮、秒数按钮、Seedance 分辨率按钮的 `OptionPill` 圆角 `rounded-full` → `rounded-md`
  - 自定义清晰度输入框 `ResolutionInput` 圆角 `rounded-full` → `rounded-md`
  - W/H 尺寸输入框 `DimensionInput` 圆角 `rounded-xl` → `rounded-md`
  - 秒数自定义输入框 `NumberInput` 圆角 `rounded-full` → `rounded-md`
  - Kling 模式选择按钮（720P/1080P/4K/标准/专业）圆角 `rounded-full` → `rounded-md`
  - Kling/通用/Seedance 比例按钮圆角 `rounded-xl` → `rounded-md`
- 视频工作台 `KlingV26WorkbenchPanel`（Kling 专用紧凑面板）：
  - 模式/尺寸/秒数等可选按钮 `optionClass` 圆角 `rounded-full` → `rounded-md`
  - 秒数自定义输入框、分镜时长输入框 `KlingNumberInput` 圆角 `rounded-full` → `rounded-md`
  - 任务数量输入框 `KlingTaskCount` 外层 `rounded-xl` 与内层 input `rounded-lg` 统一改为 `rounded-md`
- 通用底部 compact 布局（生图 page 和视频 page）：
  - 生图 `QuickSelect`、`QuickNumber` 圆角 `rounded-xl` → `rounded-md`
  - 视频 `QuickSelect`、`QuickNumber`、`TaskCountControl`、`optionPillClass` 圆角统一为 `rounded-md`
- 视频工作台 `VideoSettingsPanel` 秒数自定义输入框：在输入框右侧追加 "s" 单位后缀（与清晰度输入框的 "p" 后缀对齐）
- 视频工作台 `VideoSettingsPanel` 通用面板：把比例选择按钮从「尺寸」组拆出，单独成「比例」SettingGroup，避免与 W/H 尺寸输入框挤在一起
- 生图工作台 `ImageSettingsPanel`：「宽高比」标题改为「比例」
- 生图/视频工作台比例按钮统一调整尺寸，避免拥挤：
  - 生图 `aspectOptions` 按钮：`h-[60px]` → `h-[72px]`，`gap-2` → `gap-1.5`
  - 视频通用 `sizeOptions` 按钮：`h-[60px]` → `h-[72px]`，`gap-2` → `gap-1.5`
  - Kling/Seedance 比例按钮：`h-[68px]` → `h-[76px]`，`gap-1` → `gap-1.5`
- 生图工作台 `ImageSettingsPanel` 比例按钮按分辨率档位切换显示：
  - `aspectOptions` 新增 `tier` 字段（standard/2k/4k）
  - 「比例」标题右侧新增 Segmented 切换器（标准 / 2K / 4K），切换后只显示对应档位的比例按钮，`auto` 选项始终保留
  - 2K/4K 按钮的 label 去掉 `(2k)`/`(4k)` 后缀（档位已由 Segmented 表达，避免重复）
  - 切换档位时若当前选中的比例不在新档位，自动重置为 `auto`
  - 弹窗打开时根据 `config.size` 自动定位到对应档位（如 `16:9-2k` → 默认 2K）
  - 补全 2K/4K 档位的全部比例（按 16 倍数对齐）：
    - 2K 新增：3:2（2048×1360）、2:3（1360×2048）、4:3（2048×1536）、3:4（1536×2048）
    - 4K 新增：1:1（4096×4096）、3:2（4096×2720）、2:3（2720×4096）、4:3（4096×3072）、3:4（3072×4096）
    - 三档位比例数量一致（8 个 + auto），云端模型不支持时靠报错兜底

### 涉及文件

- `next/src/components/image-settings-panel.tsx`：`OptionPill`、`DimensionInput`、`CountInput` 三个组件 className 圆角统一；「宽高比」改名「比例」；比例按钮高度和 gap 调整；新增 `tier` 字段和 Segmented 档位切换（标准/2K/4K）
- `next/src/components/video-settings-panel.tsx`：`OptionPill`、`ResolutionInput`、`DimensionInput`、`NumberInput`、Kling 模式按钮、Kling/通用/Seedance 比例按钮圆角统一；`NumberInput` 追加 "s" 后缀；通用面板拆分「尺寸」和「比例」两个 SettingGroup；比例按钮高度和 gap 调整
- `next/src/app/(user)/image/page.tsx`：底部 compact 布局用的 `QuickSelect`、`QuickNumber` 圆角统一
- `next/src/app/(user)/video/components/kling-v26-workbench-panel.tsx`：`optionClass`、`KlingNumberInput`、`KlingTaskCount` 三个组件 className 圆角统一
- `next/src/app/(user)/video/page.tsx`：Seedance/通用视频工作台用的 `QuickSelect`、`QuickNumber`、`TaskCountControl`、`optionPillClass` 圆角统一

### 验证步骤

1. 启动前端，进入生图工作台 `/image`，展开「图像设置」面板
2. 确认质量按钮（自动/高/中/低）为方框带轻微圆角（非胶囊形）
3. 确认 W/H 尺寸输入框为方框带轻微圆角（非大圆角）
4. 确认生成张数按钮（1-10 张）和右侧自定义张数输入框均为方框带轻微圆角
5. 确认生图「宽高比」标题已改为「比例」，比例按钮高度增加、内容不拥挤
6. 确认生图「比例」标题右侧有 Segmented 档位切换器（标准 / 2K / 4K），默认根据当前 `config.size` 自动定位（例如 1:1 在「标准」，1:1(2k) 在「2K」，16:9(4k) 在「4K」）
7. 切换 Segmented 到「2K」，确认只显示 1:1 / 16:9 / 9:16 / 21:9 四个比例按钮 + auto，按钮无 `(2k)` 后缀
8. 切换 Segmented 到「4K」，确认只显示 16:9 / 9:16 / 21:9 三个比例按钮 + auto
9. 切换到「2K」选中 16:9，再切换到「4K」，确认 16:9 选项不在 4K 中时自动重置为 auto
10. 进入视频创作台 `/video`，展开各设置区
11. 确认模式（720P/1080P/4K）、尺寸（16:9/9:16/1:1）、秒数（3s/15s 或 5s/10s）等按钮为方框带轻微圆角
12. 确认秒数自定义输入框、分镜时长输入框为方框带轻微圆角，且秒数自定义输入框右侧带 "s" 单位
13. 确认任务数量输入框（外层容器和内层 input）均为方框带轻微圆角
14. 切换到 Seedance / 通用视频工作台（非 Kling 模型），确认底部 compact 布局中的清晰度、尺寸、秒数、任务数量等 select/input 均为方框带轻微圆角
15. 进入视频工作台 side 布局的「视频设置」面板（通用模型），确认「尺寸」组只有 W/H 输入框，下方有独立的「比例」组放比例选择按钮，比例按钮不拥挤
16. 切换到 Kling / Seedance 视频设置面板，确认比例按钮（带像素说明的三行内容）高度增加、gap 适中不拥挤
17. 切换浅色/深色主题，确认方框边框和颜色正常显示

## 管理后台模型管理拆分（原"渠道管理"）

把渠道配置从 `/admin/settings` 拆出来作为独立菜单项 `/admin/channels`（UI 文案显示为"模型管理"），系统设置页私有 tab 仅保留同步/日志/存储三块。详细方案见 [channels-page-split.md](./channels-page-split.md)。

### 可测试变更

- 新增管理后台页面 `/admin/channels`，承载原嵌在系统设置页私有 tab 的全部渠道逻辑（页面 UI 文案统一为"模型管理"）：
  - 渠道 Table（名称/协议/状态/模型/权重/超时/操作）
  - Channel Drawer（新增/编辑，标题为"新增模型"/"编辑模型"，含 name/protocol/baseUrl/apiKey/models/weight/timeout/enabled/remark）
  - 选择模型 Modal（双 tab：新获取/已有，Checkbox 网格、搜索、增加模型、拉取模型列表）
  - 模型测试 Modal（单测/批测）
- 管理后台侧边栏在「素材库」和「系统设置」之间新增「模型管理」菜单项，使用 `ApiOutlined` 图标
- 顶部 Header 标题在 `/admin/channels` 路径下显示「模型管理」
- 系统设置页私有 tab 移除：渠道 Table、Channel Drawer、选择渠道模型 Modal、模型测试 Modal
- 系统设置页公开 tab「系统可用模型」Select 的 options 改为从 `Form.useWatch(["private", "channels"], form)` 派生（不再依赖独立 `channels` state），extra 文案改为"可选项来自「模型管理」中各启用模型配置的模型"
- 系统设置页 `saveSettings` 移除 `mergeChannelApiKeys` / `setChannels` / `setKnownModels` 等渠道相关逻辑；`loadSettings` 移除 `setChannels` / `setKnownModels`
- 沿用整体保存模式：模型管理页保存时读取 form 中的全量 settings，仅替换 `private.channels` 后整体 `POST /api/admin/settings`，后端零改动
- 模型管理页内联一份 normalize 逻辑（`normalizeSettings` / `normalizePublicSetting` / `normalizePrivateSetting` / `normalizeChannel` 等），与 settings 页解耦
- 修复新增/编辑模型时浏览器自动填充账号密码问题：Drawer 内 Form 加 `autoComplete="off"`，baseUrl 用 `autoComplete="off"`，apiKey 用 `autoComplete="new-password"`，并在 Form 顶部加两个隐藏的假用户名/密码 input 引导浏览器填充到那里

### 涉及文件

- `next/src/app/(admin)/admin/channels/page.tsx`：新增，从 settings/page.tsx 迁移渠道相关全部逻辑
- `next/src/app/(admin)/admin/layout.tsx`：新增「模型管理」菜单项（路由 key 仍为 `/admin/channels`）和路由元数据，import `ApiOutlined`
- `next/src/app/(admin)/admin/settings/page.tsx`：删除渠道相关 UI/state/函数（约 400 行），`channelModels` 改为 Form.useWatch 派生

### 验证步骤

1. 启动前端，登录管理后台 admin/admin123
2. 确认侧边栏在「素材库」和「系统设置」之间出现「模型管理」菜单项（图标为 ApiOutlined）
3. 点击「模型管理」，确认 URL 为 `/admin/channels`（路由不变），顶部 Header 标题显示「模型管理」
4. 确认 Table 正常展示原有渠道数据（名称/协议/状态/模型/权重/超时/操作列）
5. 点击「新增模型」，确认 Drawer 弹出，标题为"新增模型"；**确认接口地址、API Key 输入框不会被浏览器自动填充账号密码**（这是本次修复重点）
6. 填写 baseUrl + apiKey + 名称后保存，确认新渠道出现在 Table 中
7. 点击某行的「编辑」，Drawer 标题为"编辑模型"，修改名称后保存，确认 Table 中名称已更新；确认编辑时 apiKey 输入框 placeholder 为"留空则沿用已保存的 API Key"
8. 点击某行的「测试」，确认测试 Modal 标题为"{名称} 模型测试"，选择模型后点击「测试」或「批量测试」，确认状态显示正常（成功/失败/请求时长）
9. 在编辑 Drawer 中点击「选择模型」，确认选择模型 Modal 标题为"选择模型"，点击「拉取模型列表」可拉取上游模型，勾选后确认返回 Drawer
10. 点击某行的删除按钮，确认渠道从 Table 中移除
11. 切换到「系统设置」页面，确认私有 tab 仅剩 3 块 Card：提示词定时同步、AI 调用日志、数据存储；不再显示渠道 Table / Drawer / Modal
12. 切换到公开 tab，确认「系统可用模型」Select 的下拉 options 仍正常显示已启用模型配置的模型；extra 文案为"可选项来自「模型管理」中各启用模型配置的模型"
13. 在公开 tab 修改默认模型或系统提示词，点击「保存设置」，确认保存成功且无报错
14. 在公开 tab 切到「手动编辑 JSON」模式，确认 JSON 内容正常显示且可编辑/格式化
15. 在私有 tab 切到「手动编辑 JSON」模式，确认 JSON 内容包含 `private.channels` 字段（保存全量 settings 仍包含渠道数据）
16. 在模型管理页保存渠道后切到系统设置页，确认系统设置页公开 tab 的「系统可用模型」options 已按最新渠道模型更新

## 修复公开配置可用模型不随渠道同步

修复 bug.md 反馈的问题：管理后台模型管理添加渠道后，公开配置 `availableModels` 一直为空，普通用户看不到/用不了管理员配置的付费模型。根因是保存设置时只对 `availableModels` 做交集过滤（`filterEnabledModels`），从不把新渠道的模型合并进来，与 `docs/backend/system-settings.md` 描述的"自动合并"设计意图不符。

### 可测试变更

- 保存设置时自动合并新增渠道模型：`SaveSettings` 在过滤之外调用 `mergeNewEnabledChannelModels`，把本次新增启用渠道的模型并入公开配置 `availableModels`
- 空值兜底：`normalizePublicSettingWithChannels` 中过滤后若 `availableModels` 为空，则直接用当前启用渠道模型填充（首次配置/全部失效时不再出现空列表）
- 管理员手动移除的既有模型不会被加回：只合并"上次不存在、这次新出现"的启用模型，已存在但被手动取消勾选的模型保持移除状态
- 默认模型自动修复逻辑不变：默认文/图/视频模型不在可用列表时仍按原规则修复

### 涉及文件

- `Go/service/settings.go`：`SaveSettings` 增加合并调用；`normalizePublicSettingWithChannels` 增加空值填充；新增 `mergeNewEnabledChannelModels` 函数

### 验证步骤

1. 管理后台「模型管理」新增一个启用渠道（含若干模型），保存后打开系统设置页公开 tab，确认「系统可用模型」中已自动出现该渠道的模型（修复前为空）
2. 若此前 `availableModels` 为空，确认保存后默认文/图/视频模型被自动修复为列表中的有效模型
3. 在系统设置页公开 tab 手动取消勾选某个既有模型并保存，再次保存渠道配置，确认该模型不会被自动加回
4. 普通用户登录后打开生图/视频工作台或聊天，确认模型下拉中能看到并正常使用管理员配置的付费模型

## 管理后台导航重组

按管理员工作流重组后台导航为四组（用户与资费 / 模型服务 / 内容库 / 系统），隐藏"公开/私有配置"实现概念；原系统设置页拆分为「开放与定价」「存储设置」「系统偏好」「高级配置」四个新页面，并把 `promptSync` 迁进提示词来源页、`aiLog` 迁进 AI 调用日志页。详细方案见 [admin-nav-restructure.md](./admin-nav-restructure.md)。

### 可测试变更

- `admin/layout.tsx` 菜单改为 4 分组结构：用户与资费（用户管理 / 算力点日志）/ 模型服务（模型管理 / 开放与定价 / AI 调用日志）/ 内容库（提示词来源 / 提示词管理 / 素材库）/ 系统（存储设置 / 系统偏好 / 高级配置），移除原「系统设置」菜单项
- `admin/settings/page.tsx` 删除全部内容，改为 `redirect("/admin/model-pricing")`，兼容旧链接
- 新增 `admin/model-pricing/page.tsx`「开放与定价」页：系统可用模型多选（options 来自已启用渠道模型并标注来源渠道名）、未定价模型顶部 Alert 警告、模型定价表（每行算力点单价输入框）、默认文/图/视频模型 4 个 Select、`allowCustomChannel` / `allowUserRemoteChannel` 两个渠道策略开关
- 新增 `admin/storage/page.tsx`「存储设置」页：存储模式、`allowUserProvider` / `allowUserGlobalProvider` 开关、容量上限与定时测量 cron、providers 列表
- 新增 `admin/preferences/page.tsx`「系统偏好」页：访问控制（`auth.allowRegister` / `allowGuestConfig`）+ 5 个内置系统提示词 TextArea
- 新增 `admin/advanced/page.tsx`「高级配置」页：左右两栏 JSON 编辑器（公开 / 私有），页头警示"仅供排障与迁移使用"
- 新增 `admin/settings-shared.ts` 抽取共享的 `normalizeSettings` / `normalizePublicSetting` / `normalizePrivateSetting` / `filterModels` / `collectChannelModels` 等归一化函数
- `admin/prompt-sources/page.tsx` 顶部新增「定时同步」卡片：`promptSync.enabled` 开关 + Cron 表达式
- `admin/ai-logs/page.tsx` 顶部新增「日志设置」卡片：`aiLog.localDirectReportEnabled` 开关 + 自动清理开关 + 保留天数 + Cron
- 后端零改动，各新页面沿用全量 settings 读写模式（读全量 → 渲染自己负责片段 → 整体 `POST /api/admin/settings`）

### 涉及文件

前端：
- `next/src/app/(admin)/admin/layout.tsx`：菜单改为 4 分组结构，新增 4 个菜单项与 `routeMeta`，移除原「系统设置」项
- `next/src/app/(admin)/admin/settings/page.tsx`：清空原内容，改为 `redirect("/admin/model-pricing")`
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增「开放与定价」页
- `next/src/app/(admin)/admin/storage/page.tsx`：新增「存储设置」页
- `next/src/app/(admin)/admin/preferences/page.tsx`：新增「系统偏好」页
- `next/src/app/(admin)/admin/advanced/page.tsx`：新增「高级配置」页
- `next/src/app/(admin)/admin/settings-shared.ts`：新增共享归一化函数
- `next/src/app/(admin)/admin/prompt-sources/page.tsx`：顶部新增「定时同步」卡片
- `next/src/app/(admin)/admin/ai-logs/page.tsx`：顶部新增「日志设置」卡片

### 验证步骤

1. 登录管理后台，确认左侧菜单显示 4 个分组：用户与资费 / 模型服务 / 内容库 / 系统
2. 确认「系统设置」菜单项已消失，原 `/admin/settings` 路径访问时自动跳转到 `/admin/model-pricing`
3. 点击「开放与定价」菜单，确认页面显示：系统可用模型多选、未定价模型 Alert（若有）、模型定价表、默认模型 Select×4、渠道策略开关×2
4. 在「模型管理」新增一个启用渠道并保存后，回到「开放与定价」页确认该渠道的模型已自动出现在「系统可用模型」中
5. 在「开放与定价」页修改某个模型的算力点单价并保存，刷新确认价格持久化
6. 切换 `allowCustomChannel` / `allowUserRemoteChannel` 两个开关，确认下方"当前：xxx"模式说明文案同步更新
7. 点击「存储设置」菜单，确认页面显示存储模式、`allowUserProvider` / `allowUserGlobalProvider` 开关、容量上限、定时测量 cron、providers 列表
8. 点击「系统偏好」菜单，确认页面显示 `auth.allowRegister` / `allowGuestConfig` 两个开关 + 5 个内置系统提示词 TextArea（image / video / text / workflow / workflowAgent）
9. 点击「高级配置」菜单，确认页面顶部有警示文案，左右两栏分别显示公开 / 私有 JSON，可格式化、可编辑、可保存
10. 点击「提示词来源」菜单，确认页面顶部新增「定时同步」卡片（开启开关 + Cron 表达式），修改 Cron 保存后刷新确认持久化
11. 点击「AI 调用日志」菜单，确认页面顶部新增「日志设置」卡片（本地直连上报开关 + 自动清理开关 + 保留天数 + Cron），修改后保存刷新确认持久化
12. 旧链接兼容：浏览器直接访问 `/admin/settings`，确认自动重定向到 `/admin/model-pricing`

## 生图/视频模型能力配置

管理后台支持按模型勾选支持的图片比例、图片档位和视频清晰度，前端生图/视频工作台根据当前所选模型的能力动态渲染选项按钮，切换模型时若当前选项不在新模型支持范围内则自动回退。详细方案见 [model-capabilities-refactor.md](./model-capabilities-refactor.md)。

### 可测试变更

- 后端 `PublicModelChannelSetting` 新增 `ModelCapabilities` 字段（`[]ModelCapability`），每项含 `model`/`imageAspects`/`imageTiers`/`videoResolutions`
- 后端 `normalizeModelCapabilities` 按 `AvailableModels` 过滤冗余项、同模型去重保留首个、字段去空格
- 空字段语义：`imageAspects` 空=无比例可选（只剩 auto）；`imageTiers` 空=无档位可选（Segmented 隐藏，只剩 auto）；`videoResolutions` 空=无清晰度按钮（只剩自定义输入兜底）
- 管理后台「开放与定价」页新增「模型能力」卡片：仅展示生图或视频模型，每个模型可勾选图片比例（8 选项）、图片档位（标准/2K/4K）、视频清晰度（480p/720p/1080p/2K/4K）；新模型默认全选，用户取消勾选并保存后按空值处理
- 前端 store `resolveEffectiveConfig` 返回当前模型的 `modelCapabilities`，切换模型时若当前 `size` 比例不在新模型能力内回退到 `auto`，若当前 `vquality` 不在新模型能力内回退到第一个支持的档位
- 生图工作台 `ImageSettingsPanel` 新增 `capabilities` prop：按 `imageTiers` 过滤 Segmented 档位（仅 1 档时隐藏 Segmented），按 `imageAspects` 过滤比例按钮（空=无比例，只剩 auto）
- 视频工作台 `VideoSettingsPanel` 新增 `capabilities` prop：按 `videoResolutions` 动态生成清晰度按钮并隐藏自定义输入框（空=无按钮 + 自定义输入兜底）
- 修复 `resolveEffectiveVideoQuality` 把 `2k`/`4k` 拼成 `2kp`/`4kp` 匹配的 bug：改为 `[quality, quality+'p']` 双候选匹配，兼容 480p/720p/1080p（带 p）和 2k/4k（不带 p）两种格式
- 修复 5 处调用方未传 `capabilities` prop 导致前端永远走默认分支（全档位 + 全比例）的问题：
  - 生图工作台 `/image`：`GenerationSettings` 内部用 `useEffectiveConfig` 取 `modelCapabilities`，按当前 `imageModel` 查找后传入
  - 视频工作台 `/video`：从 `config.modelCapabilities`（已是 effectiveConfig 派生）按当前 `model` 查找后传入
  - 画布生图浮层 `canvas-image-settings-popover.tsx`：从 `config.modelCapabilities` 按 `config.imageModel` 查找后传入
  - 画布视频浮层 `canvas-video-settings-popover.tsx`：从 `config.modelCapabilities` 按 `config.videoModel || config.model` 查找后传入
  - 创意工作流编辑器 `creative-workflow-workspace.tsx`：从 `modelConfig.modelCapabilities`（=effectiveConfig）按 `workflow.config.imageModel || workflow.config.model` 查找后传入
- 视频创作台底部设置栏（compact 布局）按模型能力配置动态显示清晰度：从 `config.modelCapabilities` 按当前 `model` 查找 `videoResolutions`，有值按配置生成选项，空数组不显示清晰度选择，未配置走默认三档 480p/720p/1080p

### 涉及文件

后端：
- `Go/model/setting.go`：新增 `ModelCapability` 结构体；`PublicModelChannelSetting` 添加 `ModelCapabilities` 字段
- `Go/service/settings.go`：新增 `normalizeModelCapabilities` 函数；`normalizePublicSettingWithChannels` 中调用

前端：
- `next/src/services/api/admin.ts`：新增 `AdminModelCapability` 类型；`AdminPublicModelChannelSettings` 添加 `modelCapabilities` 字段
- `next/src/app/(admin)/admin/settings-shared.ts`：新增 `normalizeModelCapabilities` 归一化函数
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增「模型能力」编辑卡片（Checkbox.Group 勾选配置）
- `next/src/stores/use-config-store.ts`：`AiConfig` 扩展 `modelCapabilities` 字段；新增 `resolveEffectiveImageSize` / `resolveEffectiveVideoQuality` 回退函数
- `next/src/components/image-settings-panel.tsx`：新增 `capabilities` prop；按能力过滤档位和比例
- `next/src/components/video-settings-panel.tsx`：新增 `capabilities` prop；按能力动态生成清晰度选项
- `next/src/app/(user)/image/page.tsx`：`GenerationSettings` 内部 `useEffectiveConfig` 取能力并传入 `ImageSettingsPanel`
- `next/src/app/(user)/video/page.tsx`：`VideoSettingsPanel` 调用传入 `capabilities`；底部设置栏（compact 布局）按 `config.modelCapabilities` 动态生成清晰度选项，空 `videoResolutions` 时不显示清晰度选择
- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：`ImageSettingsPanel` 调用传入 `capabilities`
- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：`VideoSettingsPanel` 调用传入 `capabilities`
- `next/src/components/workflows/creative-workflow-workspace.tsx`：`ImageSettingsPanel` 调用传入 `capabilities`

文档：
- `docs/backend/backend-database.md`：新增 `modelCapabilities` 字段及每项字段说明

### 验证步骤

1. 启动后端和前端，登录管理后台访问 `/admin/model-pricing`
2. 确认页面底部显示「模型能力」卡片，仅列出生图或视频模型（非文本/音频模型）
3. 为某个生图模型勾选部分图片比例（如仅 1:1 / 16:9 / 9:16）和图片档位（如标准 / 2K），保存后刷新确认持久化
4. 为某个视频模型勾选部分视频清晰度（如仅 720p / 1080p），保存后刷新确认持久化
5. 退出登录或用普通账号，进入生图工作台 `/image`
6. 选择刚才配置了能力的生图模型，确认：
   - Segmented 档位切换器只显示已勾选的档位（如标准 / 2K，无 4K）
   - 比例按钮只显示已勾选的比例（如 1:1 / 16:9 / 9:16，无其他）
7. 在管理后台清空某生图模型的比例勾选并保存，回到生图工作台选择该模型，确认比例区只剩 auto（无其他比例按钮）
8. 在管理后台清空某生图模型的档位勾选并保存，回到生图工作台选择该模型，确认 Segmented 切换器隐藏，只剩 auto
9. 当前选中 16:9-4k 后切换到不支持 4K 的模型，确认 `size` 自动回退到 16:9（标准档位）或 auto
10. 进入视频创作台 `/video`，选择刚才配置了能力的视频模型
11. 确认清晰度按钮只显示已勾选的选项（如 720p / 1080p / 2K / 4K），自定义清晰度输入框隐藏
12. 在管理后台清空某视频模型的清晰度勾选并保存，回到视频工作台选择该模型，确认无清晰度按钮，只剩自定义输入框
13. 当前选中 1080p 后切换到不支持 1080p 的视频模型，确认 `vquality` 自动回退到第一个支持的档位
14. 切换视频工作台为底部 compact 布局（若当前为 side 布局），确认底部"清晰度"下拉同样按模型能力配置动态显示：有值显示对应选项，空数组不显示清晰度下拉，未配置走默认三档 480p/720p/1080p
15. 新增一个生图/视频模型到开放模型列表，刷新管理后台，确认该模型在「模型能力」卡片中默认全选

## 生图接口模式（apiMode）改为后台渠道控制

将生图接口模式（Images API / Responses API）从前端用户级配置改为后台渠道级配置，用户不再需要也无法手动切换。前端根据当前生图模型所属渠道的 `apiMode` 自动解析。

### 可测试变更

- 后端 `ModelChannel` 和 `PublicModelChannelInfo` 新增 `ApiMode` 字段（`images` 默认 / `responses`）
- 后端 `normalizeModelChannel` 归一化 `ApiMode`：非 `responses` 一律视为 `images`
- 后端 `publicChannelInfos` 透传 `ApiMode` 到公开配置
- 前端 `AdminModelChannel` / `AdminPublicModelChannelInfo` 类型新增 `apiMode` 字段
- 管理后台「模型管理」渠道编辑抽屉新增「生图接口」Select（Images API / Responses API），默认 Images API
- 前端 store `resolveEffectiveConfig` 根据当前生图模型所属渠道的 `apiMode` 自动解析；本地模式固定 `images`；找不到渠道默认 `images`
- 删除前端 3 处 `apiMode` 手动切换 UI：
  - 生图工作台 `/image` 主面板的「接口模式」Segmented
  - 生图工作台 `/image` 快速配置弹窗的「接口模式」Segmented
  - 创意工作流编辑器 `creative-workflow-workspace.tsx` 的 apiMode Select
- 工作流任务沿用 `effectiveConfig.apiMode`（由渠道决定），用户无法再手动覆盖

### 涉及文件

后端：
- `Go/model/setting.go`：`ModelChannel` 和 `PublicModelChannelInfo` 新增 `ApiMode` 字段
- `Go/service/settings.go`：`normalizeModelChannel` 归一化 `ApiMode`；`publicChannelInfos` 透传 `ApiMode`

前端：
- `next/src/services/api/admin.ts`：`AdminModelChannel` 和 `AdminPublicModelChannelInfo` 新增 `apiMode` 字段
- `next/src/app/(admin)/admin/channels/page.tsx`：`emptyChannel`/`normalizeChannel` 处理 `apiMode`；渠道编辑抽屉新增「生图接口」Select
- `next/src/stores/use-config-store.ts`：`resolveEffectiveConfig` 解析 `apiMode`
- `next/src/app/(user)/image/page.tsx`：删除两处 apiMode Segmented
- `next/src/components/workflows/creative-workflow-workspace.tsx`：删除 apiMode Select

### 验证步骤

1. 进入管理后台「模型管理」，编辑或新建一个渠道，确认表单出现「生图接口」Select，默认 Images API
2. 将某渠道的「生图接口」改为 Responses API 并保存，刷新确认持久化
3. 进入生图工作台 `/image`，确认主面板和快速配置弹窗都不再有「接口模式」切换
4. 选择步骤 2 配置为 Responses API 的渠道下的生图模型，发起一次生图请求，确认请求走 `/responses` 端点（看网络面板或日志 Tag 显示 Responses）
5. 选择其他仍为 Images API 的渠道下的生图模型，发起生图请求，确认走 `/images/generations` 端点
6. 进入创意工作流编辑器，确认配置区不再有 apiMode Select；运行工作流时按当前模型所属渠道的 apiMode 发起请求
7. 切换本地直连模式，确认生图请求固定走 Images API（本地模式不读渠道 apiMode）

## 生图/视频工作台参数精简与视频秒数后台控制

精简生图/视频工作台底部栏与画布节点设置面板的参数，删除生图质量选项和尺寸 W/H 输入框（保留比例），「清晰度」文案统一改为「分辨率」，视频秒数从固定档位/数值输入改为 Slider 进度条，并由后台 `ModelCapability` 的 `videoSecondsMin`/`videoSecondsMax` 统一控制范围（默认 4-20 秒）。

### 可测试变更

- 后端 `ModelCapability` 新增 `VideoSecondsMin` / `VideoSecondsMax`（指针类型，空=默认 4-20）
- 前端 `AdminModelCapability` 类型同步新增 `videoSecondsMin` / `videoSecondsMax`
- 管理后台「模型开放与定价」视频模型配置区新增「视频秒数范围（默认 4-20）」两个 InputNumber，新模型默认填 4/20
- 前端 `use-config-store` 新增 `resolveVideoSecondsRange(cap)` 工具函数（默认 4-20），`resolveEffectiveConfig` 切换模型时 clamp `videoSeconds` 到新范围（保留 -1 智能时长原值）
- 删除生图质量选项：
  - 生图工作台 `/image` 底部栏「质量」QuickSelect、`quickQualityOptions`、`settingsSummary` 的 quality 项、日志 quality Tag/字段
  - `ImageSettingsPanel` 的「质量」栏、`qualityOptions`、`imageQualityLabel`、`DimensionInput`、`readSizeDimensions`、`alignDimension`
  - `canvas-image-settings-popover.tsx` 的 `imageQualityLabel` 引用与 quality 变量
  - 创意工作流日志 quality Tag 与 `createWorkflowConfig`/`buildWorkflowImageLog` 的 quality 字段
  - `AiConfig.quality` 字段保留（兼容历史日志反序列化），不再有 UI 读写入口，API 层仍按默认值发送
- 删除生图/视频尺寸 W/H 输入框（保留比例栏）：
  - `ImageSettingsPanel` 删除「尺寸」W/H 输入栏与「16 倍数对齐」开关
  - `VideoSettingsPanel` 通用面板删除「尺寸」W/H 输入栏
  - `/video` 底部栏删除「尺寸」QuickSelect 与 `quickSizeOptions`
- 「清晰度」文案统一改为「分辨率」：
  - `/video` 底部栏、`VideoSettingsPanel` 通用面板、后台 model-pricing 视频配置区
  - 画布 Agent 工具描述与 Skill 文档（`canvas-agent-tools.ts` / `core.ts` / `video.ts`）
- 视频秒数改 Slider + 后台范围控制：
  - 新增 `QuickSlider`（`/video` 底部栏）和 `SecondsSlider`（`VideoSettingsPanel`）组件，使用 antd Slider
  - `/video` 底部栏通用分支：`QuickNumber` 秒数 → `QuickSlider`，范围 `resolveVideoSecondsRange(videoCap)`
  - `/video` 底部栏 Kling 分支 `KlingV26BottomSettings`：秒数 → Slider，范围从父级传入；「尺寸」文案改「比例」
  - `VideoSettingsPanel` 通用面板：秒数 OptionPill+NumberInput → `SecondsSlider`
  - `KlingV26VideoSettingsPanel`：秒数 OptionPill+NumberInput → `SecondsSlider`，「时长」改「秒数」
  - `kling-v26-workbench-panel.tsx`：秒数 OptionGrid+NumberInput → Slider，删除 V3 初始化 useEffect
  - `SeedanceVideoSettingsPanel`：保留 OptionPill（含 -1 智能时长）+ NumberInput，「时长」改「秒数」，NumberInput max 改用 `secondsRange.max`
  - 删除 `secondOptions` / `klingV26DurationOptions` / `klingV3DurationOptions` / `normalizeKlingV26Duration` / `normalizeKlingV3Duration` 等硬编码定义
  - 删除 `/video` 的 V3 秒数初始化 `useEffect`（统一由 `resolveEffectiveVideoSeconds` clamp）
- 新增专属面板参数梳理文档 `docs/backend/video-exclusive-panels-params.md`，记录通用/Kling V26 V3/Seedance/Grok 四套面板的硬编码参数与后端 `ModelCapability` 扩展建议字段，作为后续后端统一控制的参考

### 涉及文件

后端：
- `Go/model/setting.go`：`ModelCapability` 新增 `VideoSecondsMin` / `VideoSecondsMax`

前端：
- `next/src/services/api/admin.ts`：`AdminModelCapability` 新增 `videoSecondsMin` / `videoSecondsMax`
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增 `setModelCapabilitySeconds`、视频秒数范围配置 UI、视频清晰度→分辨率文案
- `next/src/stores/use-config-store.ts`：新增 `resolveVideoSecondsRange` 与 `resolveEffectiveVideoSeconds`
- `next/src/app/(user)/image/page.tsx`：删除质量 QuickSelect/quickQualityOptions/settingsSummary/日志 quality
- `next/src/app/(user)/video/page.tsx`：新增 QuickSlider、删除尺寸 QuickSelect/quickSizeOptions、秒数改 Slider、清晰度→分辨率、删除 V3 初始化 useEffect
- `next/src/components/image-settings-panel.tsx`：删除质量栏/尺寸W/H栏/imageQualityLabel/DimensionInput/readSizeDimensions/alignDimension
- `next/src/components/video-settings-panel.tsx`：删除尺寸W/H栏、清晰度→分辨率、秒数改 SecondsSlider、Kling 时长→秒数、Seedance 时长→秒数、删除硬编码档位
- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：删除 imageQualityLabel 引用
- `next/src/app/(user)/video/components/kling-v26-workbench-panel.tsx`：秒数改 Slider、删除 V3 初始化
- `next/src/components/workflows/creative-workflow-workspace.tsx`：删除日志 quality Tag/字段
- `next/src/app/(user)/canvas/agent/canvas-agent-tools.ts` / `skills/core.ts` / `skills/video.ts`：清晰度→分辨率文案

文档：
- `docs/backend/video-exclusive-panels-params.md`：新增（专属面板参数梳理 + 后端扩展建议）

### 验证步骤

1. 生图工作台 `/image`：确认底部栏只剩「模型 / 尺寸 / 数量」等，无「质量」选项；画布节点 ImageSettingsPanel 无「质量」栏和「尺寸」W/H 输入，只保留「比例」栏
2. 生图工作台日志区：确认历史日志和新生成日志都不再显示 quality Tag
3. 视频工作台 `/video`：确认底部栏无「尺寸」QuickSelect，「清晰度」文案变为「分辨率」
4. 视频工作台底部栏秒数：确认是 Slider 进度条（带 {N}s 数值显示），拖动范围 4-20；切换不同视频模型，Slider 范围按后台配置变化
5. 管理后台「模型开放与定价」：视频模型配置区出现「视频秒数范围（默认 4-20）」两个输入框，修改某模型为 6-12 保存，回到视频工作台选该模型，确认 Slider 范围变为 6-12
6. 视频工作台选 Kling V26/V3 模型：确认专属面板与底部栏的秒数都是 Slider，范围从后台读取，「尺寸」文案变为「比例」
7. 视频工作台选 Seedance 模型：确认秒数仍保留「智能」选项和数值输入（-1 智能时长保留），但 max 从后台读取，「时长」文案变为「秒数」
8. 画布节点视频设置面板：通用面板秒数是 Slider，Kling 面板秒数是 Slider，「清晰度」变「分辨率」
9. 创意工作流编辑器：确认工作流日志不再显示 quality Tag

## 画布视频设置弹窗改为能力开关驱动

把画布视频节点设置弹窗（`canvas-video-settings-popover.tsx`）中按 `panelType` 厂商分流 UI 的逻辑改为完全由 `ModelCapability` 能力开关驱动，使每个视频模型都能通过后台勾选能力开关来控制多镜头、元素列表、首尾帧、运动控制等功能的显隐，不再绑定厂商专属面板类型。

### 可测试变更

- 移除 `isKlingV3` / `isKlingMotionControl` / `isKIEKlingV3` 等基于 `panelType` 的 UI 分流变量
- 角色朝向参考（运动控制）：改为 `resolveSupportsMotionControl(cap) === true` 时显示，不再仅限 `motion-control` 面板类型
- 多镜头分镜 / 分镜模式 / 分镜提示词：改为 `resolveSupportsMultiShot(cap) === true` 时显示，不再仅限 `kling-v3` 面板类型
- 元素列表：改为 `resolveSupportsElementList(cap) === true` 时显示，不再仅限 `kling-v3` 面板类型
- 首尾帧：改为 `resolveSupportsFirstLastFrame(cap) === true` 时显示；`kling-v3` 请求体格式仍使用 `klingImageNodeIds` 元数据存储，其他格式使用 `firstFrameNodeId` / `lastFrameNodeId` props
- 负面提示词：移除 `hideNegativePrompt` 传参，完全由 `VideoSettingsPanel` 内部的 `resolveSupportsNegativePrompt` 能力开关控制
- `KlingV3AdvancedSettings` 组件重命名为 `AdvancedVideoSettings`，参数改为接收 `supportsMultiShot` / `supportsElementList` / `supportsFirstLastFrame` / `useKlingMultiShotBehavior` 能力开关
- `panelType` 和 `provider` 仅用于决定首尾帧存储格式和 KIE 多镜头行为差异（请求体格式层面），不再控制 UI 功能区块的显隐

### 涉及文件

- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：移除厂商分流变量，改用能力开关；重命名 `KlingV3AdvancedSettings` → `AdvancedVideoSettings`；移除 `hideNegativePrompt` 传参和重复的负面提示词区块；清理未使用的 `Input` / `CSSProperties` 导入

### 验证步骤

1. 进入管理后台「模型开放与定价」，选一个通用视频模型（非 Kling V3），勾选「多镜头」能力开关，保存
2. 进入画布，新建视频节点选择该模型，打开设置弹窗，确认出现「多镜头分镜」区块（之前仅 Kling V3 面板类型才显示）
3. 取消勾选「多镜头」，勾选「元素列表」，保存后刷新画布，确认设置弹窗出现「元素列表」区块
4. 勾选「运动控制」，确认出现「角色朝向参考」区块（之前仅 motion-control 面板类型才显示）
5. 勾选「首尾帧」，确认出现「首尾帧」区块（之前仅非 Kling V3 模型才显示通用首尾帧）
6. 勾选「负面提示词」，确认 `VideoSettingsPanel` 内出现负面提示词输入框
7. 选一个 Kling V3 模型（面板类型 = kling-v3），确认首尾帧使用 `klingImageNodeIds` 元数据存储格式，多镜头/元素列表按能力开关显示
8. 确认 `panelType` 为 `kling-v3` 且 `provider` 为 `kie` 时，多镜头行为仍保持 KIE 特有逻辑（不设置 shotType、分镜提示词直接显示）

## 视频专属面板能力后台化重构

把视频工作台和画布节点设置面板中按「模型名 + 渠道文本」硬编码判断面板类型、厂商、模式、比例、能力开关的逻辑，统一改为读后端 `ModelCapability` 配置。新增模型或厂商调整参数只需后台改配置，前端不再硬编码分支。

### 可测试变更

- 后端 `ModelCapability` 新增视频面板控制字段（替代前端按模型名 + 渠道硬编码判断面板和请求体格式）：
  - `VideoPanelType`：面板类型，空=通用面板；`kling-v26` / `kling-v3` / `seedance` / `grok` / `motion-control` / `agnes`
  - `VideoProvider`：厂商，空=不区分；`apimart` / `kie`（仅 `kling-v3` / `motion-control` 需要区分请求体格式）
  - `VideoModes`：视频模式选项数组（Kling `std`/`pro`/`4k`、Grok `fun`/`normal`/`spicy`），空=不支持模式选择；新增 `VideoModeOption` 结构体（`value`/`label`/`desc`）
  - `VideoRatios`：视频比例选项（如 `16:9`/`9:16`/`1:1`/`adaptive`），空=通用面板走默认 `sizeOptions`
  - `VideoSecondsPresets`：秒数预设档位（如 `[5,10]`），空=连续 Slider；有值=按档位显示 OptionPill
  - `VideoSecondsSmart`：是否支持 `-1` 智能时长（Seedance）
  - 能力开关：`SupportsNegativePrompt` / `SupportsFirstLastFrame` / `SupportsMotionControl` / `SupportsAudioGeneration` / `SupportsWatermark` / `SupportsMultiShot` / `SupportsElementList`
  - 音频生成限制：`AudioRequiresMode`（如 Kling V26 要求 `mode=pro`）、`AudioMaxReferences`（如 Kling V26 要求参考图 ≤1）
- 前端 `AdminModelCapability` 类型同步新增上述字段，`AdminVideoModeOption` 类型新增
- 前端 `use-config-store` 新增 resolve 工具函数：`resolveVideoPanelType` / `resolveVideoProvider` / `resolveVideoModes` / `resolveVideoRatios` / `resolveVideoSecondsPresets` / `resolveVideoSecondsSmart` / `resolveSupportsNegativePrompt` / `resolveSupportsFirstLastFrame` / `resolveSupportsMotionControl` / `resolveSupportsAudioGeneration` / `resolveSupportsWatermark` / `resolveSupportsMultiShot` / `resolveSupportsElementList` / `resolveAudioRequiresMode` / `resolveAudioMaxReferences` / `findModelCapability`
  - 能力开关 resolve 返回 `boolean | undefined`：未配置（`undefined`）= 走前端默认硬编码兜底；有值 = 按配置
- 管理后台「模型开放与定价」视频模型配置区新增「视频专属面板配置」区块：
  - 面板类型 Select（通用/Kling V26/Kling V3/Seedance/Grok/Motion Control/Agnes）
  - 厂商 Select（仅面板类型为 `kling-v3` 或 `motion-control` 时显示，apimart/kie）
  - 视频比例 Checkbox.Group（16:9/9:16/1:1/4:3/3:4/21:9/adaptive）
  - 能力开关 Checkbox 组：负面提示词/首尾帧/运动控制/音频生成/水印/多镜头/元素列表/智能时长(-1)
  - 音频生成限制（仅勾选「音频生成」时显示）：需要模式 Select + 最大参考图 InputNumber
- 前端 `VideoSettingsPanel` 通用面板按 `videoPanelType` 分流到 Kling V26 / Seedance 专属面板；通用分支按 `videoModes` 动态渲染模式 OptionPill、按 `videoRatios` 动态渲染比例按钮（空=走默认 `sizeOptions`）、按 `resolveSupportsAudioGeneration` 控制音频生成开关显隐
- 前端 `/video` 工作台 `buildVideoConfig` 与 `createVideoRequestBody` 改用 `resolveVideoPanelType` / `resolveVideoProvider` 判断面板和厂商，替代原 `isKlingV26VideoModel` / `isSeedanceVideoConfig` / `isAPIMartKlingV26Config` 等按模型名 + 渠道文本硬编码判断
- 画布 `canvas-video-settings-popover` 与 `canvas-client-page` 视频能力判断改用 `findModelCapability` + `resolveSupportsFirstLastFrame` / `resolveSupportsAudioGeneration` / `resolveVideoPanelType` / `resolveVideoProvider`
- 删除已废弃的硬编码判断函数：
  - `next/src/lib/video-model-capabilities.ts`：删除 `supportsVideoFrameReferences` / `supportsVideoAudioGeneration`
  - `next/src/lib/seedance-video.ts`：删除 `isSeedanceVideoConfig` / `isSeedanceVideoModel` / `isSeedanceFastOrMiniModel` / `isArkPlanBaseUrl`

### 涉及文件

后端：
- `Go/model/setting.go`：`ModelCapability` 新增视频面板字段；新增 `VideoModeOption` 结构体

前端：
- `next/src/services/api/admin.ts`：`AdminModelCapability` 新增字段；新增 `AdminVideoModeOption` 类型
- `next/src/stores/use-config-store.ts`：新增 16 个 resolve 工具函数与 `findModelCapability`
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增「视频专属面板配置」区块（面板类型/厂商/比例/能力开关/音频限制）及对应 `setModelCapabilityValue` / `setModelCapabilityBool` / `setModelCapabilityNumber` 辅助函数
- `next/src/components/video-settings-panel.tsx`：通用面板按 `videoPanelType` 分流；通用分支动态渲染模式/比例/音频开关
- `next/src/app/(user)/video/page.tsx`：`buildVideoConfig` 与请求体构造改用 `panelType` / `provider`
- `next/src/services/api/video.ts`：`createVideoRequestBody` 改用 `panelType` / `provider` 判断 Kling / Motion Control / Seedance / Grok 分支
- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：能力判断改用 resolve 函数
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：视频首尾帧/音频生成/Kling V3 kie 判断改用 resolve 函数
- `next/src/lib/video-model-capabilities.ts`：删除 `supportsVideoFrameReferences` / `supportsVideoAudioGeneration`
- `next/src/lib/seedance-video.ts`：删除 `isSeedanceVideoConfig` / `isSeedanceVideoModel` / `isSeedanceFastOrMiniModel` / `isArkPlanBaseUrl`

文档：
- `docs/backend/backend-database.md`：`modelCapabilities` 字段说明同步新增视频面板字段
- `docs/backend/video-exclusive-panels-params.md`：标记已接入后台控制的参数

### 验证步骤

1. 进入管理后台「模型开放与定价」，选一个视频模型，确认视频配置区出现「视频专属面板配置」区块
2. 把某 Kling V26 模型的「面板类型」设为 `Kling V26`，保存；进入视频工作台选该模型，确认走 Kling V26 专属面板（模式 std/pro、比例 16:9/9:16/1:1、秒数 Slider）
3. 把某 Kling V3 模型的「面板类型」设为 `Kling V3`、「厂商」设为 `apimart`，保存；进视频工作台选该模型，确认走 Kling V3 面板（模式 std/pro/4k、多镜头、元素列表）
4. 把上一步模型「厂商」改为 `kie`，保存；确认负面提示词栏隐藏、请求体走 kie 格式（看网络面板 `multi_prompt`/`element_list` 为 kie 格式）
5. 把某 Seedance 模型的「面板类型」设为 `Seedance`、勾选「智能时长(-1)」，保存；进视频工作台选该模型，确认秒数保留 `-1` 智能选项
6. 把某 Grok 视频模型的「面板类型」设为 `Grok`，配置 `videoModes`（fun/normal/spicy），保存；进视频工作台选该模型，确认通用面板出现模式 OptionPill
7. 把某通用视频模型的「视频比例」勾选 `16:9`/`9:16`，保存；进视频工作台选该模型，确认比例栏只显示这两个按钮（不再走默认 sizeOptions）
8. 把某模型勾选「音频生成」+ 填「需要模式 = pro」「最大参考图 = 1」，保存；进视频工作台选该模型，确认音频生成开关仅在 `pro` 模式下可用且参考图 ≤1
9. 把某模型「面板类型」清空（通用），保存；确认视频工作台走通用面板（默认 sizeOptions、无模式选择、无音频开关除非勾选）
10. 进入画布，新建视频节点，确认节点设置弹窗与画布 Agent 视频生成按 `ModelCapability` 配置走对应面板与能力开关
11. 确认前端代码中 `isSeedanceVideoConfig` / `isSeedanceVideoModel` / `supportsVideoFrameReferences` / `supportsVideoAudioGeneration` 等硬编码函数已删除，无残留引用

## Seedance 分辨率与参考素材限制后台化收尾

完成「生图/视频模型能力配置」剩余 2 项收尾，让模型能力后台化重构形成完整闭环。任务 3（后端 `apimartImageConfig` / `kieModelInputConfig` 优先读配置）本轮跳过，后续按需补。

### 可测试变更

- **任务 1：Seedance 分辨率改读 `videoResolutions`**（实际 UI 早已走配置，本轮清理死代码 + 补默认档位）
  - `next/src/components/video-settings-panel.tsx`：默认 `resolutionOptions` 从 `720p/480p` 两档补为 `480p/720p/1080p` 三档，与底部栏 `quickResolutionOptions` 和任务要求「未配置=默认三档」对齐
  - `next/src/lib/seedance-video.ts`：删除 5 个死代码成员（`seedanceResolutionOptions` / `seedancePixels` / `normalizeSeedanceResolution` / `normalizeResolutionToken` / `seedancePixelLabel`），它们仅互相引用，全仓无外部调用方
- **任务 2：Seedance 参考素材数量限制改后台配置**（字节限制 30MB/50MB/15MB 保持硬编码不动）
  - 后端 `Go/model/setting.go`：`ModelCapability` 新增 `MaxImageReferences` / `MaxVideoReferences` / `MaxAudioReferences` 三个 int 字段，`0=走前端默认`
  - 后端 `Go/service/settings.go`：`normalizeModelCapabilities` 直接 append item，新字段自动透传无需改动
  - 前端 `next/src/services/api/admin.ts`：`AdminModelCapability` 新增 `maxImageReferences?` / `maxVideoReferences?` / `maxAudioReferences?`
  - 前端 `next/src/app/(admin)/admin/settings-shared.ts`：`normalizeModelCapabilities` 透传三个新字段
  - 前端 `next/src/app/(admin)/admin/model-pricing/page.tsx`：视频能力卡片新增「参考素材数量上限（0=默认）」区块，含图片/视频/音频三个 `InputNumber`；`setModelCapabilityNumber` 的 field 联合类型扩展支持新字段
  - 前端 `next/src/stores/use-config-store.ts`：新增 `resolveMaxImageReferences` / `resolveMaxVideoReferences` / `resolveMaxAudioReferences` 三个 resolve 函数，`0=走前端默认`
  - 前端 `next/src/app/(user)/video/page.tsx`：主组件新增 `referenceLimits` 对象（从 `klingWorkbenchCap` 解析数量上限，0 回退 `SEEDANCE_REFERENCE_LIMITS` 默认值），`addReferences` / `addReferencesFromClipboard` / `addVideoReferencesFromClipboard` / `addAudioReferencesFromClipboard` / `insertPickedAsset` 中所有数量引用改用 `referenceLimits`，字节引用保持 `SEEDANCE_REFERENCE_LIMITS`

### 涉及文件

后端：
- `Go/model/setting.go`：`ModelCapability` 新增 `MaxImageReferences` / `MaxVideoReferences` / `MaxAudioReferences`

前端：
- `next/src/services/api/admin.ts`：`AdminModelCapability` 新增三个字段
- `next/src/app/(admin)/admin/settings-shared.ts`：`normalizeModelCapabilities` 透传
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增「参考素材数量上限」配置 UI
- `next/src/stores/use-config-store.ts`：新增 3 个 resolve 函数
- `next/src/app/(user)/video/page.tsx`：新增 `referenceLimits`，数量引用改读模型能力
- `next/src/components/video-settings-panel.tsx`：默认 `resolutionOptions` 补 1080p
- `next/src/lib/seedance-video.ts`：删除 5 个分辨率相关死代码成员

文档：
- `docs/backend/backend-database.md`：`modelCapabilities` 新增三个字段说明
- `docs/backend/video-exclusive-panels-params.md`：标记 Seedance 分辨率与参考素材限制已接入
- `docs/progress/todo.md`：移除已完成的 2 项待办

### 验证步骤

1. 进入视频工作台选一个 Seedance 模型，确认分辨率选项按后台 `videoResolutions` 配置显示（未配置=默认 480p/720p/1080p 三档，空数组=仅自定义输入框）
2. 进入管理后台「模型开放与定价」，选一个 Seedance 模型，确认视频能力卡片出现「参考素材数量上限（0=默认）」区块，含图片/视频/音频三个输入框
3. 把某 Seedance 模型的「最大图片」填 `5`、「最大视频」填 `1`、「最大音频」填 `2`，保存；进视频工作台选该模型，上传参考素材确认图片上限 5、视频上限 1、音频上限 2（超过的会被忽略）
4. 把上一步模型三个输入框清空（或填 0）保存；进视频工作台选该模型，确认参考素材上限回退到默认值（图片 9、视频 3、音频 3）
5. 切换到 Kling V26 模型，确认参考素材仍走 Kling 固定逻辑（图片 2，无视频/音频），不受新字段影响
6. 确认参考素材字节限制（图片 30MB、视频 50MB、音频 15MB）保持硬编码不变，上传超限文件仍提示「已忽略超过 XX MB 的参考素材」
7. 确认前端代码中 `seedanceResolutionOptions` / `normalizeSeedanceResolution` / `seedancePixelLabel` / `seedancePixels` / `normalizeResolutionToken` 已删除，无残留引用

## 模型能力配置拆分与任务数量移除

把「模型能力」单卡片拆为「图片模型能力」和「视频模型能力」两个独立卡片；修复视频能力配置保存后能力开关丢失的问题；移除视频创作台任务数量输入框。

### 可测试变更

- 管理后台「模型开放与定价」原「模型能力」卡片拆为两张：
  - 「图片模型能力」：仅展示图片模型，配置图片比例、图片档位
  - 「视频模型能力」：仅展示视频模型，配置视频分辨率、秒数范围、请求体格式、厂商、视频比例、视频模式、能力开关、音频限制
- 修复 `normalizeModelCapabilities` 仅保留 `imageAspects`/`imageTiers`/`videoResolutions` 三个字段导致保存后 `videoPanelType`/`videoProvider`/`videoModes`/`videoRatios`/`videoSecondsSmart`/`supportsXxx`/`audioRequiresMode`/`audioMaxReferences` 全部丢失的问题；现在归一化时保留全部字段
- 视频能力配置删除「秒数预设档位」Select（与秒数范围冲突，统一只用 Slider 拉动条），删除对应 `setModelCapabilityPresets` 辅助函数
- `VideoSettingsPanel` 移除 OptionPill + NumberInput 秒数分支，统一走 `SecondsSlider`；删除未使用的 `NumberInput` 组件与 `resolveVideoSecondsPresets` resolve 函数
- 视频创作台移除「任务数量」输入框：
  - 删除 `TaskCountControl` 组件、`QuickNumber` 组件、`clampQuickNumberValue`、`normalizeVideoCount` 函数
  - 删除 `taskCount` state、`onTaskCountChange` prop 及其在 `WorkbenchMain` / `WorkbenchBottomBar` / `WorkbenchCompactBar` 三处子组件的传参
  - 删除底部 QuickNumber「任务」快捷按钮与「任务数量」WorkbenchSection
  - `buildRequestSnapshot` 内部 `taskCount` 固定为 1，日志/结果对象的 `taskCount` 字段保留兼容（恒为 1）

### 涉及文件

- `next/src/app/(admin)/admin/settings-shared.ts`：`normalizeModelCapabilities` 保留全部字段
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：拆分图片/视频能力卡片；删除秒数预设档位 UI 与 `setModelCapabilityPresets`
- `next/src/components/video-settings-panel.tsx`：秒数统一走 Slider；删除 `NumberInput` 组件
- `next/src/stores/use-config-store.ts`：删除 `resolveVideoSecondsPresets`
- `next/src/app/(user)/video/page.tsx`：删除任务数量 UI、`TaskCountControl`、`QuickNumber`、`normalizeVideoCount`、`taskCount` state 与相关 prop

### 验证步骤

1. 进入管理后台「模型开放与定价」，确认页面分别出现「图片模型能力」和「视频模型能力」两张卡片，图片模型只出现在图片卡片、视频模型只出现在视频卡片
2. 在视频能力卡片勾选某模型的「首尾帧」「音频生成」「多镜头」等多个能力开关，点击保存；刷新页面重新进入，确认勾选状态全部保留（不再丢失）
3. 在视频能力卡片配置某模型的「视频模式」（添加 2-3 个模式）、「请求体格式」、勾选「智能时长(-1)」，保存后刷新，确认全部保留
4. 确认视频能力卡片不再显示「秒数预设档位」配置项
5. 进入视频创作台，确认底部工具栏和侧边栏都不再有「任务数量」输入框或「任务」QuickNumber 按钮
6. 在视频创作台发起一次生成，确认日志/结果卡片中「数量」标签显示为 1，生成流程正常
7. 进入画布视频节点设置弹窗，确认秒数为 Slider 拉动条（不再有 OptionPill 按钮组），范围按 `videoSecondsMin`/`videoSecondsMax` 配置

## 图像/视频设置面板修复

修复画布图像节点分辨率档位消失、生成数量输入框显示与实际值不一致、视频比例中文标签三个问题。

### 可测试变更

- 画布图像节点设置弹窗分辨率档位（标准/2K/4K）消失修复：`ImageSettingsPanel` 的 `effectiveTiers` / `effectiveAspects` 逻辑调整为「`capabilities` 未传或对应字段为空数组 = 未配置，走默认全部；传入非空数组 = 按配置过滤」。此前 `imageTiers` 为空数组时会隐藏档位 Segmented，现在空数组视为未配置，显示全部 3 档
- 「生成张数」改名为「生成数量」
- 生成数量输入框显示值与实际值不一致修复：`ImageSettingsPanel` 的 `count` 变量此前被 `Math.min(maxCount, ...)` 截断传给 `CountInput` 的 `value`，导致输入超过 `maxCount`（默认 15）时显示回退到 15 但 `onConfigChange` 传原始值。现在 `count` 不再做 `maxCount` 截断，输入框显示用户实际输入值
- 画布 `getGenerationCount` 上限从 15 提升到 50，允许生成超过 15 张
- 视频比例标签从中文（横屏/竖屏/方形/宽屏/长图/宽银幕）改为比例格式（16:9/9:16/1:1/4:3/3:4/21:9），与图片比例提示一致；`sizeOptions` 和 `seedanceRatioOptions` 同步修改

### 涉及文件

- `next/src/components/image-settings-panel.tsx`：`effectiveTiers`/`effectiveAspects` 空数组视为未配置；`count` 不再截断；「生成张数」→「生成数量」
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：`getGenerationCount` 上限 15 → 50
- `next/src/components/video-settings-panel.tsx`：`sizeOptions` 标签改比例格式
- `next/src/lib/seedance-video.ts`：`seedanceRatioOptions` 标签改比例格式

### 验证步骤

1. 进入画布，选中图像节点，打开设置弹窗，确认「比例」行右侧出现「标准/2K/4K」三档切换按钮（不再消失）
2. 在画布图像节点设置弹窗点击「4K」档位，确认下方比例按钮切换为 4K 尺寸选项
3. 在「生成数量」输入框输入 20，确认输入框显示 20（不再回退到 15）；发起生成，确认实际生成数量与输入一致
4. 确认「生成数量」标题已从「生成张数」改为「生成数量」
5. 进入视频工作台或画布视频节点设置弹窗，确认比例按钮标签为「16:9」「9:16」「1:1」等比例格式（不再显示「横屏」「竖屏」「方形」）
6. 确认画布视频设置弹窗底部状态栏的比例显示也为比例格式（如「16:9」而非「横屏」）

## 图像档位查找与视频比例显示修复

修复画布图像节点档位 Segmented 不显示、视频比例按钮显示像素尺寸两个问题。

### 可测试变更

- 画布图像节点设置弹窗 `capabilities` 查找模型字段从 `config.imageModel` 改为 `config.imageModel || config.model`：画布节点切换图片模型时只更新 `model` 字段，`imageModel` 可能为空，导致 `modelCapabilities.find` 返回 `undefined`；现在优先用 `imageModel`，回退到 `model`，确保找到对应模型的能力配置
- 视频比例按钮删除副标签（此前会显示 `seedancePixelLabel` 计算的像素尺寸如「1280x720」），现在只显示比例主标签（如「16:9」）
- 画布视频设置弹窗底部状态栏 `videoSizeLabel` 改为新增的 `videoSizeRatioLabel`：把像素尺寸（如「1280x720」）统一映射为比例字符串（如「16:9」），不再显示像素尺寸
- 删除不再使用的 `videoSizeLabel` 函数和 `seedancePixelLabel` import

### 涉及文件

- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：`capabilities` 查找用 `imageModel || model`
- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：状态栏用 `videoSizeRatioLabel`
- `next/src/components/video-settings-panel.tsx`：删除比例按钮副标签；`videoSizeLabel` 改名为 `videoSizeRatioLabel` 并简化逻辑；删除 `seedancePixelLabel` import

### 验证步骤

1. 进入画布，选中图片模型节点，打开设置弹窗，确认「比例」行右侧出现「标准/2K/4K」三档切换按钮
2. 切换不同图片模型，确认档位 Segmented 始终显示
3. 进入视频工作台或画布视频节点设置弹窗，确认比例按钮只显示比例（如「16:9」），下方不再显示像素尺寸（如「1280x720」）
4. 确认画布视频设置弹窗底部状态栏显示「720p · 16:9 · 6s」格式，比例部分不再显示像素尺寸

## 画布图片节点分辨率档位显示修复（最终版）

彻底修复画布图片节点设置弹窗中「标准/2K/4K」档位 Segmented 不显示的问题。前两次尝试（见上文「图像/视频设置面板修复」「图像档位查找与视频比例显示修复」）未解决根因，本次定位到两处真正根因并修复。

### 可测试变更

- 画布图片设置弹窗 `canvas-image-settings-popover.tsx` 能力查找模型字段从 `config.imageModel || config.model` 改为 `config.model`：画布节点的 `config.imageModel` 始终是全局默认图片模型（非空），`config.model` 才是用户在节点上通过 ModelPicker 选中的模型。原 `||` 写法永远解析到 `config.imageModel`，导致能力查找用的是全局默认模型而不是节点选中模型；如果全局默认模型配置的 `imageTiers` 少于 2 项，Segmented 就不显示
- `ImageSettingsPanel` 第 113 行渲染条件从 `tierOptions.length >= 2` 改为 `tierOptions.length >= 1`：保证模型只配了 1 档（如 `["standard"]`）时 Segmented 仍渲染，保持视觉一致（虽然只有 1 项时点击无切换效果）

### 涉及文件

- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：`capabilities` 查找用 `config.model`
- `next/src/components/image-settings-panel.tsx`：Segmented 渲染条件 `>= 2` → `>= 1`

### 验证步骤

1. 进入画布，新建或选中一个图片节点，点击节点打开设置弹窗
2. 选择一个在管理后台配置了 `imageTiers = ["standard","2k","4k"]` 的图片模型，确认「比例」行右侧出现「标准/2K/4K」三档 Segmented
3. 选择一个配置了 `imageTiers = ["standard","2k"]` 的模型，确认只出现「标准/2K」两档
4. 选择一个配置了 `imageTiers = ["standard"]` 单档的模型，确认 Segmented 仍渲染（只有「标准」一项），不再整个消失
5. 选择一个未在 `modelCapabilities` 里配置的模型，确认回退显示三档（标准/2K/4K）
6. 切换不同图片模型，确认 Segmented 档位跟随模型能力配置变化
7. 切换档位（如 4K），确认下方比例按钮跟随档位切换为 4K 尺寸选项

## 顶栏算力图标补全与首尾帧能力拆分

补全非画布页面顶栏的算力图标显示，并将视频首尾帧能力开关从单一 `supportsFirstLastFrame` 拆分为「首尾帧」+「首帧」两个独立选项，使后台可配置"仅支持首帧"的模型（如 minimax-hailuo-2-3、kling-3-0-turbo）。同时画布生图节点去掉图片数量选择，固定一个节点生成一张图。

### 可测试变更

- 顶栏 `UserStatusActions` 在非画布页面（default variant）也显示算力余额：`<CreditSymbol /> + {credits}`，与画布保持一致，使用 stone 配色适配浅色/深色主题
- 后端 `ModelCapability` 新增 `SupportsFirstFrame bool` 字段（保留 `SupportsFirstLastFrame` 表示首尾帧都支持）
- 前端 `AdminModelCapability` 类型新增 `supportsFirstFrame?: boolean`
- 前端 `use-config-store` 新增 `resolveSupportsFirstFrame`（`supportsFirstFrame || supportsFirstLastFrame`，勾选「首尾帧」或「首帧」均显示首帧上传）和 `resolveSupportsLastFrame`（仅 `supportsFirstLastFrame`，勾选「首尾帧」才显示尾帧上传）
- 管理后台「模型开放与定价」视频模型能力开关 Checkbox 拆为「首尾帧」+「首帧」两项
- 画布视频节点设置弹窗：原「首尾帧」分组拆为「首帧」和「尾帧」两个独立分组，分别按 `resolveSupportsFirstFrame` / `resolveSupportsLastFrame` 能力开关显隐
- 视频工作台：原「首尾帧」Section 拆为「首帧」和「尾帧」两个独立 Section，分别按能力开关显隐；`FrameReferenceStrip` 新增 `showFirst`/`showLast` 参数支持只显示一个 slot
- 视频工作台 `buildRequestSnapshot` 去掉 `!kling` 守卫，首帧/尾帧是否传参完全由能力开关决定
- 画布 `canvas-client-page.tsx` 视频生成与重试逻辑：`frameReferencesEnabled` 拆为 `firstFrameEnabled` / `lastFrameEnabled`，不支持的那一侧图片合并进普通参考图下发
- `video.ts` 请求体构造去掉 `!kling` 守卫，只要 `input.firstFrame` / `input.lastFrame` 存在就传 `first_frame_url` / `last_frame_url`
- 画布生图节点去掉图片数量选择：`CanvasImageSettingsPopover` 的 `showCount` 默认改为 `false`（画布中图片节点和配置节点均不显示数量选择）；画布图片生成和全景图生成时 `count` 固定为 1；配置节点和 prompt 面板的 credits 计算固定 count=1

### 涉及文件

后端：
- `Go/model/setting.go`：`ModelCapability` 新增 `SupportsFirstFrame` 字段

前端类型/store：
- `next/src/services/api/admin.ts`：`AdminModelCapability` 新增 `supportsFirstFrame`
- `next/src/app/(admin)/admin/settings-shared.ts`：`normalizeModelCapabilities` 保留 `supportsFirstFrame`
- `next/src/stores/use-config-store.ts`：新增 `resolveSupportsFirstFrame` / `resolveSupportsLastFrame`

顶栏算力图标：
- `next/src/components/layout/user-status-actions.tsx`：default variant 也显示算力余额

后台配置 UI：
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：Checkbox 拆为「首尾帧」+「首帧」

画布视频弹窗：
- `next/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx`：首尾帧分组拆为两个独立分组，按能力开关显隐

视频工作台：
- `next/src/app/(user)/video/page.tsx`：Section 拆分 + `frameReferencesEnabled` 拆为 `firstFrameEnabled`/`lastFrameEnabled` + `FrameReferenceStrip` 新增 `showFirst`/`showLast`
- `next/src/services/api/video.ts`：去掉首尾帧 `!kling` 守卫

画布视频生成：
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：两处 `frameReferencesEnabled` 拆为 `firstFrameEnabled`/`lastFrameEnabled`，不支持侧合并进普通参考图

画布生图节点数量选择：
- `next/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`：`showCount` 默认改为 `false`
- `next/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：图片生成和全景图生成 `count` 固定为 1
- `next/src/app/(user)/canvas/components/canvas-config-node-panel.tsx`：credits 计算固定 count=1
- `next/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`：credits 计算固定 count=1

文档：
- `docs/backend/backend-database.md`：`supportsFirstLastFrame` 字段说明调整 + 新增 `supportsFirstFrame`
- `docs/backend/video-exclusive-panels-params.md`：首尾帧章节拆分说明 + 字段表新增 `supportsFirstFrame`

### 验证步骤

1. 登录后访问任意非画布页面（如首页、生图工作台、视频工作台），确认顶栏显示算力图标（闪电符号）+ 余额数字
2. 进入画布页面，确认顶栏算力图标仍按画布主题色显示（不变）
3. 切换浅色/深色主题，确认非画布顶栏算力图标颜色适配（stone 配色）
4. 进入管理后台「模型开放与定价」，选一个视频模型，确认能力开关区出现「首尾帧」和「首帧」两个独立 Checkbox
5. 勾选「首帧」不勾选「首尾帧」，保存后进入视频工作台选该模型，确认侧栏只出现「首帧」Section，无「尾帧」Section
6. 勾选「首尾帧」不勾选「首帧」，保存后进入视频工作台选该模型，确认侧栏「首帧」和「尾帧」两个 Section 都出现（首尾帧包含首帧）
7. 两个都不勾选，确认两个 Section 都不出现
8. 进入画布视频节点设置弹窗，选一个仅勾选「首帧」的模型，确认只出现「首帧」分组，无「尾帧」分组
9. 选一个勾选「首尾帧」的模型，确认「首帧」和「尾帧」分组都出现
10. 在视频工作台选一个仅首帧的模型，上传首帧图片后发起生成，确认请求体只包含 `first_frame_url` 不含 `last_frame_url`
11. 在画布视频节点选一个仅首帧的模型，连接首帧和尾帧图片节点，发起生成，确认首帧图片单独传 `first_frame_url`，尾帧图片合并进普通参考图 `input_reference[]`
12. 进入画布图片节点或配置节点，打开图片设置弹窗，确认不显示图片数量选择（只有比例/尺寸档位），按钮上也不显示"X 张"
13. 在画布图片节点发起生成，确认每次只生成 1 张图片节点（不再创建多个子节点）
14. 进入生图工作台（非画布），确认仍保留图片数量选择功能

## 生图并发保护与数量 UI 滑块化

统一生图请求为并发多次单张调用，避免上游 `n` 参数限制导致任务失败；生图工作台数量选择改为 Slider 滑块，上限 10 张。

### 可测试变更

- `image.ts` 的 `requestImages` 去掉 `useConcurrentSingleRequests` 条件，所有 `n > 1` 的情况统一走 `Promise.allSettled` 并发多次单张请求（count=1），不再依赖上游是否支持 `n` 参数
- `image.ts` 的 `createImageRequestParams` 中 `n` 上限从 15 调整为 10（对齐行业天花板 gpt-image-1）
- `ImageSettingsPanel` 生成数量 UI 从「快捷选项网格 + 数字输入框」改为 antd `Slider` 滑块，右侧显示当前数值（如 "3 张"）
- `ImageSettingsPanel` 的 `maxCount` 默认值从 15 改为 10，删除 `quickCount` 参数和未使用的 `OptionPill` / `CountInput` 组件
- 生图工作台 `image/page.tsx` 已传 `maxCount={10}`，与默认值一致

### 涉及文件

- `next/src/services/api/image.ts`：`requestImages` 并发逻辑统一 + `n` 上限 15→10
- `next/src/components/image-settings-panel.tsx`：Slider 滑块替换网格+输入框 + maxCount 默认 10 + 删除 OptionPill/CountInput

### 验证步骤

1. 进入生图工作台，确认生成数量区域显示为滑块（进度条样式），右侧显示当前数值
2. 拖动滑块，确认数值在 1-10 范围内变化，右侧数值同步更新
3. 确认滑块无法拖到超过 10
4. 选择一个仅支持单张生成的模型（如 Grok Imagine），设置数量为 3 张，发起生成，确认 3 张图片正常返回（并发 3 次单张请求），不再因上游 `n` 限制失败
5. 选择 gpt-image-1 模型，设置数量为 10 张，发起生成，确认 10 张图片正常返回（并发 10 次单张请求）
6. 确认画布图片节点设置弹窗不显示数量滑块（showCount=false 不受影响）
7. 确认画布生成仍固定 1 张

## 模型下拉框副标题描述

为模型下拉菜单选项接入"描述"副标题，hover 时在模型名下方淡入显示。后台在「模型开放与定价」表格中按模型填写描述（单行 30 字以内）。

### 可测试变更

- 后端 `PublicModelChannelSetting` 新增 `ModelInfos []ModelInfo` 字段（与 `ModelCosts` / `ModelCapabilities` 平级的独立列表），每项含 `model` / `description`
- 后端 `normalizeModelInfos` 规整：按 `AvailableModels` 过滤冗余项，同模型去重保留首个，描述 trim 后按 30 字截断
- 前端 `AdminPublicModelChannelSettings` 类型新增 `modelInfos` 字段；新增 `AdminModelInfo` 类型
- 前端 `AiConfig` 新增 `modelInfos` 字段；`resolveEffectiveConfig` 远程模式透传 `modelChannel.modelInfos`，本地模式返回空数组；`merge` 兜底
- 前端 `ModelPicker` 的 `channelOptions` 构建时从 `config.modelInfos` 按 model 名查找 description，作为 `subtitle` 传给 `ModelLabel`
- `ModelLabel` 组件原已预留 `subtitle` prop（hover 时 `opacity-0 → opacity-55` 淡入），本次仅接通数据，不改 UI 表现
- 管理后台「模型开放与定价」表格新增「描述」列（Input，`maxLength={30}`），放在「模型」列后、「开放」列前
- `modelInfos` 完全由 React state 管理（`useState`），不注册 antd Form.Item，避免 form store 读取数组字段丢失；`saveSettings` 时直接从 state 注入到 `rawValues.public.modelChannel.modelInfos`
- 共享助手 `settings-shared.ts` 新增 `normalizeModelInfos` / `setModelDescription`（直接用 `setModelInfos(prev => ...)` 更新 state）/ `modelInfoDescription`；`emptySettings` 默认 `modelInfos: []`

### 涉及文件

后端：
- `Go/model/setting.go`：新增 `ModelInfo` 结构体；`PublicModelChannelSetting` 新增 `ModelInfos` 字段
- `Go/service/settings.go`：新增 `normalizeModelInfos` 函数；`normalizePublicSettingWithChannels` 调用 + nil 兜底

前端类型：
- `next/src/services/api/admin.ts`：新增 `AdminModelInfo` 类型；`AdminPublicModelChannelSettings` 新增 `modelInfos` 字段

前端 store：
- `next/src/stores/use-config-store.ts`：`AiConfig` 新增 `modelInfos` 字段；`defaultConfig` / `resolveEffectiveConfig` / `merge` 同步处理

前端下拉菜单：
- `next/src/components/model-picker.tsx`：`channelOptions` 附带 description；`ModelPickerPortal` options 类型新增 `description?`；`ModelLabel` 调用传入 `subtitle={option.description}`

后台管理 UI：
- `next/src/app/(admin)/admin/model-pricing/page.tsx`：新增 `modelInfos` state；`loadSettings` / `saveSettings` 加载保存；表格新增「描述」列；`saveSettings` 从 state 注入 `modelInfos`

共享助手：
- `next/src/app/(admin)/admin/settings-shared.ts`：新增 `AdminModelInfo` 导入；`emptySettings` 默认 `modelInfos: []`；新增 `normalizeModelInfos` / `setModelDescription` / `modelInfoDescription`

文档：
- `docs/backend/backend-database.md`：`modelChannel` 字段表新增 `modelInfos`；新增「`modelInfos` 每项字段」说明表

### 验证步骤

1. 进入管理后台「模型开放与定价」，确认「模型开放与定价」表格在「模型」列后新增「描述」列
2. 为某个模型在「描述」列输入介绍文案（如"豆包视频模型"），保存后刷新确认持久化
3. 输入超过 30 字的文案，确认输入框 `maxLength=30` 限制无法继续输入
4. 清空某模型描述并保存，刷新确认该模型不再有描述（`normalizeModelInfos` 剔除空描述项）
5. 进入画布或生图/视频/音频工作台，打开模型下拉，悬停某个配置过描述的模型选项，确认模型名下方淡入显示描述文案
6. 悬停未配置描述的模型选项，确认副标题位置为空（不显示）
7. 切换浅色/深色主题，确认副标题文字颜色（`opacity-55`）适配主题
8. 取消勾选某模型的「开放」开关并保存，刷新后确认该模型从 `modelInfos` 中被剔除（后端 `normalizeModelInfos` 按 `availableModels` 过滤）
9. 重新勾选开放并保存，确认需要重新填写描述（被剔除的项不会自动恢复）


