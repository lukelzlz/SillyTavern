---
id: SESSION-20261025-world-info-server-handoff-recursion
type: implementation
title: Core World Info server handoff recursion and chronological scan parity
date: 2026-10-25
status: tested
---

# 工作留痕：World Info 服务端交接阶段性推进

## 目标

承接 `ses_e8ea5f871ffe634hn7j1HLREIJ` 的 Core Headless / Prompt Handoff 主线，继续推进服务端拥有 World Info 扫描能力，避免在浏览器已经把聊天历史按时间正序交接给服务端后，扫描器仍按错误方向读取上下文。

## 本阶段完成

1. `CanonicalWorldInfoScanner` 支持显式的全局大小写策略 `options.caseSensitive`，并保留单条 World Info entry 的 `caseSensitive` 覆盖优先级。
2. `CanonicalWorldInfoScanner` 支持受 `maxRecursionSteps` 限制的递归激活：上一轮激活内容只在下一轮进入扫描缓冲区，避免同一轮顺序造成非确定性结果。
3. 当 World Info budget 为 `0`（无限制）时，不再无条件要求 tokenizer；只有真正启用预算限制时才执行 token 预算查询，保持 ADR-003 的 fail-closed 约束且不阻断无限预算场景。
4. `PromptAssembler` 按 Core prompt contract 的约定，将 chronological `chatHistory` 反转为 World Info 扫描所需的 newest-first 顺序；扫描结果仍覆盖浏览器预计算的 stale `worldInfoBefore/worldInfoAfter`。
5. 新增回归测试，覆盖全局大小写、递归级联、无限预算、服务端 newest-first 扫描，并保留 5 组 World Info golden fixture 与 Prompt parity 回归。
6. 服务端 PromptAssembler 已将 canonical World Info outlet 结果接入 `{{outlet::key}}` 宏解析；当存在服务端 entries 时，服务端结果覆盖浏览器可能遗留的 outlet 动态副本。
7. 服务端 PromptAssembler 已将 canonical World Info 的 ANTop/ANBottom 结果围绕 active Author's Note 重建，避免依赖浏览器动态副本。
8. 服务端 PromptAssembler 已将 canonical World Info 的 EMTop/EMBottom 结果接入 `dialogueExamples` 拓扑，并保持 dialogue examples 前后顺序。
9. 浏览器 server_context 能力判定不再强制依赖插件拦截开关；无插件时可直接走服务端 PromptAssembler，有插件时再进入可选拦截握手。
10. server_context 请求不再在浏览器重复执行最终 Prompt 组装与 token 预算计算，浏览器只生成 canonical context envelope，服务端负责权威 Prompt。
11. server_context 会携带浏览器是否存在 `CHAT_COMPLETION_PROMPT_READY` 监听器；无监听器时服务端跳过拦截等待，有监听器时才启用 WS 拦截握手。
12. 新增 `GF-PROMPT-09-world-info-all-slots` browser/server golden differential fixture，覆盖八种 World Info 槽位、PromptManager 顺序、examples、Author's Note、outlet、depth 与 stale browser 内容覆盖。
13. 新增 authenticated Core WS `server_context` 真实生成链路测试，验证 WebSocket → JobManager → PromptAssembler → gateway → generation:completed 全链路。
14. 新增 authenticated Core WS `server_context` + plugin interception 回归测试，验证拦截握手不会重复注入 canonical World Info 的 before、Author's Note、outlet 槽位，也不会把 stale browser 槽位带入 gateway。
15. 新增真实浏览器 E2E `CorePromptHandoff.e2e.js`，验证 `prepareOpenAIMessages()` 在 server-owned 模式跳过浏览器最终组装，在不安全上下文与显式 client-owned 模式下各只执行一次本地 hook，并验证 Core transport 失败时 HTTP fallback 清理全部 Core 专用字段。
16. 修复 `BridgeClient` 生成流的重连竞态：初始 `followGeneration()` 在 WS 尚未完成 authenticated handshake 时失败，不再因为 handshake 先完成而错过后续 catch-up；流初始化后会补发一次受共享 promise 去重保护的 `generate:reconnect`。
17. WS 断开时主动以 `CORE_BRIDGE_UNAVAILABLE` 拒绝挂起的 generation/RPC 请求，确保 `openai.js` 能走既定 HTTP rollback，而不会把瞬时断线误报为不可降级的未知异常。
18. 新增 authenticated WebSocket 断线追帧集成回归：生成首帧后关闭原连接，服务端继续生成并完成，新连接使用 `lastSeq` 追回缺失 chunk；新增浏览器 E2E 覆盖初始 reconnect race 的完整文本去重与终态收敛。
19. `BridgeClient` 现在将服务端 `generationState` patch/snapshot 投影到绑定的浏览器状态，并通过可选回调驱动远端标签页的生成中/空闲 UI；`st-context` 已接入该回调，避免后台生成完成后其他标签页仍保持锁定状态。
20. 新增浏览器 E2E 回归，验证 authenticated Core 状态投影从 `generating` 收敛到 `idle`，且不改变既有 prompt handoff 与 generation reconnect 路径。
21. `BridgeClient` 现在跟踪 `generation:started/token/completed/aborted/failed` 对应的 active job，并为无本地 `StreamingProcessor` 的远端标签页提供幂等 `stopActiveGeneration()`；`stopGeneration()` 在远端标签页会转发 `generate:abort`，不再只中止一个本地空闲 AbortController。
22. 新增独立的真实 Core 浏览器 E2E 配置与 mock provider：浏览器通过 authenticated Core WS 发起 server-owned 请求，服务端执行 PromptAssembler 与 plugin interception，provider 返回可验证的 World Info/插件 marker 计数。
23. 真实浏览器 E2E 的“断线/中断”场景不关闭系统网络、不切换离线状态；mock provider 通过 `/control/block` 阻断上游响应，测试再由远端 Stop 触发服务端 abort，最后通过 `/control/release` 释放响应闸门，验证 job abort 与浏览器 stream 收敛。
24. 修复真实 handoff 暴露的两个 contract 问题：浏览器 `names_behavior` 数字枚举序列化为 server schema 要求的字符串；当服务端已经扫描 canonical World Info 时，PromptAssembler 不再让 browser prompt collection 中的 stale `worldInfoBefore/worldInfoAfter` 覆盖服务端槽位。

