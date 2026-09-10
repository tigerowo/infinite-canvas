# EXT-0039 思考强度、中文输入与设置弹层

状态：已实现，7 项相关测试、类型检查、生产构建及隔离浏览器验证通过。基线为 `5a00a76`，实现提交 `08d9b96`；已按用户后续授权替换 3000 端口 Docker 容器。

后续窗口行为由 [EXT-0041](0041-adaptive-canvas-panels.md) 收口：工具/图像等设置全部不透明、移除窗口手动缩放并限制节点窗口在画布区域。本记录中的“保留尺寸调整”和“仅视频/摄像机不透明”是当时实现，不代表后续版本。

## 目标与原因

- 新增文本模型也提供关闭、低、中、高、极高、最高；移除模型名白名单。关闭表示不主动传思考参数，由用户选择模型支持的档位。
- 中文输入组合阶段隐藏占位文字，避免拼音与“发送消息”叠字；候选确认回车不发送消息。
- 移除思考按钮与菜单重叠的 Tooltip，菜单按视口空间自动上下避让。
- 视频设置、摄像机弹层使用模型菜单相同的不透明主题底色，保留碰撞检测、滚动和尺寸调整。

## 扩展与接入

- `web/src/extensions/model-capabilities/reasoning.ts`：五档、关闭与旧值兼容、请求字段。
- `web/src/extensions/glass-ui/settings-popover.tsx`：增加不透明表面选项，继续由 Radix 定位。
- `web/src/extensions/model-capabilities/reasoning.test.ts`：菜单和协议字段回归。
- `web/src/extensions/media-reliability/repair-ui-smoke.mjs`：原首页回归的默认按钮标签更新为关闭。

| 上游文件与符号 | 改动及必要性 | 同步检查点 |
| --- | --- | --- |
| `canvas-assistant-composer.tsx` / `CanvasAssistantComposer` | 调整现有菜单标签与 Tooltip；菜单由此组件持有 | 默认关闭、五档可选、无遮挡、设置写回 |
| `canvas-prompt-chip-input.tsx` / `CanvasPromptChipInput` | 原编辑器持有组合事件及占位 DOM，只能在此接入组合状态 | 输入中不叠字、不提交；取消后占位恢复 |
| `canvas-video-settings-popover.tsx` / `CanvasVideoSettingsPopover` | 为现有共享弹层选择不透明表面 | 视频参数交互与上下避让 |
| `canvas-camera-control.tsx` / `CanvasCameraControl` | 为现有共享弹层选择不透明表面 | 摄像机开关、选项与上下避让 |

上述上游组件均在 `web/src/app/(user)/canvas/components/`。不复制组件到扩展目录。

## 配置与兼容

低、中、高、极高、最高依次传 `low`、`medium`、`high`、`xhigh`、`max`；根据现有协议发送 Chat、Responses 或 Gemini 字段。用户自行选择模型支持的档位，不声称每个模型都接受五档。MiMo 维持原协议的思考启用字段。

新配置默认关闭、不传字段。旧 `auto` 归一为关闭，旧 `minimal` 归一为低，旧布尔启用设置继续兼容为高。沿用项目 `agentConfig` 持久化，无新数据表或存储迁移。不透明样式仅用于视频和摄像机，浅色主题沿用浅色不透明底色。

## 验证与回退

| 检查 | 操作与结果 |
| --- | --- |
| 根因复现 | 修改前浏览器组合输入期间仍显示占位文字；点击思考菜单后 Tooltip 与选项同时存在。新规则单测先出现 2 项预期失败，再实施修复 |
| 模型与强度测试 | `web/` 下执行 `D:/huabu/ruanjian/.runtime/bun/node_modules/bun/bin/bun.exe test src/extensions/model-capabilities`，7 项通过；覆盖默认不传、旧设置兼容、新模型五档、切换模型与协议字段 |
| 类型检查 | `web/` 下执行 `node node_modules/typescript/bin/tsc --noEmit --incremental false`，退出码 0 |
| 中文输入 | Chromium CDP `Input.imeSetComposition` 模拟拼音输入，验证占位隐藏、候选确认回车不发送、提交中文和取消后占位恢复 |
| 思考菜单 | 六项（关闭加五档）均可点击；未知模型可选最高，切换 Gemini 保留最高；无思考 Tooltip 遮挡，390px 菜单在视口内 |
| 视频和摄像机 | 1038px / 390px、深浅两种主题均通过；背景与 `--popover` 相同、无背景模糊、面板未超出视口，摄像机开关可用 |
| 定位 | 在隔离页面将真实触发按钮移至上下边缘，思考/视频/摄像机分别向可用一侧展开；正常画布底部入口也验证向上展开 |
| 现有首页回归 | 运行 `repair-ui-smoke.mjs`，Skill 选择/编辑、工具设置、模型菜单外部点击聚焦、687px/390px 及游客入口通过；无 pageerror |

浏览器验证使用 `http://127.0.0.1:3001`，独立浏览器上下文、虚构账号与 API 拦截，不调用真实模型或写入用户数据。定向脚本保存在本机临时目录 `C:/Users/91202/AppData/Local/Temp/huabu-composer-check.mjs` 和 `huabu-panel-check.mjs`；截图及原首页回归日志位于 `D:/dradar-temp/huabu-ui-0039/`。Playwright 使用本机 Codex 缓存运行时；这些临时材料不作为跨机器测试依赖。

操作系统输入法候选窗口、真实模型对各档位的支持仍需人工验收；关闭表示软件不主动指定强度，不保证上游模型完全不思考。已检查公共 TODO，无相关完成项可迁移；公共待测试文档增加本记录入口。

## 本地容器更新

- 用户后续明确要求删除旧容器、启动新容器。`docker compose build app` 完成 Next.js 与 Go 生产构建；`docker compose up -d --no-deps --force-recreate --pull never app` 删除旧容器 `4b8ae722609d`，启动新容器 `4b43a6a20bcb`。
- 新镜像为 `sha256:3ff0def714d61b2c212d6de1fbfda7943fc94757be96499fc278d03227c76942`；容器名 `infinite-canvas`、端口 3000、`./data:/app/data` 持久化挂载保留。未清理其他项目容器或数据卷。
- 首页和 `/api/health` 均返回 200，健康接口正文 `ok`；新容器运行中，检查时重启次数为 0。
- 在 3000 新容器上重新运行隔离浏览器检查：中文组合输入、五档/关闭、新模型、切换模型、菜单无 Tooltip 遮挡、上下避让、390px 菜单和不透明视频弹层通过，无页面运行错误。截图在 `D:/dradar-temp/huabu-ui-0039/container/`。

本项为独立本地提交，未推送；回退代码后需重新构建并替换容器，保留项目数据。
