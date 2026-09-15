#!/usr/bin/env node
/**
 * Opt-in v2 harness smoke test — proves the upstream ego-browser v2.0.0 bundle
 * (runtime/ego-browser/dist/out/index.v2.js) can drive a real page through this
 * runtime in ISOLATED mode.
 *
 *   node scripts/verify-v2-engine.mjs
 *
 * v2 is opt-in (EGO_BROWSER_HARNESS=v2) because its Page abstraction cannot
 * drive pages in personal takeover mode yet — see runtime/PATCHES.md. This test
 * therefore runs with EGO_LINUX_PERSONAL=0 and uses the v2 script API
 * (taskSpace / task.page) rather than the default v1 facade.
 *
 * Exits 0 (PASS) or 1 (FAIL).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enumerateOwnBrowserMainProcesses } from "../runtime/ego-linux/src/chrome.mjs";
import { PROFILE_DIR } from "../runtime/ego-linux/src/paths.mjs";

const LAUNCHER = fileURLToPath(
  new URL("./ego-browser-launch.mjs", import.meta.url),
);

// A per-run space name: resuming a name whose Pages died with a previous
// browser leaves a stale ledger entry in the v2 harness.
const SPACE = `verify-v2-${Date.now()}`;

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
    const child = spawn(process.execPath, [LAUNCHER, "--headless", "nodejs"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        EGO_BROWSER_HARNESS: "v2",
        EGO_LINUX_PERSONAL: "0",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(SCRIPT);
  });
}

console.log("== ego-browser v2-harness smoke test ==");
const { code, out } = await run();
const hasUrl = /URL=https?:\/\/example\.com\//.test(out);
const hasTitle = /TITLE=Example Domain/.test(out);
console.log("---- output ----");
console.log(out.trim() || "(no stdout)");
console.log("----------------");
const own = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
const single = own.length === 1;
console.log(
  `single-instance check: ${own.length} own browser process(es) ${single ? "OK" : "MULTI-INSTANCE"}`,
);

const ok = code === 0 && hasUrl && hasTitle && single;
if (ok) {
  console.log("PASS: v2 harness drives a real page on this machine (isolated mode)");
} else {
  console.error(`FAIL: exit=${code} url=${hasUrl} title=${hasTitle} single=${single}`);
}
process.exit(ok ? 0 : 1);
