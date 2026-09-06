---
name: ego-browser
description: 'Drive a real Chromium/Edge browser for web automation through the ego-lite runtime (Windows-capable Linux port). Use for opening pages, navigating, filling forms, clicking buttons, taking snapshots and screenshots, extracting page data, scraping, logging into sites, testing web apps, or any browser automation task. Triggers: "open a website", "visit a URL", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "extract content", "test this web app", "login to a site", "automate browser actions". Run `ego-browser nodejs` with a JS heredoc; all helpers are preloaded. Prefer this over built-in web fetch for interactive or authenticated pages.'
metadata:
  version: "1.0.0-windows"
  date: "2026-08-16"
---

# ego-browser (Windows)

This skill drives a **real browser** (your Edge/Chrome) through the vendored
`ego-lite` runtime (the Linux port over CDP — the same browser automators like
Claude Code / Codex use with ego lite, now Windows-capable). The agent writes a
short JS snippet, `ego-browser` runs it against a live page in one pass, and
the result comes back on stdout. Tabs live in isolated **task spaces** that
reuse your login state without touching your normal browser windows.

## Invocation

Run browser operations with the **`ego-browser` command on PATH** — the stable
`bin\ego-browser.cmd` wrapper that auto-finds Edge/Chrome, normalizes the
Windows path, and forwards stdin to the runtime.

> **HARD RULE — always use `ego-browser` from PATH.** Do **not** search the repo
> for, or construct a path to, the launcher script (`scripts\ego-browser-launch.mjs`).
> If the command is not found (`'ego-browser' is not recognized`), stop and tell
> the user to put the repo's `bin\` folder on PATH (or run
> `scripts\install-copilot-skill.cmd`, which adds it automatically) — do not fall
> back to hunting for scripts.

cmd has no inline heredoc. Write the JS to a UTF-8 `.js` file (e.g. under
`%TEMP%`) and feed it on stdin:

```cmd
ego-browser nodejs < task.js
```

> Once `bin\` is on PATH, `ego-browser` works from any directory — no need to
> cd into the repo root.

Other commands (same as the runtime): `--status`, `--open`, `--stop`,
`--headless`, `--import-chrome-profile`, `--doctor`, `--url <url>`, and the
personal-mode `--prefs <json>` / `--prefs-clear` / `--isolated`.
Full Windows notes in [references/windows.md](references/windows.md).

**First-run direct to a page**: `ego-browser --url <url>` (or just
`ego-browser <url>`) makes the browser cold-start on that page instead of a
blank `about:blank` window, so the first window is already the page — no empty
browser first, no second browser to reach it. Combined with a script file it
reuses that very tab:

```js
// task.js
const task = await taskSpaces.useOrCreate('my goal')
console.log((await browser.listTabs()).map(t => t.url))
await taskSpaces.complete(task.id, { keep: false })
```

```cmd
ego-browser --url https://example.com nodejs < task.js
```

## Personal takeover mode (default · 个人接管模式)

默认情况下 ego-browser 驱动**你自己的 workspace Chrome**（按启动档案
`personal-browser.json`，即用户认可的 profile 目录），而不是 ego 隔离 profile。硬规则：

1. **开场不预热**：任何浏览器任务的第一步就是"静默探测 + 接管/直达启动"
   （`ego-browser [<url>] nodejs < task.js` 内部自动完成，探测只 probe 不弹窗）；
   **禁止**单独 `--open` 或空脚本预热；健康检查只用无副作用的 `ego-browser --status`。
2. **接管后先列 tab**：脚本**第一行**先 `console.log(await browser.listTabs())` ——
   该调用**直接返回数组**（每项 `{ targetId, title, url, active }`）。据此复用现有 tab、
   决定是否开新页，**避免重复/多开**用户所需页面。
3. **首用建档（硬规则）**：`ego-browser --status` 显示 `personal.prefsExists: false` 时
   → **停下，用中文向用户征询**惯常启动命令（二进制 / 端口 / workspace profile 目录 /
   附加 flag）→ 用户确认 → `ego-browser --prefs "<json>"` 建档 → 继续。**禁止**猜默认
   命令、**禁止**无档案擅自启动（CLI 会 exit 2 提示建档）。
4. **授权边界**：只操作档案里的 workspace profile（接管其**已加载登录态/会话**与已开 tab，
   直接操作）；`--stop` 只对 ego 自启实例生效，**外部已存在的用户实例绝不 kill**（只断开）；
   不 `--import-chrome-profile`、不改其 profile 数据。
5. **无浏览器在跑时**：按档案冷启动同一个 workspace profile（首窗直达目标页，不弹空白窗）。
6. **tab 卫生**：不关用户原有 tab；只清理本任务新开/重试产生的 tab
   （`browser.closeTab(targetId)`）。
7. **人工步骤**：验证码/登录等把当前 tab 留给你（不关闭、不 `--stop`），完成后接回同一 tab 继续。

接管时不建隔离 task space（而是非隔离"个人空间"，登录/会话与你的浏览器共享）。需要 ego 隔离
profile 的旧行为时用 `ego-browser --isolated ...`（或 `EGO_LINUX_PERSONAL=0`）。

## Quick start

```js
// 1. Name a task space for the whole goal, reuse it across heredoc rounds.
const task = await taskSpaces.useOrCreate('search github issues')
console.log('space id: ' + task.id)

