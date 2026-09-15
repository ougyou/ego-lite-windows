#!/usr/bin/env node
/**
 * ego-browser — Windows-first launcher for the vendored ego-linux runtime.
 *
 * The vendored runtime (runtime/ego-linux) is the community Linux port of
 * ego-lite: it drives a stock Chromium/Edge over CDP instead of the macOS app.
 * It runs on Windows, but two things need handling before it works:
 *
 *   1. EGO_LINUX_CHROME must be an ABSOLUTE path with FORWARD slashes — the
 *      runtime treats a candidate containing "/" as an absolute path and checks
 *      it with fs.access; a Windows "C:\..." backslash path is misread as a
 *      bare command name and skipped (which()).
 *   2. Chrome/Edge live in per-user install dirs not on PATH, so we probe the
 *      standard install locations instead of relying on `which`.
 *
 * This launcher finds a browser, sets the env, and forwards all args + stdin to
 * the vendored CLI, leaving the runtime untouched.
 *
 * Usage (same CLI as the vendored runtime):
 *   node scripts/ego-browser-launch.mjs nodejs <<'EOF'
 *   const task = await taskSpace('demo')
 *   const page = task.page('p1')
 *   await page.goto('https://example.com')
 *   console.log(await page.snapshot())
 *   EOF
 *
 *   node scripts/ego-browser-launch.mjs --status
 *   node scripts/ego-browser-launch.mjs --open
 *   node scripts/ego-browser-launch.mjs --stop
 *   node scripts/ego-browser-launch.mjs --headless nodejs
 *   node scripts/ego-browser-launch.mjs --import-chrome-profile
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNTIME_BIN = fileURLToPath(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url),
);
// Point the runtime at the canonical skill package so site learnings and
// agent_helpers.js resolve from a single source of truth.
const SKILL_WORKSPACE = fileURLToPath(
  new URL("../skills/ego-browser", import.meta.url),
);

/** Standard Chrome / Edge / Brave install paths (most common first). */
function browserCandidates() {
  const env = process.env.EGO_LINUX_CHROME;
  const pf = process.env.ProgramFiles || "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    env,
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Google/Chrome/Application/chrome.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    `${pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    `${pf86}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    local && `${local}/BraveSoftware/Brave-Browser/Application/brave.exe`,
  ]
    .filter(Boolean)
    // Runtime requirement: absolute paths must use forward slashes.
    .map((c) => c.replace(/\\/g, "/"));
}

function findBrowser() {
  for (const c of browserCandidates()) {
    if (existsSync(c)) return c;
  }
  return null;
}

const args = process.argv.slice(2);
const env = { ...process.env };

// Headless: --headless flag or EGO_LINUX_HEADLESS=1. Default is a visible
// agent window (like ego-lite's own browser); headless suits CI / no desktop.
// The runtime consumes `nodejs` only when it is argv[0], so we apply headless
// via env and DROP the flag from the forwarded args — keeping `nodejs` first.
if (args.includes("--headless") || env.EGO_LINUX_HEADLESS === "1") {
  env.EGO_LINUX_HEADLESS = "1";
}
const forwarded = args.filter((a) => a !== "--headless");

// Canonical skill workspace (runtime default is runtime/skills/ego-browser).
env.EGO_BROWSER_AGENT_WORKSPACE ||= SKILL_WORKSPACE.replace(/\\/g, "/");

const chrome = findBrowser();
if (chrome) {
  env.EGO_LINUX_CHROME = chrome;
  process.stderr.write(`[ego-browser] browser: ${chrome}\n`);
} else {
  process.stderr.write(
    "[ego-browser] warning: no Chrome/Edge/Brave found; set EGO_LINUX_CHROME\n",
  );
}

const child = spawn(process.execPath, [RUNTIME_BIN, ...forwarded], {
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
