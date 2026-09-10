# 默认存储、ESA 与生成结果归档

状态：代码和本地测试完成；新容器及七牛源站实测见 [EXT-0032](0032-container-storage-live-check.md)，TOS/CDN 和完整归档链路待验收。

## 范围

- 常用新增入口仅保留火山 TOS、七牛云；保留历史 Provider 供旧文件读取。
- 独立扩展配置保存默认上传 Provider，故障不自动切换；旧配置首次使用按列表顺序确定默认。
- 私有源站签名直读、EdgeOne Type B、ESA Type A；CDN 密钥只由后端使用。
- 图片和视频自动归档，失败保留生成结果，重试只执行存储。

## 接入与数据

`extensions/storageaccess/default.go` 在现有扩展表中以独立行保存默认 Provider ID；设置接口校验只能选择一个有效默认目标。`service/storage.go` 优先使用显式默认，无默认的旧配置使用第一个有效连接。显式默认停用、超限或失效时报错，不自动切换。

`extensions/storageaccess/sign.go` 新增 ESA Type A 路径签名；`web/src/extensions/storage-access/` 同卡片编辑默认位置、读取方式、CDN 与 CORS 草稿。常用新增入口只有 TOS、七牛；Endpoint 和 Region 仍需按实际桶填写，不猜测地域或自动检测成功。已有 Provider 及旧对象依赖保护保留。

`web/src/extensions/media-reliability/archive.ts` 使用每账号归档清单和最大 2 个并发保存任务，清单只存状态及 storageKey。生成结果经现有 `/api/v1/files` 上传，明确使用管理员默认存储；不应用个人 Provider 覆盖。

图片工作台先缓存 inline 图片、保存历史，再归档；视频工作台保留已有可读结果再归档；画布通过 `canvas-archive.ts` 处理新完成和带 pending 标记的图片/视频节点。成功后保存 server key，失败保留结果和错误；重新打开页面可恢复持久化的 pending 项，已失败项由用户重试保存。

这是页面驱动归档，不是浏览器关闭后仍运行的后台归档服务。首次修复前的旧完成结果不自动全量回存；音频不自动归档。失败结果如只剩上游临时链接，仍受其有效期限制。并发去重是当前页面内保证，不能宣称跨标签页或请求已成功但响应丢失时绝不重复创建对象。

## 验证

上游 `163771b` 同步见 [EXT-0035](0035-upstream-sync.md)：新增生成图片/视频自动同步及受保护视频上传分支均显式使用管理员默认存储；已有云端 key 跳过定制归档。自动同步开关开启/关闭的失败重试浏览器回归通过。开启上游全媒体同步后音频也可自动同步，这是上游新增能力，原定制归档仍仅覆盖图片/视频。

Go 全量测试通过，覆盖默认选择持久化、多默认拒绝、停用校验、ESA 官方签名样例与地址校验；Bun 草稿和签名缓存测试通过。Playwright 验证默认单选互斥、ESA 条件字段、图片/视频保存失败后保留结果、保存重试不重新生成并更新历史 storageKey。

后续真实联调已完成七牛源站读写、云端 CORS、浏览器图片和视频 Range，证据及边界见 [EXT-0032](0032-container-storage-live-check.md)。TOS、CDN 私有回源/缓存和中文对象路径仍待验证。保存 CORS 来源或显示规则不代表规则已在云端生效。

ESA 根据[官方边缘函数 Type A 规范](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/url-authentication-by-er)实现；边缘端有效期须配置为 300 秒。此处不是日志投递使用的标态鉴权。

上游同步时核对 `service/storage.go` 的 Provider 选择、管理员设置页的新增入口和同卡片草稿、图片/视频工作台完成回调、画布节点自动及手动云同步。归档必须保留 globalOnly 参数，避免个人设置覆盖默认目标；失败不得清空生成内容或重新提交生成。回退时恢复对应接入即可，保留扩展配置及已归档对象，不自动删除云文件。
