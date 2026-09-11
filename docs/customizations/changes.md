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
| EXT-0013 | [私有 OSS 临时签名读取](changes/0013-private-oss-signed-url.md) | 后端与前端代码已实现，真实 OSS/CORS/CDN 直读待验证 | 签名路由、存储权限、媒体解析与文档 |
| EXT-0014 | 后台 NewAPI 默认地址与画布登录保护 | 前端构建通过；真实登录与云端连通性待验证 | 设置模型、管理员设置页、用户布局与登录页 |
| EXT-0015 | [登录鉴权边界修复与隐私数据保护](changes/0015-auth-gating.md) | 前端构建通过；浏览器和后端环境验证待执行 | 用户布局、首页、图片/视频工作台、登录页 |
| EXT-0016 | [私有设置整合、存储访问与提示词分页](changes/0016-private-settings.md) | 本地测试通过；真实 OSS/CORS/CDN 和管理员页面操作待验证 | 私有配置入口、模型分类、存储访问扩展、媒体读取、提示词分页 |
| EXT-0017 | [微鑫画布前端玻璃质感与体验迭代](changes/0017-glass-ui-refresh.md) | 前端类型检查、构建、浏览器响应式与控制台已复核；Go/Bun、登录后和外部存储场景待测 | 前端视觉、动效、交互、响应式、可访问性、提示词摘要、重复提交防护和媒体失败状态 |
| EXT-0018 | [前端交互与提示词库收口](changes/0018-frontend-interaction-polish.md) | TypeScript、Next.js 生产构建和 `git diff --check` 通过；真实生成、OSS/CDN 和独立 Playwright 登录后场景待测 | Pointer Events 触控、动态工作台间距、提示词搜索性能、摘要布局、历史同步错误反馈和可访问性 |
| EXT-0019 | [玻璃表面层级收口](changes/0019-glass-surface-polish.md) | TypeScript、Next.js 生产构建、差异检查和首页响应式回归通过 | 移动导航抽屉与提示词卡片的玻璃层级 |
| EXT-0020 | [首页状态反馈优化](changes/0020-home-status-feedback.md) | TypeScript、Next.js 生产构建、差异检查和 375px 首页回归通过 | 首页提示词展示区的加载、失败、空状态和登录边界 |
| EXT-0021 | [提示词媒体容错与状态反馈](changes/0021-prompt-media-fallback.md) | TypeScript、Next.js 生产构建、差异检查和未登录响应式回归通过；已登录封面失败回退待测 | 提示词封面容错、提示词请求失败重试、首页 reduced-motion 和玻璃降级 |
| EXT-0022 | [移动端素材与摄像机控件优化](changes/0022-mobile-canvas-controls.md) | TypeScript、Next.js 生产构建、差异检查和未登录响应式回归通过；登录后画布控件待测 | 素材选择器移动端布局、封面失败占位、摄像机面板定位与键盘交互 |
| EXT-0023 | [提示词标签筛选收起展开](changes/0023-prompt-filter-collapse.md) | TypeScript、Next.js 生产构建、差异检查和未登录响应式回归通过；登录后标签数量和交互待测 | 提示词中心及画布选择弹窗的标签筛选收起、展开和键盘交互 |
| EXT-0024 | [提示词筛选视觉收口](changes/0024-prompt-filter-visual-polish.md) | TypeScript、Next.js 生产构建和差异检查通过；登录态按钮点击回归受浏览器控制接口异常影响 | 筛选胶囊样式、展开操作、提示词头部层级和模型下拉尺寸 |
| EXT-0025 | [云端模型 Key 策略与提示词库分页](changes/0025-cloud-key-and-prompt-pagination.md) | TypeScript、Next.js 生产构建和差异检查通过；Go/Bun 及登录态云端请求待具备对应运行环境后验证 | 管理员云端 Key 策略、用户渠道 Key、提示词页码分页和每页数量 |
| EXT-0026 | [管理员模型管理、存储配置与画布控件优化](changes/0026-admin-model-storage-canvas-controls.md) | Go 与 TypeScript 检查通过；Bun、生产构建和登录态管理员/真实 OSS 流程按本次验证记录复核 | 管理员模型拉取、S3 Provider 访问策略、CORS/EdgeOne 配置、画布屏幕浮层 |
| EXT-0027 | [模型选择、视频控件与存储配置修复](changes/0027-model-video-storage-ux-fix.md) | 本地构建与隔离浏览器回归通过，测试和外部环境限制见记录 | 能力匹配、空模型拦截、视频参数、摄像机与可调整窗口、NewAPI 单一配置来源、OSS 同卡片草稿与手机后台 |
| EXT-0028 | [模型选择、文本对话与提交布局修复](changes/0028-model-picker-chat-layout.md) | 前端构建、Go/Bun、浏览器交互和本地插件 17 项测试通过；线上插件更新与计费验收待执行 | 模型候选过滤、文本模型入口、Escape 隔离、窄屏提交布局；paipu 1.1.1 MD JSON 转换 |

