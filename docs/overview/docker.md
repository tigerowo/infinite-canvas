---
title: Docker 部署
description: 使用 Docker Compose 部署无限画布
---

# Docker 部署

如果你希望在自己的机器或服务器上运行项目，可以直接使用 Docker Compose。

## 使用发布镜像

```bash
git clone git@github.com:tigerowo/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
docker compose up -d
```

启动后访问：

```text
http://localhost:3000
```

默认管理员账号：

```text
用户名：admin
密码：.env 中的 ADMIN_PASSWORD
```

## 本地构建镜像

如果需要基于当前源码构建镜像：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

## 镜像来源与 CI

`docker-compose.yml` 默认从原作者仓库拉取发布镜像：

```text
ghcr.io/tigerowo/infinite-canvas:latest
```

fork 仓库的 CI 会把构建产物推送到自己的 GHCR（`ghcr.io/realkiro/infinite-canvas`），需要改用自建镜像时在 `.env` 中设置：

```text
IMAGE=ghcr.io/realkiro/infinite-canvas:latest
```

### 流水线

push `main`、推送 `v*` 标签或手动触发时，`.github/workflows/docker-image.yml` 依次执行：

1. 复用 `ci.yml` 的 Go 测试（含 Comfy Bridge）与前端构建作为门禁，测试不通过则不构建镜像；
2. 分别构建 linux/amd64、linux/arm64 镜像并合并为多架构 manifest，推送到 GHCR；
3. `main` 分支与版本标签都会生成 `latest`，另附短 SHA 标签；
4. 可选：把当前 `main` 同步到 `ci/upstream-sync` 分支，并向原作者仓库 `tigerowo/infinite-canvas:main` 创建或更新 PR，与上游无差异时自动跳过。

推送 GHCR 需要在仓库 Settings → Actions → General 中把 Workflow permissions 设为 **Read and write permissions**。

### 启用向上游自动 PR

该步骤默认关闭，需要两步配置后才会执行：

1. 创建 classic PAT，勾选 `repo` 与 `workflow`（同步分支包含 `.github/workflows/` 改动，缺少 `workflow` 权限会推送失败），存为仓库 Secret `UPSTREAM_TOKEN`；
2. 在 Settings → Secrets and variables → Actions → Variables 新增仓库变量 `ENABLE_UPSTREAM_PR`，值为 `true`。

启用后每次 push `main` 都会强制更新 `ci/upstream-sync` 分支并复用同一个 PR，不会重复开 PR。PR 包含 fork 的全部改动（含 CI 工作流文件）；若该工作流被合并进源作者仓库，会自动识别并跳过向上游提 PR 的步骤。

PAT 属于账号级凭据，请只在自己的 fork 仓库中配置，不要提交到代码。

## 数据目录

`docker-compose.yml` 会把本地 `./data` 挂载到容器内 `/app/data`，用于保存 SQLite 数据库、提示词数据和上传素材。

Docker 部署时建议把 `.env` 中的 SQLite 路径设置为：

```text
DATABASE_DSN=/app/data/infinite-canvas.db
```
