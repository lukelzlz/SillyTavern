# 刷新标签页 Stop：失败复现、修复与交接

状态：`[Deployed 本地服务联调完成]`。隔离环境自动化验证通过，尚未用户验收，未合入 `release`、未推送。

工作分支：`fix/core-refreshed-tab-stop`；工作区：`../SillyTavern-refreshed-tab-stop`。主工作区已有改动保留不变。

## 本轮目标与隔离边界

- 承接 `d58dfb8b2`，验证第二个标签页刷新后能停止后台任务，两页恢复 idle。
- 新增 `tests/util/core-handoff-fixture.js`，复用真实服务子进程夹具，使用临时 config/dataRoot 和动态端口，不复用用户数据。
- 服务启动参数明确包含 `--browserLaunchEnabled false`；浏览器使用 Playwright 自建 headless Chromium，不连接用户浏览器。
- mock provider 使用响应等待机制；不切换系统网络、不改防火墙。响应关闭时解除等待，夹具结束时清理子进程。

## 上一轮失败现场（修复前）

1. `npm run test:e2e -- --config=playwright.core-handoff.config.js --workers=1`（在 `tests/`）：前两项真实 transport 用例通过；新增双标签刷新用例超时。清理时页面关闭掩盖了原始错误。
2. 增加动作超时、失败 trace 并避免清理掩盖错误后，定向运行发现新数据目录的 onboarding 弹窗遮挡 Stop。
3. 通过实际点击 Save 完成 onboarding，再运行 `npm run test:e2e -- --config=playwright.core-handoff.config.js --grep "refreshed second"`：点击 Stop 成功，但服务端状态仍为 `STREAMING`，期望 `ABORTED` 的轮询失败。

该轮在定位根因后停止重跑，未执行最终 lint / 完整单测，也未提交。以下记录本次继续实施后的独立验证，不沿用历史结果作为通过证明。

## 根因

- `src/core/generation/job.js` 的 `toJSON()` 输出 `id`。
- `public/scripts/core/bridge-client.js` 的 handshake 直接保存 `msg.activeJob`，刷新后 active job 因此只有 `id`。
- `public/script.js` 的 `stopGeneration()` 远端分支只检查 `activeGenerationJob.jobId`，刷新后的任务无法进入远端 Stop 路径。
- `dispatchGenerationEvent()` 同样按 `jobId` 匹配 active job，终态清理也需要统一身份字段，而不仅是修改按钮条件。

## 本次修复

1. `public/scripts/core/bridge-client.js` 在 handshake 边界统一 `jobId`，优先使用有效的 `jobId`，否则取有效的 `id`；保留快照的原始字段和元数据。缺少有效字符串标识时清空 active job。
2. 规范化发生在标记 ready、唤醒等待者和恢复监听流之前。既有 Stop 分支、事件匹配及三种终态清理直接使用规范化结果，无需到处增加字段兼容判断，也未改变服务端 `toJSON()` 契约。
3. 新增 `tests/bridge-client-generation.test.js`，实际执行 BridgeClient 消息处理代码，覆盖字段兼容、无效标识、token 更新、三种终态清理、其他 job 事件隔离、恢复顺序、重复 Stop 去重和实时 started 路径，共 23 项。
4. 双标签 E2E 明确断言恢复对象同时保留 `id` 和规范化 `jobId`；无需先释放 provider 闸门即可停止任务，并验证两页 active job 清空、生成 UI 与 Stop 按钮收敛。
5. 保留失败清理：取消测试任务、释放 provider 闸门、关闭观察页；清理异常不掩盖原始断言失败。

### 测试环境修复与过程记录

