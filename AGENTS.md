# AGENTS.md

本项目（SillyTavern）采用文档驱动开发（Doc-Driven Development）与严格的代码治理规范。所有参与本项目的 AI Agent 必须遵守以下约定：

---

## 1. 仓库边界与防乱建规则 (Repository Boundary & Cleanliness)

- **严禁随地散落临时文件**：严禁在项目根目录、`src/` 或 `public/` 目录下放置 `PLAN.md`, `NOTES.md`, `TODO.md`, `temp/` 等未受治理的文件。
- **文档统一收敛机制**：
  - 需求提案与 PRD 归入 `docs/proposals/<slug>.md`
  - 架构决策记录 (ADR) 归入 `docs/decisions/<slug>.md`
  - 原始推演、故障复盘与工作记忆归入 `docs/sessions/<slug>.md`
  - 交付与实操验收手册归入 `docs/acceptance/<slug>.md`
- **代码精简与复杂度惩罚**：
  - 优先使用项目既有的原生轻量模块，避免为单点微调引入庞大的第三方依赖或过度复杂的工厂层。
  - 文档内严禁硬编码开发者绝对路径，一律使用仓库内相对路径。

---

## 2. Git Worktree 并发隔离规范 (Concurrent Worktree SOP)

- **工作区脏态守卫**：当主工作区存在未提交代码，或需进行高危审查、跨版本比对时，强制在同级目录建立隔离 Worktree：
  ```sh
  git worktree add ../SillyTavern-<topic> <branch>
  ```
- **资源秒级复用**：前端依赖与用户数据目录可通过软链接复用，避免冗余下载：
  ```sh
  ln -s "$(pwd)/node_modules" "../SillyTavern-<topic>/node_modules"
  ```
- **闭环清理**：验收合并推送后，必须先解除软链接，再执行 `git worktree remove`，保持环境整洁。

---

## 3. 最短验证命令集 (Shortest Verification Commands)

AI 在修改代码后，必须优先执行本节声明的最短命令进行自测与校验：

```sh
# 1. 生产依赖安装 (最小化极速安装)
npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts

# 2. 静态语法与代码规范检查 (Lint)
npm run lint

# 3. 单元测试 (需要进入 tests 目录并安装测试依赖)
cd tests && npm run test:unit

# 4. 服务端启动健康验证
node server.js
```

---

## 4. 完成度状态阶梯 (Completion States)

与用户协作或提交审查时，必须准确标注当前达到的完成度阶梯，严禁概念混淆：
1. `[Modified 本地改动]`：代码/配置已修改，尚未执行完整测试。
2. `[Tested 单测/检查通过]`：已通过本地 Lint、语法或自动化测试。
3. `[Deployed 容器/服务联调完成]`：本地 Node 服务已成功启动且接口交互正常。
4. `[Accepted 用户签字确认]`：用户已根据验收手册实操验证并明确回复“验收通过/LGTM”。
5. `[Pushed 提交与推送]`：改动已 Commit 并 Push 至远程 Git 仓库。

---

## 5. 部落知识库与历史踩坑 (Tribal Knowledge)

- **[iOS / Safari GPU 图层爆炸与发热深坑]** (`docs/sessions/SESSION-HIST-001-mobile-gpu-overheating-analysis.md`)：
  - SillyTavern 内置多达十几个全屏抽屉面板（`.drawer-content`），若收起时仅使用 `transform: translateX` 移出可视区且叠加了 `backdrop-filter: blur(...)`，iOS WebKit 会对所有离屏层保持合成并持续执行模糊计算，导致 iPhone 严重发热降频。
  - **避坑准则**：收起或隐藏抽屉面板时必须伴随 `display: none !important;` 或 `visibility: hidden;`，阻断离屏渲染。
- **[PNG 角色卡元数据与 tEXt 数据块规范]** (`docs/sessions/SESSION-HIST-002-character-card-png-chunk-parser.md`)：
  - Tavern 角色卡采用 PNG `tEXt` 数据块存储数据：V2 对应关键字 `chara`（Base64 编码的 JSON），V3 对应 `ccv3`。
  - 聊天软件复制、浏览器右键缩略图保存或 CDN 自动压缩均会剥除 Ancillary Chunks，导致服务端抛出 `Error importing character`。
  - **避坑准则**：导入失败时优先核查图片元数据块完整性，推荐使用原图传输或直接使用 `.json` 角色文件。
