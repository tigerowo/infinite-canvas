# EXT-0027 模型选择、视频控件与存储配置修复

## 标识与目标

- 编号：EXT-0027。
- 日期：2026-09-09。
- 定制上游基线：`51c4503b2c53e237b2fe67c65711b51ae5deb762`；实施分支：`fix/model-video-storage-ux`。
- 范围：修复空模型生成、能力过滤、视频参数、摄像机、窗口尺寸和管理员配置。沿用既有 NewAPI 协议与存储扩展，不修改数据库表结构或云服务控制台。
- 状态：三轮实现、自检与本地回归完成；真实上游生成和真实 OSS/CDN 读写未执行。

## 实际变更

### 模型与请求

- 画布图片、视频、文本、音频入口统一调用 `resolveModelForCapability`。云端仅选择当前可用且能力匹配的模型，去掉过期默认值和空列表时的硬编码回退。
- 后台默认模型显示“自动选择”，选项按能力过滤。服务端保留空默认值，不再自动写入列表第一项或错误能力的模型。
- 后端文本默认模型排除音频/TTS 等名称，与前端识别保持一致；旧音频默认值不会继续作为文本默认模型返回。
- 无可用模型时，画布显示对应提示并打开配置入口，不发送生成请求。
- `createVideoGenerationTask` 和 NewAPI 请求构造器拒绝空白模型。后端已有 JSON/multipart 空模型检查，本次增加回归测试验证该检查，并未重复增加另一套校验。
- 上游模型拉取拒绝 HTML、缺失 `data` 的响应；合法空列表正常返回，模型名称去除两端空白并去重。

### 视频与画布交互

- 删除画布视频设置中的首尾帧分组及专用选择组件。新任务忽略旧首尾帧、Kling 图片节点排序字段；历史元数据结构继续可读，普通连接参考素材继续生效。
- 通用视频时长选项改为 6、10、12、15 秒，自定义上限 15 秒；NewAPI 请求也校验该范围，原有专用直连模型规则继续保留。
- 比例、清晰度、时长和自定义尺寸使用蓝色边框、淡蓝背景及内描边；选项保留 `aria-pressed`，输入增加可访问名称。
- 摄像机复用 Radix 弹层，关闭按钮与 Escape 可关闭并恢复触发按钮焦点；阻止 Escape 向父节点窗口冒泡。
- 共享弹层与节点提示词窗口支持原生尺寸调整及 44px 拖动手柄，手柄也支持方向键调整。尺寸按屏幕像素计算；内容过长时滚动，弹层使用 Radix 可用高度和边缘避让。
- 节点参数窗口使用 ResizeObserver、受限的祖先样式观察和合并后的动画帧更新；清理监听，位置相同不重复更新状态。正在编辑的节点不因视口裁剪而卸载。
- 配置节点内容改为容器响应式布局，节点本身仍可四角缩放。点击单选标签等交互控件不再触发节点拖动。

### 管理员配置

- 删除可视化编辑中的 NewAPI 默认地址卡片；新增渠道地址为空，实际地址和 Key 只来自渠道卡片。旧 JSON 字段仅兼容读取，不参与请求或新渠道默认值。
- OSS 的连接字段和读取策略、CDN、Token B、CORS 放在同一 Provider 卡片。保留新增、删除、启停与容量统计；不自动插入空 Provider。
- 新草稿使用稳定 `clientKey`，提交普通配置前移除该字段；保存后按服务端规范化身份字段映射 Provider ID。删除中间项、编辑连接和列表重排不再导致访问草稿串用。
- 存储访问控制器在页签和可视化/JSON 切换时保留草稿，首次进入私有可视化编辑才加载。基础保存成功、扩展失败时保留草稿供顶部按钮重试。
- 容量统计只合并容量数据，不覆盖当前其他未保存字段。未保存 Provider 不可统计容量。
- 手机后台使用导航抽屉，避免固定侧栏挤压表单。

## 扩展文件

| 文件 | 职责 |
| --- | --- |
| `web/src/extensions/storage-access/draft.ts`、`draft.test.ts` | Provider 草稿身份、规范化映射及 CORS/CDN 校验 |
| `web/src/extensions/storage-access/panel.tsx` | 页面级访问草稿控制器和同卡片字段 |
| `web/src/extensions/glass-ui/settings-popover.tsx`、`panel-resize-handle.tsx`、`glass-ui.module.css` | 统一弹层、调整尺寸、焦点、选中状态和边界 |
| `web/src/extensions/newapi/request.ts`、`request.test.ts` | 通用 NewAPI 请求防护与协议回归 |
| `web/src/extensions/model-capabilities/classification.test.ts` | 四类能力、自动选择、过期模型和空列表回归 |
| `handler/ai_model_required_test.go` | 视频代理空模型边界 |
| `web/src/app/(user)/canvas/components/canvas-node-generation.test.ts` | 历史帧字段兼容与新任务不采用旧帧配置 |

## 上游接入清单

