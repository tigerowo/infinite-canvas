# 定制开发

本项目从 [wudiazui/infinite-canvas 的 main 分支](https://github.com/wudiazui/infinite-canvas/tree/main) 重新克隆，初始上游基线为 `51c4503b2c53e237b2fe67c65711b51ae5deb762`。

本轮从无定制功能开始，旧修改记录不恢复。后续新需求及其实际实现以修改记录索引为准。

- [开发规则](rules.md)：功能目录、最小接入、配置、样式、数据及同步原则。
- [修改记录索引](changes.md)：当前已实施变更及其上游文件影响。
- [单项修改模板](change-template.md)：每项功能建立独立记录，随同实现提交。
- [界面、存储、逻辑与性能修复文档](ux-storage-simplification-design.md)：全部用户标注、12 项补充问题、全站配色范围、修复目标与验收条件，业务修复尚未实施。
- [软件发往 NewAPI 的接口文档](newapi-interface-contract.md)：上游插件对接用，按文本、图片、视频、音频列出实际 HTTP 端点、参数、素材格式和返回要求。
- [界面、逻辑与性能排查](ux-logic-performance-audit.md)：补充问题、全站配色范围、优先级与验证限制，尚未修复。
- [NewAPI 执行计划](newapi-channel-plan.md)及[正式记录](changes/0011-newapi-channel.md)：默认通道、通用请求、插件交付、迁移和验证边界。
- [后端扩展目录](../../extensions/README.md)。
- [前端扩展目录](../../web/src/extensions/README.md)。

前后端定制均已接入，具体功能与验证状态见修改记录索引。当前已有模型策略及素材签名链接接口、独立表 `ext_model_policy`；未建立通用扩展加载器。素材传输与模型分类配置见 [EXT-0009](changes/0009-public-media.md)，视频完成后取回文件的修复见 [EXT-0010](changes/0010-video-content.md)。
