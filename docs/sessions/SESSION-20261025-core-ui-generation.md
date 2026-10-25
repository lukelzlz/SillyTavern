# Core 实际发送 UI、唯一落地与失败恢复

工作区：`../SillyTavern-core-ui-generation`；分支：`feat/core-ui-generation`；基线：`9647b8924`。

## 范围与完成门禁

- 承接刷新 Stop 修复，推进真实发送按钮 → Generate → 服务端 Prompt → 消息落地。
- 随后验证 provider 首帧前和流中失败，两标签解除锁定、错误可见并可再次发送。
- 不扩展供应商、工具调用或多 swipe；不包含生成中刷新后的完整文本接管、WS 断线追帧。
- 独立 Chromium、临时 config/dataRoot、动态端口；禁用自动打开浏览器，不使用用户数据，不改变系统网络。
- 主工作区保持原状；本阶段只做本地原子提交，不合入 release、不推送。

## 第一单元：真实发送与持久化

- 新增 `tests/frontend/CoreGenerationUI.real.e2e.js`：创建临时角色与 lore，实际填写输入框和点击发送，检查真实 WS `server_context`、单 job/单 provider 请求、WI/插件 marker 各一次。
- provider 支持首段后暂停，测试在释放前检查页面实际文本，再检查完成态与唯一回复。
- 分别读回原生聊天 API 和 Core `state.json`，刷新页面并重新打开同一聊天，验证完整回复唯一。
- `StreamingProcessor` 首个 token 原本可能被 FPS 节流丢弃；上游随后暂停时页面停在占位符。现首帧立即显示，后续仍按既有频率节流。
- 测试显式创建角色，不假定新数据目录必有默认角色；直接配置 lore 后显式同步已有绑定，避免重新绑定时旧快照覆盖测试配置。

### 验证过程

- 首次测试发现测试配置被旧 Core 快照覆盖，修正配置同步流程。
- 默认角色不稳定，改为通过既有角色 API 创建测试角色。
- 捕获真实首帧已到但 DOM 仍为占位符的失败，再修复首帧渲染。
- 已验证聊天 API 和 Core 快照各有唯一回复；页面刷新后显式重开目标聊天，不将默认欢迎页当成恢复聊天失败。
- 一次运行在服务启动的 `Compiling frontend libraries...` 阶段超过夹具既有 60 秒期限；未到业务用例，未延长超时。检查编译配置和进程后做两次独立冷启动验证，均通过。
- 定向 E2E `--grep "real send UI" --repeat-each=2`：2 次通过。
- 根目录 Lint、修改测试文件 ESLint：通过。
- 完整真实 handoff E2E 初跑暴露旧 Stop 用例在 WS abort 确认前通过 HTTP 放开 provider 的竞态；测试改为等待既有 abort promise 并断言 ABORTED 后再 release，未放宽断言。完整 4 项 E2E 随后通过。
- 定向单测：`bridge-client-generation / core-bridge / generation-orchestrator / prompt-parity`，4 suites / 122 tests 通过。

## 待完成

- 双标签 provider failure 和再次发送回归。
- 最终完整回归、用户验收说明与状态索引更新。
