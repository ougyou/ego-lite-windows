#!/usr/bin/env node
/**
 * Personal-mode E2E regression — fully isolated, never touches the real
 * chrome_workspace / daily Chrome.
 *
 *   node scripts/verify-personal.mjs
 *
 * Starts a throwaway HEADLESS Chrome on a temp profile + temp port, opens two
 * local file pages as "existing tabs", archives a prefs pointing at that
 * profile, then drives it through the real CLI personal path and asserts:
 *   A. first listTabs already shows the 2 existing tabs (pseudo-space adopt)
 *   B. openOrReuse of an existing URL does not duplicate it
 *   C. a brand-new page opens in the default context and is tracked
 *   D. closing that new tab returns the count to the baseline
 *   --stop must NOT kill the externally-started browser.
 *
 * Exits 0 (PASS) or 1 (FAIL). Cleans up its own processes and temp dir.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url),
);

const CHROME_CANDIDATES = [
  process.env.EGO_LINUX_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.ProgramFiles
    ? `${process.env.ProgramFiles.replace(/\\/g, "/")}/Google/Chrome/Application/chrome.exe`
    : null,
].filter(Boolean);
const BINARY = CHROME_CANDIDATES.find((c) => existsSync(c));
if (!BINARY) {
  console.error("verify-personal: no Chrome binary found");
  process.exit(1);
}

let failed = 0;
function check(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok" : "FAIL"} - ${name}: got=${got} want=${want}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForEndpoint(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function baseEnv(stateDir) {
  const env = { ...process.env, XDG_STATE_HOME: stateDir, EGO_LINUX_PERSONAL: "1" };
  delete env.EGO_LINUX_CDP_URL;
  delete env.EGO_LINUX_PROFILE;
  return env;
}

function runCli(args, stateDir, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
      env: baseEnv(stateDir),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin ?? "");
  });
}

function runCliSync(args, stateDir) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: baseEnv(stateDir),
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function runEgoScript(stateDir, wwwDir, source) {
  // The heredoc is fed on stdin; the facade's browser.listTabs() returns an
  // array of tabs (not { tabs }).
  const script = `const P=${JSON.stringify(`file:///${wwwDir.replace(/\\/g, "/")}`)};\n` + source;
  const res = await runCli(["nodejs"], stateDir, { stdin: script });
  return res.out;
}

async function main() {
  const root = join(tmpdir(), `ego-vp-${process.pid}-${Date.now()}`);
  const wwwDir = join(root, "www");
  const profile = join(root, "profile");
  const state = join(root, "state");
  mkdirSync(wwwDir, { recursive: true });
  writeFileSync(join(wwwDir, "p1.html"), "<!doctype html><title>vp1</title><h1>vp1</h1>");
  writeFileSync(join(wwwDir, "p2.html"), "<!doctype html><title>vp2</title><h1>vp2</h1>");
  writeFileSync(join(wwwDir, "p3.html"), "<!doctype html><title>vp3</title><h1>vp3</h1>");

  const port = await freePort();
  const url1 = `file:///${wwwDir.replace(/\\/g, "/")}/p1.html`;

  // Kill only the throwaway Chrome whose cmdline carries this temp profile.
  // (Function declaration so the early-exit path below can call it too.)
  function cleanup() {
    try {
      const esc = profile.replace(/'/g, "''");
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape('${esc}') -and $_.CommandLine -match 'chrome' } | ForEach-Object { cmd /c \"taskkill /PID $($_.ProcessId) /T /F\" 2>&1 | Out-Null }`,
        ],
        { encoding: "utf8", timeout: 20000, windowsHide: true },
      );
    } catch {
      /* best effort */
    }
  }

  // 1) throwaway headless Chrome with the archived "workspace" profile
  const chrome = spawn(
    BINARY,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-gpu",
      url1,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  chrome.unref();
  if (!(await waitForEndpoint(port))) {
    console.error(`verify-personal: chrome did not expose port ${port}`);
    cleanup();
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    // 2) second existing tab in the same default context
    const enc = encodeURIComponent(`file:///${wwwDir.replace(/\\/g, "/")}/p2.html`);
    await fetch(`http://127.0.0.1:${port}/json/new?${enc}`, { method: "PUT" });

    // 3) archive prefs pointing at this throwaway profile
    const prefs = JSON.stringify({
      binary: BINARY,
      userDataDir: profile,
      debugPort: port,
      flags: [],
    });
    const save = runCliSync(["--prefs", prefs], state);
    check("prefs saved", save.code, 0);
    if (save.code !== 0) return 1;

    // 4) heredoc assertions through the real personal path
    const out = await runEgoScript(state, wwwDir, `
const toArr = (x) => (Array.isArray(x) ? x : (x && x.tabs) || []);
const fc = (tabs) => toArr(tabs).filter((t) => /^file:/.test((t.url || "") || "")).length;
const cur = async () => toArr(await browser.listTabs());
console.log('A=' + fc(await cur()));
await browser.openOrReuseTab(P + '/p1.html', { wait: true, timeout: 20 });
console.log('B=' + fc(await cur()));
await browser.openOrReuseTab(P + '/p3.html', { wait: true, timeout: 20 });
console.log('C=' + fc(await cur()));
const created = toArr(await browser.listTabs()).find((t) => t.url === P + '/p3.html');
if (created) await browser.closeTab(created.targetId);
console.log('D=' + fc(await cur()));
`);
    const m = (k) => (out.match(new RegExp(`${k}=(\\d+)`)) || [])[1];
    check("A adopt lists 2 existing tabs", m("A"), 2);
    check("B reuse no duplicate", m("B"), 2);
    check("C new tab tracked", m("C"), 3);
    check("D close only ours", m("D"), 2);

    // 5) --stop must NOT kill the externally-started browser
    const st = runCliSync(["--stop"], state);
    check("--stop detaches, never kills external", /(not stopped|no ego-launched)/.test(st.out), true);
    const stillUp = await waitForEndpoint(port, 3000);
    check("external chrome still alive after --stop", stillUp, true);

    return failed === 0 ? 0 : 1;
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

main().then((code) => {
  if (code === 0) console.log("verify-personal: PASS");
  else console.error("verify-personal: FAIL");
  process.exit(code);
});
