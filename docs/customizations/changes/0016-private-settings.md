# EXT-0016 私有设置整合、存储访问与提示词分页

## 目标与边界

状态：本地实现与自动化验证通过；七牛云、EdgeOne 控制台配置及真实浏览器联调待完成。基于当前工作区，保留已有登录保护、品牌及 NewAPI 修改。

- 模型与素材传输入口移入私有配置；导入云端模型后，逐行点击右侧类型选择文本、图片、视频或音频，也可恢复自动识别。
- 保留现有模型策略唯一数据源 `ext_model_policy`。高级视频请求格式按已配置渠道和模型选择，说明默认标准接口与 Canvas v1 插件协议的区别。
- 私有配置增加按 OSS 独立保存的跨域来源和 CDN 访问设置。CORS 提供规则预览与复制，由管理员在目标 OSS/CDN 控制台应用；保存画布配置不宣称云端规则已生效。
- 系统设置只保留顶部“保存设置”；渠道、模型策略和存储访问都先修改页面草稿，再由一次顶部保存提交。
- 提示词分页按 `updated_at DESC, id ASC` 稳定排序，前端跨页按 ID 去重；后续页不重复加载完整标签，封面启用懒加载。
- 默认 OSS S3 临时签名直读；可选择 EdgeOne Token B，密钥仅后端保存，空值沿用，不回传。接入到现有对象归属校验后的签名路径。
- 不修改上游配置表结构。新增扩展表 `ext_storage_access`，以已有 Provider ID 关联，同一 PostgreSQL 数据库内保存。

## 实施与验收计划

1. 核对 EdgeOne 域名、回源、现有鉴权规则和官方协议。
2. 完成模型面板移动、模型行类型控件、高级视频格式说明。
3. 完成独立存储访问配置 API/UI、CORS 规则生成及 EdgeOne 签名接入。
4. 验证密钥隐藏/保留、来源校验、签名路径/过期时间和类型检查；检查真实页面。
5. 同步实际改动、上线前外部配置和未验证限制，不将本地测试当作 OSS/CDN 联调成功。

## 当前 EdgeOne 核对

控制台站点为 `weixinshihui.com` 免费版；已有加速域名 `ml.weixinshihui.com` 回源 IP，尚无七牛对象存储加速域名、无已保存的规则。规则编辑器提供 Token 鉴权入口。此次仅查看，不保存云端配置。

## 本轮实际改动

- `extensions/storageaccess/`：新增私有存储访问配置扩展、`ext_storage_access` 表、OSS 必配校验、来源校验、EdgeOne Token B 签名和脱敏接口。
- `web/src/extensions/storage-access/`：新增私有配置面板、OSS 选择、直读/EdgeOne B 选择、CORS JSON/XML 预览和签名 URL 缓存。
- `service/storage.go`、`handler/storage.go`、`router/router.go`：在对象归属校验后签发临时 URL，保护旧文件读取路径，并让前端优先直读 OSS/CDN。
- `extensions/s3compat/endpoint.go`：兼容七牛虚拟主机式 S3 Endpoint，避免重复拼接 Bucket。
- `web/src/extensions/model-capabilities/` 与管理员设置页：把模型与素材设置放入私有配置；导入后的模型逐行选择文本、图片、视频、音频或自动识别；NewAPI 视频格式单独说明标准接口与 Canvas v1 插件协议。
- `repository/prompt.go`、`service/prompts.go`、`web/src/components/prompts/`：修复同一更新时间导致的分页边界重复，增加前端 ID 去重、分页缓存、窗口聚焦策略和封面懒加载。
- `web/src/app/(admin)/admin/settings/page.tsx`：渠道抽屉“完成”只更新草稿；模型策略与存储访问区域延迟到进入私有可视化配置后加载；顶部“刷新”统一刷新基础设置和已挂载扩展。
- `extensions/storageaccess/handler.go` 与 `web/src/extensions/storage-access/`：新增 `PUT /api/extensions/storage-access` 批量保存接口，继续保留单 Provider 接口；访问设置和 CORS 预览合并到“云存储与访问”区域。
- `extensions/storageaccess/providers.go`、`service/settings.go`：有素材引用的旧 Provider 不能被删除或改连线，只能新增 Provider 后停用旧 Provider；新旧对象按 Provider ID 分别读取。
- `docs/backend/`、`docs/progress/` 及本目录变更记录：同步接口、数据表、验收边界和外部配置步骤。

NewAPI 核心仓库没有改动；软件只负责发送统一 NewAPI 请求，LEC 等供应商字段转换仍由 NewAPI 的对应插件处理。

## 验证与接入清单

已通过：Go `go test ./...`、前端 TypeScript `tsc --noEmit`、Bun 定向测试 29 项、NewAPI 插件回归 15 项、Next.js 生产构建和 `git diff --check`；本地后端重启后健康接口返回 200，存储访问 GET/PUT 未授权请求返回 401；管理员设置未授权跳转页未请求模型策略或存储访问扩展。首页性能实测桌面 LCP 约 202ms、移动端约 491ms，CLS 为 0。

仍待外部配置后验证：真实管理员页面操作、七牛 CORS 应用、EdgeOne 私有 S3 回源/Type B 规则及浏览器视频 Range 读取。上述外部操作尚未由本次代码修改自动完成。
