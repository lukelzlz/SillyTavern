---
id: ADR-002
title: 核心 WebSocket 采用 HTTP CSRF 守卫换发短期单次 Ticket 与 Sec-WebSocket-Protocol 传输
status: accepted
date: 2026-10-19
acceptedDate: 2026-10-20
implementationBranch: feat/core-authenticated-transport
---

# ADR-002: 核心 WebSocket 采用 HTTP CSRF 守卫换发短期单次 Ticket 与 Sec-WebSocket-Protocol 传输

- **状态 (Status)**: Accepted (接受日期: 2026-10-20, 用户明确回复“确认开工”)
- **实现分支 (Implementation Branch)**: `feat/core-authenticated-transport`
- **关联提案 (Related Proposal)**: `docs/proposals/PROPOSAL-002-core-authenticated-transport.md`

## 1. 决策背景 (Context)

在 PROPOSAL-001 与 ADR-001 的实现演进中，SillyTavern 引入了服务端 WebSocket 桥接器（`src/core/ws-bridge.js`），用于承担前后端状态同步、世界书匹配、Prompt 拦截握手与流式生成推送。

然而，在近期的红蓝对抗审查与自动化回归测试（`tests/core-auth-regression.test.js`）中，发现了严重的架构级安全缺陷：
1. **Express 管道完全旁路**：原生 Node.js 的 `http.Server.on('upgrade')` 事件发生于 Express 路由与中间件执行之前。原先的原型实现直接在 `upgrade` 事件中接收连接，导致 Express 体系内建立的 `cookieSession`、CSRF 守卫、IP 白名单及多用户隔离机制全数失效；
2. **跨站长连接劫持 (CSWSH)**：浏览器原生 `new WebSocket(url)` 会自动携带同源 Cookie，且浏览器原生 API 不允许向 WebSocket Upgrade 请求注入自定义 HTTP 头部（如 `x-csrf-token`）。若仅依靠 Cookie 鉴权，恶意第三方网页可发起跨站连接并盗取用户上下文；
3. **敏感凭据在 URL 泄露风险**：若采用常见的 URL Query 参数传递凭据（如 `ws://host/api/bridge/ws?ticket=xxx&userId=alice`），极易触发 CWE-598 漏洞，导致敏感票据被永久记录在 Nginx、Caddy、云厂商负载均衡反向代理日志、浏览器历史记录或监控审计平台中；
4. **会话生命周期失联**：长连接属于有状态 TCP 会话。当用户在 HTTP 端点执行注销（`/api/users/logout`）、修改密码或管理员在控制台禁用该账号（`user.enabled = false`）时，已建立的 WebSocket 未被联动销毁，导致无权限用户持续滞留在长连接通道中。

在提交 `08163b167` 中，我们采取了紧急阻断措施（将未认证的 Core WS 升级无条件返回 403）。为了让 Headless Core 真正具备上线与生产部署的安全标准，必须确立正式的认证传输架构决策。

---

## 2. 裁定方案 (Decision)

我们裁定采用 **「完整 HTTP 管道认证 + 短期单次票据换发 + Sec-WebSocket-Protocol 协议头传递 + 联动事件驱动主动撤销」** 的渐进式认证传输方案：

```
[浏览器客户端]                                          [Node.js 服务端]
      │                                                        │
      │ 1. POST /api/core/auth/ticket                          │
      │    (携带 Session Cookie + x-csrf-token)                │
      │───────────────────────────────────────────────────────>│ 2. 走完整 Express 安全中间件栈
      │                                                        │ 3. 校验用户身份、状态与 CSRF
      │                                                        │ 4. 签发单次 Ticket (TTL 30s)
      │<───────────────────────────────────────────────────────│ 5. 返回 { ticket: "st_tkt_..." }
      │
      │ 6. GET /api/bridge/ws (HTTP Upgrade)                   │
      │    Sec-WebSocket-Protocol: st-core.v1, ticket.st_tkt...│
      │    Origin: https://tavern.example.com                  │
      │───────────────────────────────────────────────────────>│ 7. Upgrade 事件拦截:
      │                                                        │    a. 校验 Origin 信任白名单
      │                                                        │    b. 校验单用户连接配额
      │                                                        │    c. 原子级提取并销毁 Ticket
      │<───────────────────────────────────────────────────────│ 8. 响应 HTTP 101 Switching Protocols
      │    Sec-WebSocket-Protocol: st-core.v1                  │    (长连接正式确立并绑定用户身份)
```

