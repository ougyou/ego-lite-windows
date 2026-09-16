# runtime/ — vendored 运行时本地改动记录

本目录来自 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（MIT，含 Linux 移植 PR #234
与本地代理补丁），在首次 vendoring 提交 `a77dee4` 时整体引入。**只读参照**为主。

> 排查/跟进上游前先看这里：如果一项改动只在下面列出，说明它相对上游是我们或本仓库维护引入的；
> 没列出的文件 = 与 vendored 时一致（它们可能本就是这个 Linux 移植自带的本地化）。

## 明确的本地改动（相对 vendored 基线）

### 2026-09-15：harness 升级到上游 v2.0.0（**默认**；v1 保留为可选）

| 文件 | 改动 | 原因 |
|---|---|---|
| `runtime/ego-browser/dist/out/index.v2.js` | **新增**：上游 citrolabs/ego-lite `v2.0.0`（tag `d01be93`）的 `package/ego-browser` 构建产物，构建前在源码打了下面的 sep 补丁 | 上游 v2 相对本仓 bundle（2026-08 的 v1.2.x）多了 6 周 / 155 个提交（85 个是 ego-browser 核心）：ref 生命周期保活、iframe 可靠性、actionability 诊断、compact snapshot、下载 API 等。默认加载 `index.v2.js` |
| `runtime/ego-linux/bin/ego-browser.mjs` | 引擎选择：默认 harness = `index.v2.js`，`EGO_BROWSER_HARNESS=v1` 时回退 `index.js`（旧 facade 方言）；`--sdk-path <f>` 仍最高优先。另把 `nodejs` 前缀剥离由「仅当 argv[0]」改为**任意位置**（`argv.indexOf("nodejs")` 后 splice） | v2 的 `runMain()` 严格拒绝任何残留 argv（打印 usage 退出），旧顺序 `--headless nodejs` 会把 `nodejs` 漏进去；v2 成默认的前提是下述 transport 修复（个人模式已实测可用） |
| `runtime/ego-linux/src/task-spaces.mjs` | `adoptPersonalSpace()` 的个人伪 space 改用**数字 id**（`state.nextId` 计数，与真实 space 同一计数器；`browserContextId` 仍为 `null` 保持非隔离），并对旧记录做一次性迁移 | v2 harness 强制 `TaskSpace requires a numeric id`，字符串 id `"personal"` 会让个人模式下 `taskSpace()` 直接抛错 |
| 上游源码 `package/ego-browser/src/learning/index.ts`（**构建期补丁，未随 bundle 发布源码**） | `relativeSitePath()` 边界校验由 `startsWith(\`${siteRoot}/\`)` 改为按实际分隔符 `sep` 拼接（并 `import { sep }`）。上游 v2.0.0 **仍未修** | Windows 上 `path.resolve` 返回反斜杠，正斜杠边界校验会让所有 learnings 的相对工具路径校验失败（同一 bug 此前已打在 v1 bundle 上） |
| `runtime/ego-linux/src/transport.mjs` + `cursor.mjs` | 会话认领机制重构：**响应永不被吞**（id < `INTERNAL_ID_BASE` 的入站消息只可能应答 harness，吞掉即 15s 超时）；`claimSession(id, { silent })` 新增非静默认领，光标 overlay 改为非静默（其会话可能被 harness 共享，事件流也要送达 harness；spaces 面板的 screencast 转播保持静默防刷屏） | **修复 v2 harness 在个人接管模式挂死的根因**（2026-09-15 transport 双向日志实证）：Chrome 在 `Target.setDiscoverTargets` 开启后，会把连接上的**每次 attach**（含 shim 内部的光标 overlay attach）都以 `Target.attachedToTarget` 事件广播 → v2 harness 从事件注册该会话并直接驱动它（`ensureSession` 的 2s 缓存快速路径）→ 而光标又认领了同一会话 → 传输层把该会话的**全部消息**（包括 harness 的响应）当 shim 私有吞掉 → 所有页面操作 15s 超时（"page is still unresponsive"）。隔离模式因 headless 下光标禁用而幸免；偶发性来自 harness 先 attach 自己的会话（正常）还是先注册到光标会话（挂死）的竞态。修复后个人模式 v2 六步探针（taskSpace/adopt/adoptedRead/newPage/goto/read）连续三轮全绿，v1 三项回归 + v2 冒烟 + 单实例回归全部无回归 |

**切换为默认的依据**：上表 transport 修复落地后，个人接管模式 v2 六步探针连续三轮全绿（此前该模式 15s 超时挂死，详见上表根因）；隔离模式、单实例回归、v1 引擎冒烟（`verify:v1`）亦全绿，故 v2 转正为默认，v1 以 `EGO_BROWSER_HARNESS=v1` 保留（旧脚本兼容，方言见 `references/facade.md`，文件顶部已标注）。