## 验证记录

- `npm run lint`：通过。
- `cd tests && npm run test:unit -- world-info-parity.test.js prompt-parity.test.js --runInBand`：通过，44 tests。
- `cd tests && npm run test:unit`：通过，28 suites / 589 tests。
- 本次 outlet 增量：`npm run lint` 通过；`cd tests && npm run test:unit -- world-info-parity.test.js prompt-parity.test.js --runInBand` 通过，45 tests。
- 本次增量后的完整回归：`cd tests && npm run test:unit` 通过，28 suites / 590 tests。
- 上一轮 Author's Note 增量：`npm run lint` 通过；`cd tests && npm run test:unit -- world-info-parity.test.js prompt-parity.test.js --runInBand` 通过，46 tests。
- 上一轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 591 tests。
- 本轮 EM 与 server-owned gateway 增量：`npm run lint` 通过；`cd tests && npm run test:unit -- world-info-parity.test.js prompt-parity.test.js --runInBand` 通过，47 tests；`cd tests && npm run test:unit -- generation-orchestrator.test.js --runInBand` 通过，50 tests。
- 本轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 593 tests。
- 本轮 server_context 闭环增量：`npm run lint` 通过；`cd tests && npm run test:unit -- core-bridge.test.js generation-orchestrator.test.js --runInBand` 通过，62 tests。
- 本轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 594 tests。
- 本轮 browser/server differential 与真实 WS 增量：`cd tests && npm run test:unit -- prompt-parity.test.js generation-orchestrator.test.js --runInBand` 通过，85 tests。
- 本轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 596 tests。
- 本轮 authenticated WS interception parity 增量：`npm run lint` 通过；`cd tests && npm run test:unit -- generation-orchestrator.test.js --runInBand` 通过，53 tests；`cd tests && npm run test:unit -- prompt-parity.test.js generation-orchestrator.test.js --runInBand` 通过，86 tests。
- 本轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 597 tests。
- 本轮 browser prompt ownership/fallback 增量：`npm run lint` 通过；`npx eslint frontend/CorePromptHandoff.e2e.js` 通过；启动本地服务后 `npx playwright test frontend/CorePromptHandoff.e2e.js --config=playwright.config.js` 通过，1 test；首次 E2E 暴露 `core_prompt_interception` 未在 HTTP fallback 清理的问题，已修复并复测通过。
- 本轮针对性单测：`cd tests && npm run test:unit -- core-bridge.test.js generation-orchestrator.test.js prompt-parity.test.js --runInBand` 通过，3 suites / 97 tests。
- 本轮完整回归：`cd tests && npm run test:unit` 通过，28 suites / 597 tests。
- 本轮 generation reconnect/catch-up 增量：目标 ESLint 无 error；`cd tests && npm run test:unit -- generation-orchestrator.test.js --runInBand` 通过，54 tests；启动本地服务后 `npx playwright test frontend/CorePromptHandoff.e2e.js --config=playwright.config.js` 通过，2 tests。
- 本轮完整检查：`npm run lint` 通过；`cd tests && npm run test:unit` 通过，28 suites / 598 tests。
- 本轮 generation state projection 增量：`npm run lint` 通过；`cd tests && npm run test:unit -- core-bridge.test.js generation-orchestrator.test.js --runInBand` 通过，2 suites / 65 tests；启动本地服务后 `npm --prefix tests run test:e2e -- frontend/CorePromptHandoff.e2e.js --config=playwright.config.js --workers=1` 通过，3 tests；随后 `cd tests && npm run test:unit` 完整回归通过，28 suites / 598 tests。
- 本轮真实 Core handoff 与远端停止增量：`npm run lint` 通过；`cd tests && npm run test:unit -- prompt-parity.test.js core-bridge.test.js generation-orchestrator.test.js --runInBand` 通过，3 suites / 99 tests；使用独立 Chromium（Playwright `channel: chromium`，未复用用户浏览器）、mock provider response gate 与 Core-enabled server 配置运行 `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --workers=1`，2 tests 通过；默认配置下 `npm --prefix tests run test:e2e -- frontend/CorePromptHandoff.e2e.js --config=playwright.config.js --workers=1`，5 tests 通过。

