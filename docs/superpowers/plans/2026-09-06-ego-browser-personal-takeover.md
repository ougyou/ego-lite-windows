# ego-browser 个人接管模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ego-browser 默认进入「个人接管模式」——探测到档案中的 workspace Chrome 在跑就 CDP 接管并就地操作其现有 tab（复用登录态、不重复开页）；没在跑就按用户档案的惯常参数启动；全程不弹空白窗、绝不碰日常 Chrome 默认 profile。

**Architecture:** 在 runtime 增加一条 personal 默认路径：`resolveBackingBrowser()` 读持久化启动档案（`personal-browser.json`）→ probe 档案端口 → 有则做身份核对后接管、无则按档案启动同一 profile → 由 CLI 注入。接管后用一个「非隔离伪空间」（`browserContextId=null`，复用 task-spaces 已有的无 context fallback）把默认 context 现有 tab 登记为可列/可复用/可切换的集合，脚本第一步即可 `browser.listTabs()`。isolated 旧行为保留为显式选项。技能四份副本同步改写为「接管 SOP」。

**Tech Stack:** Node.js ESM（runtime/ego-linux/src/*.mjs）、CDP（browser-level WebSocket）、Chrome/Edge（Windows）、`node --test`、PowerShell CIM 进程枚举、cmd 脚本。

## Global Constraints

- 仓库根：`c:\Users\quincy\workspace\mywork\fontwebProjects\ego-lite-windows`。
- 运行时模块一律 ESM `.mjs`，相对 import **带扩展名**（如 `import { x } from "./y.mjs"`），遵循既有风格（见 `chrome.mjs`/`paths.mjs`/`shim.mjs`）。
- **personal 为默认**；isolated 由 `--isolated` 或 `EGO_LINUX_PERSONAL=0` 进入，且必须保持 `node scripts/verify.mjs` 通过。
- 启动档案字段固定：`{ binary, userDataDir, debugPort, flags[], confirmedAt, source:"user-confirmed" }`；路径一律正斜杠。
- **不写死启动命令**：任何入口在"无档案且需要浏览器"时 exit 2 并提示建档，禁止用内置默认命令启动。
- **授权边界**：只操作档案 `userDataDir`（workspace profile）；外部已存在实例**绝不 kill/`--stop`**（只断开）、不 `--import-chrome-profile`、不改其 profile 数据。
- **不弹空白窗**：健康/状态检查只 probe、不 launch、不开窗口；冷启动首窗直达目标页（`EGO_LINUX_START_URL` 语义保留）。
- 运行时改动一律登记到 `runtime/PATCHES.md`（格式照旧表 + 原因）。
- 技能四份副本必须一致：`skills/ego-browser/`（权威）→ `runtime/skills/ego-browser/`、`.copilot/skills/ego-browser/`、`~/.copilot/skills/ego-browser/`。
- 交接目录：spike 报告放 `docs/superpowers/spikes/`；spec 在 `docs/superpowers/specs/2026-09-06-ego-browser-personal-takeover-design.md`。
- 终端为 PowerShell（run_in_terminal）；长命令用 `node ...`，多步用 `;` 连接，不用 `&&`。

---

### Task 1: Spike —— 验证"接管外部默认 context 现有 tab"可行性与伪空间契约

**Files:**
- Create: `docs/superpowers/spikes/2026-09-06-personal-takeover-findings.md`（spike 报告 + 决策记录）
- Create: `%TEMP%\ego-spike\spike-attach.js`、`%TEMP%\ego-spike\spike-ops.js`（临时，不进仓库）
- Reference: `runtime/ego-linux/src/tabs.mjs`、`runtime/ego-linux/src/task-spaces.mjs`、`runtime/ego-linux/src/shim.mjs`

**Interfaces:**
- Consumes: 现有 `EGO_LINUX_CDP_URL`（`ensureBrowser` 已支持：设了就直接接管该 ws）、`browser.listTabs()`/`switchTab`/`openOrReuseTab`、`page.goto/snapshot`。
- Produces: 一份**决策记录**，锁定 Task 5 的伪空间契约：a) 无 context 空间按 targetIds 归属是否足以驱动外部现有 tab；b) `createTab` 不带 `browserContextId` 是否落默认 context 且可被归入空间；c) 需要哪些 shim 补丁。输出物为文档，不改代码。

- [ ] **Step 1: 起一个临时"伪 workspace" Chrome（隔离，不碰真实 chrome_workspace）**

在 PowerShell：
```powershell
$tmp = Join-Path $env:TEMP "ego-spike-profile"
New-Item -ItemType Directory -Force $tmp | Out-Null
$port = 9333
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=$port","--user-data-dir=$tmp","--no-first-run","https://example.com","https://www.bing.com" 
```
Expected: 一个可见 Chrome 带 2 个 tab，监听 9333。

- [ ] **Step 2: 确认端点与 ws 可用**

```powershell
(Invoke-RestMethod "http://127.0.0.1:9333/json/version").webSocketDebuggerUrl
```
Expected: 输出 `ws://127.0.0.1:9333/devtools/browser/<id>`。

- [ ] **Step 3: 用 EGO_LINUX_CDP_URL 接管并跑第一个脚本（只读：listTabs + switchTab）**

`%TEMP%\ego-spike\spike-attach.js`：
```js
console.log('TABS_START', JSON.stringify((await browser.listTabs()).tabs.map(t => ({ url: t.url, active: t.active }))))
const tabs = (await browser.listTabs()).tabs
if (tabs.length >= 2) await browser.switchTab(tabs[1].targetId)
console.log('CURRENT', await page.url ? (await browser.listTabs()).tabs.find(t => t.active)?.url : '')
```
PowerShell：
```powershell
$env:EGO_LINUX_CDP_URL = (Invoke-RestMethod "http://127.0.0.1:9333/json/version").webSocketDebuggerUrl
node runtime\ego-linux\bin\ego-browser.mjs nodejs < "%TEMP%\ego-spike\spike-attach.js"
```
Expected（记录实测）：`listTabs` 能否列出**外部浏览器所有现有 tab**（而不是只看到 ego 自己开的那一个 / 或空）；`switchTab` 是否生效。若 listTabs 被"无选中 space"截成空或报错，把现象写进报告。

- [ ] **Step 4: 跑操作脚本（openOrReuse 复用 + goto + snapshot + 新开 tab）**

`%TEMP%\ego-spike\spike-ops.js`：
```js
const list = () => browser.listTabs()
console.log('BEFORE', JSON.stringify((await list()).tabs.map(t => t.url)))
// 语义复用：example.com 已开，openOrReuse 应复用而非新开
await browser.openOrReuseTab('https://example.com', { wait: true })
console.log('AFTER_OPEN_REUSE', JSON.stringify((await list()).tabs.map(t => t.url)))
await page.goto('https://example.org')
console.log('GOTO_OK', await page.url())
console.log('SNAP_OK', (await page.snapshot()).length > 0)
```
PowerShell：同上用 `spike-ops.js` 再跑一次。
Expected（记录实测）：复用命中（tab 数不增）、goto/snapshot 正常、是否有任何 API 因"无 context space"报错。

- [ ] **Step 5: 写 spike 报告并落决策**

写 `docs/superpowers/spikes/2026-09-06-personal-takeover-findings.md`，内容：
- 实测表：listTabs / switchTab / openOrReuseTab（复用 vs 新开）/ goto / snapshot / createTab 各自结果与报错；
- **决策**：
  - PASS：无需隔离即可驱动外部默认 context 现有 tab → Task 5 采用"无 context 伪空间 + targetIds 登记 + createTab 不带 browserContextId"。
  - PARTIAL：列出失败 API 与最小补丁点（引 `tabs.mjs`/`task-spaces.mjs` 具体函数）→ Task 5 按补丁清单做。
  - FAIL：无法接管 → 方案回退（在报告写"启用 playwright-cli 或仅最小接管"），并**停止后续 runtime 任务，先向用户报告**。
- 伪空间契约（供 Task 5 锁定）：空间对象 `{ id, name, targetIds:Set, browserContextId:null, defaultJar:true }`；selected 指向它；`listTabs` 无 context 时按 targetIds 过滤（`tabs.mjs` 已有该 fallback）。

- [ ] **Step 6: 清理临时进程与文件，并提交 spike 报告**

```powershell
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'C:\Program Files\Google\Chrome\Application\chrome.exe' -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'ego-spike-profile' } | ForEach-Object { Stop-Process -Id $_.Id -Force }
Remove-Item -Recurse -Force "$env:TEMP\ego-spike-profile","%TEMP%\ego-spike" -ErrorAction SilentlyContinue
```
```bash
git add docs/superpowers/spikes/2026-09-06-personal-takeover-findings.md
git commit -m "spike(ego-browser): personal takeover feasibility findings"
```

---

### Task 2: 启动档案模块 `personal-prefs.mjs`（纯逻辑，先 TDD）

**Files:**
- Create: `runtime/ego-linux/src/personal-prefs.mjs`
- Create: `runtime/ego-linux/test/personal-prefs.test.mjs`
- Modify: `runtime/ego-linux/src/paths.mjs`（新增 `PERSONAL_PREFS_FILE`、`PERSONAL_STATE_FILE`）

**Interfaces:**
- Consumes: `STATE_DIR`、`PERSONAL_PREFS_FILE`（`paths.mjs`）。
- Produces:
  - `normalizePrefs(raw) -> prefs|null`：校验并正斜杠化 `binary`/`userDataDir`；`debugPort` 取正整数（默认 9222）；`flags` 必须为 string[]（默认 `[]`）；缺 `binary`/`userDataDir` 返回 null。附带 `confirmedAt = new Date().toISOString()`、`source = "user-confirmed"`。
  - `loadPrefs() -> Promise<prefs|null>`
  - `savePrefs(prefs) -> Promise<void>`（mkdir STATE_DIR 递归后写 `PERSONAL_PREFS_FILE`，2 空格缩进）
  - `clearPrefs() -> Promise<void>`
  - `profileMatches(cmdline, userDataDir) -> boolean`：两者均先 `.toLowerCase().replace(/\\/g,"/")`；`cmdline` 需同时含 `--user-data-dir=` 且其值等于 `userDataDir`（按 `--user-data-dir=` 后到首个空白/引号截取，允许带引号）。不含该 flag 返回 false。

- [ ] **Step 1: 写失败测试**

`runtime/ego-linux/test/personal-prefs.test.mjs`：
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePrefs, profileMatches, savePrefs, loadPrefs, clearPrefs } from "../src/personal-prefs.mjs";
import { PERSONAL_PREFS_FILE } from "../src/paths.mjs";

test("normalizePrefs: 合法输入补全默认并正斜杠化", () => {
  const p = normalizePrefs({ binary: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", userDataDir: "C:\\Users\\q\\workspace\\chrome_workspace", debugPort: 9222, flags: ["--disable-web-security"] });
  assert.ok(p);
  assert.ok(p.binary.startsWith("C:/"));
  assert.ok(p.userDataDir.startsWith("C:/"));
  assert.equal(p.debugPort, 9222);
  assert.equal(p.source, "user-confirmed");
  assert.ok(p.confirmedAt);
});
test("normalizePrefs: 缺 binary/userDataDir 返回 null", () => {
  assert.equal(normalizePrefs({ userDataDir: "C:/x" }), null);
  assert.equal(normalizePrefs({ binary: "C:/x" }), null);
  assert.equal(normalizePrefs(null), null);
});
test("profileMatches: 命中/未命中/带引号", () => {
  const ud = "C:/Users/q/workspace/chrome_workspace";
  assert.ok(profileMatches(`chrome.exe --user-data-dir=${ud} --remote-debugging-port=9222`, ud));
  assert.ok(!profileMatches(`chrome.exe --user-data-dir=${ud} --remote-debugging-port=9222`, "C:/Users/q/other"));
  assert.ok(!profileMatches("chrome.exe --remote-debugging-port=9222", ud));
  assert.ok(profileMatches(`chrome.exe "--user-data-dir=${ud}" --type=renderer`, ud));
});
test("save/load/clear roundtrip", async () => {
  await clearPrefs();
  assert.equal(await loadPrefs(), null);
  const prefs = normalizePrefs({ binary: "C:/Program Files/Google/Chrome/Application/chrome.exe", userDataDir: "C:/Users/q/workspace/chrome_workspace" });
  await savePrefs(prefs);
  const back = await loadPrefs();
  assert.equal(back.binary, prefs.binary);
  assert.equal(back.debugPort, 9222);
  await clearPrefs();
  assert.equal(await loadPrefs(), null);
});
```
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test runtime/ego-linux/test/personal-prefs.test.mjs`
Expected: FAIL，报模块找不到 / `normalizePrefs` 未定义。测试中 `PERSONAL_PREFS_FILE` 会指向真实 `STATE_DIR`——为避免污染真实状态，跑测试前设临时 XDG：
```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP "ego-state-test"; node --test runtime/ego-linux/test/personal-prefs.test.mjs
```

- [ ] **Step 3: 写最小实现**

`runtime/ego-linux/src/paths.mjs` 追加：
```js
export const PERSONAL_PREFS_FILE = join(STATE_DIR, "personal-browser.json");
export const PERSONAL_STATE_FILE = join(STATE_DIR, "personal-browser-state.json");
```
`runtime/ego-linux/src/personal-prefs.mjs`：
```js
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { PERSONAL_PREFS_FILE, STATE_DIR } from "./paths.mjs";

const FWD = (s) => (s || "").replace(/\\/g, "/");

export function normalizePrefs(raw) {
  if (!raw || typeof raw !== "object") return null;
  const binary = typeof raw.binary === "string" ? FWD(raw.binary.trim()) : "";
  const userDataDir = typeof raw.userDataDir === "string" ? FWD(raw.userDataDir.trim()) : "";
  if (!binary || !userDataDir) return null;
  const debugPort = Number.isInteger(raw.debugPort) && raw.debugPort > 0 ? raw.debugPort : 9222;
  const flags = Array.isArray(raw.flags) ? raw.flags.map(String) : [];
  return { binary, userDataDir, debugPort, flags, confirmedAt: new Date().toISOString(), source: "user-confirmed" };
}

export async function loadPrefs() {
  try {
    const raw = JSON.parse(await readFile(PERSONAL_PREFS_FILE, "utf8"));
    return normalizePrefs(raw); // 宽松：存档若损坏则视为无档案
  } catch {
    return null;
  }
}

export async function savePrefs(prefs) {
  const clean = normalizePrefs(prefs);
  if (!clean) throw new Error("invalid prefs: binary and userDataDir are required");
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PERSONAL_PREFS_FILE, JSON.stringify(clean, null, 2));
}

export async function clearPrefs() {
  await rm(PERSONAL_PREFS_FILE, { force: true });
}

export function profileMatches(cmdline, userDataDir) {
  if (typeof cmdline !== "string" || typeof userDataDir !== "string") return false;
  const cl = FWD(cmdline).toLowerCase();
  const ud = FWD(userDataDir).toLowerCase();
  const flag = "--user-data-dir=";
  const idx = cl.indexOf(flag);
  if (idx < 0) return false;
  let rest = cl.slice(idx + flag.length);
  if (rest.startsWith('"')) rest = rest.slice(1); // 允许带引号
  const value = rest.split(/["\s]/)[0] || "";
  return value === ud;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `$env:XDG_STATE_HOME = Join-Path $env:TEMP "ego-state-test"; node --test runtime/ego-linux/test/personal-prefs.test.mjs`
Expected: PASS（全部 4 个测试）。

- [ ] **Step 5: 登记 PATCHES.md 并提交**

在 `runtime/PATCHES.md` 表格追加一行（文件=新增模块；改动=新增 personal 启动档案模块；原因=个人接管模式存档/身份核对）。然后：
```bash
git add runtime/ego-linux/src/paths.mjs runtime/ego-linux/src/personal-prefs.mjs runtime/ego-linux/test/personal-prefs.test.mjs runtime/PATCHES.md
git commit -m "feat(ego-browser): personal launch prefs module + identity matcher"
```

---

### Task 3: `chrome.mjs` —— 泛化进程查找 + `resolveBackingBrowser()`（personal/isolated 分流）

**Files:**
- Modify: `runtime/ego-linux/src/chrome.mjs`
- Create: `runtime/ego-linux/test/chrome-personal.test.mjs`（只测可单测的纯/半纯部分；launch 走 Task 6 E2E）

**Interfaces:**
- Consumes: `personal-prefs.mjs`（`loadPrefs`/`savePrefs`/`profileMatches`）、`paths.mjs`（`PERSONAL_STATE_FILE`）、现有 `probe()`/`waitForPortReady()`/`pickDebugPort()`。
- Produces:
  - `findChromeMainOnPort(port) -> Promise<Array<{pid:number, cmdline:string}>>`：win32 用 CIM 按 `--remote-debugging-port=<port>` + 非 `--type=` 枚举；非 win32 返回 `[]`（本机为 Windows，POSIX 可后续补）。
  - `personalStatus() -> Promise<{ prefsExists:boolean, debugPort:number|null, running:boolean, ours:boolean, attachable:boolean, reason?:string }>`
  - `resolveBackingBrowser({ headless=false, startUrl=null }={}) -> Promise<{ wsUrl:string, port:number, launched:boolean, owned:boolean, mode:"personal"|"isolated" }>`：见 Step 2 逻辑。isolated 走原 `ensureBrowser()`。

- [ ] **Step 1: 写失败测试（纯逻辑：findChromeMainOnPort 的 cmdline 过滤函数抽出可单测）**

把 CIM 输出解析提为内部可导出纯函数便于测试——在 `chrome.mjs` 导出 `parseWinCimChrome(listJson, { port, userDataDir })`：
- 输入 CIM 数组元素 `{ ProcessId, CommandLine }`；返回命中 `{ pid, cmdline }` 数组（按 `--remote-debugging-port=<port>` + 非 `--type=` + 若给 `userDataDir` 则 `profileMatches`）。

`runtime/ego-linux/test/chrome-personal.test.mjs`：
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWinCimChrome } from "../src/chrome.mjs";
test("parseWinCimChrome: 只认端口+主进程，可按 profile 过滤", () => {
  const list = [
    { ProcessId: 1, CommandLine: `C:/chrome.exe --user-data-dir=C:/Users/q/workspace/chrome_workspace --remote-debugging-port=9222` },
    { ProcessId: 2, CommandLine: `C:/chrome.exe --user-data-dir=C:/Users/q/other --remote-debugging-port=9222` },
    { ProcessId: 3, CommandLine: `C:/chrome.exe --user-data-dir=C:/Users/q/workspace/chrome_workspace --remote-debugging-port=9222 --type=renderer` },
    { ProcessId: 4, CommandLine: `C:/chrome.exe --user-data-dir=C:/Users/q/workspace/chrome_workspace --remote-debugging-port=9333` },
  ];
  const hit = parseWinCimChrome(list, { port: 9222 });
  assert.deepEqual(hit.map(x => x.pid).sort(), [1, 2]);
  const mine = parseWinCimChrome(list, { port: 9222, userDataDir: "C:/Users/q/workspace/chrome_workspace" });
  assert.deepEqual(mine.map(x => x.pid), [1]);
});
```
Expected: FAIL（函数未导出）。

- [ ] **Step 2: 实现**

在 `chrome.mjs` 加：
```js
import { loadPrefs, profileMatches } from "./personal-prefs.mjs";
import { PERSONAL_STATE_FILE } from "./paths.mjs";

export function parseWinCimChrome(list, { port, userDataDir } = {}) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter((p) => p && typeof p.CommandLine === "string")
    .filter((p) => p.CommandLine.includes(`--remote-debugging-port=${port}`))
    .filter((p) => !p.CommandLine.match(/(?:^|\s)--type=/))
    .filter((p) => (userDataDir ? profileMatches(p.CommandLine, userDataDir) : true))
    .map((p) => ({ pid: Number(p.ProcessId), cmdline: p.CommandLine }));
}

export async function findChromeMainOnPort(port) {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return [];
    const parsed = JSON.parse(r.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return parseWinCimChrome(list, { port });
  } catch { return []; }
}

export async function personalStatus() {
  const prefs = await loadPrefs();
  if (!prefs) return { prefsExists: false, debugPort: null, running: false, ours: false, attachable: false, reason: "no-prefs" };
  const wsUrl = await probe(prefs.debugPort);
  if (!wsUrl) return { prefsExists: true, debugPort: prefs.debugPort, running: false, ours: false, attachable: false };
  const hit = await findChromeMainOnPort(prefs.debugPort);
  const mine = hit.find((p) => profileMatches(p.cmdline, prefs.userDataDir));
  if (mine) return { prefsExists: true, debugPort: prefs.debugPort, running: true, ours: false, attachable: true };
  return { prefsExists: true, debugPort: prefs.debugPort, running: true, ours: false, attachable: false, reason: "port-owned-by-other-profile" };
}
```
`resolveBackingBrowser` 与 `launchPersonal`（最终实现）：
```js
function personalEnabled() {
  const v = (process.env.EGO_LINUX_PERSONAL ?? "").toLowerCase();
  return !["0", "false", "no"].includes(v); // 默认/未设 => personal
}

async function launchPersonal(prefs, startUrl) {
  // 绝不二次启动同一 profile：启动前若该 userDataDir 已被活实例占用（任意端口），报错
  const args = [...prefs.flags, `--user-data-dir=${prefs.userDataDir}`, `--remote-debugging-port=${prefs.debugPort}`, startUrl || "about:blank"];
  const child = spawn(prefs.binary, args, { detached: true, stdio: "ignore" });
  child.unref();
  const { port, wsUrl } = await waitForPortReady(prefs.debugPort);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PERSONAL_STATE_FILE, JSON.stringify({ port, pid: child.pid, binary: prefs.binary, userDataDir: prefs.userDataDir, startedByEgo: true }, null, 2));
  return { wsUrl, port, launched: true, owned: true, mode: "personal" };
}

export async function resolveBackingBrowser({ headless = false, startUrl = null } = {}) {
  if (process.env.EGO_LINUX_CDP_URL) {
    return { wsUrl: process.env.EGO_LINUX_CDP_URL, port: null, launched: false, owned: false, mode: "personal" };
  }
  if (!personalEnabled()) {
    const r = await ensureBrowser({ headless });
    return { ...r, owned: true, mode: "isolated" };
  }
  const prefs = await loadPrefs();
  if (!prefs) {
    const err = new Error("no personal-browser.json; run `ego-browser --prefs <json>` (ask the user first)");
    err.code = "NO_PREFS";
    throw err;
  }
  const wsUrl = await probe(prefs.debugPort);
  if (wsUrl) {
    const hit = await findChromeMainOnPort(prefs.debugPort);
    const mine = hit.find((p) => profileMatches(p.cmdline, prefs.userDataDir));
    if (!mine) {
      throw new Error(`port ${prefs.debugPort} is owned by another Chrome/profile; refusing to attach (identity check failed)`);
    }
    return { wsUrl, port: prefs.debugPort, launched: false, owned: false, mode: "personal" };
  }
  return launchPersonal(prefs, startUrl);
}
```
> 注意：`personalEnabled` 默认 true；CLI（Task 4）在解析到 `--isolated` 时设 `process.env.EGO_LINUX_PERSONAL = "0"` 切到 isolated，本文件不再改判定。`spawn`/`spawnSync`/`mkdir`/`writeFile`/`STATE_DIR` 均已在文件顶部 import，无需重复。

- [ ] **Step 3: 跑单测确认通过**

Run: `node --test runtime/ego-linux/test/chrome-personal.test.mjs`
Expected: PASS。再快速跑既有单测确保没破坏：`node --test runtime/ego-linux/test/personal-prefs.test.mjs`（同样设 `XDG_STATE_HOME` 临时）。

- [ ] **Step 4: 冒烟（personal 分支错误路径 + status 报告）**

不设 prefs 时应报 NO_PREFS 而不是启动浏览器：
```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP "ego-state-empty"; Remove-Item -Recurse -Force $env:XDG_STATE_HOME -ErrorAction SilentlyContinue
node -e "import('./runtime/ego-linux/src/chrome.mjs').then(async m => { try { await m.resolveBackingBrowser({}); console.log('UNEXPECTED_OK') } catch (e) { console.log('EXPECTED', e.code) } })"
```
Expected: `EXPECTED NO_PREFS`，且**没有任何 chrome 进程被启动**。

- [ ] **Step 5: 登记 PATCHES.md 并提交**

```bash
git add runtime/ego-linux/src/chrome.mjs runtime/ego-linux/test/chrome-personal.test.mjs runtime/PATCHES.md
git commit -m "feat(ego-browser): resolveBackingBrowser personal/isolated split + port identity check"
```

---

### Task 4: CLI 接线 —— `--prefs`/`--prefs-clear`/`--isolated`/`--status` 扩展/`--stop` 语义

**Files:**
- Modify: `runtime/ego-linux/bin/ego-browser.mjs`

**Interfaces:**
- Consumes: `resolveBackingBrowser`（Task 3）、`personal-prefs`（Task 2）、`personalStatus`（Task 3）。
- Produces: 命令行为——
  - `--status`：输出含 `personal` 报告（调 `personalStatus()`）。
  - `--prefs <json>`：`savePrefs(JSON.parse(json))` 成功打印 `prefs saved`；非法 JSON/缺字段打印错误 exit 2。
  - `--prefs-clear`：`clearPrefs()` 打印 `prefs cleared`。
  - `--isolated`：设 `process.env.EGO_LINUX_PERSONAL = "0"` 后走原逻辑。
  - 默认（nodejs/`--url`）分支：改用 `resolveBackingBrowser({ headless, startUrl })` 替换原来的 `createEgoShim` 内部 `ensureBrowser` 调用。`createEgoShim` 需接受注入端点（见 Task 5 接口，此处先改调用方式：`createEgoShim` 增可选参数）。
  - `--stop`：personal 下读 `PERSONAL_STATE_FILE`；`startedByEgo` 才优雅关闭（复用 `closeBrowserGracefully`/`stopBrowser` 逻辑），否则输出 `attached only; your browser was NOT stopped`。

- [ ] **Step 1: 改 `createEgoShim` 调用点以支持注入端点**

`shim.mjs` 的 `createEgoShim({ headless })` 目前内部 `ensureBrowser`。改成：
```js
export async function createEgoShim({ headless = false, endpoint = null } = {}) {
  const { wsUrl, port } = endpoint || (await ensureBrowser({ headless }));
  ...
```
调用点（bin/ego-browser.mjs）默认分支改为：
```js
const { resolveBackingBrowser } = await import("../src/chrome.mjs");
let endpoint;
try {
  endpoint = await resolveBackingBrowser({ headless, startUrl: process.env.EGO_LINUX_START_URL || null });
} catch (e) {
  if (e?.code === "NO_PREFS") { process.stderr.write("NO_PREFS: no personal-browser.json — ask the user for their launch command, then: ego-browser --prefs \"{...}\"\n"); return 2; }
  throw e;
}
const shim = await createEgoShim({ headless, endpoint });
```

- [ ] **Step 2: `--status` / `--prefs` / `--prefs-clear` / `--isolated` 分支**

在 `--status` 分支改为：
```js
if (argv[0] === "--status") {
  const status = await browserStatus();
  const personal = await personalStatus();
  process.stdout.write(`${JSON.stringify({ ...status, personal }, null, 2)}\n`);
  return 0;
}
if (argv[0] === "--prefs") {
  if (!argv[1]) { process.stderr.write("--prefs requires a JSON object\n"); return 2; }
  try { await savePrefs(JSON.parse(argv[1])); process.stdout.write("prefs saved\n"); return 0; }
  catch (e) { process.stderr.write(`invalid prefs: ${e.message}\n`); return 2; }
}
if (argv[0] === "--prefs-clear") { await clearPrefs(); process.stdout.write("prefs cleared\n"); return 0; }
```
`--isolated`：在 headless 解析处附近（argv 还未经 splice 前）：
```js
const isolated = argv.includes("--isolated");
if (isolated) process.env.EGO_LINUX_PERSONAL = "0";
```
并把 `--isolated` 从 `rest` 过滤掉（与 `--headless` 同样处理）。

- [ ] **Step 3: `--stop` personal 语义**

在 `--stop` 分支开头插入（保留现有 isolated/space cookie 回流逻辑作为 isolated 分支）：
```js
if (argv[0] === "--stop" && personalEnabled()) {
  try {
    const st = JSON.parse(await readFile(PERSONAL_STATE_FILE, "utf8"));
    if (st?.startedByEgo) { await stopBrowser(); /* stopBrowser 内部关 graceful + 删 state */ }
    else process.stdout.write("attached only; your browser was NOT stopped\n");
    await rm(PERSONAL_STATE_FILE, { force: true });
    return 0;
  } catch { /* 无记账：无 ego 自启实例，直接提示 */ }
  process.stdout.write("no ego-launched personal browser to stop\n");
  return 0;
}
```
> 说明：`stopBrowser()`（Task 3 已存在）关的是 `BROWSER_STATE_FILE` 记账的实例；personal 自启实例记账在 `PERSONAL_STATE_FILE`。**实现时请给 `chrome.mjs` 加一个 `stopPersonalBrowser()`**：读 `PERSONAL_STATE_FILE` → 有 `startedByEgo` 则对其 port 走 `closeBrowserGracefully` → 删 `PERSONAL_STATE_FILE`；`--stop` 分支改调它。（`stopBrowser` 本身不动，isolated 仍可用。）

- [ ] **Step 4: 手动冒烟（不碰真实浏览器）**

```powershell
# 无档案 --status：应报 personal.prefsExists=false 且不启动任何浏览器
$env:XDG_STATE_HOME = Join-Path $env:TEMP "ego-state-empty2"; node runtime\ego-linux\bin\ego-browser.mjs --status
# 非法档案：exit 2
node runtime\ego-linux\bin\ego-browser.mjs --prefs "{}"; Write-Host "exit=$LASTEXITCODE"
# 合法档案写/读/清
node runtime\ego-linux\bin\ego-browser.mjs --prefs "{\"binary\":\"C:/Program Files/Google/Chrome/Application/chrome.exe\",\"userDataDir\":\"C:/x/y\"}"
node runtime\ego-linux\bin\ego-browser.mjs --status
node runtime\ego-linux\bin\ego-browser.mjs --prefs-clear
```
Expected：第一条 `prefsExists:false`；第二条 exit=2；写/读/清各打印对应文案。

- [ ] **Step 5: 登记 PATCHES.md 并提交**

```bash
git add runtime/ego-linux/src/shim.mjs runtime/ego-linux/src/chrome.mjs runtime/ego-linux/bin/ego-browser.mjs runtime/PATCHES.md
git commit -m "feat(ego-browser): CLI prefs/isolated/status/stop for personal mode"
```

---

### Task 5: shim「伪空间」适配 —— 依 spike 结论驱动外部现有 tab（接 Task 1 决策）

**Files:**
- Modify: `runtime/ego-linux/src/task-spaces.mjs`、`runtime/ego-linux/src/shim.mjs`
- Test: `runtime/ego-linux/test/`（若 spike 为 PARTIAL 所列 API 涉及可单测逻辑则补，否则以 Task 6 E2E 验证）

**Interfaces:**
- Consumes: Task 1 spike 报告的决策/补丁清单；`createTaskSpacesApi(cdp)` 内部已有"无 context 空间"fallback（`listTabs` 按 `scope.targetIds` 过滤、`createTab(url, undefined)` 落默认 context）。
- Produces:
  - `taskSpaces.adoptPersonalSpace(name) -> Promise<{ id }>`：建立/复用 `id="personal"` 的非隔离空间，`browserContextId=null`，把**当前默认 context（或全部 page）现有 tab** 的 targetId 并入该空间，并置为 selected；不改动/不关闭任何现有 tab。
  - `createEgoShim({ headless, endpoint, personal=true })`：personal 且已接管外部浏览器时，先 `await taskSpaces.adoptPersonalSpace("personal")` 再返回 ego（脚本第一步即可 `listTabs` 列出既有 tab）。

- [ ] **Step 1: 依 spike 决策，把补丁点落成代码（PARTIAL 清单或 PASS 全量）**

若 spike=PASS，最小实现（`task-spaces.mjs` 内新增）：
```js
async function adoptPersonalSpace(name = "personal") {
  const state = await readState();
  let space = state.spaces.find((s) => s.id === name || s.name === name);
  if (!space) {
    space = { id: name, name, targetIds: [], urls: [], browserContextId: null, createdAt: Date.now(), personal: true };
    state.spaces.push(space);
  }
  const live = await livePageTargets();
  for (const target of live.values()) space.targetIds.push(target.targetId); // 并入现有 tab，不关不改
  space.targetIds = [...new Set(space.targetIds)];
  state.selectedId = space.id;
  await writeState(state);
  return { id: space.id };
}
```
并在 `createTaskSpacesApi` 返回值里暴露 `adoptPersonalSpace`。`shim.mjs`：`createEgoShim` 在 `endpoint` 注入且 personal 时于 return 前 `await taskSpaces.adoptPersonalSpace("personal")`（失败不阻断——catch 记 stderr）。
> 若 spike=PARTIAL：按报告逐条修（例如 `switchTab` 对不在 selected 的 target 报"not found"时，先把它并进 personal 空间再切；或 `createTab` 需要显式不带 context）。把每条补丁写成独立小步骤并跑 Task 6 脚本复测。

- [ ] **Step 2: 冒烟——接管 Task 1 的临时 Chrome 复测（PASS 判据）**

复用 Task 1 Step 4 的 `spike-ops.js`（临时目录），断言：
- `BEFORE` 列出外部浏览器全部现有 tab；
- `AFTER_OPEN_REUSE` tab 数**不增加**（example.com 被复用）；
- `GOTO_OK` / `SNAP_OK` 正常。
PowerShell 跑 `ego-browser` 默认分支（此时应走 personal 接管该临时 Chrome）：
```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP "ego-state-personal"; $env:EGO_LINUX_PERSONAL = "1"
node runtime\ego-linux\bin\ego-browser.mjs --prefs "{\"binary\":\"C:/Program Files/Google/Chrome/Application/chrome.exe\",\"userDataDir\":\"$tmp\",\"debugPort\":9333}"
node runtime\ego-linux\bin\ego-browser.mjs nodejs < spike-ops.js
```
Expected：如上三条断言通过；没有第二个浏览器进程被拉起（`Get-Process chrome` 计数不增）。

- [ ] **Step 3: 登记 PATCHES.md 并提交**

```bash
git add runtime/ego-linux/src/task-spaces.mjs runtime/ego-linux/src/shim.mjs runtime/PATCHES.md
git commit -m "feat(ego-browser): personal pseudo-space adopt existing default-context tabs"
```

---

### Task 6: E2E 回归 `scripts/verify-personal.mjs`（隔离环境，绝不碰真实 chrome_workspace）

**Files:**
- Create: `scripts/verify-personal.mjs`
- Modify: `package.json`（`scripts["verify:personal"]`）、`runtime/PATCHES.md`

**Interfaces:**
- Consumes: 全部 runtime 改动（Task 2–5）+ `bin/ego-browser.cmd` 或 `node runtime/ego-linux/bin/ego-browser.mjs`。
- Produces: 0 退出码 = 全绿；打印逐步断言。

- [ ] **Step 1: 写脚本**

`scripts/verify-personal.mjs` 要点（node:assert + child_process 跑 CLI，全临时目录）：
1. 建 `%TEMP%\ego-vp-profile`、`%TEMP%\ego-vp-state`、挑空闲端口 9400+；
2. 起临时 Chrome（带 `--remote-debugging-port` + 该临时 userDataDir + `https://example.com`）；
3. `EGO_LINUX_PERSONAL=1`、`XDG_STATE_HOME=临时` → `--prefs` 写入指向该临时 profile 的档案；
4. 跑两个 heredoc 脚本（写 `%TEMP%`）：
   - `a.js`：`console.log('T', (await browser.listTabs()).tabs.length)` → 断言 ≥1 且含 example.com；
   - `b.js`：`await browser.openOrReuseTab('https://example.com',{wait:true}); console.log('N', (await browser.listTabs()).tabs.length)` → 断言 N == a 的 T（复用不新增）；
   - `c.js`：新 URL → `openOrReuseTab('https://example.org')` → 断言 N+1；随后 `browser.closeTab(该新tab)` → 断言回到 N；