### 核心机制细则：
1. **HTTP 换票端点（Ticket Dispenser）**：
   - 暴露受保护的 REST 接口 `POST /api/core/auth/ticket`；
   - 必须强制经过 `cookieSession`、`setUser`、`requireLoginMiddleware` 及 `validateCsrfToken` 中间件校验；
   - 挂载独立的内存频控限流器（如单个 IP/用户 10 次/分钟），防范暴力刷票。
2. **票据密码学特性与生命周期（Ephemeral Single-Use Ticket）**：
   - 票据采用 `crypto.randomBytes(32).toString('base64url')` 生成（256 位熵）；
   - 严格限定有效期为 **30 秒**；
   - 必须满足**单次消费（Single-Use）**：服务端在 Upgrade 握手提取到票据的瞬间，执行原子级 `delete` 操作，彻底阻断任何重放攻击；
   - 票据内部绑定 `userHandle` 与 `accountVersion`，若用户账号在换票与握手之间发生变更，票据自动作废。
3. **传输载体：标准 Sec-WebSocket-Protocol 子协议头部**：
   - 客户端升级请求声明子协议：`Sec-WebSocket-Protocol: st-core.v1, ticket.<token>`；
   - 服务端验证通过后，在 101 Switching Protocols 响应中仅回显协议标识：`Sec-WebSocket-Protocol: st-core.v1`；
   - **严禁在 URL Query String 或 Path 中传递 Ticket 或 User ID**。
4. **强 Origin 校验与反向代理信任**：
   - Upgrade 事件中严格检查 `request.headers.origin`；
   - 结合系统配置的 `core.transport.trustedOrigins` 与经过代理验证的 `Host` 进行比对，不匹配时立即返回 `403 Forbidden` 并调用 `socket.destroy()`；
   - 严禁将请求端的 Origin 无脑反射回允许头。
5. **联动撤销与连接即时终止（Active Revocation & Termination）**：
   - 在用户执行登出操作（`/api/users/logout`）、密码修改或管理员将用户标记为禁用（`user.enabled = false`）时，服务端不仅清空 HTTP Session，同时触发传输层事件：
     1. 作废该用户名下所有待兑换的 Ticket；
     2. 遍历全局活跃连接表，对归属该用户的全部 WebSocket 发送 `4001 Session Revoked` 关闭帧，并物理断开底层 TCP 套接字。
6. **单用户与多用户模式对齐**：
   - 单用户（无密码）模式下，复用原有的自动登录逻辑为客户端赋予 `default` 身份会话，同样经过标准的换票与子协议升级流程，保证整套传输安全基线完全统一。

---

## 3. 备选方案与否决理由 (Alternatives Considered & Why Rejected)

### 备选方案 A：在 URL Query 参数中传递 Ticket（如 `ws://host/path?ticket=xxx`）
- *做法*：最常见的简易方案，前端直接拼接 URL 发起连接。
- *否决理由*：
  - **严重违反 OWASP 与 CWE-598 规范**：URL 会被所有反向代理（Nginx、Cloudflare、Traefik 等）、CDN、防火墙、浏览器历史记录与前端报错收集系统完整记录在访问日志中；
  - 一旦日志落盘或泄露，恶意人员可在有效期内利用日志重放凭据。

