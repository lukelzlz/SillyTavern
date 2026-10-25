---
id: PROPOSAL-005
title: 服务端生成编排器与后台任务管理器架构 (Generation Orchestrator & Server Job Manager)
status: accepted
author: Agent (文档架构员) & User
date: 2026-10-20
acceptedDate: 2026-10-20
branch: docs/generation-orchestrator
implementationBranch: feat/generation-orchestrator
---

# PROPOSAL-005: 服务端生成编排器与后台任务管理器架构

- **状态 (Status)**: Accepted (接受日期: 2026-10-20, 用户明确指令“确认开工 一直执行直到实现最终目标”)
- **实现分支 (Implementation Branch)**: `feat/generation-orchestrator`
- **文档分支 (Doc Branch)**: `docs/generation-orchestrator`
- **关联决策 (Related ADR)**: `docs/decisions/ADR-005-generation-orchestrator.md`
- **关联前序提案**: `docs/proposals/PROPOSAL-001-server-side-headless-core.md`, `docs/decisions/ADR-001-state-mirror-and-bridge-event-bus.md`, `docs/proposals/PROPOSAL-002-core-authenticated-transport.md`, `docs/decisions/ADR-002-core-ws-ticket-authentication.md`, `docs/proposals/PROPOSAL-004-prompt-parity-golden-contract.md`, `docs/decisions/ADR-004-prompt-parity-differential-testing.md`

---

## 1. 业务背景与问题定义 (Problem Statement)

在 SillyTavern 传统的客户端单体架构中，文本生成的全流程完全由浏览器端 JavaScript（`public/scripts/openai.js` 等）直接驱动。浏览器向模型提供商（或通过服务端简单代理）发起长轮询 HTTP fetch 请求，并通过 ReadableStream 监听打字机吐字。

这种“前端驱动型（Client-Driven）”生成模型在移动端与复杂网络环境下暴露出致命的缺陷与体验断层：

### 现状痛点剖析
1. **移动端锁屏与后台休眠导致生成夭折**：
   - 现代移动操作系统（尤其是 iOS Safari 与 Android WebKit）在用户锁屏、切出 App 至后台、切换应用或接收系统来电时，会于数百毫秒内强制挂起或冻结网页的 JavaScript 线程，并切断底层 TCP/HTTP 长连接；
   - 模型服务商（如 OpenAI、Anthropic、DeepSeek）在云端仍在持续推理并计费消耗 Token，但由于客户端网络套接字中断，生成的长文本在传输半途中永久丢失；用户重新亮屏解锁后，界面停留在“生成中”转圈卡死状态，甚至丢失整条 AI 回复。
2. **浏览器页面刷新与意外断网的孤儿请求（Orphan Request）**：
   - 桌面端用户在等待长回复（如推理模型慢速思考）时，若不慎刷新页面、误关标签页或遭遇 Wi-Fi 抖动，前端与服务端的通信管道瞬间切断；
   - 缺乏服务端常驻任务管理器，已生成的千字上下文无法落地存储，导致不可逆的数据损毁，并迫使用户点击“重新生成”，造成 Token 费用与时间的双重浪费。
3. **多标签页与多端设备状态脱节**：
   - 用户在 PC 浏览器与手机端同时打开 Tavern 时，在一端发起的生成无法实时投影至另一端；
   - 缺乏服务端统筹的流式广播总线，多客户端无法协同观察同一场生成的推演过程。
4. **架构越权与私网安全风险（SSRF 诱惑）**：
   - 在试图将生成逻辑迁移至服务端的过程中，极易出现简单粗暴的工程反模式——即在服务端重新编写一套独立的 `fetch(targetModelApi)`。这种做法极其危险：
     - **安全失守**：完全绕过了项目既有的成熟后端代理安全网关（`src/endpoints/backends/chat-completions.js`），破坏了严格的 SSRF 私网 IP 拦截、代理路由（Proxy Agent）与凭据隔离；
     - **生态割裂**：SillyTavern 原生后端网关承载了海量的供应商方言转换（Claude Messages 结构清洗、Google Gemini contents 适配、Mistral/Cohere/xAI 方言、Anthropic Prompt Caching 自动深度注入、Tool Calling 规范化清洗等）。另起炉灶必然导致方言适配全面崩塌与双重维护噩梦。