- **[前端 Extension 与服务端 Plugin 职责边界]**：
  - 前端扩展位于 `public/scripts/extensions/third-party/`，主控 DOM 交互、CSS 美化与前端事件拦截。
  - 服务端插件位于 `plugins/`，须在 `config.yaml` 中显式开启 `enableServerPlugins: true`，负责 Node 端重度计算与原生能力扩展。
- **[Core 刷新任务身份契约]**：服务端 job 快照使用 `id`，实时事件和浏览器生成控制使用 `jobId`。必须在 BridgeClient handshake 边界统一标识，并在 ready / reconnect recovery 前完成；只兼容 Stop 按钮而不覆盖终态匹配会留下 stale active job。见 `docs/sessions/SESSION-20261025-refreshed-tab-stop-blocker.md`。

---

## 6. 工作记忆与变更索引 (Session & Proposal Index)

| 日期 / ID | 类型 | 标题 / 议题 | 关联文档 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-08-18 | Hist | SillyTavern 移动端 (iOS/Safari) 严重发热与 GPU 图层爆炸排查 | `docs/sessions/SESSION-HIST-001-mobile-gpu-overheating-analysis.md` | Accepted |
| 2026-08-19 | Hist | 角色卡导入失败 (Error importing character) 与 PNG tEXt 块解析 | `docs/sessions/SESSION-HIST-002-character-card-png-chunk-parser.md` | Accepted |
| 2026-10-19 | Init | 初始化项目文档驱动体系与跨 Agent 历史记忆继承 | `AGENTS.md` | Accepted |
| 2026-10-19 / PROPOSAL-001 | Spec | SillyTavern 服务端有状态核心化与前端视图投影重构 | `docs/proposals/PROPOSAL-001-server-side-headless-core.md`, `docs/decisions/ADR-001-state-mirror-and-bridge-event-bus.md` | Accepted |
| 2026-10-20 / PROPOSAL-002 | Spec | Core WS 一次性票据握手与安全认证传输规范 | `docs/proposals/PROPOSAL-002-core-authenticated-transport.md`, `docs/decisions/ADR-002-core-ws-ticket-authentication.md` | Accepted |
| 2026-10-20 / PROPOSAL-003 | Spec | 服务端 World Info 语义对齐与金标差分契约 | `docs/proposals/PROPOSAL-003-world-info-parity-contract.md`, `docs/decisions/ADR-003-world-info-canonical-contract.md` | Accepted |
| 2026-10-20 / PROPOSAL-004 | Spec | 服务端 Prompt 装配等价性纯数据契约与黄金差分 | `docs/proposals/PROPOSAL-004-prompt-parity-golden-contract.md`, `docs/decisions/ADR-004-prompt-parity-differential-testing.md` | Accepted |
| 2026-10-20 / PROPOSAL-005 | Spec | 服务端生成编排器与后台常驻任务管理器 (锁屏断网续传) | `docs/proposals/PROPOSAL-005-generation-orchestrator.md`, `docs/decisions/ADR-005-generation-orchestrator.md` | Accepted |
| 2026-10-25 / SESSION-20261025 | Session | Core World Info 服务端交接递归、大小写与 chronological scan parity 阶段推进 | `docs/sessions/SESSION-20261025-world-info-server-handoff-recursion.md` | Tested |
| 2026-10-25 / SESSION-refresh-stop | Session | Core 刷新标签页任务身份规范化、远端 Stop 与双页 idle 闭环 | `docs/sessions/SESSION-20261025-refreshed-tab-stop-blocker.md` | Deployed（隔离自动化联调；未用户验收） |
| 2026-10-25 / SESSION-core-ui-generation | Session | Core 实际发送 UI、消息唯一落地、provider 失败跨标签恢复 | `docs/sessions/SESSION-20261025-core-ui-generation.md` | Tested（隔离自动化通过；测试目录存在既有 lint 阻塞；未用户验收） |
