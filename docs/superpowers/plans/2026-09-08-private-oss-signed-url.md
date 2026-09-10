# 私有 OSS 签名读取实现计划

目标：完成私有 S3/OSS 的短时 GET 签名读取，同时保留本地、WebDAV、旧公开对象和经过鉴权的后端回退，并修复模型能力面板的 Ant Design message 警告。

- [ ] 后端使用 AWS SDK v2 的 SigV4 presigner（复用现有依赖），校验 Provider、对象归属、Bucket 和 ObjectKey，限制有效期不超过 300 秒。
- [ ] 增加 `GET /api/v1/files/:id/signed-url`，返回统一响应；错误不返回密钥或完整签名 URL。
- [ ] 收紧私有对象旧内容接口：私有 S3 对象必须鉴权并完成归属检查；公开旧 URL、WebDAV 和本地对象保持兼容。
- [ ] 前端增加签名 URL API 和按用户隔离的内存缓存，图片、媒体、下载及参考素材优先使用临时 URL，过期最多刷新一次。
- [ ] 保持浏览器原生 Range 请求，不把签名 URL再次送入微鑫画布代理，不将临时 URL写入 localforage或项目 JSON。
- [ ] 为签名器、路由权限、私有内容回退和前端 API 增加定向测试；运行 Go 测试、前端类型检查和 `git diff --check`。
- [ ] 更新后端 API、数据库边界和 customizations 记录，明确 CDN 需要单独配置，不能把 `publicBaseUrl` 直接改成任意 CDN 域名。

不修改 NewAPI，不新增数据库表，不在没有真实 OSS CORS 和 CDN 配置的情况下宣称线上直读验收完成。
