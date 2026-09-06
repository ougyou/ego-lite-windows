# Operating preferences（操作约定 · 用户的习惯）

> 这些是用户（本人）在使用本仓库/浏览器时的**长期习惯与偏好**。任何 agent /
> Copilot 在驱动 `ego-browser` 时都应遵守。移植到其他电脑后同样生效。

## 1. 显式操作（最重要 · 不可违反）

**任何涉及以下动作的操作，执行前必须先向用户说明并征得明确同意，绝不自主执行：**

- 启动浏览器/窗口（`--open`、可见窗口、弹窗）
- 杀进程 / 清理残留（`--stop`、taskkill、强杀）
- 修改文件、数据、配置、profile
- 运行可能耗时/有副作用的命令（安装、长任务、网络请求）
- 任何涉及用户**本机真实浏览器（Chrome/Edge/Brave）或个人数据**的操作

用户本机浏览器和真实数据**永远不可被擅自读取、修改、复制或终止**。agent 只
操作自己的 profile（`~/.local/share/ego-lite-linux`）。

## 2. 语言

与用户使用**中文**交流。

## 3. 登录态：用"登录一次"法，别依赖 import

- 需要登录的站点：用可见浏览器 `--open` 登录**一次** → `--stop` 优雅关闭落盘
  → 之后所有任务空间自动继承登录态。
- **不要依赖 `--import-chrome-profile`**：Windows 上 Chrome cookie 加密、解密
  密钥在源 `Local State`，导入只复制 `Default`，登录态传不过（实测无效）。
- 如果自动化过程中遇到登录、验证码、SSO、站点安全策略或其他必须人工
  完成的步骤：**浏览器停在当前页不关闭** → `taskSpaces.handOff(id)` 交给
  用户 → 明确告诉用户操作 → 等用户说"好了" → `taskSpaces.takeOver(id)`
  继续原任务。**严禁为了"结束任务"而 `--stop` 关闭浏览器**，也不要对
  验证码做无意义重试。

## 4. 验证登录：用站点接口，别用 CDP 查 cookie

- 用 `page.evaluate('document.cookie')` + **站点自身鉴权接口**验证登录。
  例（bilibili）：`https://api.bilibili.com/x/web-interface/nav` 返回
  `data.isLogin === true`。
- **不要用** `cdp('Network.getAllCookies')` / `cdp('Storage.getCookies')`：
  经 heredoc 的 `cdp()` 走页面级会话，**恒返回 0（假阴性）**。

## 5. 关闭浏览器永远用 `--stop`

`--stop` 会优雅关闭并让 cookie 落盘；强杀（kill/任务管理器）会丢运行期登录态。

- 如果重试过程中创建了额外 tab，问题最终解决或放弃后，都要把这些重试
  产生的 tab 关闭掉，避免进程/标签页竞争。

## 6. 一个目标 = 一个浏览器，全程复用，首启直达

- 每个用户目标对应**一个 task space / 一个长驻浏览器**，整个任务（含
  handoff 往返）复用同一浏览器/窗口；**不要为了继续任务而 `--stop` 重启**。
- 任务启动一律 `ego-browser --url <目标页>`（或 `ego-browser <目标页>`）
  首启直达，第一个窗口就是目标页，**不要出现 about:blank 空白窗口**。
- **不预热**：**不要**单独 `--open` 预热再跑任务（那是历史上多开的主要来源）。
  `--open` 仅用于登录/人工检查，用后 `--stop` 关闭。运行时已改为单实例：
  探测到活进程就复用，绝不新开第二个。
- 脚本执行一律用"写 `.js` 文件 → stdin 喂入"：cmd 无 heredoc，用 `ego-browser nodejs < file` 喂入，减少往返与转义问题。
- **单 tab 优先（语义驱动）**：任务默认在同一个 tab 用 `page.goto` 顺序导航（目标是"到达某个最终页面"时，中间步骤都是路径，不新开 tab）；只有用户语义明确需要多页（对比/并行/保留参考页）才开新 tab，用完 `closeTab`。导航后先轮询 `page.url()` 确认指向目标再读。
- **临时脚本放 TEMP、收尾清理**：临时操作脚本写 `%TEMP%\ego-browser-<task>\`（不进仓库），任务收尾删除；产物（截图）保留到仓库可见目录。

## 7. 完成前先验证，用证据说话

- 改动/任务完成前先跑验证（如 `node scripts/verify.mjs`）并贴出真实输出。
- 不猜测、不拍脑袋：先收集证据定位根因，再动手。

## 8. 常用工具命令速记

```cmd
:: 端到端冒烟（无头）
node scripts\verify.mjs
:: 单实例回归（多开检查）
node scripts\verify-single-instance.mjs
:: 开可见窗口（登录用）
ego-browser --open
:: 优雅关闭 + 落盘
ego-browser --stop
:: 状态
ego-browser --status
:: 无头跑脚本文件
ego-browser --headless nodejs < task.js
```

## 9. 个人接管模式（默认）· 补充约定（2026-09-06）

- **默认驱动你自己的 workspace Chrome**（按 `personal-browser.json` 档案）：接管在跑实例（复用其
  已加载登录态/会话与已开 tab，直接操作），无实例则按档案冷启动同一 profile。不弹空白窗、不重复多开。
- **首用建档**：`--status` 显示 `personal.prefsExists:false` → 先征询用户惯常启动命令，确认后
  `ego-browser --prefs "{...}"` 建档；之后每次启动前读取。禁止猜默认命令、禁止无档案擅自启动。
- **外部实例绝不杀**：`--stop` 只关 ego 自启实例；外部用户浏览器只"断开"。不 import、不改其 profile 数据。
- 需要 ego 隔离 profile 旧行为：`--isolated` 或 `EGO_LINUX_PERSONAL=0`。
