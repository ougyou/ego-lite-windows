#!/usr/bin/env node
/**
 * Smoke test — prove the default (upstream v2) harness can drive a real page
 * on this machine through the runtime. Launches headless Edge/Chrome via the
 * launcher, opens a page, reads it back, and closes the task space.
 *
 *   node scripts/verify.mjs
 *
 * Exits 0 (PASS) or 1 (FAIL).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enumerateOwnBrowserMainProcesses } from "../runtime/ego-linux/src/chrome.mjs";
import { PROFILE_DIR } from "../runtime/ego-linux/src/paths.mjs";

// The runtime bin directly (single node process); it detects Windows
// browsers itself, so the launcher hop is unnecessary.
const LAUNCHER = fileURLToPath(
  new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url),
);

// A per-run space name: resuming a name whose Pages died with a previous
// browser leaves a stale ledger entry in the harness.
const SPACE = `verify-${Date.now()}`;

const SCRIPT = `
const task = await taskSpace(${JSON.stringify(SPACE)})
console.log('SPACE_ID=' + task.spaceId)
const page = task.page('p1')
await page.goto('https://example.com', { timeout: 30000 })
console.log('URL=' + (await page.url()))
console.log('TITLE=' + (await page.title()))
await task.finish({ keep: [] })
`;

function run() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [LAUNCHER, "--headless", "nodejs"],
      { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, EGO_LINUX_PERSONAL: "0" } },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(SCRIPT);
  });
}

console.log("== ego-browser smoke test ==");
const { code, out } = await run();
const hasUrl = /URL=https?:\/\/example\.com\//.test(out);
const hasTitle = /TITLE=Example Domain/.test(out);
console.log("---- output ----");
console.log(out.trim() || "(no stdout)");
console.log("----------------");
// The smoke test leaves the shared (headless) browser up by design. Assert it
// stayed a SINGLE instance — the multi-browser regression guard.
const own = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
const single = own.length === 1;
console.log(
  `single-instance check: ${own.length} own browser process(es) ${single ? "OK" : "MULTI-INSTANCE"}`,
);

const ok = code === 0 && hasUrl && hasTitle && single;
if (ok) {
  console.log("PASS: runtime drives a real page on this machine");
} else {
  console.error(`FAIL: exit=${code} url=${hasUrl} title=${hasTitle} single=${single}`);
}
process.exit(ok ? 0 : 1);
