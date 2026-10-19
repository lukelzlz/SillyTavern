---
id: ADR-001
title: 采用状态镜像代理与分布式事件桥接实现前后端解耦
status: accepted
date: 2026-10-19
---

# ADR-001: 采用状态镜像代理与分布式事件桥接实现前后端解耦

## 1. 决策背景 (Context)
在 PROPOSAL-001 中，我们旨在将 SillyTavern 的核心业务逻辑（WorldInfo 正则检索、分词计算、PromptManager 组装、大模型流式调用）从浏览器完全迁移至 Node.js 服务端，同时保证现有的前端 UI 完全不变、所有第三方前端插件的 API 签名与生命周期拦截能力 100% 保持兼容。

## 2. 裁定方案 (Decision)
我们裁定采用 **「服务端 Session Engine + 前端 State Mirror 代理 + 分布式 EventSource 桥接」** 的整体解耦方案：
1. **通信协议层**：引入双向低延迟通道（WebSocket 优先，降级支持 SSE + REST RPC），负责状态同步、事件透传与流式下发。
2. **状态镜像代理（State Mirror）**：
   - 前端维护轻量级的状态对象（`chat`, `characters`, `chat_metadata`），对外暴露的原生引用保持不变；
   - 读取操作直接从本地镜像高速读取，写操作（如 `chat.push()`、`saveReply()`）通过函数包装或 Proxy 触发轻量级同步消息至服务端。
3. **分布式事件桥接（Bridge EventSource）**：
   - 服务端派发的系统事件（如 `GENERATION_STARTED`, `MESSAGE_SENT`, `TOKEN_COUNT_UPDATED`）统一通过 WebSocket 推送至客户端；
   - 客户端内部事件总线透明派发，插件原有的 `eventSource.on(...)` 无需感知服务端存在。
4. **双向生命周期拦截握手（Interception Handshake Protocol）**：
   - 对于关键的 `CHAT_COMPLETION_PROMPT_READY` 等前置拦截事件，服务端组装好 Prompt 后挂起生成并向前端发送询问；
   - 前端触发本地事件，若有插件注册并修改了消息列表，前端将修改结果序列化打包确认回执给服务端；
   - 服务端以最终确认的 Prompt 调用大模型接口。若前端无插件拦截，则 0ms 直通无需等待。

## 3. 备选方案与否决理由 (Alternatives Considered & Why Rejected)
- **备选方案 A：仅服务端暴露无状态算力 API（Server-Assisted Function Calls）**
  - *做法*：服务端仅提供单个函数级接口（如 `/api/scan-wi`），前端依然持有全量状态并负责指挥调度。
  - *否决理由*：无法解决手机锁屏切后台断连的问题，前端依旧需要维护复杂的调度时序和大量的中间状态，解耦不彻底。
- **备选方案 B：强制将前端插件全部改写为 Node.js 服务端插件**
  - *做法*：彻底废弃前端插件，所有扩展全部跑在服务端的 `plugins/` 目录。
  - *否决理由*：彻底破坏既有社区生态，违背了用户“不改变对插件开放的接口能力”的最高铁律。

## 4. 后果与权衡 (Consequences & Trade-offs)
- **正面收益**：
  - 前后端职责彻底清晰，客户端从“重运算”变成“纯视图”，彻底消灭移动端发热与 CPU 爆表；
  - 天然具备后台静默生成与多终端实时同步能力；
  - 100% 兼顾现有第三方前端插件生态。
- **负面代价与应对**：
  - **网络延迟开销**：拦截握手增加了 1 次客户端与服务端的本地/局域网 RTT（约 1~5ms）。应对：仅在检测到有活跃的拦截监听器时才发起阻塞握手，默认状态下 0ms 直通。
  - **状态同步一致性**：高并发连续编辑或撤回时需防止竞态。应对：服务端采用基于自增版本号（Version Vector / Sequence ID）的乐观锁与有序队列。
