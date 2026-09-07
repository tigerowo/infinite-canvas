# 定制开发

本项目从 [wudiazui/infinite-canvas 的 main 分支](https://github.com/wudiazui/infinite-canvas/tree/main) 重新克隆，初始上游基线为 `51c4503b2c53e237b2fe67c65711b51ae5deb762`。

本轮从无定制功能开始；旧品牌、Logo、导航和轮播修改不属于当前需求，也不恢复旧修改记录。新的需求从新的独立记录开始。

- [开发规则](rules.md)：功能目录、最小接入、配置、样式、数据及同步原则。
- [修改记录索引](changes.md)：当前已实施变更及其上游文件影响。
- [单项修改模板](change-template.md)：每项功能建立独立记录，随同实现提交。
- [后端扩展目录](../../extensions/README.md)。
- [前端扩展目录](../../web/src/extensions/README.md)。

当前只建立目录和文档约定，没有扩展加载器、已注册的定制路由、定制数据库表或功能开关。具体功能确定后再增加必要实现。
