# 定制修改记录

初始上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`，来源为 `origin/main`。

| 编号 | 变更 | 状态 | 上游影响 |
| --- | --- | --- | --- |
| EXT-0001 | [扩展目录及规则初始化](changes/0001-extension-foundation.md) | 已建立，验证见记录 | `AGENTS.md`、`docs/index.md`；无业务代码修改 |
| EXT-0002 | [隐藏顶部 GitHub 入口](changes/0002-navigation.md) | 页面验证通过；类型检查限制见记录 | `web/src/components/layout/user-status-actions.tsx` |
| EXT-0003 | [移除首页商业广告轮播](changes/0003-home-banners.md) | 页面验证通过；类型检查限制见记录 | `web/src/app/(user)/page.tsx` |
| EXT-0004 | [隐藏顶部版本号入口](changes/0004-version-entry.md) | 页面验证通过 | `web/src/components/layout/user-status-actions.tsx` |

后续按 [单项修改模板](change-template.md) 新建记录，不把多个功能堆入同一份日志。
