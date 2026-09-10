# EXT-0025：云端模型 Key 策略与提示词库分页

## 目的

让管理员只维护云端接口和模型渠道，按需选择统一 Key 或用户自带 Key；同时把提示词库改为可控制的页码分页，降低长列表加载和筛选状态混乱。

## 实际修改

- `model/setting.go`、`service/settings.go`：增加公开模型渠道 `apiKeyMode`，兼容旧配置并默认使用管理员 Key。
- `service/user_data.go`、`handler/ai.go`：增加按公开渠道 ID 读取用户 Key 的云端渠道选择逻辑。用户 Key 模式只使用管理员发布的 Base URL、协议和模型列表，Key 为空时返回明确错误；管理员模式继续使用私有渠道 Key。
- `web/src/services/api/admin.ts`、`web/src/app/(admin)/admin/settings/page.tsx`：后台增加“云端渠道 API Key 使用方式”选项。
- `web/src/stores/use-config-store.ts`、`web/src/components/layout/app-config-modal.tsx`：用户配置增加 `remoteChannelKeys`；用户 Key 模式显示只读渠道信息和按渠道填写的 Key，统一 Key 模式不要求用户填写。
- `web/src/components/prompts/use-prompt-list.ts`：将提示词查询改为 `useQuery` 的显式 `page/pageSize` 查询，并为后续页保留第一页的分类和标签元数据。
- `web/src/app/(user)/prompts/page.tsx`、`web/src/components/prompts/prompt-select-dialog.tsx`：移除滚动触底加载，增加页码、每页数量选择和响应式分页底栏。
- `web/src/components/prompts/prompts.test.ts`：删除无限滚动辅助函数测试，增加页数计算边界测试。

## 验证

- `npx tsc --noEmit`：通过。
- `npm run build`：通过，Next.js 生产构建完成。
- `git diff --check`：通过；Git 仅提示既有文件的换行转换警告。
- `go test ./...`：当前环境未安装 Go，未执行。
- Bun 定向测试：当前环境未安装 Bun，未执行。
- 浏览器中的登录态真实云端 Key 请求和管理员保存操作：待在具备有效账号与渠道配置的环境中验证。

## 兼容与限制

旧用户配置继续按原字段读取。用户 Key 会随登录用户配置同步保存，用于后端代理请求；管理员 Key 不通过公开设置接口下发。当前没有修改 NewAPI、OSS 或外部控制台配置。
