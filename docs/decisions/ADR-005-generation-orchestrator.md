---
id: ADR-005
title: 服务端生成编排器状态机、后端网关复用与流式追帧架构裁定
status: accepted
date: 2026-10-20
acceptedDate: 2026-10-20
implementationBranch: feat/generation-orchestrator
---

# ADR-005: 服务端生成编排器状态机、后端网关复用与流式追帧架构裁定

- **状态 (Status)**: Accepted (接受日期: 2026-10-20, 用户明确指令“确认开工 一直执行直到实现最终目标”)
- **实现分支 (Implementation Branch)**: `feat/generation-orchestrator`
- **关联提案 (Related Proposal)**: `docs/proposals/PROPOSAL-005-generation-orchestrator.md`
- **关联前序决策**: `docs/decisions/ADR-001-state-mirror-and-bridge-event-bus.md`, `docs/decisions/ADR-002-core-ws-ticket-authentication.md`, `docs/decisions/ADR-004-prompt-parity-differential-testing.md`

---

## 1. 决策背景 (Context)

在 SillyTavern 传统的客户端单体架构中，模型生成过程直接由前端浏览器的 JavaScript 逻辑发起。随着应用从纯桌面单机使用场景扩展至移动端（iOS Safari、Android PWA）以及面对慢速推理思考模型（如 o1、DeepSeek-R1、Claude 3.5 Sonnet 长思考链），这种模式暴露了严重的架构缺陷：

1. **移动端后台中断与数据丢失**：
   - 用户锁屏、切换至其它应用或遭遇无线网络短暂抖动时，浏览器线程被移动操作系统挂起，活跃的 HTTP fetch 连接中断。
   - 此时远端模型依然在计费生成，但客户端连接已死，导致生成的回复半途丢失，用户端产生无响应卡死或必须重新生成，造成严重资金与时间浪费。
2. **多端协同与状态割裂**：
   - 用户在多个标签页或跨设备（如电脑与手机）登录同一账号时，无法感知并同步进行中的生成，破坏了 Headless Core 的多端一致性愿景。
3. **架构违规与 SSRF 穿透风险**：
   - 某些初步设想试图直接在服务端重新编写轻量级的 `fetch(apiUrl)` 调度逻辑。这构成了极度危险的安全隐患与工程倒退：
     - **安全漏洞**：绕过了 `src/endpoints/backends/chat-completions.js` 完备的 SSRF 校验防御、内网白名单机制与正向/反向代理链路；
     - **生态破坏**：SillyTavern 原生后端网关沉淀了海量的供应商方言适配（Claude Prompt Caching、Gemini Contents 映射、Tool Calling 规范化清洗等）。脱离现有网关将导致适配断层与双轨维护灾难。

为了从根本上解决断网/锁屏断流痛点，并绝对杜绝安全绕过，必须做出正式的架构决策。

---

## 2. 裁定方案 (Decision)

我们裁定在 SillyTavern 服务端引入 **「服务端生成编排器与后台任务管理器（Generation Orchestrator & Server Job Manager）」**，核心决策如下：

### 裁定 1：基于单机内存确定性状态机的常驻任务生命周期
服务端建立统一的任务管理器 `JobManager`，采用单进程内存状态机管理生成生命周期：
```
QUEUED -> PREPARING -> INTERCEPTING_PLUGINS -> STREAMING -> COMPLETED / ABORTED / FAILED
```
- **脱离前端生命周期**：任务一旦转入 `PREPARING`，其生命周期归属服务端托管。即使所有客户端均断开连接，后台任务依然持续生成直至终态，并自动持久化写入会话存储。
- **内存防膨胀**：已完成（COMPLETED/ABORTED/FAILED）的任务元数据在内存中保留 300 秒供客户端离线追溯，随后触发 GC 回收。

### 裁定 2：严格复用既有成熟后端网关，绝对严禁独立 Fetch 绕过
- **架构硬性红线**：Orchestrator 严禁引入任何裸 `node-fetch` 发起外部 API 请求。
- **复用管道**：所有模型推理请求必须 100% 委托给 `src/endpoints/backends/chat-completions.js` 的核心管道：
  - 完整继承 SSRF 私网 IP 拦截与内网保护机制；
  - 完整继承正向代理（Corporate Proxy/SOCKS5）与 TLS 证书配置；
  - 完整继承 Anthropic、Google、OpenAI、OpenRouter 等全部供应商方言转换器与 Prompt Caching 计算逻辑；
  - 完整继承统一的密钥解密与鉴权安全边界。

### 裁定 3：基于环形缓冲与单调递增 Seq 的流式追帧与多标签广播
- **环形缓冲区 (Chunk Ring Buffer)**：为每个进行中的 Job 分配固定容量（默认 2048 个 chunks）的流式分块内存环形缓冲，记录每一帧的序号 `seq`、增量文本 `delta` 与时间戳。
- **断线秒级追帧 (Stream Catch-up)**：客户端重连握手（`generate:reconnect`）携带其已接收的 `lastSeq`，Orchestrator 快速切片并批量推送缺失的 Chunks（`job:catchup`），随后平滑续接实时推送。
- **多端广播**：同一个用户的多个活跃 WebSocket 连接共享订阅该 Job 的事件总线，实现 PC 与移动端状态严格镜像。

