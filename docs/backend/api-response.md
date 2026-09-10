---
title: 接口响应约定
description: 业务接口统一响应结构与前端处理约定
---

# 接口响应约定

后端业务接口统一返回 JSON：

```json
{
  "code": 0,
  "data": {},
  "msg": "ok"
}
```

- `code`: 业务状态码，`0` 表示成功，非 `0` 表示失败。
- `data`: 业务数据。失败时通常为 `null`。
- `msg`: 响应消息。成功默认为 `ok`，失败时放错误原因。

前端请求逻辑以 `code` 判断业务是否成功。当前后端业务失败也会返回 HTTP 200，前端不要只依赖 HTTP 状态码判断结果。

接口连接失败、服务不可达、返回体不是约定 JSON 时，前端按网络或接口异常处理。
## 私有 OSS 签名读取

`GET /api/v1/files/{id}/signed-url` 需要登录凭证。后端按数据库中的对象记录校验归属，仅对私有 S3 Provider 返回短时 GET URL；响应数据包括 `url`、`expiresAt`、`mimeType` 和 `bytes`。临时 URL 不应持久化或写入日志。

管理员接口 `GET /api/extensions/storage-access` 返回每个已保存 S3 Provider 的私有读取配置；`PUT /api/extensions/storage-access/{providerID}` 保存 CORS 来源、OSS 直读或 EdgeOne Type B 选项。密钥只允许写入，不通过响应返回；跨域规则由前端生成预览，仍需管理员在 OSS/CDN 控制台应用。
