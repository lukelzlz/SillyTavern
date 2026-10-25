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

## 未完成与下一阶段

- 仍需继续补齐 browser/server 的完整 World Info slot differential fixture，并在真实 Core WS handoff 流程中验证无重复注入。
