# EXT-0017：微鑫画布前端玻璃质感与体验迭代

## 目的

为微鑫画布建立统一、低成本的 Apple 风格玻璃质感，并同步修复动画、交互、响应式、可访问性和明确可证实的性能问题。

## 计划与范围

实施计划见 [`docs/superpowers/plans/2026-09-09-glass-ui-refresh.md`](../../superpowers/plans/2026-09-09-glass-ui-refresh.md)。

本项只修改前端体验和直接相关的验证/文档，不修改 NewAPI、OSS、数据库或上游业务协议。已关闭的首页宣传轮播保持关闭。

## 实际修改

- `web/src/app/globals.css`：新增浅色/深色玻璃表面 token、统一玻璃工具类和全局 reduced-motion 兜底；移除确认无源码使用点的 `.ai-title-aurora` 无限动画。
- `web/src/lib/canvas-theme.ts`：为画布增加玻璃面板、边框、高光和阴影 token，保留原有节点与工具栏颜色结构。
- `web/src/components/layout/app-top-nav.tsx`、`web/src/components/layout/user-status-actions.tsx`：导航和账户操作接入玻璃表面体系，补充当前页语义、焦点状态和 44px 触控区。
- `web/src/app/(user)/canvas/components/canvas-assistant-composer.tsx`、`canvas-toolbar.tsx`、`canvas-zoom-controls.tsx`：统一输入区、底部 dock 和缩放控件的玻璃表面、阴影和焦点反馈。
- `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：画布顶部栏接入玻璃表面；拖拽初始位置改用 `Map`；全屏预览补充 dialog 语义、前后切换标签、焦点环和键盘可见音量滑块。
- `web/src/app/(user)/canvas/components/canvas-prompt-chip-input.tsx`：提示词编辑器补充 focus-visible 反馈。
- `web/src/app/(user)/page.tsx`、`assets/page.tsx`、`asset-library/page.tsx`：非首屏图片启用异步解码和懒加载。
- `web/src/app/(user)/video/page.tsx`：历史视频默认 `preload="none"`，避免列表初始化时抢占媒体资源。
- `web/src/extensions/glass-ui/prompt-preview.ts`：新增展示层摘要函数，折叠连续空白，限制约 120 个字符并保留原始提示词不变。
- `web/src/components/prompts/prompt-card.tsx`、`prompt-detail-dialog.tsx`、`prompt-select-dialog.tsx`：卡片只显示标题、日期、标签和三行摘要；点击卡片进入完整提示词详情，只有“使用此提示词”才执行选择。
- `web/src/components/prompts/prompts.test.ts`：增加摘要边界、空白折叠和空文本覆盖。
- `web/src/app/(user)/page.tsx`、`web/src/app/(user)/canvas/components/canvas-side-panel.tsx`：首页提示词展示和画布侧栏提示词列表也统一使用摘要；首页卡片点击进入完整提示词详情，避免只有独立提示词页才有正确展示逻辑。
- `web/src/app/(user)/image/page.tsx`：修复可拖动工作流按钮首次渲染时服务端与客户端位置不一致造成的 hydration warning。
- `web/src/extensions/glass-ui/settings-popover.tsx`、`glass-ui.module.css`：新增基于 Radix Portal 的玻璃浮层、进入/退出动画、选中态、焦点态和 reduced-motion 兼容，修正旧 Portal CSS 选择器不匹配问题。
- `web/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx`、`canvas-video-settings-popover.tsx`、`canvas-audio-settings-popover.tsx`：统一改用玻璃设置浮层，移除重复 Portal 和旧的不透明浮层结构。
- `web/src/components/image-settings-panel.tsx`、`video-settings-panel.tsx`：参数按钮、输入框接入统一表面和 `aria-pressed` 选中语义。
- `web/src/app/(user)/image/page.tsx`、`video/page.tsx`：工作台容器接入玻璃表面，同时保留已有业务逻辑。
- 本轮继续收口：降低工作台内部卡片叠层的实色感，首页背景只保留轻量环境光；图片/视频工作台在窄屏下保持工具栏可换行；生成提交增加同步锁，避免双击创建重复任务；参考素材删除按钮在触屏上常驻、桌面端支持键盘聚焦；结果操作按钮补充可访问名称并扩大命中区；生成图片和视频增加媒体读取失败提示。
- 提示词库继续收口：卡片按钮重置浏览器默认样式并移除按钮内的块级容器，筛选项统一为 40px 高的胶囊控件；详情弹窗区分“复制提示词”和“使用此提示词”；外层选择弹窗关闭时清理详情状态；分页遇到空页或全重复页时停止继续请求；搜索框补充可访问名称。

保留已关闭的首页宣传轮播及其组件，方便后续有明确需求时恢复；本次没有重新启用或删除它。

## 验证结果

- TypeScript：使用项目内 Node 运行 `tsc --noEmit` 通过。
- 摘要 smoke test：3 个边界用例通过。
- Next.js：生产构建通过，20 个静态页面生成成功。
- 浏览器：当前本地首页、图片工作台和视频工作台控制台错误数均为 0；桌面和移动 Lighthouse 的 Accessibility、Best Practices、SEO、Agentic Browsing 均为 100。
- 性能：首页 trace 的 LCP 约 202ms、CLS 0；仍可观察到浏览器通用的 forced reflow insight，本轮未发现由玻璃样式新增的长任务或布局偏移。
- 之前已完成的接口验证继续保留：本地 `/api/health` 返回 200，未授权存储访问接口返回 401。
- `git diff --check` 通过。Prettier 检查仍报告工作区既有多文件格式差异，本次没有执行全文件格式化，以避免覆盖其他定制改动。
- 本轮复核：TypeScript 和 Next.js 生产构建再次通过；Playwright 在首页、图片、视频 375/768/1280 视口下检查无横向溢出，三页控制台错误数为 0；未登录访问提示词库会正确跳转登录页。

未验证项：当前环境没有 Go 与 Bun 可执行文件，因此 `go test ./...` 和 Bun 定向测试未能执行；真实登录后的提示词详情、管理员页面操作、真实 OSS/CDN、外部视频生成和生产部署也未验证。
