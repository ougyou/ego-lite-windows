# ego-browser CDP 连接可靠性设计（2026-08-16）

> 状态：**已实现（第一步）**。探讨自用户提出的"CDP 经常断联，是否参考 playwright
> 用调试端口 + ws 连接更可靠"。
> 本仓库非 git 仓库，无法 commit（沿用前几轮说明）。

## 1. 背景与探讨结论

用户观察到 CDP 断联频繁，提出参考 playwright-cli-portable 的"固定调试端口 +
ws 连接"方式。探讨后结论：

- **方向正确**，但可靠性不来自"端口形式"，而来自"连接/session 管理与复用/重连"。
- 断联分三层：端口/启动期、连接建立、进程内 session/target 生命周期。
- **第一步（本轮）**：解决连接建立期可靠性——固定调试端口 + 状态文件丢失也能
  从进程命令行恢复端口 + ws 打开重试。
- **边界**：进程内 session 断联（如验证码页的 `browser connection closed`）依赖
  harness（编译产物）重建 session，改 dist 风险高；由既有 handoff SOP 兜底，
  彻底方案为第二步"长驻连接代理"（类似 playwright MCP 守护进程持有 ws）。

## 2. 设计（第一步）

1. **固定调试端口**：`launch()` 默认 `--remote-debugging-port=9222`
   （`EGO_LINUX_DEBUG_PORT` 可覆盖）；被其他进程占用则找相邻空闲端口，全忙回退
   `0`（Chrome 自选）。端口可预测、可从进程命令行读出。
2. **从进程命令行恢复端口**：`recoverLiveEndpoint()` —— `browserStatus()` /
   `ensureBrowser()` 的活实例路径先读 `DevToolsActivePort` 文件，失败则从
   `enumerateOwnBrowserMainProcesses()` 的 cmdline 提取 `--remote-debugging-port=`
   并 probe。即使 `browser.json` / `DevToolsActivePort` 丢失也能重连。
3. **ws 打开重试**：`connectCdp()` 用 `openSocketWithRetry()` 打开 browser-level
   WebSocket，失败短间隔重试 3 次（`waitForEndpoint` 已确认端口可答，open 失败
   多为瞬时竞态）。

## 3. 变更文件清单

| 文件 | 变更 |
|---|---|
| `runtime/ego-linux/src/chrome.mjs` | `pickDebugPort()`/`isPortFree()` + launch 固定端口 + `recoverLiveEndpoint()` + browserStatus/ensureBrowser 用它 |
| `runtime/ego-linux/src/transport.mjs` | `openSocketWithRetry()` 接入 `connectCdp()` |
| `runtime/PATCHES.md` | 登记上述两处 |

## 4. 验证

- 语法：`node --check` 通过。
- 隔离 headless 冒烟（`verify.mjs`）+ 单实例回归（`verify-single-instance.mjs`）：
  固定端口工作、无回归。
- 不回归：单实例、`--stop` 清零、复用。