// 2. Open or reuse a tab in that space.
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 30 })

// 3. See the page, then act.
console.log(await page.snapshot())

// 4. Finish in a DEDICATED final heredoc:
//    await taskSpaces.complete(task.id, { keep: false })
```

## Preloaded helpers (the facade)

All of these are injected into every heredoc (no imports needed):

| Helper | Purpose |
|---|---|
| `page` | Playwright-style page: `goto`, `url`, `title`, `info`, `snapshot`, `screenshot`, `evaluate`, `locator`, `getBy*`, `waitFor*`, `keyboard`, `mouse`, `screencast` |
| `browser` | Tabs: `listTabs`, `currentTab`, `switchTab`, `openOrReuseTab`, `closeTab`, `ensureRealTab` |
| `taskSpaces` | Isolated browsing contexts: `useOrCreate`, `list`, `switch`, `claim`, `complete`, `handOff`, `takeOver`, `waitForAgentControl` |
| `site` | Learned per-site skills: `skills`, `runTool`, `runBrowserTool`, `learnContext` |
| `fetch` | `server(url, opts)` (Node side), `browser(url, opts)` (page context) |
| `cdp` | Raw CDP call: `await cdp('Page.captureScreenshot', {...})` |
| `help` | `help()` / `help('page')` / `help('locator')` — usage for any helper |

Full reference: [references/facade.md](references/facade.md).
Task-space ownership & handoff policy: [references/task-spaces.md](references/task-spaces.md).

## Core patterns

1. **See first** — `console.log(await page.snapshot())` returns a semantic tree
   with `loc=...` values you can pass back into locators.
2. **Act** — `await page.locator('button[type=submit]').click()`,
   `await page.getByLabel('Email').fill('me@example.com')`,
   `await page.mouse.click(x, y)`.
3. **Wait** — `page.waitForLoadState('networkidle')`, `page.waitForSelector(...)`,
   `page.waitForURL(...)`, `page.waitForResponse(...)`.
4. **Verify** — `page.info()`, `page.snapshot()`, `page.screenshot({ path })`.
5. **Output** — **use `console.log(...)`**; it is routed to stdout by the
   runtime. Final results must go through `console.log`. Do not rely on
   `process.stdout.write` or print huge dumps.

## Startup and reuse

- Start **one** browser process per task space and **reuse it**. Do not open a
  blank browser first and then start a second browser for the real task.
- Do **not** start a standalone visible browser as a separate preparation step
  unless the user explicitly asked for manual login or inspection. The same
  invocation that runs the task should be the one that reuses or creates the
  browser.
- **Tab 策略（语义驱动 · 默认单 tab）**：判断依据是用户语义 / 任务目标。任务
  本质是"到达某个最终页面"（如"去百度搜 bilibili，去 bilibili 打开慢学AI 的
  视频"——就是看那个视频）时，中间步骤都是路径，**默认在同一个 tab 里用
  `page.goto(url)` 顺序导航，不新开 tab**；只有用户语义明确需要多页（对比、
  并行、保留参考页）才 `browser.openOrReuseTab(...)` 开新 tab，用完
  `browser.closeTab(tab)` 关闭。
- **导航后先确认再读**：每次 `page.goto` / `openOrReuseTab`+`switchTab` 之后，
  先 `page.waitForURL(...)` 或轮询 `page.url()` 直到指向目标，再读取 / 操作；
  不要等页面就绪就去读（"读未加载的新 tab"是出错重做的头号来源）。
- If a tab already exists for the current task space, keep using it unless the
  user explicitly asks for a new page.
- The browser is a long-lived shared process: every `ego-browser nodejs` run
  reuses the same browser, not a new one. Only a browser that was stopped or
  restarted launches fresh. Never warm up with a standalone `ego-browser` /
  `--open` before the real task — that is exactly what produces the blank
  window plus a second browser.
- **Start every task direct-to-page**: open the task's first page with
  `ego-browser --url <url>` (or `ego-browser <url>`) so the very first window
  is the target page — never a blank `about:blank` that is then navigated.
  One user goal = one task space = one long-lived browser; reuse it for the
  whole task (including handoff round-trips). Never `--stop`/restart the
  browser just to continue a task.

## Stable script execution (cmd)

cmd has no inline heredoc, so always write the script to a UTF-8 `.js` file
once and feed it on stdin:

```cmd
ego-browser nodejs < task.js
```

This is the recommended way to run multi-step flows: one file, run repeatedly,
no quoting surprises. A simple task should take ≤ 3 script runs: (1) open + do
the work, (2) after a handoff, take over + continue, (3) finish/clean up.

## Human-in-the-loop handoff（人工介入 SOP）

When a page needs a human — login, CAPTCHA, SSO, slider verification, bot
checks — follow this fixed flow. **Never** close the browser, `--stop`, or end
the goal just because a human step appeared:

1. **Detect**: the page got redirected to a captcha/login page (URL contains
   `captcha`, `wappass`, `login`, `sso`, `passport`, `verify`, ...) or shows a
   login form / slider.
2. **Stay on the page**: do not navigate away; leave the browser window on
   that exact page.
3. **Hand off**: `await taskSpaces.handOff(task.id)` hands control to the user.
4. **Tell the user** in one sentence what to do in the window, and that they
   should reply "好了/继续" when finished.
5. **Wait** — do not retry and do not attempt to auto-solve CAPTCHAs.
6. **Resume**: after the user confirms, run a new heredoc starting with
   `await taskSpaces.takeOver(task.id)` and continue in the SAME task space /
   browser. If the user says stop, close normally with
   `await taskSpaces.complete(task.id, { keep })`.

```js
// handoff heredoc — once a human step is detected:
const task = await taskSpaces.useOrCreate('my goal') // reuse the SAME name/id
await taskSpaces.handOff(task.id)
console.log('DONE: 请完成窗口里的验证码/登录，完成后回复"好了"')

