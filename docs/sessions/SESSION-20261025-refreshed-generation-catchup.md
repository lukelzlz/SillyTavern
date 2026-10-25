# Core 刷新接管、终态持久化与定向 WS 追帧

状态：`[Tested 单测/检查通过]`。本地真实服务与隔离 Chromium E2E 已通过，尚未用户验收，未推送。

## 目标与边界

- 在生成进行中刷新观察标签页后，继续投影服务器拥有的完整文本。
- 生成终态由 Core state patch 作为权威结果，刷新页不得创建第二条助手消息。
- 定向关闭当前页面的 Core WebSocket 后，使用既有 `lastSeq` reconnect/catch-up 恢复缺失 chunk。
- 不使用系统断网、浏览器 offline、用户浏览器或用户数据；不扩展工具调用、多 swipe 或供应商范围。

## 实现

### 刷新页远端生成投影

- `public/scripts/st-context.js` 在当前 chat/character binding 完成后检查 handshake 的 active job。
- 无本地 `StreamingProcessor` 的页面通过 `coreBridge.followGeneration()` 接管已有 `fullText` 和后续 token。
- 远端投影使用 `core_generation_job_id` marker 创建或更新单个临时助手消息；不发出 `MESSAGE_RECEIVED`，也不把临时内容反向同步成新的 Core state。
- snapshot/append/update 到达时先渲染权威聊天，再重新补回仍在生成中的临时投影，避免刷新初始化竞态移除已有文本。
- completed/aborted/failed 后刷新 authoritative state；当 generation state 收敛为 idle，刷新页执行一次 native chat save，覆盖没有本地 `StreamingProcessor`、不会执行 `onFinishStreaming` 的路径。

### 消息唯一性契约

- `src/core/generation/job.js` 的 job snapshot 现在暴露 `coreGenerationJobId`。
- 刷新页使用服务端返回的同一 marker，Core `_settleSession()` 的 marker-based update/append 可以替换临时消息，而不是追加第二条助手消息。

### 定向 WebSocket 追帧

- 没有新增 provider 请求或生成重试逻辑。
- 断线由已有 BridgeClient reconnect 机制处理；生成监听器根据当前序号发送 `generate:reconnect`，由 `followGeneration()` 对 fullText 和 seq 做去重。

## 测试

新增/更新：

- `tests/frontend/CoreGenerationUI.real.e2e.js`
  - 刷新观察页后接管首段和剩余文本；两页、Core state、native chat 均只保留一条完整回复。
  - 定向关闭 `window.coreBridge.ws` 后验证 `generate:reconnect` 使用 `lastSeq >= 1`、provider 请求仍为 1、回复不重复。
- `tests/generation-orchestrator.test.js`
  - 验证 job snapshot 暴露浏览器生成 marker。

## 实际验证记录

- `npm run lint`：通过。
- `npm --prefix tests run lint -- --quiet`：通过。
- `npm --prefix tests run test:unit -- generation-orchestrator.test.js bridge-client-generation.test.js core-bridge.test.js --runInBand --silent --verbose=false`：3 suites / 98 tests 通过。
- `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --grep "refreshed observer" --workers=1`：1 项通过。
- `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --grep "targeted Core WebSocket" --workers=1`：1 项通过。
- `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --workers=1`：9 项通过。
- `npm --prefix tests run test:unit -- --runInBand --silent --verbose=false`：29 suites / 634 tests 通过。

## 目标收敛：手机关闭网页后继续生成

用户最终目标明确为：手机发送消息后可以直接关闭网页，服务端继续完成生成并持久化；稍后重新打开网页和对应聊天，能够看到唯一的完整回复。

为覆盖这个真实结果，新增 `closing the sending page` E2E：

- 发送页在任务开始后直接关闭，不发送 abort。
- provider 继续完成，服务端 Job 进入 `COMPLETED`，provider 请求数仍为 1。
- 重新打开页面并进入同一聊天，恢复完整回复且不重复。

过程中发现并修复一个实际根因：新页面启动时会短暂绑定欢迎页，旧 bootstrap 逻辑可能用欢迎页状态覆盖已经持久化的 Core 聊天。`BridgeClient.bootstrapOrRefreshBoundState()` 现在识别“浏览器临时欢迎页 + Core 已有非空 chatId”场景，优先保留服务器状态。

新增测试后验证：

- `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --grep "closing the sending page" --workers=1`：1 项通过。
- `npm --prefix tests run test:unit -- core-bridge.test.js generation-orchestrator.test.js --runInBand --silent --verbose=false`：2 suites / 72 tests 通过。
- 最终真实 handoff 回归：9 项通过；最终完整单测：29 suites / 634 tests 通过。

## 后续验证与交付门禁

- 继续运行完整 Core handoff E2E 和完整单测，确认既有真实发送、失败恢复、刷新 Stop 不回归。
- 完成后按独立行为创建原子提交；不创建新分支或 Worktree，直接在 `release` 工作区进行。
- 用户未明确回复“验收通过/LGTM”前，不标记 Accepted、不推送远程。
