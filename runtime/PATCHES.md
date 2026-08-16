# runtime/ — vendored 运行时本地改动记录

本目录来自 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（MIT，含 Linux 移植 PR #234
与本地代理补丁），在首次 vendoring 提交 `a77dee4` 时整体引入。**只读参照**为主。

> 排查/跟进上游前先看这里：如果一项改动只在下面列出，说明它相对上游是我们或本仓库维护引入的；
> 没列出的文件 = 与 vendored 时一致（它们可能本就是这个 Linux 移植自带的本地化）。

## 明确的本地改动（相对 vendored 基线）

| 文件 | 改动 | 原因 / 提交 |
|---|---|---|
| `runtime/ego-linux/src/cursor.mjs` | 光标覆盖层默认名 `Claude` → `DeepSeek`（4 处：默认值 + 注释） | 品牌统一，`dacbd47` |
| `runtime/ego-linux/src/paths.mjs` | `CHROME_CONFIG_CANDIDATES` 增加 **Windows** 候选：`%LOCALAPPDATA%\Google\Chrome\User Data`、`...\Microsoft\Edge\User Data`、`...\BraveSoftware\Brave-Browser\User Data`（仅 `win32` 且 `LOCALAPPDATA` 存在时追加） | Windows 适配：`--import-chrome-profile` 原本只找 Linux 路径（`~/.config/google-chrome`），在 Windows 上找不到真实 Chrome 数据，登录继承失效 |
| `runtime/ego-linux/src/chrome.mjs` | `stopBrowser()` 的兜底杀进程改用新增的 `terminateTree()`：Windows 走 `taskkill /T /F`（先经 `ownsOurProfileOnWindows()` 用 PowerShell CIM 校验该 pid 的命令行确实指向我们的 profile，防 pid 复用误杀），POSIX 维持 `SIGTERM` | Windows 适配：原 `process.kill(pid,"SIGTERM")` 在 Windows 只杀主进程、子进程树（renderer/gpu 等）残留并锁住 profile，导致 `--open` 起的 detached 窗口 `--stop` 停不干净（2026-08-16 实测 8 个残留进程） |
| `runtime/ego-linux/src/chrome.mjs` | `BINARY_CANDIDATES` 增加 `windowsBrowserCandidates()`：`win32` 时补 Chrome/Edge/Brave 的 Windows 安装路径（正斜杠，`exists()` 判定；POSIX 为空数组、无害） | Windows 适配：原候选只有 Linux 命令名（`which` 找），Windows 上绕过 launcher 直接跑 runtime 时找不到浏览器；补齐后 runtime 自身在 Windows 也自足 |
| `runtime/ego-linux/src/chrome.mjs` | `launch()` 的初始标签页改读 `EGO_LINUX_START_URL || "about:blank"` | 首启直达：`ego-browser --url <url>` 时冷启动直接打开目标页，不再先出一个 about:blank 空白页窗口（2026-08-16） |
| `runtime/ego-linux/src/chrome.mjs` | **单实例根因修复**：新增 `enumerateOwnBrowserMainProcesses()`（win32 用 CIM 按 `--user-data-dir` + `--class=ego-lite-linux` + 非 `--type=` 枚举本 profile 的活主进程）；`browserStatus()`/`ensureBrowser()` 探针失败不再判死，改为查活进程并用 `waitForEndpoint` 恢复端点（复用优先，绝不新开）；`launch()` 顶部加活实例护栏；`clearProfileLock()` win32 用 CIM 确认锁持有者确实死了才删锁（活实例的锁绝不删，否则破坏 ProcessSingleton 交接导致第二个独立 Chrome 实例）；新增 `STATE_DIR/launch.lock` 跨进程启动互斥（`fs.open('wx')` + pid 过期检测）；`reapOrphanedBrowsers()` win32 分支用 CIM 枚举回收孤儿（原 `/proc` 在 Windows 恒失效）；`ownsOurProfileOnWindows()` 改为复用枚举器 | Windows 多开（多个独立 Chrome 进程组）根治：原判定/删锁/孤儿回收都依赖 Linux `/proc`，在 Windows 上失效 → 冷启动慢或状态过期时误判已死并删活锁，spawn 出第二个实例（2026-08-16） |
| `runtime/ego-browser/dist/out/index.js` | harness `relativeSitePath()` 的"工具路径必须在 site skill 目录内"校验：原用 `${siteRoot}/`（正斜杠）做 `startsWith`，Windows 上 `path.resolve` 返回反斜杠 → 所有 learnings 相对工具路径都校验失败；改为按实际分隔符 `sep` 拼接 | Windows 兼容：bilibili/google 等 learnings 的 nodeTools/browserTools 在 Windows 无法 `runTool`（2026-08-16） |
| `runtime/ego-linux/src/chrome.mjs` | **固定调试端口**：`launch()` 改用 `pickDebugPort()`（默认 `--remote-debugging-port=9222`，`EGO_LINUX_DEBUG_PORT` 可覆盖；被占则找相邻空闲端口，全忙才回退 0）；新增 `recoverLiveEndpoint()`：`browserStatus()`/`ensureBrowser()` 的活实例路径先读 `DevToolsActivePort` 文件，失败再**从活进程命令行 `--remote-debugging-port=` 恢复端口**；新增 `waitForPortReady()`：固定端口下 Chrome **不再写 `DevToolsActivePort` 文件**（Chrome 151/headless 实测），故直接 probe 已知端口，且 probe（HTTP `/json/version`）成功后再稳定延迟 1.5s 等 browser-level ws 真正就绪，避免首个 CDP socket 挂起 | CDP 连接可靠性：随机端口依赖 `DevToolsActivePort` 文件，状态文件丢失即无法重连；固定端口 + 从 cmdline 恢复让"下一 heredoc 连得上"不再依赖状态文件；固定端口下 Chrome 不写端口文件且 browser ws 滞后 HTTP，需直接 probe + 稳定延迟（2026-08-16） |
| `runtime/ego-linux/src/transport.mjs` | 新增 `openSocketWithRetry()`：`connectCdp()` 打开 browser-level WebSocket 失败时**重试 3 次（间隔 2s）**再放弃；**移除 connectCdp 里残留的"等待 open" promise**（openSocketWithRetry 已确保 socket open，残留的 open 等待对新 socket 永远超时） | CDP 连接可靠性：open 失败多为瞬时竞态（浏览器仍在就绪），重试避免偶发"刚 launch 即连不上"；残留 open 等待是固定端口改造时引入的回归，导致 connectCdp 永远 10s 超时（2026-08-16） |
| `runtime/ego-linux/src/task-spaces.mjs` | 新增 `reflowSpaceCookies()`：`disposeContext()` 销毁 context 前把该 space 的 cookies 合并回默认 jar；新增 `adoptStartupTarget()`：`EGO_LINUX_START_URL` 冷启动时把默认 context 的启动页认领为第一个 space 的 anchor（共享 jar） | 登录态持久 + 不多开：space 的独立 context 是内存 cookie jar，销毁即丢登录态，先回流默认 jar 才能跨会话继承；首启直达时认领启动页避免“空白页 + 第二个标签页”（2026-08-16） |
| `runtime/ego-linux/bin/ego-browser.mjs` | 新增 `--url <url>` / 裸 URL 参数解析（设 `EGO_LINUX_START_URL`，`nodejs` 前缀剥离移到其后）；`--stop` 前先把仍存活 space 的 cookies 回流默认 jar 再停浏览器 | 同上：支持 `ego-browser --url <url>` 首启直达；`--stop` 兜底防止浏览器关闭时把 space 登录态一起丢掉（2026-08-16） |
| （其余 runtime 文件）| 与 vendoring 时一致 | 无后续本地改动 |

## 说明
- `chrome.mjs` 里的代理支持（`EGO_LINUX_PROXY`）在首次 vendoring 时已包含（本 Linux 移植特性），
  非后续本地改动；如需调整走它。
- **同步提醒**：`lib/index.js` 与 `bin/ego-cast-worker.mjs` 各有一份 humanCheck 探针（逻辑相似）——
  若改探针特征，两处都要同步。
- 若要跟进 ego-lite 上游，重点 diff 上表的 cursor.mjs；其余文件可直接与上游对齐。