5. `--stop` → 断言输出"attached only; your browser was NOT stopped"（外部实例不杀）；再验证该临时 Chrome 仍活着；
6. 结束清理：关临时 Chrome、删临时目录；打印 `verify-personal: PASS`。

> 复现性注意：`example.com` 可能被本机网络劫持/超时——改用 `data:` 页或 `about:blank#<n>` 亦可；用 `about:blank` 时 openOrReuse 按 URL 去重对 about:blank 语义弱，**建议用两个本地 `data:text/html` URL** 保证确定性：`data:text/html,<title>p1</title><h1>p1</h1>` 与 `...p2...`。请按此实现断言（URL 完全一致才算复用命中）。

- [ ] **Step 2: 跑脚本直到全绿**

Run: `node scripts/verify-personal.mjs`
Expected: 打印逐步断言，最后 `verify-personal: PASS`，exit 0。同时确认**没有**创建/触碰 `C:\Users\quincy\workspace\mywork\chrome_workspace` 下任何文件（可在跑前记录该目录文件清单对比）。

- [ ] **Step 3: 回归 isolated**

Run: `node scripts/verify.mjs`（isolated 路径不受 personal 影响）
Expected: PASS（原行为不破）。若 verify.mjs 依赖默认 personal，则需给其入口加 `EGO_LINUX_PERSONAL=0`——**实现时先跑一次看**；若失败按此修：`package.json` 的 `verify` 保持调用，但 verify.mjs 内 `spawn` runtime 时统一注入 `EGO_LINUX_PERSONAL=0`。

