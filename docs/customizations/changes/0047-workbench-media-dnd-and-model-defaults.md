---
title: 工作台素材拖拽与默认模型选择修复
---

# 工作台素材拖拽与默认模型选择修复

## 问题

- 生图和视频工作台只能通过点击素材选择器插入，无法复用画布的拖拽素材协议。
- 图片历史卡片使用临时 URL 作为 React key，签名地址变化时会重建媒体元素。
- 视频历史媒体在历史同步后没有主动跟随新的存储地址解析。
- 管理员模型设置把“默认模型”与默认文本模型重复展示，选项首位还出现空白的“自动选择”，没有独立的默认音频模型。

## 修改

- 素材库和我的素材卡片统一写入 `application/x-infinite-canvas-asset` 拖拽数据并复用已有类型校验。生图工作台接受文本和图片；视频工作台接受文本、图片、视频和音频。
- 移除图片结果卡片按 URL 设置的 React key；媒体地址变化只更新 `src`，不强制重建组件。
- 视频媒体组件在存储标识或地址变化后重新解析本地缓存/有效地址，保留失败重试。
- 管理员设置按图片、视频、文本、音频四类展示默认模型，去掉空白选项，并新增 `defaultAudioModel` 配置字段；服务端和客户端均做能力校验。

## 验证

- Web TypeScript 检查通过。
- Next.js 生产构建通过。
- `reference-limits.test.ts`：4 项通过；`canvas-sync.test.ts`：9 项通过。
- Docker 生产镜像构建通过，包含 Go 编译；`go test -timeout 180s ./...` 和 `go test -race -timeout 240s ./...` 均通过。
- 3104 最终已替换为 `infinite-canvas:lifecycle-experience-fix-7`，沿用原 PostgreSQL 环境、`lifecycle-validation` 网络和 `lifecycle-stage-data` 数据卷；登录页和健康检查返回 200。
- 隔离浏览器真实执行了生图和视频工作台的本机文件 `drop`：生图上传请求到达 `/api/v1/files`，视频生成请求携带了参考图 multipart；未调用收费供应商。
- 四类默认模型及下拉无空白项已用隔离浏览器验证；3104 实际渠道分类仍需管理员登录后确认。
