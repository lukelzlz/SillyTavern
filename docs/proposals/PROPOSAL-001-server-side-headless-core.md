---
id: PROPOSAL-001
title: SillyTavern 服务端有状态核心化与前端视图投影重构 (Server-Side Headless Core)
status: accepted
author: Agent & User
date: 2026-10-19
branch: feat/server-headless-core
worktree: ../SillyTavern-server-core
---

# PROPOSAL-001: SillyTavern 服务端有状态核心化与前端视图投影重构

## 1. 业务背景与问题痛点
当前 SillyTavern 是典型的“重前端胖客户端”单页应用（Fat Client）：
1. **移动端发热与卡死**：世界书（数百条条目递归正则扫描）、分词（WASM Tokenizer）、Prompt 拼接、Instruct 转换全部在移动端浏览器主线程执行，导致 iPhone 14 等移动设备短时间内剧烈发烫、降频掉帧乃至崩溃白屏（详见 `SESSION-HIST-001`）。
2. **后台易断连**：浏览器切至后台或手机锁屏时，长连接极易被操作系统休眠或杀死，导致长回复生成中断。
3. **架构失衡**：Node.js 后端算力闲置，仅被用作文件读写与简单反向代理，未能发挥多核并发优势。

## 2. 目标与非目标 (Goals & Non-Goals)

### 核心目标 (Goals)
1. **重计算全部下沉至服务端**：
   - 世界书/Lorebook 激活检索、正则匹配与深度注入全由 Node.js 服务端承载；
   - Token 计数与上下文自动截断（Context Shifting/Trimming）移至服务端；
   - PromptManager、Instruct 模式格式化、宏变量（`{{char}}`, `{{user}}` 等）替换移至服务端；
   - 与大模型（OpenAI, Claude 等）的生成通信、流式处理由服务端独立托管。
2. **UI 100% 保持现状**：
   - 不改变任何 HTML 结构、CSS 样式、抽屉抽拉面板、设置弹窗与聊天气泡外观；
   - 前端彻底转为瘦客户端（Thin Client）与视图投影层，只负责接收结构化数据并进行 DOM 渲染。
3. **插件开放能力 100% 兼容**：
   - 前端保留 `SillyTavern.getContext()` 接口，返回实时状态镜像（State Mirror）；
   - 前端事件总线 `eventSource.on(...)` 保留，由服务端事件桥接（Bridge EventSource）透明透传；
   - 保留关键生命周期拦截能力（如 `CHAT_COMPLETION_PROMPT_READY`）：服务端组装好 Prompt 后先推给前端，由前端本地插件修改确认后再回传服务端发起请求。

### 非目标 (Non-Goals)
- 本次不对 UI 视觉主题做任何重新设计或重写为 React/Vue，保留原生 Vanilla JS + jQuery 视图层；
- 不强制将第三方前端 DOM 插件（如 Quick-Reply、Live2D、语音播放等）改写为服务端插件；纯客户端 DOM 插件依然在前端运行。

## 3. 核心用户故事 (User Stories)

### Story 1: 移动端冷机流畅聊天体验
- **场景**：作为使用 iPhone 14 访问酒馆的移动端用户，在一个挂载了包含 500+ 条目世界书的大型角色卡中聊天。
- **行为**：点击发送后，移动端浏览器不再卡死，不跑正则扫描和分词，手机保持常温；服务端瞬间完成世界书匹配和 Prompt 组装，并以 WebSocket/SSE 流式推回文字；前端只负责将文字追加到消息气泡中。

### Story 2: 锁屏与切 App 断点续传
- **场景**：用户发送了一条生成指令后，手机由于超时自动锁屏或用户临时切换到微信。
- **行为**：服务端生成不受浏览器挂起影响，持续独立与 LLM 完成流式通信；用户重新打开酒馆页面后，前端通过状态同步协议自动补全最新生成的完整回复，无中断、无丢失。

### Story 3: 第三方扩展无感平移兼容
- **场景**：用户安装了依赖 `eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY)` 的第三方提示词修改插件或记忆增强插件。
- **行为**：在生成前，前端事件总线依然精准收到该事件，插件依然能像从前一样在本地检查并篡改 `messages` 内容；修改后的内容被安全回执给服务端并最终生效，插件完全不需要做代码修改。

## 4. 系统架构与关键时序设计

```
[浏览器前端 (Thin Client)]                          [Node.js 服务端 (Headless Core)]
          │                                                   │
   1. 发送消息 / Trigger                                       │
          │────────────────── ws: generate(payload) ─────────>│
          │                                                   │ 2. 状态入库 (Chat History)
          │                                                   │ 3. WorldInfo 正则/向量匹配
          │                                                   │ 4. Token 截断 & Prompt 拼装
          │                                                   │
          │<── ws: event: PROMPT_READY (messages) ────────────│ 5. 发送拦截握手 (如存在拦截插件)
   6. 派发本地 eventSource                                    │
   7. 前端插件就地篡改 messages                                │
   8. 发送确认回执                                            │
          │────────────────── ws: prompt_ack(messages) ───────>│
          │                                                   │ 9. 直连 LLM API 发起流式生成
          │<── ws: stream_chunk ("Hello") ────────────────────│ 10. 服务端持续流式下发
  11. 前端轻量追加渲染 DOM                                     │
          │<── ws: event: GENERATION_ENDED ───────────────────│ 12. 最终落盘并广播结束
```

## 5. 验收基准 (Acceptance Criteria)
- [ ] 自动化单测覆盖：服务端独立 Prompt 组装、WorldInfo 匹配、Token 截断逻辑通过单元测试。
- [ ] 性能压测达标：大世界书（500 条目）激活时，客户端 CPU 占用显著下降，无主线程长任务阻塞（Long Task < 50ms）。
- [ ] 插件兼容性验证：`SillyTavern.getContext()` 常见调用及 `CHAT_COMPLETION_PROMPT_READY` 事件拦截能正常生效并回写。
- [ ] 异常断线恢复：流式生成过程中断开前端网络再重连，生成结果可在服务端完整落盘并通过状态镜像补全。