因此，必须在服务端构建一套**专业、具备状态机闭环、支持断线重连补录、且彻底复用既有成熟后端网关的服务端生成编排器与任务管理器（Generation Orchestrator & Server Job Manager）**。

---

## 2. 目标与非目标 (Goals & Non-Goals)

### 核心目标 (Goals)
1. **服务端常驻任务与生命周期闭环 (Stateful Job Management)**：
   - 建立完备的服务端生成任务状态机：`QUEUED -> PREPARING -> INTERCEPTING_PLUGINS -> STREAMING -> COMPLETED / ABORTED / FAILED`；
   - 生成任务生命周期独立于前端连接存活：即使前端断网、锁屏或浏览器完全关闭，服务端生成任务持续在后台执行，完成后自动写入会话存储并刷盘持久化。
2. **彻底复用成熟后端网关，严禁任何直接私网 Fetch (Strict Gateway Reuse)**：
   - **绝对严禁**在 Orchestrator 中直接使用裸 `fetch()` 请求第三方 API；
   - 必须通过受控管道 100% 复用 `src/endpoints/backends/chat-completions.js` 的核心生成路由与方言转换器，完整继承其全量功能：
     - SSRF 私网地址过滤与内网保护；
     - 正向代理（HTTP/HTTPS/SOCKS5）与证书链支持；
     - 供应商方言适配（Claude/Gemini/OpenRouter/Tool Calling/Prompt Caching 等）；
     - 密钥解密、请求头清洗与多提供商认证隔离。
3. **双向 WebSocket 桥接与流式追帧分发 (Stream Catch-up & Multi-Tab Broadcast)**：
   - 服务端为每个活跃任务维护流式分块环形缓冲区（Stream Chunk Ring Buffer），每个分块打上单调递增的序号（`seq`）；
   - 支持多客户端/多标签页并行订阅广播；
   - 支持移动端解锁或客户端断线后发起重连补录（`generate:reconnect`），服务端根据客户端提交的 `lastSeq` 实现秒级“追帧回放”，无缝衔接当前实时流。
4. **前端插件拦截握手与防挂死降级 (Plugin Handshake & Timeout Fallback)**：
   - 严格继承并保持 `CHAT_COMPLETION_PROMPT_READY` 插件生命周期事件；
   - 在 `INTERCEPTING_PLUGINS` 阶段通过 WS 向客户端发送已装配的 Prompt 纯数据结构，等待前端扩展（如向量检索、思维链注入等）审查或修改；
   - 设立严格的 **3000ms 超时门禁**：若客户端断线、无活跃连接或插件未能在此窗口内回复，Orchestrator 自动执行降级策略（Fallback），以原始装配 Prompt 继续驱动生成，彻底杜绝后台任务无限僵死。
5. **严格 Fail-Closed 并发控制与防 DoS 配额 (Concurrency Guard)**：
   - 实施单用户维度的生成互斥控制：**单用户同一时刻仅允许存在 1 个主生成任务（Active Job Limit = 1）**；
   - 当已有任务处于执行态时，新请求直接返回 `409 Conflict` 或触发错误拒绝帧，不建立无上限的内存任务堆积，防止恶意或误触导致的资源耗尽；
   - 具备完备的 AbortController 级联取消机制：用户在前端点击“停止生成”时，秒级中断底层 API 连接与流式解析。
6. **无缝平滑回滚能力 (Zero-Downtime Rollback)**：
   - 引入配置开关 `core.generation.orchestratorEnabled`；
   - 当开关关闭时，系统平滑回退至原有的前端直驱模式，确保生成能力的高可用底线。

### 明确不做 (Non-Goals)
- **严禁独立私网 Fetch 绕过既有后端网关**：绝不新建并行的外部 API 通信通道，坚决守卫网络安全边界；
- **不引入重型分布式任务队列中间件**（如 Redis、RabbitMQ、BullMQ、Kafka 等）：SillyTavern 恪守轻量级单机嵌入式 Node.js 架构，任务管理器收敛在单进程内存状态机中；
- **不支持跨多用户的任务抢占式抢流**：每个用户的任务队列与配额完全隔离，互不阻塞；
- **不重构前端非聊天模块与全站 UI 布局**。

---

## 3. 核心用户故事 (User Stories - 已批准)