- [ ] **Step 4: package.json + PATCHES.md + 提交**

`package.json` scripts 加 `"verify:personal": "node scripts/verify-personal.mjs"`；PATCHES.md 追加 verify-personal 行。提交：
```bash
git add scripts/verify-personal.mjs package.json runtime/PATCHES.md
git commit -m "test(ego-browser): personal-mode E2E regression (isolated env)"
```

---

### Task 7: 技能层改写（4 份副本 + references + AGENTS）与收尾验证

**Files:**
- Modify（权威源，然后逐份复制）: `skills/ego-browser/SKILL.md`、`skills/ego-browser/references/operating-preferences.md`、`skills/ego-browser/references/windows.md`、`skills/ego-browser/references/install.md`、`skills/ego-browser/references/task-spaces.md`
- Copy to: `runtime/skills/ego-browser/`、`.copilot/skills/ego-browser/`、`~/.copilot/skills/ego-browser/`
- Modify: `AGENTS.md`、`docs/superpowers/specs/2026-09-06-ego-browser-personal-takeover-design.md`（如需在末尾加"已实现"状态）

**Interfaces:**
- Consumes: 运行时新命令 `--prefs`/`--prefs-clear`/`--isolated` 与 personal 默认行为。
- Produces: agent 可执行的「接管 SOP」文字，硬规则落档（避免 agent 忘记/猜）。

