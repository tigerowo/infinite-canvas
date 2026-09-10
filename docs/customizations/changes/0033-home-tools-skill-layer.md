# 首页登录状态、工具说明与 Skill 弹层

状态：已构建并更新本地 3000 端口容器；独立 TypeScript 检查和浏览器定向回归通过。

未登录首页隐藏模型、思考和工具配置；保留输入及已有登录引导。工具设置明确区分图片与视频模型，显示现有自动提交生成开关，默认行为不变。“自动”思考不发送强度参数，使用上游默认值。

Skill 使用 Ant Design Portal，而工具设置使用 z-index 1200 的 Radix Portal。修复 Skill 层级及父弹窗将 Skill 点击误判为外部点击的问题，支持搜索、选择、关闭及编辑。

手机实测还发现 `topLeft` 对齐只翻转而不平移，弹层左侧会出屏。改为支持自动横向避让的 `top`，并扣除外框内边距限制内容宽度；390px 视口下 Skill 弹层边界已验证完全位于屏幕内。

接入点：`web/src/app/(user)/canvas/components/canvas-assistant-composer.tsx` 是首页与画布共用输入栏；同目录 `canvas-agent-skill-popover.tsx` 持有 Skill 选择/编辑状态；`web/src/extensions/glass-ui/settings-popover.tsx` 负责父弹窗点击边界。仅修改上述交互，不修改 Agent 工具协议和生成请求。上游同步时检查登录判断、Skill Portal 标记、层级及父层外部点击规则。

旧容器复现层级 1030 < 1200 的失败；修复后浏览器通过 Skill 层级、搜索聚焦、选择收起、编辑/取消和父面板保持、自动提交开关、思考选择、模型菜单外部点击、游客入口隐藏及 687/390px 首页无横向溢出检查。测试使用隔离 API 数据，不实际调用生成模型。挂载 Windows 依赖的容器类型检查曾因 Next 模块路径缺失失败，改用完整 Linux 构建阶段镜像执行 `bun x tsc --noEmit` 后通过；生产构建本身跳过类型检查，不能代替该独立检查。

已确认保留 Agent 自动判断，不新增对话/图片/视频强制模式。首页原有 `autoGenerateMedia=false` 保持不变，开关只更改当前 Agent 配置。CDN 暂缓，现有七牛本地 CORS 保留，实际云端范围见 EXT-0032。

依据：[Ant Design Popover API](https://ant.design/components/popover/)。默认弹层层级为 1030，Skill 需高于工具设置的 1200；编辑对话框也须高于父面板。