### Story 1: 手机锁屏与后台切出后的无缝后台生成与秒级追帧
- **场景**：用户 Bob 在手机 Safari 浏览器上与 AI 角色长文互动，点击“发送”后立即锁屏将手机放入兜里，或切换至微信回复消息。
- **系统行为**：
  1. 手机端连接进入休眠断开，但服务端 Orchestrator 维持 Job 状态机流转：装配 Prompt、调用后端网关发起流式请求；
  2. 模型吐出 stream chunks，服务端实时将 chunks 记录入内存环形缓冲区，并持续拼接完整回复；
  3. 2 分钟后，Bob 重新亮屏解锁打开 Safari，前端通过 WS 发送 `generate:reconnect { jobId, lastSeq: 4 }`；
  4. 服务端瞬间向前端推送缺失的 `seq: 5..48` 历史 chunks（打字机快速追赶回放），随后继续平滑推送实时流；
  5. 即使 Bob 在生成完全结束后才打开手机，也能立即看到完整持久化的助手消息与元数据。
- **价值**：彻底根除移动端日常使用中最折磨用户的“断网卡死与回复丢失”顽疾。

### Story 2: 浏览器误刷新与多标签页协同镜像
- **场景**：用户在 PC Chrome 标签页 A 触发长文本生成，过程中误按 `F5` 刷新页面，或者同时打开了标签页 B。
- **系统行为**：
  1. 标签页 A 刷新断开，服务端 Job 状态未受任何影响，后台正常进行；
  2. 标签页 A 刷新完成重新建立 WS 连接后，自动检测到当前用户有名为 `job_xxx` 的活跃生成任务（状态为 `STREAMING`）；
  3. 标签页 A 与标签页 B 均向服务端订阅该 Job，服务端向两端同时广播实时打字机分块；
  4. 两端界面同步呈现生成进度，完全一致。
- **价值**：提供工业级 SPA 的稳健状态投影体验。

### Story 3: 严格复用成熟后端网关，抵御 SSRF 与保持生态兼容
- **场景**：用户配置了复杂的反向代理、自定义证书，连接部署在局域网内部的模型服务，或使用了 Anthropic Claude 的 Prompt Caching。
- **系统行为**：
  1. Orchestrator 在执行阶段将请求委托给成熟的内部网关执行管道（`src/endpoints/backends/chat-completions.js`）；
  2. 网关内部的 SSRF 防火墙校验目标 IP，确保不发生非法内网穿透；
  3. 网关内部的方言转换器自动完成 Claude 专有缓存标记（`cache_control: { type: 'ephemeral' }`）深度计算与系统消息转换；
  4. 代理与 Headers 清洗机制完整生效，请求顺利送达模型服务商。
- **价值**：零代码重复，100% 继承 SillyTavern 历经多年打磨的数十种后端模型适配器。

### Story 4: 插件生命周期安全拦截与 3000ms 降级门禁
- **场景**：用户安装了某些需要修改 Prompt 的第三方扩展（如动态向量注入插件），但在某次请求中，插件脚本出现死循环无法响应。
- **系统行为**：
  1. 任务到达 `INTERCEPTING_PLUGINS` 状态，服务端通过 WS 向客户端发射 `job:plugin_intercept` 事件并挂起 3000ms 定时器；
  2. 插件由于异常未能在 3000ms 内回传修改后的 Prompt；
  3. 服务端定时器触发，打印安全警告 `[Orchestrator] Plugin interception timed out for job ${id}, falling back to original prompt.`；
  4. 任务状态机自动脱离拦截等待，以原始 Prompt 推进至 `STREAMING` 阶段并正常生成。
- **价值**：兼顾第三方插件生态的灵活性与核心生成通路的绝对不死锁性。

### Story 5: 单用户并发互斥锁与防 DoS 守卫
- **场景**：用户因网络卡顿在 1 秒内连续多次点击“发送”按钮，或恶意脚本尝试并发注入。
- **系统行为**：
  1. 第一次点击创建了活跃 Job 并锁定用户槽位；
  2. 第二次及后续请求到达服务端 Orchestrator 时，并发守卫检测到 `userActiveJobs.has(userId)`；
  3. 服务端立即拒绝后续请求，返回 HTTP `409 Conflict` 及 `{ error: "Another generation job is currently in progress." }`；
  4. 服务端不会向模型服务商发出重复的并发扣费请求，Node.js 内存无任何泄露。
- **价值**：杜绝重复请求导致的 Token 资金损失与服务雪崩。