- [ ] **Step 1: 重写 SKILL.md 为「接管 SOP」**

在 `skills/ego-browser/SKILL.md` 更新以下（替换 task-space-first 的叙述为新流程）：
- Invocation 段：新增命令表行 `--prefs <json>` / `--prefs-clear` / `--isolated`（写回 commands 列表）。
- 新增「个人接管模式（默认）」小节，内容硬规则：
  1. **开场不预热**：任何浏览器任务第一步就是"静默探测 + 接管/直达启动"（直接 `ego-browser <url?> nodejs < task.js`，内部自动接管/启动）；**禁止**单独 `--open` 或空脚本预热；健康检查只允许无副作用的 `--status`。
  2. **接管后先列 tab**：脚本首行 `console.log(await browser.listTabs())`；据此复用现有 tab、决定是否开新页 → 避免重复/多开用户所需页面。
  3. **首用建档（硬规则）**：`--status` 显示 `personal.prefsExists:false` → **停下，用中文向用户征询**惯常启动命令（二进制/端口/profile 目录/附加 flag）→ 用户确认 → `ego-browser --prefs "{...}"` 建档 → 继续。**禁止**猜默认命令、禁止擅自启动。
  4. **授权边界**：只操作档案里的 workspace profile；`--stop` 只对 ego 自启实例；外部用户实例绝不 kill/不 `--import-chrome-profile`/不改其数据。
  5. **登录态/会话复用**：接管复用该实例已加载会话与已开 tab（直接操作）；无实例则按档案启动同一 profile（落盘 cookie 自动加载）。
  6. **tab 卫生**：不关用户原有 tab；只清理本任务新开/重试产生的 tab。
  7. **人工步骤**：验证码/登录把当前 tab 留给你（不关闭、不 `--stop`），完成后接回同一 tab 继续。