**两个引擎的脚本方言不同**（v2 API 默认 ↔ v1 facade 可选）：`taskSpace(n)` ↔ `taskSpaces.useOrCreate(n)`；`task.page("p1")`/`task.tabs()`/`page.close()` ↔ `browser.openOrReuseTab/listTabs/closeTab`；`task.finish({keep})` ↔ `taskSpaces.complete(id,{keep})`。v2 方言见 `references/api.md` 与 SKILL.md（已以上游 2.0.0 文档为基底重建，保留本仓 Windows 调用规则、个人接管 SOP、Open→Verify→Correct、Win 注意事项）。

构建 v2 bundle 的方式（Windows）：

```bash
cd <upstream clone>/package/ego-browser
npm install --ignore-scripts   # 上游 prepare 钩子是 POSIX shell 写法，Windows 下直接失败
node scripts/build.mjs         # 产物 dist/out/index.js（约 800K）→ 复制为 index.v2.js
```

| `runtime/ego-linux/src/chrome.mjs` | `stopBrowser()` 在状态文件缺失/失效时**兜底枚举本 profile 的活主进程并终止**（`enumerateOwnBrowserMainProcesses` → `terminateTree`，二者都带归属校验，绝不误伤用户自己的浏览器）；`--stop` 成功关停后**清掉 space 台账** `task-spaces.json` | 修复本仓自带回归测试的既有失败（**未改动的 HEAD 上 `scripts/verify-single-instance.mjs` 的 S4/S5 就会失败**，2026-09-15 实证）：① 两个冷启动竞争同一 profile 时，落败方的清理会删掉 `browser.json`，此时 `--stop` 只认状态文件 → 浏览器活着却停不掉且失去句柄；② 浏览器已停但台账里的 space 仍记着已失效的 `browserContextId`/`targetId`，下次冷启动续用同名 space 会失败（`verify-personal` 与单实例测试均覆盖）。修后 `verify-single-instance` 全绿 |

### 2026-09-16：性能修复（bin 直连 + 枚举缓存）

| 文件 | 改动 | 原因（含实测修正） |
|---|---|---|
| `bin/ego-browser.cmd`、`package.json`、`scripts/verify*.mjs` | 入口直连 `runtime/ego-linux/bin/ego-browser.mjs`（单 Node 进程）。原先 `bin → node launcher → node runtime` 双 Node 启动；runtime 自带 Windows 浏览器探测（`windowsBrowserCandidates`）与 workspace 设置、`--headless` 参数也原生处理，launcher 四项职责全部冗余。`scripts/ego-browser-launch.mjs` 保留未删（兼容显式调用），但 bin/npm scripts/verify 全部不再经过它 | Windows 一次 Node 启动实测 ~400ms（Defender 扫描加成），双跳多付 ~200ms/次。实测 warm 轻调用 **790ms → 590ms（-25%）**。注：最初预估"省 1.5s"系脚本内容混淆（对比项里一个带整页加载一个不带），实测修正为 ~200ms |
| `runtime/ego-linux/src/chrome.mjs` | `enumerateOwnBrowserMainProcesses()` 增加同进程 **1.5s TTL 缓存**（按 profileDir 键控，POSIX 不缓存）；`terminateTree()` 杀进程与 `launch()` spawn 之后主动失效缓存 | PowerShell+CIM 单次 ~1.2s。冷启动干净路径本就只枚举 1 次（实测冷启动 ~10s 不变，由 Chrome 启动 + 端口稳定延迟 1.5s 主导），缓存的收益在**多次枚举场景**：`--stop` 兜底循环逐进程校验归属、personal 模式多端口探测、回归测试密集 `countOwn`——合并为一次扫描 |

**性能归因（实测，沙箱 + 真机）**：每次调用固定开销 ≈ Node 启动 400ms + 连接/attach/域启用 ~200ms，warm 轻调用 590ms 是当前"每次 heredoc 一个新进程"架构的地板；冷启动 ~10s 由 Chrome 启动 + 1.5s 端口稳定延迟主导。macOS 快的本质是 app 内常驻连接（无每次握手、无发现/枚举防护）。质变需要常驻连接/daemon 模式，另行立项。