## 未完成与下一阶段

### 2026-10-25 隔离浏览器夹具增量

- 在 `fix/core-refreshed-tab-stop` 隔离工作区承接已有未提交测试改动，主工作区不变。
- `core-handoff-fixture.js` 复用真实认证服务夹具，使用临时 config/dataRoot、动态端口、独立 headless Chromium；服务端显式禁止自动打开浏览器。
- mock provider 的响应等待随连接关闭释放，夹具退出时清理服务端及 provider 子进程，并为 provider 退出增加强制终止兜底。
- 原有真实 handoff 两项 E2E 通过；根目录 Lint 通过，测试文件 ESLint 无 error。
- 认证回归首次出现首帧握手超时：原测试在 `connectWs()` 返回后才监听消息，可能漏过同一事件循环的握手。夹具改为在 `open` 回调内先注册握手 promise，调用方等待该 promise，保持原握手检查的 2000ms 超时而非加长等待。
- 夹具最终复测：`npm --prefix tests run test:unit -- core-auth-regression.test.js --runInBand`，37 tests 通过；`npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --grep "sends browser context|stops a response-gated" --workers=1`，2 tests 通过。
- 刷新标签页 Stop 的失败复现保留在工作区，将与生产修复同一提交交付；本夹具增量不宣称该问题已解决。

- 本阶段的 browser/server 完整 World Info slot differential fixture、真实 Core WS `server_context` interception 无重复注入验证，以及浏览器 `prepareOpenAIMessages()` ownership/fallback 路径均已完成。
- 上一轮已补齐多标签生成状态投影的第一步；本轮在此基础上完成了远端标签页 Stop 与 capability 开启时的真实 Core WS server-context streaming 验收。
- 本轮已完成 capability 开启时浏览器真实 Core WS server-context streaming、服务端 World Info/插件 interception、response-gated 远端停止与 UI stream 收敛；仍未完成完整的双浏览器页面共享 active job 刷新接管，以及 provider 失败后的真实浏览器跨标签页错误 UI 验收。
- 下一阶段继续沿 Core prompt handoff 主线补齐真实 `Generate()` / `sendStreamingRequest()` UI 入口接管、双标签页刷新后的 active job 恢复，以及 provider failure 后的跨标签页状态恢复；断线类测试继续采用 provider/gateway 响应闸门或定向 WebSocket 连接注入，不使用系统断网。
