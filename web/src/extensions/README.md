# 前端扩展目录

本目录是前端定制实现的唯一主目录。已接入的功能及验证状态统一见修改记录。

`newapi/` 为独立默认通道的配置、通用图片/视频请求和回归测试；原 `lec-video/` 已移除，LEC 转换交由 NewAPI 插件。

每项功能按 `web/src/extensions/<feature>/` 集中放置组件、hooks、状态、API 调用和私有样式。Next.js 必须放在 `app/` 下的路由入口仅承担必要接入职责。

完整目录、样式和配置约定见 [定制开发规则](../../../docs/customizations/rules.md)，改动须关联 [修改记录](../../../docs/customizations/changes.md)。
