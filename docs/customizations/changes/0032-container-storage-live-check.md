# 容器更新与真实存储联调

状态：新容器已运行；七牛源站上传、签名读取、浏览器跨域和视频播放已通过。CDN、TOS 及登录后完整上传操作仍待补齐实际配置或登录状态。

## 容器与备份

- 已执行 `docker compose build app` 和 `docker compose up -d --no-deps --force-recreate app`，旧应用容器由 Compose 删除并替换，新容器继续使用 `infinite-canvas` 名称及 3000 端口。
- 更新前镜像保留为 `huabu-rollback:before-storage-integration`。本轮构建镜像 ID 为 `sha256:00e099053f804fbf7fec63e9937f32a3dd9055e1a6f442cb2a4a4664ec548316`。
- 实际数据源是 PostgreSQL 18，并非工作目录里的旧 SQLite 文件。使用 PostgreSQL 18 客户端完成自定义格式备份，`pg_restore --list` 可读取；备份目录为 `data/extensions/storage-access/backups/pre-integration-20260910/`。其中环境配置包含凭据，不应公开或提交。
- 新容器 `/api/health` 返回 200 `ok`，首页返回 200。首页及后台设置页使用隔离 API 数据完成布局/交互冒烟验证；这部分不代表真实登录和外部 API 通过。

## 七牛实测

当前可用配置为七牛 `wxsh6`，Endpoint 为 `https://wxsh6.s3.cn-east-1.qiniucs.com`，Region 为 `cn-east-1`。另一个 Provider 仍是空草稿，没有可测试的 TOS 配置。CDN 读取方式尚未启用。

测试使用现有应用源代码中的 `service.UploadStorageObject`、`publicmedia.Presign`、`service.DownloadStorageObject` 及真实数据库和七牛凭据。维护程序以内存用户上下文调用服务层，不修改管理员密码、不签发生产登录令牌；因此上传成功不等同于已经验证生产 HTTP 登录上传全流程。

| 检查项 | 实测结果 |
| --- | --- |
| 图片上传与签名 GET | 68 字节 PNG 上传成功；HTTP 200、SHA-256 一致、MIME 正确 |
| 视频上传与签名 GET | 1526 字节、160×90 WebM 上传成功；HTTP 200、SHA-256 一致、MIME 正确 |
| 源站及应用服务层 Range | `bytes=0-15` 返回 206，16 字节内容一致，Content-Range 正确 |
| 浏览器图片读取 | localhost 和 127.0.0.1 的 3000 端口均通过 fetch、图片解码和画布像素读取 |
| 浏览器视频读取 | 两个来源均能播放，进度正常推进并可跳到 0.6 秒 |
| 匿名/伪造签名 | 不带签名返回 400 `NotSupportAnonymous`；篡改签名返回 403 `SignatureDoesNotMatch` |
| CDN | 软件配置没有域名和鉴权，未进行 CDN 回源、缓存或签名验收 |

视频由本地浏览器生成，仅用于联调，没有调用收费模型。图片与视频测试对象及数据库索引均已清理，两个对象的源站签名读取均返回 404；本地清单中的签名 URL 也已清空。

## 已修复的云端 CORS

初次查询七牛 S3 `GET /?cors` 返回 404，表示桶没有跨域规则；实际签名 GET 虽然返回 200，但不带允许来源响应头，OPTIONS 返回 403。

通过七牛兼容 S3 API 备份原状态后新增读取规则：

- 来源：`http://localhost:3000`、`http://127.0.0.1:3000`。
- 方法：GET、HEAD；允许请求头 Range。
- 暴露响应头：ETag、Content-Length、Content-Range、Accept-Ranges；MaxAgeSeconds 为 300。
- 更新返回 200，回读成功；七牛将两个来源展开为两条规则。传播完成后，两种来源的浏览器读取和 OPTIONS 均通过。

没有开放任意来源或匿名读取，也没有调整桶 ACL。软件内 AllowedOrigins 草稿仍需在管理员登录后同步，云端实际规则与软件里的规则预览不是同一份配置。原始 CORS 响应备份在 `data/run/storage-live/cors-before.xml`，状态码在同目录 `cors-before-status.txt`；原状态为无规则，回退仅撤销本轮新增规则，不能覆盖后续人工修改。

协议依据：[七牛 S3 兼容 API](https://developer.qiniu.com/kodo/4087/compatible-s3-api)、[七牛 CORS 配置说明](https://developer.qiniu.com/kodo/8539/set-the-cross-domain-resource-sharing)。

## 剩余条件与验证边界

- 提供实际素材 CDN 域名，明确 EdgeOne 或 ESA，并配置对应鉴权和私有回源；不要复用 NewAPI 服务域名。再验证合法/错误/过期签名、缓存命中、Range、CORS 和源站保护。
- TOS 需要实际 Bucket、Region、Endpoint 和凭据后才能测试；密钥填写在本地后台，不写入文档或聊天。
- 容器重启后原登录状态需重新验证。环境文件中的管理员初始化密码不等于现有数据库密码，本轮未重置密码；登录后补验 `/api/v1/files`、签名接口、默认存储保存和自动归档完整操作。
- 本轮只覆盖小型测试媒体，不覆盖大文件分片、长视频、多并发、签名自然到期、中文自定义对象路径或全部生成模型。

本次未修改应用业务代码；临时联调工具和测试清单位于 Git 忽略目录 `data/run/storage-live/`。容器运行仍使用既有持久卷和数据库配置，其他项目容器保持原状。
