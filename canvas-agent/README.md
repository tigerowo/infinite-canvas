# Canvas Agent

网页对话通过本地服务运行 Codex，插件通过同一个 MCP 操作画布。工具定义、节点操作和生成流程继续使用网页现有实现。

## 启动

安装 Node.js 22+ 后，在终端执行，npx 会从 npm 获取服务及依赖：

```sh
npx -y @tigerowo/canvas-agent@latest
```

首次启动自动生成 Token，保存在当前用户的 `~/.infinite-canvas/codex-agent.json`；下次启动复用。终端显示 `Local URL` 和 `Connect token`，默认地址为 `http://127.0.0.1:3210`。网页与服务在同一台电脑运行，不需要克隆仓库或手工创建 `.env`；正确 Token 连接后自动记录网站来源。

Codex 尚未登录时执行 `npx -y @openai/codex@0.153.4 login` 并完成登录，已有登录态会直接复用。

## 插件自动连接

在 Codex 所在电脑执行：

```sh
codex plugin marketplace add https://github.com/tigerowo/infinite-canvas.git
codex plugin add canvas-agent@infinite-canvas
```

安装后新建 Codex 对话，说“帮我打开并连接到 Infinite Canvas”。插件优先使用当前对话提供的画布地址或原画布标签；无法确定站点时再询问地址。

插件市场定义在仓库根目录的 `.agents/plugins/marketplace.json`，指向仓库内的 `canvas-agent` 插件目录。市场名 `infinite-canvas` 仅为安装标识；插件由 GitHub 获取，MCP 和连接 Skill 通过 npx 使用 npm 上的服务，无需进入插件缓存安装依赖。

插件会启动服务、自动带入连接信息，并通过 MCP 确认目标画布。已有画布优先复用原浏览器标签；标签不可控时使用 `npx -y @tigerowo/canvas-agent@latest open "<画布URL>" <浏览器> [浏览器参数...]`。浏览器支持 `chrome`、`edge`、`firefox`、`brave` 和 `default`，保持原浏览器及配置；画布地址沿用实际的 `/canvas/[id]` 路由。浏览器的本地网络权限提示由用户允许。

移除插件执行 `codex plugin remove canvas-agent`。

## 直接注册 MCP

与插件安装二选一：

```sh
codex mcp add infinite-canvas -- npx -y @tigerowo/canvas-agent@latest mcp
```

直接注册 MCP 不包含自动打开 Skill，需要先启动服务并连接画布。移除时执行 `codex mcp remove infinite-canvas`。

## 本机配置与范围

`npx -y @tigerowo/canvas-agent@latest config` 输出 `{url, token, origins}`，首次尚未启动时会提示先启动服务。HTTP `GET /config` 只返回 `{url, hasToken}`；Token 和包含它的连接链接不要分享。

`CANVAS_AGENT_TOKEN`、`CANVAS_AGENT_PORT`、`CANVAS_AGENT_ORIGINS` 可选环境变量覆盖 Token、端口和预置来源；更改后重启服务。通常无需设置。

外部 MCP 默认只操作唯一已连接的画布；多个画布连接时，通过 MCP 环境变量 `CANVAS_AGENT_CLIENT_ID` 明确目标。断开连接会结束对应 Codex 进程，已提交的生成任务仍由现有画布流程处理。

默认权限为 `workspace-write` 与 `on-request`，工作目录为实际 Agent 包目录。服务不写 Codex 全局配置文件；其他全局 MCP 是否合并到当前会话尚未联调确认。