### Story 6: 用户主动中止（Abort）全链路级联取消
- **场景**：AI 正在流式吐字，用户发现生成偏离预期，在界面点击“停止生成（Stop）”。
- **系统行为**：
  1. 客户端通过 WS 发送 `generate:abort { jobId }`；
  2. Orchestrator 匹配到对应活跃任务，立即调用其绑定的 `abortController.abort()`；
  3. 底层 `chat-completions.js` 的 fetch 请求瞬间中断，上游模型连接被切断；
  4. 任务状态机流转为 `ABORTED`，将当前已接收到的部分截断文本落地存储至会话，释放用户并发锁，并向所有在线客户端广播 `job:aborted`。
- **价值**：秒级止血，提供灵敏的交互响应与模型费用控制。

---

## 4. 服务端任务状态机与生命周期设计 (Job State Machine)

任务管理器为每个生成请求实例化一个受控生命周期的 `GenerationJob` 对象，遵循单向确定性状态转移：

```
                    ┌─────────────────────────┐
                    │       [ 1. QUEUED ]     │ <--- 接收请求、校验并发配额
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │     [ 2. PREPARING ]    │ <--- 提取会话状态、组装 Prompt
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ [3.INTERCEPTING_PLUGINS]│ <--- WS 广播拦截，等待插件审查
                    └────────────┬────────────┘      (3000ms 超时自动降级跳过)
                                 │
                                 ▼
                    ┌─────────────────────────┐
       ┌──────────> │      [ 4. STREAMING ]   │ <--- 复用 chat-completions.js 管道
       │            └──────┬───────────┬──────┘      (实时写入 Chunk 环形缓冲并分发)
       │                   │           │
[用户 Abort]               │           │ [异常/断流]
       │                   ▼           ▼
       │            ┌─────────────┐  ┌─────────────┐
       └──────────> │ [ ABORTED ] │  │ [ FAILED ]  │
                    └─────────────┘  └─────────────┘
                           ▲
                           │ [正常吐字完结]
                           ▼
                    ┌─────────────┐
                    │[ 5.COMPLETED│
                    └─────────────┘
```

### 状态定义与行为契约表

| 状态 (State) | 前置条件 | 核心执行逻辑 | 退出/跃迁触发 | 异常与防护 |
| :--- | :--- | :--- | :--- | :--- |
| **QUEUED** | 收到客户端生成指令 | 校验用户权限，检查 `userActiveJobs` 槽位，若已有任务则直接拒载 (409)；分配全局唯一 `jobId` 并锁定用户槽位。 | 初始化完成即刻推进至 PREPARING | Fail-Closed：若创建失败立即清理槽位。 |
| **PREPARING** | 任务排队就绪 | 调用服务端 `PromptEngine.assemble(context)`，依据 PROPOSAL-004 纯数据契约完成 10 阶段装配。 | 装配完成推进至 INTERCEPTING_PLUGINS | 装配异常则跳转至 FAILED，释放锁。 |
| **INTERCEPTING_PLUGINS** | Prompt 装配完成 | 通过 WS 广播 `job:plugin_intercept`；启动 3000ms 防挂死定时器。 | 收到客户端确认修改或超时触发推进至 STREAMING | 客户端无响应或网络中断时自动以原始 Prompt 降级继续，严禁僵死。 |
| **STREAMING** | 最终 Prompt 就绪 | 挂载 `AbortController`，委托内部成熟网关；将增量 chunk 写入环形缓冲区；向所有绑定 WS 发射 `job:chunk`。 | 流式完成 `[DONE]` 推进至 COMPLETED；收到取消信号跳至 ABORTED。 | 底层网络异常/API 报错推进至 FAILED；保持 chunk ring buffer 供重连。 |
| **COMPLETED** | 模型流式正常结束 | 拼接完整文本，追加至服务端 `UserSession`，持久化落盘；广播 `job:completed`；释放并发锁。 | 终态（保留在历史完成队列中供短期查询，随后 GC） | 保证会话数据原子级落盘。 |
| **ABORTED** | 接收到用户主动中止 | 触发 `abortController.abort()` 切断底层 fetch；截断文本落地；广播 `job:aborted`；释放并发锁。 | 终态 | 确保底层连接物理切断，不悬挂后台资源。 |
| **FAILED** | 网关抛错或 API 异常 | 记录脱敏错误日志，广播 `job:failed`；释放并发锁；会话回滚未完成消息。 | 终态 | 严禁向客户端暴露私网内网堆栈与敏感凭证。 |

