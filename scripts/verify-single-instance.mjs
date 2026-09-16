#!/usr/bin/env node
/**
 * Single-instance regression test — proves the runtime never opens a second
 * independent browser process, whatever the trigger (cold-start + immediate
 * re-run, parallel invocations, `--open` warm-up misuse, `--stop` teardown).
 *
 *   node scripts/verify-single-instance.mjs            # headless (default)
 *   node scripts/verify-single-instance.mjs --visible  # also tests `--open`
 *
 * Counting uses the runtime's own Windows-native enumerator
 * (enumerateOwnBrowserMainProcesses), which matches main processes whose
 * command line carries our --class marker + --user-data-dir=<PROFILE_DIR>.
 *
 * Exits 0 (PASS) or 1 (FAIL). Always leaves the machine browser-clean (--stop).
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
const VISIBLE = process.argv.includes("--visible");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

async function countOwn() {
  const list = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
  return list.length;
}

function runEgo(args, script = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
      // This suite drives the isolated ego profile; force isolated.
      env: { ...process.env, EGO_LINUX_PERSONAL: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(script);
  });
}

// Space names are per-invocation-group: a name whose browser died leaves a
// stale ledger entry, so only the deliberate reuse case (S1 → S1b) shares one.
let spaceSeq = 0;
const nextSpace = () => `si-${process.pid}-${Date.now()}-${++spaceSeq}`;

const navScript = (space) => `
const task = await taskSpace(${JSON.stringify(space)})
const page = task.page('p1')
await page.goto('https://example.com', { timeout: 30000 })
const tabs = await task.tabs()
console.log('TAB_URL=' + tabs.map((t) => t.url).join(','))
`;

const reuseScript = (space) => `
const task = await taskSpace(${JSON.stringify(space)})
console.log('TABS=' + (await task.tabs()).length)
`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== ego-browser single-instance regression ==");
try {
  // Clean slate: stop any browser left from earlier runs.
  await runEgo(["--stop"]);
  await pause(500);

  // S1: cold-start direct-to-page, then immediately re-run (same space: the
  // deliberate reuse case).
  const s1Space = nextSpace();
  const s1 = await runEgo(
    ["--url", "https://example.com", "--headless", "nodejs"],
    navScript(s1Space),
  );
  check("S1 cold-start direct-to-page runs", s1.code === 0, `exit=${s1.code}`);
  // Assert via task.tabs() (the tab's real URL), not page.info(), which can
  // resolve to the harness's CDP anchor (about:blank) right after a cold start.
  check("S1 first window is the page", /TAB_URL=.*https:\/\/example\.com/.test(s1.out), s1.out.trim().split("\n").find((l) => l.startsWith("TAB_URL")) || "no TAB_URL");
  const c1 = await countOwn();
  check("S1 exactly one browser process", c1 === 1, `count=${c1}`);

  const s1b = await runEgo(["--headless", "nodejs"], reuseScript(s1Space));
  check("S1 immediate re-run reuses browser", s1b.code === 0 && /TABS=\d+/.test(s1b.out), `exit=${s1b.code}`);
  const c1b = await countOwn();
  check("S1 still exactly one process after re-run", c1b === 1, `count=${c1b}`);

  // S2: parallel invocations from a clean (stopped) state must not double-launch.
  await runEgo(["--stop"]);
  await pause(500);
  const c0 = await countOwn();
  check("S2 clean state before parallel", c0 === 0, `count=${c0}`);
  const [p1, p2] = await Promise.all([
    runEgo(["--headless", "nodejs"], navScript(nextSpace())),
    runEgo(["--headless", "nodejs"], reuseScript(nextSpace())),
  ]);
  check("S2 parallel run A ok", p1.code === 0, `exit=${p1.code}`);
  check("S2 parallel run B ok", p2.code === 0, `exit=${p2.code}`);
  const c2 = await countOwn();
  check("S2 exactly one process after parallel", c2 === 1, `count=${c2}`);

  // S3 (--visible only): the classic `--open` warm-up then task misuse.
  if (VISIBLE) {
    await runEgo(["--stop"]);
    await pause(500);
    const warm = await runEgo(["--open"]);
    check("S3 --open warm-up ok", warm.code === 0, `exit=${warm.code}`);
    const task = await runEgo(["--url", "https://example.com", "nodejs"], navScript(nextSpace()));
    check("S3 task after warm-up ok", task.code === 0, `exit=${task.code}`);
    const c3 = await countOwn();
    check("S3 still exactly one process (no multi-open)", c3 === 1, `count=${c3}`);
  } else {
    console.log("SKIP  S3 --open warm-up (run with --visible to test it)");
  }

  // S4: --stop must tear down cleanly.
  const stop = await runEgo(["--stop"]);
  await pause(800);
  const c4 = await countOwn();
  check("S4 --stop ok", stop.code === 0, `exit=${stop.code}`);
  check("S4 zero processes after --stop", c4 === 0, `count=${c4}`);

  // S5: cold-start direct-to-page regression after a clean stop.
  const s5 = await runEgo(
    ["--url", "https://example.com", "--headless", "nodejs"],
    navScript(nextSpace()),
  );
  check("S5 cold-start after stop ok", s5.code === 0, `exit=${s5.code}`);
  const c5 = await countOwn();
  check("S5 exactly one process", c5 === 1, `count=${c5}`);
} finally {
  // Always leave the machine clean, even on failure.
  await runEgo(["--stop"]);
}

console.log(
  failures === 0
    ? "PASS: single-instance regression"
    : `FAIL: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