### 原有改动（相对 vendored 基线）

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
| `runtime/ego-linux/bin/ego-browser.mjs` | **个人接管模式 CLI**：新增 `--prefs <json>` / `--prefs-clear` / `--isolated`；`--status` 并入 `personal` 报告；默认 nodejs 分支经 `resolveBackingBrowser()`（无档案 → NO_PREFS exit 2，绝不擅自启动）；`--stop` personal 分支经 `stopPersonalBrowser()`（只关 ego 自启实例，外部实例输出"attached only"不杀） | 个人接管模式：档案建档/读取/清除命令、状态报告、统一接管/直达入口、外部实例只断不杀（2026-09-06） |
| `runtime/ego-linux/src/shim.mjs` | `createEgoShim({ headless, endpoint })` 支持注入端点（`endpoint || ensureBrowser`），供 personal 模式传入 `resolveBackingBrowser` 结果 | 个人接管模式：接管外部浏览器时避免二次走 ensureBrowser（2026-09-06） |
| `runtime/ego-linux/src/paths.mjs` | 新增 `PERSONAL_PREFS_FILE` / `PERSONAL_STATE_FILE`（`STATE_DIR/personal-browser.json`、`personal-browser-state.json`） | 个人接管模式：用户认可启动档案与其记账状态文件（2026-09-06） |
| `runtime/ego-linux/src/personal-prefs.mjs` | **新增模块**：`normalizePrefs`/`loadPrefs`/`savePrefs`/`clearPrefs`/`profileMatches`（档案读取/写入/清除 + `--user-data-dir=` 身份核对纯函数）；配单测 `runtime/ego-linux/test/personal-prefs.test.mjs` | 个人接管模式：启动档案"读取优先 / 无则建档 / 每次启动前读取"；接管前身份核对防误接他人 Chrome（2026-09-06） |
| `runtime/ego-linux/src/chrome.mjs` | **个人接管模式**：新增 `personalEnabled()`（默认开，`EGO_LINUX_PERSONAL=0`/CLI `--isolated` 关）、`parseWinCimChrome()`/`findChromeMainOnPort()`（泛化端口进程枚举 + profile 过滤，纯函数配单测 `chrome-personal.test.mjs`）、`personalStatus()`（只 probe 不 launch 的报告）、`resolveBackingBrowser()`（统一入口：`EGO_LINUX_CDP_URL`→直连；personal→读档案→probe 端口→身份核对后接管 / 无则按档案启动；isolated→原 `ensureBrowser()`）、`launchPersonal()`（按档案启动并写 `PERSONAL_STATE_FILE` 记账）、`stopPersonalBrowser()`（只优雅关 ego 自启实例，外部实例只断开） | 个人接管模式：默认接管用户 workspace Chrome（复用登录态/现有 tab），不弹空白窗；身份核对防误接；外部实例绝不杀（2026-09-06） |
| `runtime/ego-linux/src/task-spaces.mjs` | **新增 `adoptPersonalSpace(name="personal")`**：建立/复用**非隔离** space（`browserContextId=null`），把浏览器当前**默认 context** 的 page target（非 devtools、非 createBrowserContext 产物）登记为其成员并置为 selected/pinned；幂等，每次 heredoc 重算成员；配集成验证（spike `docs/superpowers/spikes/2026-09-06-personal-takeover-findings.md` 与 Task 5 E2E） | 个人接管模式：就地驱动现有 tab、复用登录态/会话；新 tab 落默认 context 并被跟踪；不改不关用户原有 tab（2026-09-06） |
| `runtime/ego-linux/src/shim.mjs` | personal（注入 `endpoint`）时在 shim 装配末尾自动 `await taskSpaces.adoptPersonalSpace("personal")`（best-effort，失败回落无 scope 全量列 tab） | 个人接管模式：脚本第一步 `browser.listTabs()` 即见用户现有 tab（2026-09-06） |
| `runtime/ego-linux/src/chrome.mjs` | **追加健壮性**：新增 `findChromeMainWithProfile(userDataDir)`（按 profile 扫任意端口主进程）；`resolveBackingBrowser()` probe 失败时先区分「带端口正在就绪（等待）」/「在跑但没开调试端口（给可操作错误，提示关闭或用档案重启）」/「空闲（才启动）」，避免对已占用 profile 二次启动白等 20s | 个人接管模式真实边界：Chrome 单实例限制下，对"在跑但无调试口"的 workspace Chrome 给出明确指引而非超时（2026-09-06） |
| （其余 runtime 文件）| 与 vendoring 时一致 | 无后续本地改动 |

## 说明
- `chrome.mjs` 里的代理支持（`EGO_LINUX_PROXY`）在首次 vendoring 时已包含（本 Linux 移植特性），
  非后续本地改动；如需调整走它。
- **同步提醒**：`lib/index.js` 与 `bin/ego-cast-worker.mjs` 各有一份 humanCheck 探针（逻辑相似）——
  若改探针特征，两处都要同步。
- 若要跟进 ego-lite 上游，重点 diff 上表的 cursor.mjs；其余文件可直接与上游对齐。
- **仓库级（非 vendored）配套**（2026-09-06，个人接管模式）：新增
  `scripts/verify-personal.mjs`（personal E2E，隔离临时 Chrome，`package.json` 加
  `verify:personal`）；`scripts/verify.mjs` 与 `scripts/verify-single-instance.mjs` 的 spawn env
  注入 `EGO_LINUX_PERSONAL=0`（这两个回归驱动的是 isolated ego profile，须显式关掉 personal 默认）。