| EXT-0029 | [媒体任务、缓存与恢复可靠性](changes/0029-media-reliability.md) | Go/Bun、类型检查、构建及隔离失败重试验证通过；真实云端、双设备、长期资源与性能基准待验收 | 视频身份扩展、Responses 终态、私有 Blob、素材恢复、历史增量队列及视频重签名 |
| EXT-0030 | [对话底栏与全站中性主题](changes/0030-composer-neutral-theme.md) | 桌面/手机定向浏览器验证通过；更多主题和弹层组合待验收 | 思考能力、模型菜单、共享中性色、点阵、节点按钮与后台表格 |
| EXT-0031 | [默认存储、ESA 与生成结果归档](changes/0031-default-storage-archive.md) | 默认配置与签名单测、隔离保存失败重试通过；七牛源站实测见 EXT-0032，TOS/CDN 待验收 | storageaccess 扩展、TOS/七牛入口、唯一默认、ESA Type A、图片视频自动归档 |
| EXT-0032 | [容器更新与真实存储联调](changes/0032-container-storage-live-check.md) | 新容器已运行，七牛读写/CORS/视频播放通过；CDN 域名、TOS 配置和真实登录上传待补齐 | 容器替换、PostgreSQL 备份、七牛云端 CORS 与真实媒体验收 |
| EXT-0033 | [首页登录状态、工具说明与 Skill 弹层](changes/0033-home-tools-skill-layer.md) | 构建、独立类型检查及定向浏览器回归通过，已更新本地容器 | 游客隐藏模型、工具分组、自动生成开关、Skill 层级与点击边界 |
| EXT-0035 | [上游 AutoDL 与媒体同步合并](changes/0035-upstream-sync.md) | 冲突处理、Go/Bun/插件、类型、构建与隔离浏览器通过；真实渠道和云清理待验收 | 上游 `163771b`，AutoDL、自动同步、默认归档目标及账号切换保护 |
| EXT-0034 | [OSS 复用、缓存与归档修复](changes/0034-oss-reuse-cache-audit.md) | 已实现并通过本地回归；真实云端和跨设备验收见记录，未替换容器 | 上传稳定身份、服务端导入、持久缓存、受保护视频、账号隔离及共享文件删除保护 |
| EXT-0036 | [Skill 独立工具栏入口](changes/0036-skill-toolbar.md) | 首页桌面/手机隔离浏览器验证通过，未替换容器 | 共享输入框将 Skill 移至设置按钮旁边 |
| EXT-0037 | [节点信息层级、导演台入口与视频时长](changes/0037-canvas-overlay-video-duration.md) | 本地实现及容器浏览器验证通过，已加载 3000，见 EXT-0038 | 节点信息置顶、导演台隐藏 GitHub、通用/NewAPI 视频最长 30 秒 |
| EXT-0038 | [本地容器更新与旧镜像清理](changes/0038-local-container-refresh.md) | 代码已提交、数据库已备份、新容器与浏览器检查通过 | 加载 EXT-0034/0036/0037，清理本项目旧镜像，数据卷保留 |
| EXT-0039 | [思考强度、中文输入与设置弹层](changes/0039-composer-input-settings.md) | 已实现；验证范围见记录 | 新模型五档手选、默认关闭、中文组合输入占位、菜单去遮挡、视频/摄像机不透明表面 |
| EXT-0040 | [QIQI New API 视频插件](changes/0040-qiqi-newapi-plugin.md) | 1.0.2 插件与画布直链归档已部署，用户反馈成功取回视频；真实关页恢复待验收 | 独立插件、画布任务后台归档和错误显示；不改 New API 核心 |
| EXT-0041 | [不透明自适应窗口与 Agent 设置收口](changes/0041-adaptive-canvas-panels.md) | 类型、布局、生产构建与浏览器检查通过；容器状态见记录 | 统一不透明、移除窗口缩放、画布区域避让、默认 Responses、删除重复自动提交入口 |
| EXT-0042 | [媒体节点交互与画布同步](changes/0042-canvas-media-sync.md) | 单元、后端、类型、构建和双浏览器回归通过，已更新本地容器 | 视频交互和比例、登录模型、移除首尾帧、跨浏览器版本合并与删除保护 |

| EXT-0043 | [统一参考素材限制](changes/0043-reference-limits.md) | 单元、类型、构建及三个入口边界测试通过，已更新本地容器 | 三类参考素材合计最多 50 个、取消音频大小上限，画布/工作台共用校验 |
| EXT-0044 | [生成失败与跨浏览器状态同步](changes/0044-generation-failure-sync.md) | 后端、单元、类型、构建及隔离页面验证通过，已更新本地容器 | 失败任务持久化、终态防回退、历史错误同步、参考图载入缓存与媒体实际比例 |

| EXT-0045 | [素材生命周期与全链路验收](changes/0045-media-lifecycle.md) | 代码实现及隔离验收完成；MySQL 上游迁移、范围闭环、真实供应商/云删除和大数据量性能仍阻断或待授权 | 去重、分享引用、续期、清理与策略预览、归档恢复、结算、素材 CAS 和跨端历史保护 |

| EXT-0046 | [画布同步闪烁修复](changes/0046-canvas-sync-flicker.md) | 已完成代码修复；新镜像启动后的登录态浏览器回归待执行 | 远端媒体快照归一化比较、画布无变化恢复抑制 |

| EXT-0047 | [工作台素材拖拽与默认模型选择修复](changes/0047-workbench-media-dnd-and-model-defaults.md) | Web 类型检查与生产构建通过；3104 登录态拖拽、缓存命中和真实渠道分类待回归 | 素材选择器统一拖拽协议、媒体 URL 稳定更新、图片/视频/文本/音频默认模型 |

| EXT-0048 | [工作台拖放、视频历史与保留页体验修复](changes/0048-workbench-history-retention-ux.md) | 类型、单元、生产构建、完整镜像和隔离浏览器拖放通过；真实历史缓存命中与登录态视觉待验收 | 本机文件拖放、终态耗时冻结、不透明工作台、保留页排版与文案 |

各项验证以正式记录为准。用户此前“ok了已经”的反馈只对应当时已运行流程，不扩大为 EXT-0011 或全部模型、计费路径通过。

后续按 [单项修改模板](change-template.md) 新建记录，不把多个功能堆入同一份日志。
