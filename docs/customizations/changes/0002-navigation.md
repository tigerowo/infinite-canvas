# EXT-0002：隐藏顶部 GitHub 和登录入口

## 目标与范围

上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`。状态：已实现，页面验证通过，完整类型检查存在上游既有错误。

删除用户标注的顶部 GitHub 和登录入口；公共导航及画布共用同一入口组件，因此两处一致生效。登录页面、已登录账户菜单、管理后台及后端鉴权接口保留。这是界面显示调整，不是禁用登录能力。

## 扩展文件与上游接入

配置集中在 `web/src/extensions/navigation/config.ts`，`showGitHubLink` 与 `showLoginLink` 默认均为 `false`，改为 `true` 可恢复相应入口，无环境变量、样式或数据变更。

| 上游文件与符号 | 改动 | 必须修改的原因 | 同步检查点 |
| --- | --- | --- | --- |
| `web/src/components/layout/user-status-actions.tsx` / `UserStatusActions` | 导入扩展配置并条件渲染两个入口 | 上游组件直接渲染入口，没有可复用的显示配置接口 | 两个判断继续包住对应入口，主题、配置、版本和已登录账户行为不变 |

## 验证

- 首页浏览器 DOM 和截图确认顶部 GitHub、登录入口消失，配置、主题和版本入口仍在。
- 后端 `/api/auth/me` 返回 HTTP 200 和正常访客响应，后端及登录页面源码无改动；未进行真实账号登录操作。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false` 报告画布 `canvas-client-page.tsx:4362` 的三条滑块类型错误（TS2322、两条 TS7031）。通过 TypeScript 编译器读取修改前的 `UserStatusActions` 源码进行对照，得到同样三条错误；本项未引入新诊断。
- 已检查上游 TODO 和待测试文档，定制验证集中在本记录，不重复添加公共功能条目。

## 提交与回退

独立提交主题：`feat(ext-navigation): 隐藏顶部 GitHub 和登录入口`。恢复配置即可重新显示入口；完整回退时撤销上游两处条件和配置导入，再移除扩展配置。无数据迁移。启动生成的 `web/next-env.d.ts` 改动不属于本项提交。
