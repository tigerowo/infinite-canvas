# EXT-0041 不透明自适应窗口与 Agent 设置收口

状态：实现、生产构建、本地与 3000 新容器浏览器验证全部通过。基线 `ecdbbd3`。

## 目标

工具、图像、视频、音频、摄像机设置统一不透明；节点编辑框与设置窗口去掉原生和按钮手动缩放，随内容和可用区域适配。节点窗口限制在画布区域，不遮挡右侧文本对话。新建配置的文本接口默认 Responses；工具菜单删除重复自动提交开关及说明，保留 Agent 设置中的原开关。

## 接入与取舍

- `web/src/extensions/glass-ui/settings-popover.tsx`、`glass-ui.module.css`：统一表面、内容高度、视口与画布边界；移除 `surface` 分支和缩放组件。
- `web/src/extensions/glass-ui/node-panel-layout.ts`：节点窗口按实际画布区域定位及限制尺寸。
- `web/src/app/(user)/canvas/components/canvas-node.tsx`：Portal 由节点持有，在这里接入可用区域和内容尺寸监听，移除手动缩放。
- `canvas-node-prompt-panel.tsx`、`canvas-config-composer.tsx`：现有提示词编辑器改内容高度、不透明底色，不能仅靠 Portal 的尺寸修复内层固定高度。
- `canvas-assistant-composer.tsx`：删除工具菜单里的重复开关和说明；`canvas-assistant-panel.tsx` 保留唯一配置入口并提高对话区域层级。
- `canvas-camera-control.tsx`、`canvas-video-settings-popover.tsx`：移除已经不再需要的表面参数，统一服从共享窗口；摄像机按容器宽度切换两列/四列，标签随内容换行。
- `web/src/app/(user)/page.tsx`、`web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`：既有默认值入口改为 Responses；画布区域增加稳定定位标识。

上述未给出目录的组件位于 `web/src/app/(user)/canvas/components/`。上游同步时核对 Portal 的区域测量、尺寸监听、右侧面板层级和默认值合并，避免恢复全视口定位或固定编辑器高度。

无新增存储或数据库迁移。保留用户已经保存的 Chat 选择和自动生成状态；仅缺失配置及新配置使用 Responses。保留节点本体缩放和左右侧栏宽度分隔线，它们不属于本轮所指的窗口缩放按钮。窄屏对话占满屏幕时优先显示对话，收起对话后可使用节点编辑框。

## 验证

| 检查 | 结果 |
| --- | --- |
| `bun test src/extensions/glass-ui/node-panel-layout.test.ts src/extensions/model-capabilities/reasoning.test.ts` | 4 项通过；覆盖画布边界、缩窄、对话占满视口及原强度设置 |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 通过 |
| 画布隔离浏览器 | Responses 默认选中、手动 Chat 保留、唯一自动生成开关可操作；节点正文随长短增长/收紧，编辑框/设置无缩放把手，右侧对话采样点无遮挡 |
| 画布边界与窄屏 | 节点编辑框与图像/摄像机设置在画布区域内，摄像机内容无横向溢出；390px 收起对话后窗口宽度自动适配，摄像机两列展示 |
| 首页 715px/390px 深浅主题 | 工具、图像、视频三类窗口均不透明、无手动缩放、无横向溢出、未越出视口 |
| 原首页回归 | `repair-ui-smoke.mjs` 通过，含 Skill、模型选择聚焦、687px/390px 布局和游客边界；已同步删除旧重复开关的测试预期 |

命令在 `web/` 下执行，Bun 使用本地 `.runtime/bun/node_modules/bun/bin/bun.exe`。浏览器采用独立上下文与虚构账号/API 拦截，没有真实模型请求或用户数据写入。临时定向脚本：`C:/Users/91202/AppData/Local/Temp/huabu-adaptive-check.mjs`、`huabu-tools-check.mjs`；截图和日志：`D:/dradar-temp/huabu-ui-0041/`。实际模型的 Responses 支持仍须用户按渠道验收。

已检查公共 TODO，无本轮相关完成项可移除；公共待测试文档仅登记本记录入口。

本项独立本地提交；撤销接入与扩展变更并重新构建即可回退，不删除项目数据。

## 容器更新

`docker compose build app` 完成 Next.js / Go 生产构建；`docker compose up -d --no-deps --force-recreate --pull never app` 删除旧容器 `4b43a6a20bcb` 并启动 `cf78984f0115`。镜像为 `sha256:0ab1ec777d6e318edede46001a8d7dce89e7153271e1cf5cd4a24fb8570dbc49`。

首页与 `/api/health` 返回 200，健康正文 `ok`，重启次数为 0；端口 3000 和 `./data:/app/data` 挂载保留。在新容器再次执行两份定向脚本，画布避让、内容自适应、默认 Responses、唯一自动开关，以及 715px/390px 深浅主题的工具/图像/视频窗口全部通过，无页面运行错误。证据在 `D:/dradar-temp/huabu-ui-0041/container/`。其他项目容器和数据未清理。
