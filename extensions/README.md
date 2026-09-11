# 后端扩展目录

本目录是 Go 后端定制实现的唯一主目录。`s3compat/` 提供 TOS 的 S3 请求寻址适配；`modelcapabilities/` 提供模型别名分类、策略接口和独立表 `ext_model_policy`；`publicmedia/` 提供素材归属校验及 S3 签名链接接口。具体实现和验证结果见 [修改记录](../docs/customizations/changes.md)。

`newapi/` 提供独立协议、严格视频结果解析，以及 `plugin/paipu.js`、`plugin/qiqi.js` 插件源码；安装要求和迁移步骤见 [EXT-0011](../docs/customizations/changes/0011-newapi-channel.md) 与 [EXT-0040](../docs/customizations/changes/0040-qiqi-newapi-plugin.md)。

每项功能按 `extensions/<feature>/` 集中放置；共享内容仅在实际复用时提取。目录划分、接入方式、配置及数据边界见 [定制开发规则](../docs/customizations/rules.md)，改动须关联 [修改记录](../docs/customizations/changes.md)。
