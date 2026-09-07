# EXT-0001：扩展目录及规则初始化

## 目标与范围

在重新克隆的原版项目上建立前后端集中扩展目录、定制开发规则和逐项修改记录，不恢复旧定制功能。

上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`。

## 新增文件

- `extensions/README.md`：后端扩展入口说明。
- `web/src/extensions/README.md`：前端扩展入口说明。
- `docs/customizations/README.md`：定制文档入口。
- `docs/customizations/rules.md`：唯一的定制开发规则正文。
- `docs/customizations/changes.md`：修改记录索引。
- `docs/customizations/change-template.md`：单项修改模板。
- `docs/customizations/changes/0001-extension-foundation.md`：本记录。

## 上游文件修改清单

| 文件 | 修改 | 必须修改的原因 | 同步检查点 |
| --- | --- | --- | --- |
| `AGENTS.md` | 增加定制规则入口及适用范围，修正用户指令优先级、授权、验证和数据边界 | 确保自动化开发会发现规则，解决上游分散目录约定与本地集中扩展要求的冲突 | 保留规则入口，避免合并后恢复矛盾的目录、验证或授权要求 |
| `docs/index.md` | 增加定制文档入口链接 | 使原有文档索引能找到新的规则和修改记录 | 保留有效相对链接 |

没有修改上游业务文件；没有新增路由、组件接入、配置读取逻辑、CSS、数据库模型或表迁移。上游 TODO 与待测试文档已检查，本次没有业务功能和待办变化，无需修改。

## 验证

状态：文档及目录检查已通过。

- 检查 9 份相关文档，32 个本地相对链接均能解析，未发现冲突标记。
- `git diff --check` 通过；已跟踪上游文件仅 `AGENTS.md` 和 `docs/index.md` 有改动，另新增 7 份 Markdown 文档，没有业务代码改动。
- 新仓库克隆基线与已查询的远端 `main` 均为上述提交；Git reflog 确认本轮重新克隆。
- Bun、Go、前端 `node_modules` 均保留；新旧 `web/package.json` 和 `web/bun.lock` 哈希一致，保留依赖对应同一份依赖声明。
- 新仓库不存在旧 `data/infinite-canvas.db` 和 `web/.next`。
- 此次没有业务改动，不执行应用构建或功能测试，不宣称服务已启动。规则后续需要在具体定制功能中验证执行效果。

## 提交与回退

本项组织为一个本地提交：`docs(extensions): 建立独立扩展目录与定制开发规则`。不推送远端。

可通过 `git log -- docs/customizations/changes/0001-extension-foundation.md` 查找关联提交。回退本项仅撤销新增文档及两处上游文档接入，不涉及业务数据；后续已有功能依赖这些目录时需先检查关联影响。

## 工作区清理结果

原路径已重新克隆，保留并放回原 `web/node_modules`；没有把旧数据库或 `.next` 复制进新项目。用户随后批准清理，已删除旧项目 `../infinite-canvas-delete-pending/`（含旧数据库和构建产物）、`../backups/`、`../.runtime/banner-review/` 和 `../.runtime/go1.27.1.windows-amd64.zip`，并逐项确认这四个目标不再存在。

工作区顶层现在仅有新项目 `infinite-canvas/` 和 `.runtime/`。已确认新项目 Git 目录、前端 `node_modules`、Bun、Go、Go 构建缓存及 gopath 均保留。清理结果作为独立文档提交记录；撤销文档提交不会恢复已删除的旧文件。
