# EXT-0026：管理员模型管理、存储配置与画布控件优化

## 目的

集中解决管理员找不到上游模型拉取入口、存储访问配置需要先选择 Provider，以及画布缩放时参数控件跟着放大的问题。

## 实际修改

- `web/src/components/admin-model-management-panel.tsx`：增加独立模型管理区，按渠道展示协议、地址、启用状态和模型数量，支持拉取上游模型并进入现有勾选合并弹窗。
- `web/src/app/(admin)/admin/settings/page.tsx`：将模型管理区接入私有配置；S3 Endpoint、Region、Bucket 增加通用服务商填写提示；存储访问面板并入云存储与访问区域。
- `web/src/extensions/storage-access/panel.tsx`：移除“先选择 Provider”的主流程，改为每个 S3 Provider 独立展开卡片，直接编辑读取方式、CDN、EdgeOne Token B、CORS 来源和规则预览；密钥仍由后端保存并脱敏。
- `extensions/storageaccess/providers.go`：Provider 引用保护仍比较真实连接字段，但允许单独修改公开访问域名。
- `extensions/storageaccess/providers_test.go`：增加公开访问域名独立变更的回归测试。
- `web/src/app/(user)/canvas/components/canvas-node.tsx`：节点面板移到屏幕坐标 Portal，跟随节点矩形、滚动、窗口变化和节点尺寸变化重新定位，限制小屏宽度和高度。

## 验证结果

- `go test ./...`：通过，全部 Go 包测试通过。
- 完整源码副本 TypeScript 检查：通过。
- Bun 定向测试：32/32 通过。
- Next.js 16.2.9 生产构建：通过。
- `docker compose build app`：通过；随后使用新镜像重建并启动应用。
- `/api/health`：返回 200；未携带凭据访问 `/api/admin/settings`：返回 401。
- `git diff --check`：通过；Git 仅报告既有换行转换提示。
- 登录态管理员流程、真实上游模型拉取和真实 OSS/CDN 读取仍需在配置完成的浏览器环境中复核。

## 兼容与限制

- 继续使用通用 S3 字段，不增加七牛、火山或 R2 专用协议分支。
- 更换存储必须新增 Provider、保存后停用旧 Provider，避免历史素材失效。
- 不自动修改七牛、火山、Cloudflare 或 EdgeOne 控制台配置。
- 不修改 NewAPI、数据库表结构和普通用户个人存储范围。
