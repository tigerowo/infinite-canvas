# 后端扩展目录

本目录是 Go 后端定制实现的唯一主目录。`s3compat/` 提供 TOS 的 S3 请求寻址适配；没有新增路由或数据库结构。具体实现和验证结果见修改记录。

每项功能按 `extensions/<feature>/` 集中放置；共享内容仅在实际复用时提取。目录划分、接入方式、配置及数据边界见 [定制开发规则](../docs/customizations/rules.md)，改动须关联 [修改记录](../docs/customizations/changes.md)。