### 裁定 4：`CHAT_COMPLETION_PROMPT_READY` 双向 WS 握手与 3000ms 降级门禁
- **保持插件生态兼容**：在 `INTERCEPTING_PLUGINS` 阶段，通过 WS 向客户端发射拦截通知，允许前端插件（如向量记忆、动态总结等）对装配完成的 Prompt 进行最终修订。
- **严格超时降级守卫**：启动 **3000ms** 严格倒计时。若客户端插件由于脚本错误未响应，或网络断开无在线客户端，定时器自动触发降级，以原始 Prompt 推进至 `STREAMING` 阶段，彻底杜绝任务死锁。

### 裁定 5：用户维度的 Fail-Closed 并发互斥与防 DoS 配额
- **单用户单任务约束 (Active Job Limit = 1)**：单用户同一时刻仅允许执行 1 个主生成任务。
- **快速失败 (Fail-Closed)**：若用户已有活跃任务，新的生成请求直接拒绝（HTTP 409 Conflict 或 WS 错误帧），严禁创建无限排队的堆积队列，防止恶意刷并发耗尽系统内存与模型 Token 资金。
- **级联中止 (Cascade Abort)**：客户端触发中止指令时，通过 `AbortController` 瞬间切断网关与上游模型的 TCP/HTTP 套接字。

---

## 3. 备选方案与否决理由 (Alternatives Considered & Why Rejected)

### 备选方案 A：在 Orchestrator 中直接使用 `node-fetch` 请求大模型
- *做法*：在服务端编排器中重新编写简易的 fetch 调用。
- *否决理由*：
  - **灾难级 SSRF 漏洞**：绕过了 `chat-completions.js` 中严密的私网 IP 检查与代理防御；
  - **方言与生态全面崩溃**：SillyTavern 支持数十种提供商（Claude、Gemini、xAI、Mistral 等），直接 fetch 意味着必须在 Orchestrator 中重写近万行的方言转换与缓存计算，造成不可接受的双重维护成本与代码漂移。

### 备选方案 B：引入外部 Redis / BullMQ / RabbitMQ 分布式队列
- *做法*：使用重量级消息队列中间件支撑持久化后台任务调度。
- *否决理由*：
  - **严重违反轻量级与开箱即用宪法**：SillyTavern 的核心定位是单机、便携式、桌面与私有化 Node.js 应用，强依赖外部 Redis 会极大提升用户部署与运维门槛；
  - 单用户/私有化场景下，基于 Node.js 内存与事件驱动的状态机完全足以支撑百毫秒级的可靠性要求。

### 备选方案 C：继续保持前端直驱，仅依赖 ServiceWorker / Web Locks 保活
- *做法*：不改动服务端架构，试图依靠浏览器端 ServiceWorker 在后台维持长连接。
- *否决理由*：
  - **根本无法对抗移动操作系统**：iOS WebKit 对后台 ServiceWorker 的执行生命周期有严苛限制，锁屏或切后台几秒内即被直接冻结或杀进程；
  - 无法解决跨多标签页与多端设备状态同步的根本问题。

### 备选方案 D：客户端断线后立即中止服务端任务
- *做法*：一旦 WebSocket 或长轮询断开，立即调用 `abort()`。
- *否决理由*：
  - 完全违背“解决锁屏与短暂断网”的核心诉求；网络微小抖动即导致生成作废，用户体验极其恶劣。

---

## 4. 后果与权衡 (Consequences & Trade-offs)

### 正面收益 (Positive Consequences)
1. **彻底解决移动端锁屏与弱网痛点**：用户在手机锁屏放入口袋后，模型在后台稳定生成，解锁即刻补齐完整文本，大幅改善日常体验；
2. **零安全回归与零方言漂移**：100% 复用现有成熟网关，无缝保留所有模型提供商方言、Prompt Caching 与 SSRF 深度防御；
3. **插件生态零破坏**：双向握手协议确保第三方扩展功能正常，同时通过 3000ms 降级门禁杜绝死锁风险；
4. **资源与资金防刷保护**：单用户并发限制与 Fail-Closed 机制有效防止重复点击导致的高额 API 账单与 Node.js 内存溢出。

### 负面代价与应对措施 (Trade-offs & Mitigations)
1. **服务端内存开销**：每个活跃任务需要维护环形缓冲区；
   - *应对*：限制环形缓冲区最大容量为 2048 个 chunks（约几十 KB 内存），完成任务设置 300 秒生存期，由全局定时任务自动清理，严防内存泄漏。
2. **状态机复杂度提升**：相比于简单的请求-响应，有状态任务管理增加了事件跃迁和异常分支；
   - *应对*：编写覆盖所有 7 种边界场景的自动化集成测试矩阵（`tests/generation-orchestrator.test.js`），确保状态流转具备确定性。

---

## 5. 执行细则与安全验收标准 (Implementation Details & Acceptance Criteria)

1. **配置开关**：
   - 默认通过 `core.generation.orchestratorEnabled: true` 开启；若关闭，前端无缝降级回退至传统 HTTP 直接调用。
2. **网关安全验收**：
   - 严禁任何绕过 `chat-completions.js` 的裸网络请求；SSRF 防御与代理逻辑在自动化测试中必须被验证完整触发。
3. **断线追帧验收**：
   - 在高延迟与模拟断网场景下，客户端提交 `lastSeq` 能 100% 完整补齐丢失的字词，无重复、无乱序、无吞字。
4. **超时降级验收**：
   - 模拟第三方插件脚本死循环，编排器必须在 3000ms 边界精准触发降级并顺利完成生成。