---

## 5. 后端网关复用与内部管道隔离模式 (Gateway Integration)

为了绝对避免私网 fetch 绕过与代码重复，Orchestrator 采用**受控内部管道调用模式（In-Process Sub-Pipeline Invocation）**与 `src/endpoints/backends/chat-completions.js` 结合：

```
┌────────────────────────────────────────────────────────┐
│               Generation Orchestrator                  │
│  - 状态机控制 / 环形缓冲 / 并发防 DoS / WS 追帧分发       │
└──────────────────────────┬─────────────────────────────┘
                           │ 受控内部参数传递 (无网络开销)
                           ▼
┌────────────────────────────────────────────────────────┐
│     chat-completions.js 核心处理管道 (Core Handler)    │
│  - SSRF 私网 IP 拦截器 (SSRF Guard)                     │
│  - 代理配置引擎 (Corporate/SOCKS Proxy)                 │
│  - 供应商方言与消息结构化清洗 (Claude/Gemini/OpenRouter) │
│  - 密钥安全注入 (Token & Secret Manager)               │
└──────────────────────────┬─────────────────────────────┘
                           │ 真实受保护的外部模型调用
                           ▼
                 [ LLM Provider API ]
```

### 严格架构防线约束
1. **统一出口原则**：所有出站至大语言模型（LLM）的 HTTP/HTTPS 请求，必须且只能经过 `src/endpoints/backends/chat-completions.js`；
2. **严禁二次 Fetch**：在 `src/core/` 目录下的任何新模块中，严禁直接 `import fetch from 'node-fetch'` 并发起外部网络请求；
3. **上下文透传**：客户端原始请求的认证凭据（如用户 Handle、Cookie Session、自定义 Header）通过参数对象受控传递，保持权限与审计链路完整。

---

## 6. WebSocket 传输协议帧规范 (Protocol Specification)

所有编排器协议帧均在 PROPOSAL-002 确立的受认证 WebSocket 隧道中以标准 JSON 结构传递：

### 客户端上行消息 (Client to Server)
1. **发起生成 (`generate:start`)**:
   ```json
   {
      "type": "generate:start",
      "payload": {
        "core_request_id": "req_2026-10-20-001",
        "core_prompt_mode": "client_final",
        "chatId": "chat-2026-10-20-001",
        "characterId": "chara_alice",
       "generationParams": { "max_tokens": 1024, "temperature": 0.8 },
       "streaming": true
      }
    }
    ```

   Prompt ownership is explicit: `client_final` means the browser has already
   assembled and plugin-processed `messages`; `server_context` means the
   payload carries `core_prompt_context` and the server owns PromptAssembler
   plus the single plugin interception round-trip. Legacy jobs without this
   field retain the historical compatibility path.
2. **主动中止 (`generate:abort`)**:
   ```json
   {
     "type": "generate:abort",
     "payload": {
       "jobId": "job_1020_abcd1234"
     }
   }
   ```
3. **断线追帧重连 (`generate:reconnect`)**:
   ```json
   {
     "type": "generate:reconnect",
     "payload": {
       "jobId": "job_1020_abcd1234",
       "lastSeq": 42
     }
   }
   ```
4. **插件拦截响应 (`generate:plugin_response`)**:
   ```json
   {
     "type": "generate:plugin_response",
     "payload": {
       "jobId": "job_1020_abcd1234",
       "interceptId": "int_789xyz",
       "modifiedPrompt": [ ... ]
     }
   }
   ```

### 服务端下行消息 (Server to Client)
1. **任务就绪与创建 (`job:created`)**:
   ```json
   {
     "type": "job:created",
     "jobId": "job_1020_abcd1234",
     "state": "QUEUED"
   }
   ```
2. **插件生命周期拦截通知 (`job:plugin_intercept`)**:
   ```json
   {
     "type": "job:plugin_intercept",
     "jobId": "job_1020_abcd1234",
     "interceptId": "int_789xyz",
     "prompt": [ ... ],
     "timeoutMs": 3000
   }
   ```
3. **流式增量分发 (`job:chunk`)**:
   ```json
   {
     "type": "job:chunk",
     "jobId": "job_1020_abcd1234",
     "seq": 43,
     "delta": "你好！今天有什么",
     "accumulatedLength": 8
   }
   ```
