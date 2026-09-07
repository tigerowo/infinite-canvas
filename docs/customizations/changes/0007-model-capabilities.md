# 修复视频模型别名分类

## 标识与目标

- 编号：EXT-0007；上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`。
- 状态：分类回归验证通过；页面完整生成待验证。
- `lec-mj-wan-3-0-1080p`、`lec-seed-2-0-900`、`lec-seed-2-5-900` 未命中上游关键词判断，被默认当成文本模型。
- 已核对 `https://linjing.space/api/pricing`：三个模型的说明均为视频生成，支持端点包括 `video` 或 `openai-video`。

## 扩展文件

- `web/src/extensions/model-capabilities/`：前端已确认视频别名和实际分类入口回归测试。
- `extensions/modelcapabilities/`：后端已确认视频别名。

## 上游接入清单

| 上游文件与符号 | 改动及必要原因 | 同步检查点 |
| --- | --- | --- |
| `web/src/stores/use-config-store.ts` / `isVideoModelName` | 调用扩展判断；列表、默认值与持久化恢复均使用此公共分类入口 | 保留既有协议和其他模型分类 |
| `service/settings.go` / `isVideoModelName` | 调用扩展判断；后端默认模型修复需要相同结论 | 前后端别名表一致 |
| `service/settings_model_capabilities_test.go` | 包内回归测试私有默认分类函数 | 防止视频再次成为文本 |

## 配置、样式和数据

不更改模型 ID、接口协议、密钥、数据库或样式。仅精确匹配已验证别名，不把全部 `seed` 或 `wan` 名称当成视频。已有缓存通过原有分类入口重新计算；无需删除配置。将来新增特殊别名仍需核对实际能力后更新前后端别名表。

## 验证

- `bun test src/extensions/model-capabilities/classification.test.ts`：修复前失败，修复后通过。直接测试实际 store 分类入口，三个别名进入视频列表并退出文本列表；图片、文本、未知别名、大小写及空白检查通过。
- `go test ./service ./extensions/... -count=1`：修复前别名测试失败，修复后相关包通过。
- `go build -o data/run/server.next.exe .`：通过，已启动新二进制，`http://localhost:3000/api/health` 返回 `ok`。`data/run/server.exe` 已同步为同一构建。
- `tsc --noEmit --incremental false`：仍有既有 `canvas-client-page.tsx:4362` 滑块回调的 TS2322、两条 TS7031，无本次新增错误。
- 浏览器完整生成未验证：重启后原页面显示未登录，尚未切换模型并提交真实生成任务。默认视频模型仍保留用户原选择。
- 单独的视频上游 `Model name not specified` 错误尚未确认根因；该错误与分类修正分别验证。

## 提交、回退与同步

- 独立本地提交 `fix(ext-model-capabilities): 修复视频模型别名分类`，不推送。
- 回退该提交即可恢复原分类，无数据库迁移。
- 上游 TODO 和待测试文档不追加定制明细，验证与限制集中在此记录。
