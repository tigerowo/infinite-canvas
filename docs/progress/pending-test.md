---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

+ ComfyUI 直连：系统设置 → 私有配置 →「ComfyUI 服务地址」填写默认地址与额外服务端，模型渠道新建 ComfyUI 渠道时不选 Bridge，粘贴 API JSON 后「拉取参数」应能推断字段并保存。
+ ComfyUI 直连生成：用直连渠道跑一条图片工作流，任务应从排队变为成功并在画布显示产物；参考图应自动上传到 ComfyUI 的 input 目录。
+ ComfyUI 服务端绑定：给工作流选择「执行服务端」后生成应打到该服务端；删除该服务端后保存设置，再生成应回落到默认地址。
+ ComfyUI 鉴权：服务端开启 Bearer 鉴权时填写 API Key 应能提交成功；Key 不会回显到前端。
+ ComfyUI Bridge：仍绑定 Bridge 的 comfyui 渠道应保持原行为，不看默认地址。
