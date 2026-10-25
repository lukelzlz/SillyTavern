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

## 验证记录

- `npm run lint`：通过。
- `cd tests && npm run test:unit -- world-info-parity.test.js prompt-parity.test.js --runInBand`：通过，44 tests。
- `cd tests && npm run test:unit`：通过，28 suites / 589 tests。

## 未完成与下一阶段

- World Info 的 EM examples、Author's Note 前后置内容、outlet 注入仍需在 server-owned context 中实现完整的“去浏览器动态副本后由服务端重建”闭环；本阶段只修复扫描顺序、递归与预算基础能力。
- 仍需继续补齐 browser/server 的完整 World Info slot differential fixture，并在真实 Core WS handoff 流程中验证无重复注入。