- 隔离夹具先提交为 `ed0c7e150 test(core): isolate real browser handoff fixtures`，刷新回归与生产修复另作一项原子提交。
- 共享认证回归曾出现首帧握手超时。原调用方在 `connectWs()` 返回后注册消息监听，存在漏过即时握手的竞态；现改为在 `open` 回调内注册握手 promise，原有断言等待该 promise。未放宽 2000ms 握手检查，37 项认证回归随后通过。
- 修复生产代码前，新增任务身份/终态定向单测出现 6 项预期失败，直接证明 `id` 快照缺少 `jobId` 且三种终态无法清理。首次单测导入还触发了浏览器 singleton 的自动重连定时器，导致进程未退出；测试现隔离模块初始化调度，不使用强制退出或跳过断言，最终单测正常退出。
- 初次新增单测 ESLint 报 `globalThis` 不在测试配置声明的 globals 中，改用 Node 测试环境已有的 `global` 后通过。E2E 清理条件提取为辅助函数，最终修改文件 ESLint 无 error / warning。
- 依赖由 worktree 软链接复用，未重新安装或修改共享依赖；所有服务使用临时 config/dataRoot，服务端自动打开浏览器明确禁用，未接入用户浏览器、未断网或改防火墙。

## 最终验证（2026-10-25）

以下命令从隔离工作区根目录执行，均为本次实际结果：

| 检查 | 命令 / 环境 | 结果 |
| --- | --- | --- |
| 生产 Lint | `npm run lint` | 通过 |
| 测试 Lint | 在 `tests/` 执行 `./node_modules/.bin/eslint bridge-client-generation.test.js core-auth-regression.test.js frontend/CorePromptHandoff.real.e2e.js playwright.core-handoff.config.js util/core-auth-fixture.js util/core-handoff-fixture.js util/core-handoff-provider.js` | 0 errors / 0 warnings |
| 新增单测 | `npm --prefix tests run test:unit -- bridge-client-generation.test.js --runInBand` | 23 tests 通过 |
| 刷新 Stop 定向 E2E | `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --grep "refreshed second" --workers=1` | 1 test 通过 |
| 完整真实 handoff E2E | `npm --prefix tests run test:e2e -- --config=playwright.core-handoff.config.js --workers=1` | 3 tests 通过 |
| 默认配置浏览器回归 | `npm --prefix tests run test:e2e -- frontend/CorePromptHandoff.e2e.js --config=playwright.config.js --workers=1` | 5 tests 通过 |
| 针对性单测 | `npm --prefix tests run test:unit -- bridge-client-generation.test.js core-bridge.test.js generation-orchestrator.test.js prompt-parity.test.js core-auth-regression.test.js --runInBand --silent --verbose=false` | 5 suites / 159 tests 通过 |
| 完整单测 | `npm --prefix tests run test:unit -- --runInBand --silent --verbose=false` | 29 suites / 622 tests 通过 |

默认配置浏览器回归由临时 runner 复制 `default/config.yaml` 到临时目录，保持 Core transport 默认关闭；用临时 dataRoot 和动态端口启动 `node server.js`，带 `--browserLaunchEnabled false --listen false`，通过 `ST_BASE_URL` 把地址交给 Playwright。`GET /csrf-token` 返回 HTTP 200，结束后服务与临时目录已清理。真实 handoff 配置则由仓库内夹具自行启动启用 Core 的隔离服务。

### 关键行为证据

- 页面 A 发起任务，provider `pending=1`；页面 B 显示 generating。
- B 刷新后恢复同一任务，且没有本地 `StreamingProcessor`。
- B 点击真实 `#mes_stop`，服务端进入 `ABORTED`，provider `pending=0`，此前没有调用 release。
- 两页 generating 状态取消，Stop 隐藏，active job 均为 null；A 的流以 `Clicked stop button` 结束。

## 验证范围限制与下一步

新增双标签测试通过真实 Core `startGenerationStream()` 发起 `client_final` 请求，验证的是后台任务恢复/停止，不是 `Generate()` / `sendStreamingRequest()` 全 UI 入口。provider 响应等待也不等同于 WebSocket 断线恢复，两种测试不得混称。

下一步依次补齐：真实发送 UI 入口及消息落地去重、provider failure 后跨标签错误和发送状态恢复、刷新后的完整文本接管与定向 WS 追帧。本次不宣称上述完整目标已验收。
