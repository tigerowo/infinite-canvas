# EXT-0038 本地容器更新与旧镜像清理

用户授权提交当前修改、停止旧容器、清理旧镜像并运行最新版本。

## 已执行

- 代码提交 `bbc1c86`，包含 EXT-0034、0036、0037 及配套文档；仅本地提交，未推送。
- 使用当前源码执行 `docker compose build app`，Go 后端和 Next.js 前端构建成功。
- 更新前通过 PostgreSQL 18 `pg_dump -Fc` 备份实际数据库，并用 `pg_restore --list` 检查备份可读取。文件位于 Git 忽略目录 `data/extensions/mediaarchive/backups/pre-bbc1c86/database.dump`，不写入仓库。
- `docker compose up -d --no-deps --force-recreate --pull never app` 停止并替换旧应用容器，保留同名 `infinite-canvas` 和 3000 端口；`./data:/app/data` 挂载及原数据库配置保留。
- 当前镜像 `sha256:f8d0075f2cd74f71d76d3c5a67d3e21960299170cb4e3798647dce3ec11329b6`，应用代码对应 `bbc1c86`。
- 删除 `huabu-web-check:local`、`huabu-rollback:before-storage-integration`、`huabu-api-test:local`、`infinite-canvas:verification`、`infinite-canvas-web-check:latest` 五个旧测试/回退镜像。旧运行镜像 `db42961cd336` 在替换后已不存在，删除命令返回不存在，最终镜像列表再次确认无该镜像。
- 其他项目容器、镜像、数据库和数据卷未清理；没有运行全局 prune。

## 验证与边界

- `http://127.0.0.1:3000/api/health` 返回 200 `ok`，首页、导演台入口和新增扩展样式返回 200。
- 新容器运行正常，检查时重启次数为 0。
- 在 3000 新容器上运行隔离浏览器回归：首页 Skill、桌面/手机布局、游客边界、节点信息置顶与 JSON/关闭、导演台 GitHub 隐藏、30 秒请求和视频保存失败恢复均通过，无页面运行错误。
- 浏览器生成/存储测试使用模拟 API，不代表真实收费模型或 OSS 上传全链路验收；此前记录中的真实云端待验收项仍保留。

本记录取代 EXT-0034、0036、0037 中“3000 未更新”的部署状态。现在直接访问 `http://localhost:3000` 使用新版本；3001 仅为开发预览，不是正式使用入口。

## 回退

旧镜像已按用户要求删除，若需回退应从所需 Git 提交重新构建应用。数据库备份保留，恢复备份会覆盖之后新增数据，不能自动执行。新扩展表不要求为代码回退而删除。
