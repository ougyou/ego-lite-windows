# Install ego-browser (Windows)

Read this only when setting up for the first time, or when the browser can't be
reached. For day-to-day browser work, go back to `SKILL.md`.

This repo is self-contained: the runtime (Node + CDP) is vendored in
`runtime/`, the skill in `skills/`. There is no macOS app and no download.

## Prerequisites

- **Node >= 22** (check: `node --version`)
- **Chrome, Edge, or Brave** installed (the launcher auto-detects; or set
  `EGO_LINUX_CHROME`)

## PATH recommendation

The `ego-browser` command **must** be on `PATH` — the skill hard-requires it.
Add this folder to your user `PATH`:

`c:\Users\quincy\workspace\mywork\fontwebProjects\ego-lite-windows\bin`

Do **not** add `scripts\` for command-line use; `bin\ego-browser.cmd` is the
stable wrapper. `scripts\install-copilot-skill.cmd` (and
`skills\ego-browser\scripts\install.cmd`) add `bin\` to your user PATH
automatically (idempotent) — you only need to do it by hand if you skip those.

## Install steps

```cmd
:: 1. (optional) put the `ego-browser` command on PATH
::    - add the repo's bin\ folder to PATH, or
::    - run:  scripts\install-copilot-skill.cmd   (also installs the Copilot skill)

:: 2. Verify the runtime end-to-end (headless smoke test):
node scripts\verify.mjs
::    PASS: runtime drives a real page on this machine

:: 3. Confirm the command works (after adding bin\ to PATH):
ego-browser --status
```

## Connect to GitHub Copilot (VS Code)

The skill lives at `skills/ego-browser/`. To make it available to Copilot in
any workspace:

```cmd
scripts\install-copilot-skill.cmd
```

This copies the skill to `~\.copilot\skills\ego-browser\` (VS Code Copilot
loads skills from there). **Restart VS Code / reload the window** afterwards.
You can also drop the repo's own `.copilot/skills/ego-browser/` copy in if you
only ever use it inside this repo.

When the skill is active, just ask Copilot to browse — it will read `SKILL.md`
and run heredocs through the `ego-browser` command.

## Verify the skill picked it up

After the reload, type `/` in Copilot Chat — `ego-browser` should appear as a
slash command, and Copilot should auto-load it for phrases like
"open a website" / "scrape this page".

## First real browser run

```cmd
:: first window is already the page:
ego-browser --url https://example.com nodejs
:: or feed a saved script file:
ego-browser nodejs < task.js
```

```js
// task.js
const task = await taskSpaces.useOrCreate('my goal')
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 30 })
console.log(await page.snapshot())
await taskSpaces.complete(task.id, { keep: false })
```

## Next steps

- `--import-chrome-profile` to inherit your real logins.
- `--open` to see the agent browser window.
- See [references/windows.md](references/windows.md) for troubleshooting.