### 备选方案 B：直接依靠 Cookie 进行 WS Upgrade 鉴权，仅做 Origin 检查
- *做法*：不搞独立的换票流程，在 `server.on('upgrade')` 中手动解析 `cookie` 头部。
- *否决理由*：
  - **缺乏 CSRF 守卫深度防御**：浏览器对 WebSocket Upgrade 请求会自动携带 Cookie，但原生无法添加 `x-csrf-token` 自定义头；
  - 若仅依赖 Origin 检查，一旦反向代理配置不当或内网存在 DNS 劫持/子域名穿透漏洞，攻击者即可实现 CSWSH 跨站连接；
  - 无法利用 Express 已有的完备会话管理与限流管道，导致需要将大量认证代码在底层 raw http server 复制一遍，违反 DRY 原则。

### 备选方案 C：升级后首包认证（In-Band JSON Handshake Envelope）
- *做法*：允许无凭据直接建立 WebSocket 连接，要求客户端在建立连接后 3 秒内发送包含 Token 的首包 JSON，超时未发则断开。
- *否决理由*：
  - **无法阻断连接层 DoS 攻击**：未经鉴权的攻击者可以发起海量 TCP 握手与 WebSocket 协议切换，耗尽 Node.js 文件描述符与内存连接槽位；
  - **破坏 HTTP 语义**：鉴权失败时连接已经被提升为 WebSocket，服务端无法向客户端返回符合标准的 HTTP 401/403 状态码与标头。

### 备选方案 D：基于无状态 JWT 签发票据
- *做法*：使用独立私钥将 userHandle 和过期时间打成 JWT 票据下发，服务端解密验证。
- *否决理由*：
  - **无法满足“即时作废与防重放”**：无状态 JWT 一旦签发，在其过期前无法单方面吊销，除非服务端维护中心化黑名单；
  - SillyTavern 为轻量级独立部署应用，内存级的单次 Ticket 消耗机制（`Map.delete`）实现复杂度远低于 JWT + 吊销黑名单体系。

---

## 4. 后果与权衡 (Consequences & Trade-offs)

### 正面收益 (Positive Consequences)
1. **绝对的凭据私密性**：敏感票据完全收敛在 HTTP 请求体与专用协商协议头中，URL 保持绝对干净，杜绝任何中间反代日志泄露风险；
2. **深度防御 (Defense-in-Depth)**：复用既有的 HTTP CSRF 与 Session 管道，任何未登入或跨站伪造请求在换票阶段即被拦截；
3. **即时会话同步**：彻底解决长连接无法感知登出或禁用的历史顽疾；
4. **与既有生态 100% 兼容**：对前端 DOM 插件和现有界面无任何破坏性变更。

### 负面代价与应对措施 (Trade-offs & Mitigations)
1. **增加了 1 次换票网络往返 (RTT)**：
   - *代价*：在发起 WebSocket 之前需先执行一次 `POST /api/core/auth/ticket`（增加约 1~10ms 本地/局域网延迟）。
   - *应对*：WebSocket 为高频长寿命通道，仅在初次进入页面或网络彻底断线重连时执行一次换票，平摊后的性能损耗几乎为零。
2. **状态ful 长连接与 HTTP 无状态的本质差异**：
   - *代价*：长连接无法像 HTTP 每次请求那样执行全量 Express 中间件扫描。
   - *应对*：在 PROPOSAL-002 中明确声明**不声称与 HTTP 无状态安全完全等价**。传输层必须补充配套的主动会话撤销事件总线（Revocation Event Bus）与帧结构校验，保证在用户权限变更时即刻阻断长连接。
3. **多实例/分布式部署受限**：
   - *代价*：基于内存的单次 Ticket 机制要求换票与升级落在同一 Node.js 进程。
   - *应对*：SillyTavern 本质是单进程桌面/服务器应用；若用户采用高可用多进程集群，反向代理需配置会话保持（IP Hash / Sticky Sessions）。
