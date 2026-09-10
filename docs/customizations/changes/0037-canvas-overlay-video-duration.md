# EXT-0037 节点信息层级、导演台入口与视频时长

## 需求与方案

- 节点信息弹窗当前与固定提示词编辑框同为 1000 层级，可能被后出现的编辑框遮挡；将该弹窗提升到画布现有浮层之上。
- 3D 导演台仅提供已构建的静态包，通过扩展专用样式移除 GitHub 按钮的展示与交互，保留关闭入口。
- 通用视频设置和 NewAPI 请求校验的自定义时长上限由 15 秒统一调整为 30 秒。供应商专用模型的限制不因通用输入上限变化而扩展。

## 必要接入与同步检查

| 路径 | 符号与改动 | 接入原因、同步检查点 |
| --- | --- | --- |
| `web/src/app/(user)/canvas/components/canvas-node-hover-toolbar.tsx` | `CanvasNodeInfoModal` 设置 `zIndex={2100}` | 弹窗由该组件创建，必须直接设置层级；高于编辑框 1000、工具/Skill 1200–1400 和全屏画布浮层 2000 |
| `web/public/director/index.html` | 加载 `/extensions/director-ui/overrides.css` | 导演台 iframe 独立文档不继承主站样式，需在静态入口加载；更新导演台构建包时保留扩展样式链接 |
| `web/public/extensions/director-ui/overrides.css` | 精确限定导演台顶部 GitHub 按钮 `display:none` | 避免改写含第三方依赖的压缩包；隐藏后无可视、鼠标或键盘入口，关闭按钮保留；上游标签变化时复核选择器 |
| `web/src/components/video-settings-panel.tsx` | 通用 `NumberInput` 的 `max` 改为 30 | 首页、画布、工作台复用此面板；失焦钳制与底部快捷设置的 30 秒保持一致 |
| `web/src/extensions/newapi/request.ts` | `createNewAPIVideoRequest` 校验 1–30 整数秒 | UI 放开后请求层不能再拒绝 16–30 秒；JSON、单图 multipart 和 Canvas v1 均发送原值 |

未改数据库、依赖或运行配置。回退只撤销以上接入和对应测试，删除扩展样式；保留上一轮 OSS 与 Skill 修复。

## 验证结果

- NewAPI 契约测试 11 项通过；新增边界覆盖 1、16、30 秒的 JSON 与 multipart、30 秒 Canvas v1，以及 0、31、小数、非数字的拒绝。
- 独立 TypeScript 检查通过。
- 隔离浏览器画布测试通过：提示词编辑器保持展开时，节点信息的多个采样点均由弹窗接收命中，JSON 切换和关闭正常；截图 `D:/dradar-temp/huabu-repair-smoke/huabu-node-info-topmost.png`。
- 导演台浏览器检查通过：GitHub 不在可访问按钮列表中，关闭与视角切换保留，无页面运行错误；截图 `D:/dradar-temp/huabu-repair-smoke/huabu-director-no-github.png`。
- 视频浏览器检查通过：自定义 30 秒失焦保留，31 秒收回 30 秒；切到底部布局提交时，捕获 `/api/v1/videos` 的 JSON 仍为 `seconds: "30"`；保存失败恢复不重复生成，1038px/390px 视口无横向溢出。
- 首次并发编译页面时 `/video` 曾返回 `Unexpected end of JSON input`；同一实现重新加载后完成全部断言，未修改业务数据来规避该错误。

## 使用范围与待验收

本轮不替换运行中的 3000 容器，新界面在 `http://127.0.0.1:3001`。自动化通过模拟渠道验证请求内容，没有执行真实付费生成。30 秒是通用/NewAPI 软件输入上限，不代表所有供应商模型都支持：Kling、Seedance、Gemini 等原生专用规则以及 paipu 的固定时长模型校验保留。真实 30 秒生成需选择上游明确支持该时长的模型。

已同步 NewAPI 接口契约、修改索引及待测试文档；公共 TODO 无需新增事项。
