# EXT-0030 对话底栏与全站中性主题

状态：已实现并完成定向浏览器验证。覆盖标注 1–12、共享中性黑灰、淡点阵与 AUD-11；完整浅色主题及所有弹层组合待人工验收。

## 范围与验收

- 首页与画布共用底栏：文本模型、思考强度、发送；Skill、图片和视频默认值移入工具设置，不删除 Agent 工具。
- `extensions/model-capabilities/reasoning.ts` 集中处理能力选项、旧布尔兼容和请求字段。初版按模型限制档位；[EXT-0039](0039-composer-input-settings.md) 已改为默认关闭、所有文本模型提供五档手选，切换模型保留选择。
- `ModelPicker` 捕获外部 pointerdown，关闭后保留用户点击的输入焦点，兼容 Radix 模态遮挡和父面板停止冒泡。
- 图片节点默认可见边框，生成工具桌面 36px、粗指针 44px；未知费用不再显示为免费。额外修复节点靠近顶部时快捷工具被裁切，工具栏限制在画布区域并适配共享主题。
- `extensions/glass-ui/neutral-theme.css` 将既有 stone 色阶映射到 neutral，共享玻璃表面与 `canvas-colors.ts` 使用中性色；新画布默认 dots，已有明确背景配置不覆盖。
- 后台渠道、费用和模型表格设置内部横向滚动及列宽；NewAPI 图片 Chat 模式隐藏不发送的尺寸、质量控件。

接入点：`canvas-assistant-composer.tsx`、`canvas-assistant-panel.tsx`、`canvas-agent.ts`、`model-picker.tsx`、节点及工具栏、画布 store/client、`globals.css`、管理员设置页、`image-settings-panel.tsx` 和图片工作台。

Playwright：首页思考强度选择、首次外部点击聚焦、687px/390px 布局通过；画布节点边框、嵌套模型菜单与工具栏边界通过；后台 1038px/390px 表格边界通过。图片、视频两种工作台已渲染检查，底部工作台为中性灰；视频 1038px/390px 无页面横向溢出。测试使用独立浏览器和拦截接口，无真实用户数据写入。

初版保留玻璃透明程度；EXT-0039 将视频设置与摄像机弹层改为不透明主题底色。生图高级参数进一步折叠、后台整体导航重组尚未实施；共享颜色替换不等于所有页面的所有状态都完成了截图验收。

上游同步时核对底栏 `textReasoningEffort` 到 `requestCanvasAgentTurn` 的传递、`ModelPicker` 的捕获事件与关闭焦点恢复、节点工具及后台表格边界。现有组件持有这些交互状态，必要接入无法只靠新扩展文件实现；颜色和能力规则集中于扩展以减少重复。浏览器复测脚本和依赖说明见 EXT-0029。
