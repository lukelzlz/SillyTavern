---
id: SESSION-HIST-001
title: 历史会话归档：SillyTavern 移动端 (iOS/Safari) 严重发热与 GPU 图层爆炸深度排查
date: 2026-08-18
type: historical_archive
original_source: Antigravity (a50b3a68-4698-4734-9d08-8d758290c84b)
---

# 历史推演归档：SillyTavern 移动端严重发热与服务端/客户端负载排查

## 1. 历史问题现象与排查背景
- **问题现象**：在 iPhone 14（iOS Safari / PWA 模式）中打开 SillyTavern 即使不做任何复杂交互或聊天，手机短时间内严重发热并发生剧烈降频发烫（芯片位置烫手无法握持）。
- **用户诉求**：探查发热根因，探索是否能够通过插件将客户端繁重的 Prompt/Token/Regex 计算转移至 Node.js 服务端，或者通过扩展治理前端渲染性能。

## 2. 曾尝试的无效路径与失败原因
- **尝试 1：归咎于大模型请求与背景轮询**：
  - 现象推测：初期怀疑是生成过程或长轮询接口卡死。
  - 排除原因：用户刚进页面、未发送任何消息时便立刻发热，网络空闲时热量依然持续飙升。
- **尝试 2：单纯局部优化 CSS backdrop-filter**：
  - 仅给部分顶部栏降低 blur 模糊半径，发热并未根本消除。因为整个 DOM 中有十多个处于隐藏状态的抽屉抽拉面板在后台仍然保持合成图层。

## 3. 最终落地的解决策略与架构洞见
- **根因定位 (GPU Layer Explosion & Overlapping Kernels)**：
  - SillyTavern 是单页 Vanilla JS 应用，内置了超过 10 个全屏/半屏抽屉面板（`.drawer-content`，如 `#left-nav-panel`, `#WorldInfo`, `#AdvancedFormatting`, `#user-settings-block` 等）。
  - 在移动端 CSS 中，抽屉收起时往往仅通过 `transform: translateX(...)` 或绝对定位移出屏幕，并未设置 `display: none` 或 `visibility: hidden`。
  - 每个面板均叠加了 `backdrop-filter: blur(...)`，配合底层的全屏大背景图（`#bg1`），导致 iOS WebKit 将所有不可见的抽屉面板全量提升为独立的 GPU 渲染图层（Compositing Layers）。GPU 每秒都在执行十几个多层模糊核的离屏渲染，直接导致移动端 GPU 跑满、瞬间发热降频。
- **治理与优化方向**：
  - **CSS 图层熔断**：抽屉面板在关闭时强制赋予 `display: none !important;` 或 `visibility: hidden;`，彻底从 WebKit Compositing Tree 中剔除。
  - **插件与扩展解耦**：
    - 前端扩展机制：位于 `public/scripts/extensions/third-party/`，通过 `manifest.json` 与 `index.js` 注入样式与前端事件。
    - 服务端插件机制：位于 `plugins/`，需在 `config.yaml` 中配置 `enableServerPlugins: true`，在 Node.js 服务端注册 Express `/api/plugins/*` 路由。

## 4. 沉淀至部落知识库的经验条目
1. **iOS Safari / PWA 绝对忌讳“隐藏未卸载”的 backdrop-filter 堆叠**：离屏抽屉面板收起时必须伴随 `display: none`，切忌只依赖 CSS `transform` 移出可视区。
2. **前后端架构边界明确**：SillyTavern 默认几乎所有 Prompt 组装、宏替换、世界书触发词命中与 Token 截断均在前端浏览器完成。如需将高负载卸载至后端，需依赖服务端插件（Server Plugin），而不能仅依靠纯前端 Extension。
