# EXT-0013 私有 OSS 临时签名读取

## 目的

让私有 S3/OSS 的媒体正文由浏览器直接读取，减少微鑫画布服务器的出口流量，同时保留本地、WebDAV 和旧公开对象兼容。

## 已修改

- 增加受保护的 `GET /api/v1/files/{id}/signed-url`。
- 使用 AWS SDK v2 SigV4 生成最长 5 分钟的 GET 签名 URL。全局配置保存时至少需要一个完整可用的 OSS Provider，允许配置多个 OSS；非 OSS Provider 不计入全局云存储。
- 签名前校验对象归属；旧内容接口对私有 S3 对象同步执行鉴权，避免代理回退绕过权限。
- 图片和媒体解析器共用按当前会话隔离的内存临时 URL 缓存，不把签名写入项目或 localforage；用户切换账号时清空缓存。
- 修复 model-capabilities 面板使用静态 Ant Design `message` 的上下文警告。

## 未完成的线上条件

需要在实际 OSS 上配置私有 Bucket、CORS 和正确的 S3 Endpoint 后再做真实直读验证。CDN 需要独立的签名和回源配置，`publicBaseUrl` 仍保持公开 URL 语义，不能直接替换成任意 CDN 域名。

## 验证

- `go test ./extensions/storageaccess ./extensions/s3compat ./extensions/modelcapabilities ./service ./handler ./router` 通过。
- 签名 URL、对象归属、Qiniu 地址形式和 OSS 最低配置测试通过。
- 前端 TypeScript 检查和相关 Bun 回归测试通过；未执行真实 OSS 下载、CDN 回源、CORS 应用或生产部署。

