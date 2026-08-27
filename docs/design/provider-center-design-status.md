---
title: 连接中心设计状态
description: STITCH 交付核对与代码侧视觉基线
---

# 连接中心设计状态

## 当前结论

连接中心正式 STITCH 设计版本已确认为 `provider-center-v1`。设计复用私有项目 `16311479161257811593` 的 `CanvasMind Creative Workspace` 设计系统，设计系统 ID 为 `assets/c6395985d33e4ea9b9788efd56caedc7`、版本为 `1`。

参考仓库 `preparation/stitch/` 已包含桌面主稿、390px 窄屏列表、窄屏编辑表单、状态规范页、对应 HTML、设计 token 与交付说明。代码侧已完成首轮布局对稿，仍待用户最终像素和交互确认。

早期 `brief-fallback` 只保留为设计形成前的历史基线，不再作为当前正式设计版本。

## 已执行的代码侧基线

- 页面保持工作台式信息密度，不增加 Hero、营销文案、渐变或装饰性背景。
- 容器与卡片圆角不超过 8px，桌面使用表格，窄屏使用列表卡片。
- API 与 CLI 使用一级 Tab；密钥、连接状态、默认渠道、迁移入口和安全边界在主流程内可见。
- 补齐 RunningHub 独立协议说明、引用格式与连接检测语义。
- CLI 可执行程序改为 helper 检测结果只读字段，并明确不会执行用户填写路径。
- 零个已连接时使用中性状态点，避免误显示为健康状态。

## 正式 STITCH 交付清单

| 交付项 | STITCH Screen ID | 参考仓库文件 |
| --- | --- | --- |
| 桌面连接中心与编辑抽屉 | `0c0e8c354eea4f889046175de979daaa` | `provider-center-desktop-v1.*` |
| 390px 窄屏渠道列表 | `2f885297d0e44eb4b6ae07c66cfa7243` | `provider-center-mobile-list-v1.*` |
| 390px 窄屏编辑表单 | `53fad7d83ec24d648a85f9d8ed358779` | `provider-center-mobile-edit-v1.*` |
| 状态与反馈规范 | `03d5a004619741768b7e88612a614f65` | `provider-center-states-v1.*` |
| 设计 token | 不适用 | `provider-center-design-tokens-v1.json` |
| 版本与实施说明 | 不适用 | `provider-center-delivery-v1.md` |

## 下一步对稿范围

1. 桌面表格行高、列宽、长模型名截断及 440px 右侧抽屉密度。
2. 390px 独立卡片、两行模型信息、底部状态与开关、全屏编辑表单和无横向溢出。
3. 加载、空、未测试、测试中、不可用、禁用及错误映射。
4. Codex CLI 逐次确认与 Gemini/即梦只检测安装版本的能力边界。
5. 深浅色主题与项目现有 Ant Design token 的映射。

STITCH HTML 只用于视觉核对，不直接替换现有 Next.js、Ant Design 和 Tailwind 实现。
