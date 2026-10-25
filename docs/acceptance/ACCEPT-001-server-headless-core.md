# ACCEPT-001: SillyTavern 服务端 Headless Core 架构验收手册

本手册用于对 **PROPOSAL-001（方案 B：服务端有状态核心化与前端视图投影）** 的全套架构改造进行实操验收与交付闭环验证。

---

## 一、改造核心概述

1. **重计算全部下沉至 Node.js 服务端**：
   - `WorldInfoEngine`：将过去导致 iPhone/移动端剧烈发烫卡死的数百条世界书正则、复杂选择逻辑与级联递归完全交由服务端执行；
   - `PromptEngine`：宏变量替换（`{{char}}`, `{{user}}` 等）、System 组装、上下文预算截断全下沉服务端；
2. **UI 100% 保持现状**：
   - 原生 HTML/CSS 结构、设置弹窗、抽屉面板完全未被修改；
3. **插件生态 100% 兼容闭环**：
   - 建立双向 WebSocket 通信通道与分布式事件桥（`BridgeClient`）；
   - 实现了关键的 `CHAT_COMPLETION_PROMPT_READY` 前端拦截握手：服务端拼装后向前端挂起询问，允许本地第三方插件就地审查/篡改 `messages`，修改结果被服务端采纳生成。

---

## 二、一键自动化测试套件验证 (One-Click Automated Suite)

请在终端执行以下命令，运行针对核心引擎与前后端通信桥的 16 项自动化集成测试：

```sh
cd /Users/zhangran/Documents/SillyTavern-server-core

# 运行全套 16 项自动化集成测试
node tests/core-bridge.test.js && node tests/world-info-engine.test.js && node tests/prompt-engine.test.js
```

**预期输出核验**：
- `✓ /api/core/status passed`
- `✓ Handshake passed`
- `✓ RPC syncFullState passed`
- `✓ Server -> Client event broadcast passed`
- `✓ Client Interception Handshake passed`
- `✓ World Info: Primary keyword / Regex / Selective logic / Constant / Recursive cascade / Depth / Budget (7/7 passed)`
- `✓ PromptEngine: Macro substitution / Budget truncation / End-to-End Interception (4/4 passed)`
- 终端打印 `🎉 ALL 4 PROMPT ENGINE & INTERCEPTION TESTS PASSED! 🎉` 且退出码为 0。

---

## 三、本地服务启动与健康端点验证 (Server Boot & Health Check)

```sh
cd /Users/zhangran/Documents/SillyTavern-server-core

# 启动酒馆服务端（端口 8199）
node server.js --listen=false --browserLaunchEnabled=false --port=8199
```

在另一终端或浏览器访问健康端点：
```sh
curl -s http://127.0.0.1:8199/api/core/status | jq .
```

**预期返回值**：
```json
{
  "ok": true,
  "summary": {
    "userId": "default",
    "characterId": null,
    "characterName": null,
    "chatId": null,
    "messageCount": 0,
    "stateVersion": 0,
    "generationState": "idle"
  },
  "activeSessions": 1
}
```

---

## 四、前端页面与 UI 交互核验清单

1. 打开浏览器访问：`http://127.0.0.1:8199`；
2. **UI 完整性检查**：
   - [ ] 左侧抽屉、顶部导航栏、角色列表与聊天输入框排版完好，无任何错位或样式缺失；
   - [ ] 打开浏览器开发者工具（F12 Console），控制台清晰打印 `[Core Bridge] Connected to SillyTavern Headless Core` 与 `[Core Bridge] Handshake complete`；
3. **插件能力兼容检查**：
   - [ ] 在控制台输入 `SillyTavern.getContext().coreBridge`，确认返回已连接的单例对象；
   - [ ] 现有插件（如 Quick Reply、内置扩展）正常加载与工作。

---

## 五、严格用户验收门禁 (User Acceptance Gate)

根据工程宪法，在完成本地实操验证并确认一切符合预期前，**严禁擅自标记交付、合并或向远程仓库推送代码**。

实操跑通后，请回复：
> **“验收通过”** 或 **“LGTM”**

收到明确确认后，方可执行 Worktree 合并与主干推送闭环。
