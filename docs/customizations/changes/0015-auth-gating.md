# EXT-0015 登录鉴权边界修复与隐私数据保护

## 标识与目标

- 编号、功能名、上游基线：EXT-0015；登录鉴权边界修复与隐私数据保护；基于当前工作区上游基线。
- 需求与范围：账号数据页面必须登录；首页发送、图片/视频生成及所有重试入口必须登录；匿名状态不请求首页提示词数据。
- 状态：已验证（前端构建）。

## 扩展文件

- `web/src/app/(user)/layout.tsx`：保护画布、提示词和素材路由，并保留完整 redirect。
- `web/src/app/(user)/page.tsx`：登录后才加载提示词展示，发送前校验会话。
- `web/src/app/(user)/image/page.tsx`、`web/src/app/(user)/video/page.tsx`：生成、失败重试和历史重试统一校验有效用户。
- `web/src/components/prompts/prompt-select-dialog.tsx`、`use-prompt-list.ts`、`web/src/services/api/prompts.ts`：提示词弹窗登录拦截并携带用户 token。
- `router/router.go`：提示词 API 改为强制用户鉴权。
- `web/src/app/(user)/login/page.tsx`、`web/src/components/layout/user-status-actions.tsx`：移除重复登录切换条，保留导航登录入口。

## 上游接入清单

| 上游文件与符号 | 改动内容 | 必须修改的原因及替代方案取舍 | 上游同步检查点 |
| --- | --- | --- | --- |
| `web/src/app/(user)/layout.tsx` `protectedPrefixes` | 增加账号数据路由保护 | 复用现有布局鉴权，避免重复页面守卫 | 保留登录回跳路径和查询参数 |
| `web/src/app/(user)/page.tsx` `IndexPage` | 限制提示词请求和主页发送 | 首页入口不适合整页保护，采用操作级鉴权 | 登录后提示词展示和发送流程保持不变 |
| `web/src/app/(user)/image/page.tsx`、`video/page.tsx` | 覆盖首次生成及全部重试入口 | 重试同样会发起生成请求，不能绕过鉴权 | 已登录生成、重试行为不变 |
| `router/router.go`、提示词 API 调用方 | 提示词接口强制登录并传递 token | 前端保护不能替代后端数据访问控制 | 匿名请求返回未授权，已登录查询正常 |

## 配置、样式和数据

不新增配置项、数据表、密钥或存储命名空间。匿名状态不读取账号提示词展示数据；已有本地工作台状态仍按原逻辑保留。

## 验证

| 检查 | 命令或操作 | 结果与证据 |
| --- | --- | --- |
| 前端构建 | `npm run build`（`web/`） | 已通过；Next.js 编译、静态页面生成完成 |
| 差异检查 | `git diff --check` | 已通过 |
| TypeScript 独立检查 | `tsc --noEmit` | 未验证；环境未安装项目本地 TypeScript 二进制 |
| Go 测试 | `go test ./...` | 未验证；环境未提供 `go` 命令 |
| 浏览器登录、匿名网络请求 | 实际部署后访问受保护路由和生成/重试按钮 | 未验证 |

## 提交、回退与同步

- 提交主题：`fix(ext-0015): 收紧登录鉴权边界`；不包含其他工作区改动。
- 回退：恢复上述前端文件和本记录即可；无数据库迁移或持久化数据变更。
- 限制：真实登录回跳、过期会话和匿名网络请求需在部署环境用浏览器复测。
