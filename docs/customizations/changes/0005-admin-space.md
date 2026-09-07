# EXT-0005：修复算力点日志页面 Space 弃用警告

上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`。本项是上游兼容性修复，不新增定制功能。

## 改动与原因

`web/src/app/(admin)/admin/credit-logs/page.tsx` 的 `AdminCreditLogsPage` 将一处 `Space direction="vertical"` 改为 `Space orientation="vertical"`。本地 Ant Design 实现对旧属性发出弃用警告，新属性仍产生相同的垂直布局。

必须直接修改上游调用点以移除弃用属性；不为单个属性建立扩展包装组件。无后端、配置、样式或数据库改动。后续同步检查上游是否已采用新属性，已修复时不重复应用。

## 验证

已使用本地 React 服务端渲染与 Ant Design 组件，根据页面实际属性复现一条 direction 弃用警告；修复后运行相同检查，警告数量为 0，渲染结果仍包含 `ant-space-vertical`。该检查不涉及账户数据或登录状态，尚未重新登录后台进行完整页面人工验证；本次仅修复截图指向的一处调用，未清理其他页面的弃用属性。

## 提交与回退

单独组织兼容性修复提交，回退仅涉及这一属性名。上游 TODO 无新增事项；具体页面人工验证结果未确认前不更新功能说明。开发服务器自动生成的 `web/next-env.d.ts` 不纳入本项。
