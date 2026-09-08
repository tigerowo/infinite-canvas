# 定制修改记录

初始上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`，来源为 `origin/main`。

| 编号 | 变更 | 状态 | 上游影响 |
| --- | --- | --- | --- |
| EXT-0001 | [扩展目录及规则初始化](changes/0001-extension-foundation.md) | 已建立，验证见记录 | `AGENTS.md`、`docs/index.md`；无业务代码修改 |
| EXT-0002 | [隐藏顶部 GitHub 入口](changes/0002-navigation.md) | 页面验证通过；类型检查限制见记录 | `web/src/components/layout/user-status-actions.tsx` |
| EXT-0003 | [移除首页商业广告轮播](changes/0003-home-banners.md) | 页面验证通过；类型检查限制见记录 | `web/src/app/(user)/page.tsx` |
| EXT-0004 | [隐藏顶部版本号入口](changes/0004-version-entry.md) | 页面验证通过 | `web/src/components/layout/user-status-actions.tsx` |
| EXT-0005 | [修复算力点日志 Space 弃用警告](changes/0005-admin-space.md) | 组件渲染验证通过 | `web/src/app/(admin)/admin/credit-logs/page.tsx` |
| EXT-0006 | [修复 TOS 上传失败](changes/0006-s3-tos.md) | 本地测试及真实 TOS 上传读取通过 | `service/storage.go`、回归测试、`Dockerfile` |
| EXT-0007 | [修复视频模型别名分类](changes/0007-model-capabilities.md) | 前后端分类回归通过；生成验证限制见记录 | `web/src/stores/use-config-store.ts`、`service/settings.go`、回归测试 |
| EXT-0008 | [通过 NewAPI 发送 LEC Seedance 特定请求体](changes/0008-lec-video.md) | 历史实现，已被 EXT-0011 取代 | 客户端 LEC 请求分支已删除，转换移至 NewAPI 插件 |
| EXT-0009 | [素材公网 URL 与模型能力策略](changes/0009-public-media.md) | 已实现，完整兼容验证待补；登录要求、协议限制及数据表见记录 | 路由、存储、前后端分类、管理面板及图片/视频/音频/画布请求入口 |
| EXT-0010 | [视频完成后通过内容接口取回并缓存文件](changes/0010-video-content.md) | 已实现；用户反馈当前流程可用，未逐渠道复测 | `web/src/services/api/video.ts` / `cacheProtectedVideo` |
| EXT-0011 | [独立 NewAPI 默认通道](changes/0011-newapi-channel.md) | 本地实现及契约测试完成，真实插件部署和上游验收待执行 | 通道默认值、前后端调用链、视频 ID、素材与设置入口；paipu 插件源码同步 |
| EXT-0012 | [微鑫画布品牌与 PostgreSQL 配置](changes/0012-weixin-brand-postgres.md) | 品牌与配置已写入；密码、远程连接和迁移未验证 | 前端品牌资源、`.env` / `.env.example`；无新增数据表 |

各项验证以正式记录为准。用户此前“ok了已经”的反馈只对应当时已运行流程，不扩大为 EXT-0011 或全部模型、计费路径通过。

后续按 [单项修改模板](change-template.md) 新建记录，不把多个功能堆入同一份日志。
