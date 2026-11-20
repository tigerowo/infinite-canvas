---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- [ ] push `main` 后流水线自动执行 Go 测试（含 Comfy Bridge）与前端构建，测试失败时不再构建镜像
- [ ] 多架构镜像推送到 `ghcr.io/realkiro/infinite-canvas`，`main` 与 `v*` 标签均生成 `latest` 及短 SHA 标签
- [ ] `docker compose up -d` 默认拉取 `ghcr.io/tigerowo/infinite-canvas:latest`
- [ ] `.env` 设置 `IMAGE` 后可切换到自建镜像
- [ ] 配置 `UPSTREAM_TOKEN` 与 `ENABLE_UPSTREAM_PR` 后，push `main` 会创建或更新到 `tigerowo/infinite-canvas` 的 PR；与上游无差异时跳过
