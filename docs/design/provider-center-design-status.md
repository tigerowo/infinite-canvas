---
title: 连接中心设计状态
description: STITCH 交付核对与代码侧视觉基线
---

# 连接中心设计状态

## 当前结论

连接中心正式 STITCH 设计版本已确认为 `provider-center-v1`。设计复用私有项目 `16311479161257811593` 的 `CanvasMind Creative Workspace` 设计系统，设计系统 ID 为 `assets/c6395985d33e4ea9b9788efd56caedc7`、版本为 `1`。

参考仓库 `preparation/stitch/` 的交付清单包含桌面主稿、390px 窄屏列表、窄屏编辑表单、状态规范页、对应 HTML、设计 token 与交付说明。代码侧已完成第二轮布局和 token 对稿，并已使用登录后的真实 Provider 数据完成桌面、390px、深浅色和编辑抽屉的最终视觉复核。

STITCH 桌面屏幕把“连接中心”标题应用为 48px `display-hero`，但版本 1 设计 token 明确定义页面标题为 24/32、700；代码以设计 token 为准，避免把连接中心做成独立于其他工作台的营销式 Hero。深色正式屏幕之外，现已在同一设计系统下生成桌面、390px 列表和 390px 编辑表单的正式浅色变体；浅色稿只改变语义色映射，不改变已确认的信息架构和密度。

早期 `brief-fallback` 只保留为设计形成前的历史基线，不再作为当前正式设计版本。

## 已执行的代码侧基线

- 页面保持工作台式信息密度，不增加 Hero、营销文案、渐变或装饰性背景；页面标题采用 token 指定的 24/32、700。
- 桌面表格按 33% / 17% / 20% / 16% 的主要列宽分配，并保留 76px 启用列和 48px 操作列；中号表格使用 16px 纵向、24px 横向单元格内边距，长模型名稳定截断。
- 390px 页面使用 16px 横向留白、16px 卡片间距、16px 卡片内边距和 12px 卡片圆角；模型信息使用标签加单行 180px 截断，状态固定在底部右侧，开关和受控操作放在右上。
- 连接中心主容器显式隐藏横向溢出，窄屏隐藏表格，编辑抽屉保持桌面 440px、窄屏不超过 `100vw`。
- 抽屉控件高度统一为 40px，桌面使用 24px、窄屏使用 16px 水平内边距，表单项间距收敛为 16px。
- 深浅色连接中心 token 集中在 `web/src/lib/app-theme.ts`：深色画布 `#0F0F12`、深色表面 `#0E1416` / `#1A2122`、浅色页面 `#F8F9FA`、浅色表面 `#FFFFFF`、强调色 `#00CAE0` / `#00A1C2`、错误色 `#FF3355`、警告色 `#FFA21E`。
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
| 桌面连接中心与编辑抽屉（浅色） | `3040a5f55a3041afa0db2fa1dae099cb` | `.stitch/designs/provider-center-desktop-light-v1.*` |
| 390px 窄屏渠道列表（浅色） | `d7dca9d1ddcc43299c0ea53acbc8bcfa` | `.stitch/designs/provider-center-mobile-list-light-v1.*` |
| 390px 窄屏编辑表单（浅色） | `dc5b4b3cbf43428f8ef4c239521da595` | `.stitch/designs/provider-center-mobile-edit-light-v1.*` |
| 设计 token | 不适用 | `provider-center-design-tokens-v1.json` |
| 版本与实施说明 | 不适用 | `provider-center-delivery-v1.md` |

浅色变体生成会话为 `12504138825416016201`；参考仓库同时保存 HTML、PNG 和 SHA-256 元数据，未把 STITCH HTML 迁入生产代码。

## 最终验收范围

1. 使用登录后的真实 Provider 数据分别截取桌面、390px、桌面编辑抽屉和390px 编辑抽屉，确认没有因真实长名称、模型或能力数量破坏布局。
2. 切换深浅色主题，确认背景、表面、分隔线、Tab、状态语义色和输入控件对比度。
3. 复核加载、空、未测试、测试中、不可用、禁用及错误状态；状态必须同时包含文字，不只依赖颜色。
4. 在 390px 下确认 `document.documentElement.scrollWidth <= window.innerWidth`，并复核停用二次确认和抽屉底部操作区。

STITCH HTML 只用于视觉核对，不直接替换现有 Next.js、Ant Design 和 Tailwind 实现。

## 最终人工复核结果

- 桌面 1440px：表格主要列宽实测为 401 / 206 / 243 / 194px，另保留 104px 启用列和 66px 操作列；数据行高度 75px，长模型名使用单行省略号，页面无横向溢出。
- 390px：Provider 卡片左右留白 16px、卡片间距 16px、圆角 12px；模型值限制在 180px 内单行截断，状态位于底部右侧，页面 `scrollWidth` 与 `clientWidth` 均为 390px。
- 编辑抽屉：桌面宽度 440px，390px 下稳定为全宽；桌面水平内边距 24px、窄屏 16px，底部取消与保存操作区固定可见，页面无横向溢出。
- 主题：深色与浅色页面、表格、卡片、状态语义色和表单控件均保持可读对比；主题切换动画完成后的稳定状态无残留遮罩。
- 浏览器控制台未发现来自应用源码的 Ant Design 警告或运行时错误；出现的按键监听错误来自浏览器扩展脚本，不计入应用问题。
- 为保护真实连接，本轮没有点击启停、保存、迁移或连接测试；这些交互继续由现有 Mock 与组件测试覆盖。
