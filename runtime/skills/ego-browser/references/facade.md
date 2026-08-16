# ego-browser facade — full helper reference

Every heredoc gets these helpers preloaded. This is the complete reference for
the vendored runtime (`runtime/ego-browser/dist/out/index.js`). When in doubt,
`help()` inside a heredoc prints the same information.

## `page` — Playwright-style page facade

| Call | Description |
|---|---|
| `page.goto(url, { timeout, waitUntil, settle })` | Navigate the current tab |
| `page.reload({ ignoreCache, waitUntil, timeout })` | Reload and wait for load |
| `page.info()` | `{ url, title, w, h, sx, sy, pw, ph }` (or `{ dialog }` if a native dialog is open) |
| `page.url()` | Current URL |
| `page.title()` | Current title |
| `page.setDefaultTimeout(ms)` | Default timeout for locator/waits |
| `page.locator(selector)` | Strict auto-waiting locator (see Locator below) |
| `page.getByRole(role, { name })` / `getByText` / `getByLabel` / `getByPlaceholder` / `getByAltText` / `getByTitle` / `getByTestId` | Locator factories |
| `page.waitForTimeout(ms)` | Fixed wait |
| `page.waitForLoadState(state, { timeout })` | `load`, `domcontentloaded`, `networkidle`, `commit` |
| `page.waitForSelector(selector, { state, timeout })` | `visible` / `hidden` / `attached` / `detached` |
| `page.waitForFunction(fn, { timeout, polling })` | Poll browser JS until truthy |
| `page.waitForURL(urlOrPredicate, { timeout, waitUntil })` | Wait for URL match (string / glob / regex / predicate) |
| `page.waitForRequest(urlOrPredicate, { timeout })` | Wait for a request |
| `page.waitForResponse(urlOrPredicate, { timeout })` | Wait for a response (can read body) |
| `page.waitForEvent('download')` | Wait for a download event |
| `page.evaluate(expression)` | Run JS in the page (string expression; top-level `return` auto-wrapped) |
| `page.screenshot({ path, ... })` | Capture the page |
| `page.snapshot()` | Semantic tree with `loc=...` / `@N` refs (the "eyes" for the agent) |
| `page.snapshotRaw()` | Raw snapshot payload |
| `page.elementCenter(selector)` | Center coordinates of an element |
| `page.drainEvents()` | Consume the buffered async event queue (navigation, network, …) |
| `page.screencast.start({ path, size, quality })` / `page.screencast.stop()` | Record the viewport to WebM (needs `.webm` path) |
| `page.keyboard.press(key)` / `down` / `up` / `insertText(text)` / `type(text)` | Keyboard |
| `page.mouse.click(x, y, opts)` / `dblclick` / `move(x,y)` / `down` / `up` / `wheel` / `drag` | Mouse (CSS-pixel viewport coords) |

### Locator (returned by `page.locator` / `getBy*`)

Strict and auto-waiting. Methods: `locator()`, `getByRole()`, `getByText()`,
`filter()`, `first()`, `nth(i)`, `last()`, `click()`, `hover()`,
`dragTo(target)`, `scrollIntoViewIfNeeded()`, `fill(value)`, `clear()`,
`press(key)`, `check()`, `selectOption(value)`, `textContent()`, `innerText()`,
`innerHTML()`, `isVisible()`, `isEnabled()`, `getAttribute(name)`,
`screenshot()`, `count()`, `evaluate(fn, arg)`, `evaluateAll(fn, arg)`,
`waitFor(options)`.

Selector forms: raw CSS, `xpath=...`, `text=...`, `loc=css:...`,
`loc=role:...`, `loc=href:...`, and `@N` snapshot refs (`ref=N`). `@N` refs are
only for the facade — not valid inside `document.querySelector`.

```js
await page.locator('button.primary').click()
await page.locator('@21').click()
await page.getByLabel('Email').fill('me@example.com')
await page.locator('#login').click()  // strict: throws on multiple matches
```

## `browser` — tab facade

| Call | Description |
|---|---|
| `browser.listTabs()` | All tabs in the current space |
| `browser.currentTab()` | Active tab |
| `browser.switchTab(target)` | Activate a tab (targetId is short-lived — refresh the list first) |
| `browser.openOrReuseTab(url, { wait, timeout })` | Open a URL in an existing or new tab |
| `browser.closeTab(target)` | Close a tab (or current when omitted) |
| `browser.ensureRealTab()` | Switch to an existing non-about: page tab (or `null`) |
| `browser.iframeTarget(selector)` | Resolve an iframe target for nested navigation |

## `taskSpaces` — isolated browsing contexts

| Call | Description |
|---|---|
| `taskSpaces.useOrCreate(nameOrId)` | Reuse an agent-owned space or create one; prefer numeric `id` across rounds |
| `taskSpaces.list()` | List spaces with ownership |
| `taskSpaces.switch(nameOrId)` | Select a space (agent-owned only) |
| `taskSpaces.claim(nameOrId)` | Take ownership of a user-owned/inactive space |
| `taskSpaces.complete(nameOrId, { keep })` | Finish a space (`keep` required; default `false`) |
| `taskSpaces.handOff(nameOrId)` | Give control to the user (login / captcha / manual step) |
| `taskSpaces.takeOver(nameOrId)` | Take control back (only after explicit user confirmation) |
| `taskSpaces.waitForAgentControl(nameOrId, opts)` | Read-only blocking poll for a handoff you initiated |

Ownership policy and handoff rules: [task-spaces.md](task-spaces.md).

## `site` — learned per-site skills

| Call | Description |
|---|---|
| `site.skills(url)` | Site skills matching a URL |
| `site.skillsForUrl(url)` | Same, by URL |
| `site.runTool(siteId, toolName, args)` | Run a learned node-side tool |
| `site.runBrowserTool(siteId, toolName, args)` | Run a learned browser-side tool |
| `site.learnContext(url)` | Context for a URL |

Site packs live in `skills/ego-browser/learnings/<site>/` (e.g. `google`,
`x-com`).

## `fetch`

| Call | Description |
|---|---|
| `fetch.server(url, options)` | Request from the Node side |
| `fetch.browser(url, options)` | Request from the current page context |

## `cdp` — raw DevTools Protocol

```js
await cdp('Page.captureScreenshot', { format: 'png' })
await cdp('Page.handleJavaScriptDialog', { accept: true })
```

## `help`

```js
console.log(help())            // all helper docs
console.log(help('page'))      // page facade
console.log(help('locator'))   // locator methods
console.log(help('click'))     // a specific helper
```

## Output

Use `console.log(...)` for everything you want back. The runtime buffers it and
flushes to stdout when the script settles (it is dropped if the script throws).
`console.error`/`console.warn` go to stderr and are NOT part of results.