| 文件与符号 | 改动和必要性 | 上游同步检查点 |
| --- | --- | --- |
| `web/src/stores/use-config-store.ts` / `resolveModelForCapability` | 校验当前可用模型，空云端列表返回空值 | 能力策略、云端可用模型与直连兼容 |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 统一模型解析、生成前拦截、移除新任务帧字段、保留活动编辑节点 | 不恢复旧硬编码默认模型和帧请求 |
| `canvas-node-prompt-panel.tsx`、`canvas-config-node-panel.tsx` | 同一解析入口、配置节点布局 | 模式切换后对应能力模型 |
| `canvas-node.tsx` | 屏幕浮层、尺寸调整、定位观察与交互命中范围 | Portal 事件隔离、监听清理、节点拖动 |
| `canvas-node-generation.ts`、`canvas-video-settings-popover.tsx` | 移除首尾帧设置与新任务组装 | 保留旧数据类型与普通参考素材 |
| `canvas-camera-control.tsx`、图像/音频设置弹层 | 接入共享弹层、触发区域至少 44px | 开关、焦点和响应式 |
| `web/src/components/image-settings-panel.tsx`、`video-settings-panel.tsx` | 自定义选中状态、时长范围、比例判断 | 不覆盖专用直连模型规则 |
| `web/src/services/api/video.ts` | 创建任务前拒绝空白模型 | 任务轮询兼容 |
| `web/src/app/(admin)/admin/settings/page.tsx` | NewAPI 收口、默认模型过滤、OSS 同卡片与保存草稿 | 顶部统一保存、脱敏和部分失败 |
| `web/src/app/(admin)/admin/layout.tsx` | 小屏导航抽屉 | 桌面菜单保留、手机宽度不被挤占 |
| `web/src/services/api/admin.ts` | 浏览器临时 Provider 身份类型 | 不将临时键存入服务端普通设置 |
| `service/settings.go` | 自动默认模型、严格模型列表解析 | 名称规范化、有效空列表与 HTTP 错误 |

## 配置、样式和数据

`ext_storage_access` 表、批量保存与脱敏机制继续保留。空 Token 表示沿用服务端已保存密钥；草稿 `clientKey` 仅用于浏览器表单关联。更换存储账号或服务商仍使用新增 Provider、保存、停用旧 Provider 的方式，已被对象引用的 Provider 继续禁止删除或覆盖连接。公开域名和 CDN/CORS 修改不等同于连接迁移。

本次没有数据迁移，不写七牛、火山或 EdgeOne 控制台；CORS 只提供规则预览。玻璃样式限于既有交互表面，保留 reduced-motion。

## 验证

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| Go 全量 | `docker run --rm --mount type=bind,source=D:/huabu/ruanjian/infinite-canvas,target=/app,readonly huabu-api-test:local go test ./...` | 通过；含模型列表成功/空/401/404/非 JSON/超时、空模型、存储权限与脱敏等测试 |
| Bun 全量 | `docker run --rm --mount type=bind,source=D:/huabu/ruanjian/infinite-canvas/web,target=/app/web,readonly -w /app/web oven/bun:1.3.14 bun test` | 39 通过，0 失败 |
| TypeScript | `./web/node_modules/.bin/tsc --noEmit --pretty false -p web/tsconfig.json` | 通过；独立于 Next.js 构建的类型跳过设置 |
| 生产构建 | `docker compose up -d --build` | 已构建 Next.js 16.2.9 并重建本地容器 |
| HTTP 边界 | 本地 `/api/health`、未登录 `/api/admin/settings`、`/api/extensions/storage-access` | 分别为 200、401、401 |
| 管理员保存 | 隔离 Playwright 接口夹具 | OSS 删除中间项、切换页签/JSON、扩展保存失败后重试不丢草稿；每次保存各一次普通设置、模型策略、存储批量请求 |
| 渠道模型 | 隔离 Playwright 接口夹具 | 拉取、预览、勾选合并仅更新页面草稿；顶部保存前没有设置写入 |
| 空模型 | 浏览器空渠道列表后点击生成 | 提示缺少视频模型并打开配置入口，生成 POST 数量为 0 |
| 缩放与尺寸 | 节点窗口键盘调整、节点拖动、5% 与 500% 缩放 | 窗口宽度保持 606px，位置随节点变化；配置节点四角拖动从 440×240 改为 536×304 |
| 弹层和主题 | 深浅主题；375、768、1280px；摄像机开关、Escape、尺寸手柄；图片、视频、音频面板 | 通过；实际生产容器复测，375px 视频面板 x=12、宽 351px，顶部/横向均未越界，自定义秒数蓝色选中 |
| 配置节点模式 | 鼠标依次切换文本、音频、生图、视频 | 通过；四个模式选中状态和对应模型同步，无拖动吞点击 |
| 私有扩展加载 | 公开设置后进入私有设置 | 通过；存储访问请求由 0 次变为 1 次，切换屏幕宽度没有重复加载 |
| 差异检查 | `git -c core.safecrlf=false diff --check` | 通过；保留既有工作区修改 |

浏览器写操作全部使用隔离测试用户与接口夹具，测试模型名与 OSS 地址均为测试数据，没有改动真实管理员配置。未执行真实付费生成、真实 OSS 上传/容量统计、跨服务商迁移读写或 CDN 鉴权端到端请求，也未进行大规模节点压力基准；测试通过不等同于这些外部环境均已验收。

## 提交、回退与同步

- 未提交、推送或部署远程环境；工作区保留既有定制修改，不把整个脏工作区归入本次变更。
- 回退时逐项撤回上述接入点及本条新增扩展，保留既有存储表和历史画布数据；不要整体回退 `service/settings.go` 或管理员页面以免移除此前定制。
- 后续上游同步重点复核模型分类、视频协议、Provider 规范化身份、Radix 弹层和 Pointer Events。
