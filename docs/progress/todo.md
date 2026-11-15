---
title: TODO
description: 当前项目后续值得处理的事项
---

# TODO

本文档用来记录当前项目后续比较值得处理的事项。

+ ComfyUI 直连产物地址目前直接用服务端 `/view` 链接，开启 Bearer 鉴权的服务端需要浏览器能直连该地址；后续可加服务端媒体代理。
+ ComfyUI 直连渠道只能用 API JSON 拉取参数，尚未支持从服务端扫描工作流目录或把画布 JSON 自动转成 API JSON。
+ ComfyUI 服务端目前只由管理员在系统设置里维护，个人渠道只能选用系统服务端，暂不能配置自己的服务端。
+ ComfyUI 直连的视频参考素材仍只接受公开 HTTPS 链接（`comfy:` 文件名沿用旧逻辑），本地视频节点传 data URL 会被拒绝。
+ 画布取消直连任务只会把任务标记取消，不会中断 ComfyUI 里已排队的 prompt；后续可对接 `/queue` 与 `/interrupt`。
