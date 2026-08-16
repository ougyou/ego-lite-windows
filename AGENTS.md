# Repository Guidelines

## What this is

A standalone, Windows-capable packaging of the ego-lite browser automation
runtime + a GitHub Copilot skill. It reuses the community **Linux port of
ego-lite** (drives a stock Chromium/Edge over CDP) so it runs on Windows
without the macOS app, DSH, or a build step.

## Layout

- `runtime/` — vendored runtime, **read-only reference**. `runtime/ego-linux/`
  is the CDP shim + launcher; `runtime/ego-browser/dist/out/index.js` is the
  compiled harness. Any local change goes in `runtime/PATCHES.md`.
- `skills/ego-browser/` — the **canonical skill package** (SKILL.md + references
  + learnings). This is what Copilot reads and what the runtime uses for site
  learnings (via `EGO_BROWSER_AGENT_WORKSPACE`).
- `scripts/ego-browser-launch.mjs` — the only recommended entry point. It
  resolves Edge/Chrome/Brave, normalizes Windows paths to forward slashes
  (runtime requirement), sets env, and forwards stdin/args.
- `bin/ego-browser.cmd` — PATH convenience wrapper over the launcher.

## Key facts / gotchas

- The runtime exposes the **facade**: `page`, `browser`, `taskSpaces`, `site`,
  `fetch`, `cdp`, `help` — NOT the upstream top-level helper names
  (`useOrCreateTaskSpace` etc.). Keep `SKILL.md`/`facade.md` in sync with the
  vendored dist (`runtime/ego-browser/dist/out/index.js`), not with upstream.
- `EGO_LINUX_CHROME` must be a forward-slash absolute path.
- Output from heredocs must go through `console.log` (routed to stdout).
- If `runtime/skills/ego-browser/` is kept as a runtime-default skill workspace,
  keep it in sync with `skills/ego-browser/` (the launcher points at the
  canonical one anyway).

## 协作约定（用户习惯）

- **显式操作**：启动窗口/浏览器、杀进程、改数据、跑长命令、安装、网络请求等动作，先说明并征得用户同意；绝不擅动用户本机真实浏览器和个人数据。
- **中文交流**。
- 登录态：`--open` 登录一次 → `--stop` 落盘；别依赖 `--import-chrome-profile`。
- 验证登录：用站点鉴权接口（如 bilibili `/x/web-interface/nav`），别用 CDP `getAllCookies`。
- 完整清单见 `skills/ego-browser/references/operating-preferences.md`。

## Verification

- `node scripts/verify.mjs` — end-to-end smoke test (headless, real page).
- After touching the skill, re-run the smoke test and confirm the copied
  `~/.copilot/skills/ego-browser/` (if installed) is up to date.