- 保留 isolated 小节：`EGO_LINUX_PERSONAL=0` / `--isolated` 走旧隔离模式（CI/需隔离场景），并说明这与默认 personal 的差异。
- 删/改与"永远启动 ego 隔离 profile + task space 隔离"相冲突的旧段落（如"Start every task direct-to-page"里对 task space 的强依赖描述），保持一致。

- [ ] **Step 2: 同步 references**

- `operating-preferences.md`：§1 显式操作补充"建档/`--prefs` 属显式写档操作，需先征询"；新增"接管 SOP"要点（登录复用/不杀外部实例/首用建档）；`--stop` 语义更新（personal 只断不杀）。
- `windows.md`：命令表加 `--prefs`/`--prefs-clear`/`--isolated`；说明 personal 默认。
- `install.md`：在状态检查示例处保持 `--status`，补充首次建档提示。
- `task-spaces.md`：加"personal 接管模式下 task space 语义降级（非隔离伪空间）"说明。

- [ ] **Step 3: 同步 4 份副本并校验一致**

```powershell
Copy-Item -Recurse -Force skills\ego-browser\* runtime\skills\ego-browser\
Copy-Item -Recurse -Force skills\ego-browser\* .copilot\skills\ego-browser\
Copy-Item -Recurse -Force skills\ego-browser\* "$env:USERPROFILE\.copilot\skills\ego-browser\"
```
校验（对比权威源与生效副本，应无 diff）：
```powershell
git diff --no-index --stat skills\ego-browser "$env:USERPROFILE\.copilot\skills\ego-browser"
```
Expected: 无差异输出（或仅文件清单一致）。
> 注意：`~/.copilot/skills/ego-browser` 在 repo 外，不作为 git 内容；`.copilot/skills`（repo 内）与 `runtime/skills` 作为 git 内容提交。

