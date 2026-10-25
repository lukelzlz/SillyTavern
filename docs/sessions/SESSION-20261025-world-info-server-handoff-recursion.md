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

## 未完成与下一阶段

- 本阶段的 browser/server 完整 World Info slot differential fixture、真实 Core WS `server_context` interception 无重复注入验证，以及浏览器 `prepareOpenAIMessages()` ownership/fallback 路径均已完成。
- 本轮已补齐多标签生成状态投影的第一步：服务端 `generationState` 的状态 patch/snapshot 可驱动远端浏览器 UI 从生成中恢复为空闲；仍未完成远端标签页直接发起停止操作，以及 capability 开启时浏览器实际 `sendStreamingRequest()` 到服务端 gateway/plugin interception 的完整真实链路验收。
- 下一阶段继续沿 Core prompt handoff 主线补齐真实浏览器 authenticated Core WS 生成链路，重点推进 capability 开启时浏览器实际发起 `sendStreamingRequest()` 的端到端服务端生成/插件拦截；随后再处理远端标签页停止操作与生成中断后的完整 UI 状态恢复验收。