// resume heredoc — after the user confirms:
const task = await taskSpaces.useOrCreate('my goal')
await taskSpaces.takeOver(task.id)
console.log(await page.snapshot()) // continue from where the user left off
```

## Task spaces

- Start every heredoc with `taskSpaces.useOrCreate(nameOrId)` (reuse the same
  name or numeric id across rounds; prefer `task.id`).
- `taskSpaces.complete(id, { keep })` must be its own final heredoc, run only
  after a prior round confirmed the task is done. Default `keep: false`
  (close the space); `{ keep: true }` only when the user needs the live page.
- If a site blocks automation with login, CAPTCHA, SSO, bot checks, or other
  human-only steps, **stop retrying and follow the handoff SOP above** — keep
  the browser open on the page, `handOff`, wait for the user, then `takeOver`.
  Never close the browser or `--stop` to "end" the task because of a captcha.
- If retries or fallback attempts created extra tabs, close those tabs once
  the issue is resolved or declared unresolved.
- If the user takes control, stop and ask — never auto-retry or auto-takeover.
- **Logins persist across sessions.** A login done inside a space (including a
  manual login the user performs) is flushed back to the shared profile when
  the space closes or the browser stops, so the next session's space inherits
  it automatically. `--stop` flushes everything, so still end sessions with a
  clean `--stop`.

## 任务收尾清单（tab 卫生 · 清理 · 经验沉淀）

任务完成、验证通过后，按此收尾（避免遗留脚本 / 多余 tab / 重复踩坑）：

1. **验证结果**：`page.info()` / `page.snapshot()` / 站点接口确认已达到目标。
2. **关多余 tab**：`browser.closeTab(...)` 掉任务中为对比 / 重试开的临时 tab，
   只保留最终结果页。
3. **收尾 space**：用独立的最终 heredoc 跑 `taskSpaces.complete(task.id,
   { keep: true })`（用户需要保留页面时；默认 `keep: false`）。
4. **清理临时脚本**：任务临时脚本默认写 `%TEMP%\ego-browser-<task>\`
   （不进仓库），收尾删除该目录；产物（截图 / 下载）保留到仓库可见位置
   （如 `<repo>/<task>_task/` 或用户指定）。
5. **沉淀经验（可选）**：本次验证过的新站点知识（选择器、坑、正确流程）写入
   `learnings/<site>/`（manifest + notes，必要时 tools），供下次复用。

## Notes & gotchas

- `page.evaluate` takes a **string expression** (top-level `return` is wrapped
  in an IIFE automatically). `await page.evaluate("document.title")`.
- If `page.info()` returns `{ dialog: ... }`, a native dialog is open — handle
  it with `await cdp('Page.handleJavaScriptDialog', { accept: true })` before
  running page JS (page JS is blocked while a dialog is up).
- `page.snapshot()` refs (`@N`) are short-lived — re-snapshot after navigation.
- The browser persists between heredocs; each heredoc is a short-lived Node
  process. `--stop` stops the shared browser; `--import-chrome-profile` copies
  your real Chrome profile in to inherit logins.
- Prefer the **visible** browser by default (it's real — you can watch it).
  Use `--headless` / `EGO_LINUX_HEADLESS=1` for CI or no-desktop.

## Operating principles（操作约定 · 用户的习惯）

Copilot must honor these when driving this browser:

1. **显式操作（最重要）**：任何涉及启动浏览器/窗口（`--open`）、杀进程（`--stop`/清理）、修改数据、跑长命令、安装、网络请求的动作，执行前先向用户说明并征得同意；**绝不擅动用户本机真实 Chrome/Edge 或任何个人数据**。
2. **中文交流**：与用户用中文沟通。
3. **登录态用"登录一次"法**：需要登录的站点，用可见浏览器（`--open`）登录一次，再 `--stop` 优雅关闭落盘；之后任务空间自动继承。**不要依赖 `--import-chrome-profile`**（Windows 上 cookie 加密导致传不过）。
4. **验证登录用站点接口**：用 `page.evaluate('document.cookie')` + 站点自身鉴权接口（如 bilibili `/x/web-interface/nav`）确认登录；**不要用 CDP `getAllCookies`/`Storage.getCookies`**（页面级会话，恒返回 0 的假阴性）。
5. **关闭永远用 `--stop`**：保证 cookie 落盘；强杀会丢运行期登录态。
6. **遇人工步骤不关闭、不重试**：验证码/登录等必须人工的步骤，浏览器停在页面并 `handOff`，等用户完成后 `takeOver` 继续；绝不 `--stop` 关浏览器来"结束任务"。
7. **完成前先验证再下结论**：先跑 `node scripts/verify.mjs` 等验证，用证据说话。
8. **不预热**：任务一律 `ego-browser --url <目标页>` 冷启动直达（第一个窗口即目标页）；**禁止单独 `--open` 预热再跑任务**。`--open` 仅用于登录/人工检查，用后 `--stop` 关闭落盘。
9. **单 tab 优先 + 收尾卫生**：任务默认在一个 tab 顺序导航（语义驱动，见"Startup and reuse"），不无谓开新 tab；收尾按"任务收尾清单"关闭多余 tab、删除临时脚本、沉淀经验。

详见 [references/operating-preferences.md](references/operating-preferences.md)。