- [ ] **Step 4: AGENTS.md + 状态登记 + 提交**

`AGENTS.md` 的"协作约定"或 Key facts 补一句：默认 personal 接管模式、`--prefs` 建档、外部实例不杀。提交：
```bash
git add skills runtime/skills .copilot/skills AGENTS.md
git commit -m "docs(ego-browser): personal takeover SOP across all skill copies"
```

---

### Task 8: 全量验证 + 收尾（证据先行）

**Files:** 无新增（必要时微调）。

- [ ] **Step 1: 跑全部回归并贴证据**

```powershell
node runtime\ego-linux\test\personal-prefs.test.mjs   # 或 node --test ...
node --test runtime\ego-linux\test\chrome-personal.test.mjs
node scripts\verify-personal.mjs
node scripts\verify.mjs
```
Expected: 全绿；真实 `chrome_workspace` 未被触碰（跑前/后文件清单一致）。

- [ ] **Step 2: 对真实 chrome_workspace 做一次"只读接管冒烟"（需用户在场、先征询）**

征询用户同意后：用户按惯常命令起 Chrome（或已在跑）→ 运行：
```powershell
node runtime\ego-linux\bin\ego-browser.mjs --status
```
Expected: `personal.attachable:true`；随后只读脚本 `console.log(await browser.listTabs())` 列出用户现有 tab，**不做任何写操作**。完成后向用户报告。

