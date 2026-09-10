# EXT-0036 Skill 独立工具栏入口

## 需求与实现

用户要求将 Skill 从工具设置弹层移出，放在设置旁边。首页和画布共用的 `web/src/app/(user)/canvas/components/canvas-assistant-composer.tsx` 将既有 `CanvasAgentSkillPopover` 放到 `SettingsPopover` 后面，直接显示在工具栏中，保留 `canConfigure` 登录限制。

这里是现有工具栏 JSX 的最小位置调整，未新增转发组件。搜索、选择、编辑、弹层层级和主题沿用原实现。上游同步时检查 Skill 仍只有一个入口、位于设置按钮右侧，工具设置内无重复按钮。

## 验证

- `repair-ui-smoke.mjs` 首页回归通过：独立入口位置、搜索、选择、编辑、游客隐藏、687px 和 390px 视口边界。
- 独立 TypeScript 检查、前端测试及生产构建通过。
- 无配置、依赖或数据库变更。回退只需恢复原 JSX 位置和相应测试断言。

本轮未替换 3000 容器；新前端预览地址为 `http://127.0.0.1:3001`。
