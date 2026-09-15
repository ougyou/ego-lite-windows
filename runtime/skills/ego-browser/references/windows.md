# Windows setup & troubleshooting

This repo bundles the **ego-lite Linux port** (community port over CDP) so it
runs on Windows. It drives your installed Edge or Chrome — there is no macOS
app and nothing to buy. Requirements: **Node >= 22** and any
**Chrome / Edge / Brave**.

## Two harnesses: v2 (default) and v1 (legacy)

The browser engine (`runtime/ego-browser/dist/out/*.js`) exists in two builds:

| Engine | File | Status |
|---|---|---|
| **v2** (default) | `dist/out/index.v2.js` | Upstream citrolabs/ego-lite **v2.0.0** built with the Windows path patch. The API documented in [api.md](api.md) and in this Skill (`taskSpace()`, `task.page()`). Verified in isolated **and** personal takeover mode. |
| **v1** (legacy, opt-in) | `dist/out/index.js` | The old facade dialect (`taskSpaces`, `browser`, `page` globals — [facade.md](facade.md)). For old scripts only. |

Select the legacy engine per run:

```cmd
set EGO_BROWSER_HARNESS=v1
ego-browser nodejs < old-task.js
```

`node scripts/verify-v1-engine.mjs` covers the legacy bundle; `verify.mjs`,
`verify-single-instance.mjs` and `verify-personal.mjs` all run the default v2
engine. `--sdk-path <file>` still selects a bundle explicitly and wins over both.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `EGO_LINUX_CHROME` | Absolute path to a browser binary (forward slashes!) | auto-detected by the launcher |
| `EGO_LINUX_HEADLESS` | `1` / `true` = headless (no agent window) | off (visible window) |
| `EGO_BROWSER_AGENT_WORKSPACE` | Where site learnings / `agent_helpers.js` live | `skills/ego-browser` (set by the launcher) |
| `EGO_LINUX_PROXY` | HTTP proxy for the browser | unset |

## The Windows gotcha (why the launcher exists)

The vendored runtime decides whether a browser candidate is an absolute path by
testing `candidate.includes("/")`. A Windows path like
`C:\Program Files\...\msedge.exe` contains **no forward slash**, so the runtime
misreads it as a bare command name, runs `which` on it, and reports
"no Chrome/Chromium binary found".

The `ego-browser` command (`bin\ego-browser.cmd` → `scripts/ego-browser-launch.mjs`)
fixes this: it probes the standard install locations and hands the runtime a
**forward-slash** path (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`).

**Always invoke `ego-browser` from PATH** (once `bin\` is on PATH). Do **not**
search the repo for the launcher script:

```cmd
ego-browser nodejs
ego-browser --status
ego-browser --open
ego-browser --stop
ego-browser --url https://example.com
ego-browser https://example.com
ego-browser --prefs "{...}"   :: 首次建档（先征询用户）
ego-browser --prefs-clear      :: 清除档案
ego-browser --isolated ...    :: 切回 ego 隔离 profile 旧行为
```

**个人接管模式（默认）**：`ego-browser` 默认接管/启动你自己的 workspace Chrome（按 `--prefs`
建档的 profile，见 SKILL.md「Personal takeover mode」）；没有档案时 `--status` 会报告
`personal.prefsExists: false`，先征询用户再 `--prefs` 建档。接管不弹空白窗、不重复开已有页面；
`--stop` 只关 ego 自启的实例，外部用户实例只断开不杀。

**不预热（重要）**：do **not** first launch `--open` (or a standalone
`ego-browser`) just to create an empty window and then run a second command for
the real task — that pattern used to produce a second competing browser/tab.
Use one cold-start invocation for the task (`ego-browser --url <url> nodejs`),
and reserve `--open` for login / manual inspection, closing it with `--stop`
afterwards. The runtime is single-instance: it detects a live process owning the
profile and reuses it instead of launching a second browser.

If you invoke `runtime/ego-linux/bin/ego-browser.mjs` directly, set
`EGO_LINUX_CHROME` yourself with forward slashes.

## Stable script execution (cmd)

cmd has no inline heredoc, so write the script to a UTF-8 `.js` file and feed it
on stdin:

```cmd
ego-browser nodejs < task.js
```

Use this for multi-step flows — one file, run repeatedly, no quoting surprises.
A simple task should take ≤ 3 script runs (open + work → take over after a
handoff → finish).

## Headless vs visible

- Default is a **visible** agent browser (like ego-lite's own window) — you can
  watch and even take it over.
- `ego-browser --headless nodejs` or `EGO_LINUX_HEADLESS=1` runs without a
  window (CI, servers, no desktop).
- `--open` shows a visible window for a headless-by-default setup.

## Inheriting your logins

```cmd
ego-browser --stop
ego-browser --import-chrome-profile
```

This copies your real Chrome profile (cookies, bookmarks) into the agent
profile. Task spaces then start already signed in. Cookies written inside a
space stay in that space; the browser only persists them to disk on a clean
`--stop`/close.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no Chrome/Chromium binary found` | Set `EGO_LINUX_CHROME` to a forward-slash absolute path, or install Edge/Chrome |
| `useOrCreateTaskSpace is not defined` (or similar) | You're using the new upstream helper names. This runtime exposes the **facade** (`taskSpaces`, `page`, `browser`, ...) — see [facade.md](facade.md) |
| `'ego-browser' is not recognized` | `bin\` isn't on PATH. Add it (or run `scripts\install-copilot-skill.cmd`, which adds it automatically), then open a new terminal. Do **not** fall back to hunting for scripts |
| A blank browser opens before the real task starts | Don't warm up. Use one cold-start `ego-browser --url <url> nodejs` so the very first window is already the page; the browser is single-instance and reuses across runs |
| Several independent browser processes pile up | The runtime now detects a live instance by process (not just a port probe) and never launches a second one. If you still see multiples, run `ego-browser --stop` once, then use `ego-browser --url <url>` cold-start. Close tabs created by retries once the task is done |
| Task hits a CAPTCHA / login wall | Do NOT `--stop` or close the browser. Keep the page open, `taskSpaces.handOff(id)`, tell the user what to do, and after they confirm `taskSpaces.takeOver(id)` to continue the same space |
| Logged in, but the next session is logged out | Logins now flush back to the shared profile on space close / `--stop`. Still end with a clean `--stop`; a hard kill (taskkill /F / crash) can lose the most recent writes |
| Heredoc hangs on a dialog | `page.info()` returns `{ dialog }`; run `await cdp('Page.handleJavaScriptDialog', { accept: true })` |
| Page actions hit a blank/stale tab | Add `await browser.ensureRealTab()` before acting (the runtime already does this in `openOrReuseTab`) |
| First run slow (~20s) | Cold Chromium start; the runtime retries transient CDP failures — it's normal |
| Browser doesn't show up | Run `--open`; or check it wasn't killed by a `--stop` race |