- [ ] **Step 3: 更新 spec 状态 + 提交收尾**

在 spec 末尾追加"实现状态：已完成（YYYY-MM-DD）"并提交；如 Task 1 spike 曾为 FAIL/PARTIAL 需回退，则在收尾前向用户报告并共同决策。
```bash
git add docs/superpowers/specs/2026-09-06-ego-browser-personal-takeover-design.md
git commit -m "docs(ego-browser): mark personal takeover design as implemented"
```

---

## Self-Review 记录

- **Spec coverage**：§1 期望 1→Task 5/6（不弹空窗：probe 不 launch、首窗直达）；期望 2→Task 3/4/5（探测+身份核对接管）；期望 3→Task 5（列 tab/复用）；期望 4→Task 2/3/4（档案读取优先/建档/每次读取）；期望 5→Spec §2 已决策不集成，计划无 playwright 任务。D1–D6→Task 3（双模式/统一入口）、Task 2（档案）、Task 5（伪空间）。授权边界/`--stop`→Task 4/6/7。副本同步→Task 7。
- **Placeholder scan**：无 TBD；唯一开放项是 spike（Task 1）PASS/PARTIAL/FAIL 三态——已显式写成决策分支而非占位；Task 5 Step 1 要求"若 PARTIAL 按报告逐条修"，为 spike 决策的受控延展，属 spike 产物输入而非空泛占位。
- **Type consistency**：`normalizePrefs`/`loadPrefs`/`savePrefs`/`clearPrefs`/`profileMatches`（Task 2 定义，Task 3/4 复用）；`parseWinCimChrome`/`findChromeMainOnPort`/`personalStatus`/`resolveBackingBrowser`（Task 3 定义，Task 4/6 复用）；`adoptPersonalSpace`（Task 5 定义，Task 6/7 依赖行为）；prefs 字段名全篇一致。命名前后一致（无 Task3 `clearLayers` 式漂移）。
