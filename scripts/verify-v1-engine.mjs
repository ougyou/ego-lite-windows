#!/usr/bin/env node
/**
 * Legacy v1-harness smoke test — proves the opt-in v1 bundle
 * (runtime/ego-browser/dist/out/index.js, EGO_BROWSER_HARNESS=v1) still drives
 * a real page. The v1 harness speaks the facade dialect (taskSpaces/browser),
 * see references/facade.md.
 *
 *   node scripts/verify-v1-engine.mjs
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

const SCRIPT = `
const task = await taskSpaces.useOrCreate('verify-v1')
console.log('SPACE_ID=' + task.id)
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 30 })
const info = await page.info()
console.log('URL=' + info.url)
console.log('TITLE=' + info.title)
await taskSpaces.complete(task.id, { keep: false })
`;

function run() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, "--headless", "nodejs"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        EGO_BROWSER_HARNESS: "v1",
        EGO_LINUX_PERSONAL: "0",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(SCRIPT);
  });
}

console.log("== ego-browser v1-harness smoke test ==");
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
  console.log("PASS: v1 harness drives a real page on this machine");
} else {
  console.error(`FAIL: exit=${code} url=${hasUrl} title=${hasTitle} single=${single}`);
}
process.exit(ok ? 0 : 1);