4. **断线追帧批量回放 (`job:catchup`)**:
   ```json
   {
     "type": "job:catchup",
     "jobId": "job_1020_abcd1234",
     "fromSeq": 43,
     "toSeq": 65,
     "chunks": [
       { "seq": 43, "delta": "你好！今天有什么" },
       { "seq": 44, "delta": "我可以" }
     ]
   }
   ```
5. **任务完成归档 (`job:completed`)**:
   ```json
   {
     "type": "job:completed",
     "jobId": "job_1020_abcd1234",
     "fullText": "你好！今天有什么我可以帮你的？",
     "tokenStats": { "promptTokens": 120, "completionTokens": 16 }
   }
   ```
6. **任务中止与失败通知 (`job:aborted` / `job:failed`)**:
   ```json
   {
     "type": "job:failed",
     "jobId": "job_1020_abcd1234",
     "error": "Upstream API timeout after 30000ms"
   }
   ```

---

## 7. 自动化测试矩阵 (Test Matrix & Regression Verification)

为了保证工业级健壮性，本提案制定了必须在实现阶段通过的测试矩阵：

| 编号 | 测试用例分类 | 验证场景与对抗手段 | 期望结果 (断言) |
| :--- | :--- | :--- | :--- |
| **TM-ORCH-01** | 状态机流转 | 正常请求执行完整生命周期 | 状态严格依次跃迁为 QUEUED -> PREPARING -> INTERCEPTING_PLUGINS -> STREAMING -> COMPLETED。 |
| **TM-ORCH-02** | 并发互斥防护 | 同一用户并发快速发起 2 个生成请求 | 第 1 个成功创建 Job；第 2 个立即返回 409 Conflict，不产生额外后台开销。 |
| **TM-ORCH-03** | 插件超时降级 | 模拟客户端在 `INTERCEPTING_PLUGINS` 阶段挂起或故意不响应 | 精准在 3000ms 后触发超时警告，以原装配 Prompt 推进至 STREAMING，严禁死锁。 |
| **TM-ORCH-04** | 移动端追帧重连 | 客户端断开连接，等待 10 个 chunks 生成完毕后重新发起 `generate:reconnect` 并传入 `lastSeq` | 服务端通过 `job:catchup` 精确回放未同步的所有 chunks，后续流正常推送。 |
| **TM-ORCH-05** | 用户主动中止 | 生成到第 5 个 chunk 时调用 `generate:abort` | 底层 `AbortController` 立即触发，网关连接瞬间切断，任务置为 ABORTED，释放用户并发锁。 |
| **TM-ORCH-06** | 后端网关复用 | 检查外部调用栈与网络行为 | 验证所有 API 请求均经过 `chat-completions.js` 管道；严禁任何绕过网关的裸 fetch；SSRF 检查器 100% 触发生效。 |
| **TM-ORCH-07** | 异常崩溃恢复 | 模拟上游返回 500 错误或畸形流 | 任务安全进入 FAILED，持久化不产生半包脏数据，槽位被正常释放。 |

---

## 8. 部署、配置与平滑回滚方案 (Rollback Plan & Feature Flag)

### 配置声明 (`default/config.yaml`)
```yaml
core:
  generation:
    # 是否启用服务端生成编排器与任务管理器
    orchestratorEnabled: true
    # 插件拦截最大等待超时 (毫秒)
    pluginInterceptionTimeoutMs: 3000
    # 对携带 core_prompt_context 的无头任务启用服务端 PromptAssembler 装配
    serverPromptAssemblyEnabled: true
    # 单任务环形流式缓冲区最大保留 chunk 数量
    streamChunkRingBufferSize: 2048
    # 任务完成后在内存中的保留清理周期 (秒)
    jobRetentionSeconds: 300
```

### 平滑回滚机制 (Rollback Plan)
1. **即时无损降级**：
   - 若线上运行中发现编排器出现未知逻辑回归，仅需将 `core.generation.orchestratorEnabled` 设置为 `false` 并重启服务；
2. **透明前向兼容**：
   - 前端代码包含双轨路由守卫：当服务端编排器关闭时，前端自动降级至原有的传统 HTTP `POST /api/backends/chat-completions/generate` 路径直接驱动生成；
   - 历史已生成的会话数据格式与原有规范 100% 兼容，无需任何数据库或持久化数据迁移操作。
