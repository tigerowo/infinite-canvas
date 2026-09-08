# 0012 微鑫画布品牌与 PostgreSQL 配置

## 目标与边界

将用户可见品牌统一为“微鑫画布”，替换指定 Logo，并为本地部署预填 PostgreSQL 连接参数。密码不写入仓库，由部署者自行填写。

## 已修改

- 用户界面、登录页、管理后台、画布默认名称和导出默认文件名中的“无限画布”改为“微鑫画布”。
- 将 `C:\Users\91202\Pictures\logo.png` 复制到 `web/public/logo.png`，页面 Logo 和素材/提示词默认图片改用该资源。
- 本地 `.env` 配置为 PostgreSQL：主机 `121.36.72.181`、端口 `5432`、数据库 `huabu`、用户名 `huabu`；密码保存在本地环境文件中，不进入仓库。
- `.env.example` 增加同一连接格式示例，不包含真实密码。
- NewAPI 渠道的备注名称不再预填 `NewAPI`，新增或首次配置时留空，由用户自行填写；协议仍默认选择 NewAPI。
- 首页宣传卡片仅在前端通过 `SHOW_HOME_BANNERS = false` 隐藏，卡片组件、数据和扩展配置保留，改为 `true` 即可恢复。
- New API 自动配置链接保留为兼容入口，但改为直接写入 `localChannels` 的固定 NewAPI 渠道；不再由该入口单独写入旧的顶层 `baseUrl`、`apiKey` 字段。

## 数据库行为

项目现有 GORM 初始化会连接指定数据库并执行已有模型的 `AutoMigrate`。本次没有新增表，也没有修改 NewAPI 数据库；如果 `huabu` 是与 NewAPI 共用的数据库，应在启动前确认两套程序的表名、权限和数据隔离方式。

## 验证结果

- 使用配置连接远程 PostgreSQL 成功，确认数据库为 `huabu`、当前用户为 `huabu`。
- 后端已使用 PostgreSQL 配置启动，`GET /api/health` 返回 HTTP 200。
- GORM 自动迁移成功，当前生成 18 张项目业务表；未执行 NewAPI 数据迁移，也未覆盖已有表。
- 密码未在命令输出、日志或文档中显示。

后续如需切回 SQLite，只需恢复 `STORAGE_DRIVER=sqlite` 和对应 `DATABASE_DSN`；远程数据库中的数据会保留。
