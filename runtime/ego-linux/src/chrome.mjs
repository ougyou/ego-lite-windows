import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { BROWSER_STATE_FILE, PERSONAL_STATE_FILE, PROFILE_DIR, STATE_DIR } from "./paths.mjs";
import { loadPrefs, profileMatches } from "./personal-prefs.mjs";

const BINARY_CANDIDATES = [
  process.env.EGO_LINUX_CHROME,
  ...windowsBrowserCandidates(),
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
].filter(Boolean);

/**
 * Standard Windows install paths (forward slashes so resolveBinary() treats
 * them as absolute). Harmless no-ops on POSIX — the paths just never exist.
 * Keeps the runtime itself usable on Windows even without the launcher.
 */
function windowsBrowserCandidates() {
  if (process.platform !== "win32") return [];
  const pf = process.env.ProgramFiles || "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const local = process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA.replace(/\\/g, "/")
    : "";
  return [
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Google/Chrome/Application/chrome.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    `${pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    `${pf86}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    local && `${local}/BraveSoftware/Brave-Browser/Application/brave.exe`,
  ].filter(Boolean);
}

// Chrome writes the negotiated port here once the DevTools endpoint is live.
const PORT_FILE = "DevToolsActivePort";

// Shared by the launch args and the orphan reaper that reads them back out of
// /proc — if the two spellings drifted, the reaper would match nothing.
const PROFILE_FLAG = "--user-data-dir=";

/** Window class shared with the desktop entry's StartupWMClass. */
export const WM_CLASS = "ego-lite-linux";

/** Shown in Chrome's profile chip so the agent window is identifiable. */
const PROFILE_LABEL = "ego lite — agent";

/**
 * Default CDP debugging port. Fixed (instead of Chrome's random port 0) so the
 * port is predictable and recoverable from the process command line even when
 * state files go stale. Override with EGO_LINUX_DEBUG_PORT. If the default is
 * taken by something else we pick a nearby free port; only if all are busy do
 * we fall back to 0 (Chrome chooses).
 */
const DEFAULT_DEBUG_PORT = 9222;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickDebugPort() {
  const envPort = Number(process.env.EGO_LINUX_DEBUG_PORT);
  const base =
    Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_DEBUG_PORT;
  for (let port = base; port < base + 50; port++) {
    if (await isPortFree(port)) return port;
  }
  return 0; // let Chrome choose
}

const LAUNCH_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  // Node's WebSocket sends no Origin; without this Chrome rejects the upgrade.
  "--remote-allow-origins=*",
  // Big enough that a page laid out for a desktop viewport fits. The default
  // headless window is ~800x600, which pushes lower page content out of view;
  // input dispatched at those coordinates hit-tests to nothing and
  // Input.dispatchMouseEvent can hang waiting for a frame that never comes.
  "--window-size=1280,900",
  // Without this the desktop's HiDPI scaling (1.5x here) shrinks the CSS
  // viewport — a 1280px window lays out as 853px — so page content the agent
  // expects on screen falls below the fold.
  "--force-device-scale-factor=1",
  // "Chrome didn't shut down correctly — Restore pages?". Two things keep it
  // away, covering different halves: the graceful Browser.close in stopBrowser()
  // stops the profile *earning* the mark, and clearStaleCrashMark() clears a
  // mark it already carries, which a clean exit alone never does. This flag is
  // the backstop for what neither covers — a browser killed by something outside
  // this launcher, between one launch's clear and the next.
  "--hide-crash-restore-bubble",
  // Give the agent browser its own window class. Without it the window carries
  // Chrome's, so the desktop groups it under the ordinary Chrome icon: it never
  // appears as its own running app and the launcher icon cannot raise it.
  // Paired with StartupWMClass in the desktop entry.
  `--class=${WM_CLASS}`,
];

/**
 * Is this directory *provably* absent?
 *
 * exists() answers "could I stat it", collapsing every failure into false —
 * fine for picking a browser binary, dangerous for deciding whether to kill a
 * process. A transient ESTALE on NFS, an EIO, or a FUSE timeout would read as
 * "profile deleted" and take a live browser down with it. Only ENOENT is
 * evidence of absence; every other error means "assume it is there".
 */
async function definitelyGone(path) {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary() {
  for (const candidate of BINARY_CANDIDATES) {
    if (candidate.includes("/")) {
      if (await exists(candidate)) return candidate;
      continue;
    }
    const found = await which(candidate);
    if (found) return found;
  }
  throw new Error(
    `no Chrome/Chromium binary found (tried: ${BINARY_CANDIDATES.join(", ")}). ` +
      `Set EGO_LINUX_CHROME to an absolute path.`,
  );
}

function which(name) {
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** Ask a running DevTools endpoint for its browser-level WebSocket URL. */
async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const info = await response.json();
    return info.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function readBrowserState() {
  try {
    return JSON.parse(await readFile(BROWSER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeBrowserState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(BROWSER_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Poll for a DevTools endpoint that answers.
 *
 * The port file appears a beat after the process starts, and Chrome does not
 * necessarily write it once: a launch that loses the ProcessSingleton race is
 * restarted internally, and the process that survives publishes a different
 * port. Probing whatever the file said first therefore names a port that never
 * listens — so re-read it on every attempt and keep probing until one answers.
 */
export async function waitForEndpoint(profileDir, { timeoutMs = 20000 } = {}) {
  const path = join(profileDir, PORT_FILE);
  const deadline = Date.now() + timeoutMs;
  let lastPort = null;
  while (Date.now() < deadline) {
    let port = null;
    try {
      const [line] = (await readFile(path, "utf8")).split("\n");
      port = Number(line.trim()) || null;
    } catch {
      // not written yet
    }
    if (port) {
      lastPort = port;
      const wsUrl = await probe(port);
      if (wsUrl) return { port, wsUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    lastPort
      ? `Chrome came up on port ${lastPort} but exposed no WebSocket URL within ${timeoutMs}ms`
      : `Chrome did not expose a DevTools port within ${timeoutMs}ms`,
  );
}

/**
 * Poll a known fixed debugging port until its DevTools endpoint answers AND a
 * browser-level WebSocket can actually open.
 *
 * With a fixed `--remote-debugging-port` Chrome does not reliably write the
 * DevToolsActivePort file the way `--remote-debugging-port=0` does (observed on
 * Chrome 151/headless), so the port is already known — probe it directly. But
 * /json/version being reachable is not enough: the browser-level ws endpoint can
 * lag the HTTP endpoint by a beat, and connecting to it too early hangs the
 * first CDP socket (and Chrome then refuses retries). So we open — and close —
 * a probe connection before declaring the endpoint ready.
 */
async function waitForPortReady(port, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wsUrl = await probe(port);
    if (wsUrl) {
      // The browser-level ws endpoint can lag the HTTP /json/version by a beat;
      // give it a moment so the very first CDP socket connects instead of
      // hanging (a hanging first socket then makes Chrome refuse retries).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { port, wsUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Chrome did not expose a DevTools port ${port} within ${timeoutMs}ms`,
  );
}

/**
 * Recover a live instance's DevTools endpoint. Tries Chrome's DevToolsActivePort
 * file first (always written), then the process command line's
 * `--remote-debugging-port=` flag — so a stale or missing port file never
 * strands a live browser (fixed-port recovery).
 */
async function recoverLiveEndpoint(live, timeoutMs) {
  try {
    const { port, wsUrl } = await waitForEndpoint(PROFILE_DIR, { timeoutMs });
    return { port, wsUrl };
  } catch {
    // fall through to the command-line port
  }
  for (const p of live) {
    const m = p.cmdline.match(/--remote-debugging-port=(\d+)/);
    if (!m) continue;
    const port = Number(m[1]);
    const wsUrl = await probe(port);
    if (wsUrl) return { port, wsUrl };
  }
  return null;
}

/**
 * Reset page zoom in the agent profile.
 *
 * --import-chrome-profile copies real Chrome preferences, which include the
 * user's zoom level. A 150% zoom lays a 1280px window out as 853 CSS px, so
 * content the page expects on screen falls below the fold — element coordinates
 * then hit-test to nothing and pointer input silently does nothing. This profile
 * exists only to drive agents, so zoom is pinned to 100%.
 */
async function neutralizeZoom(profileDir) {
  const path = join(profileDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(path, "utf8"));
    let changed = false;
    for (const scope of ["partition", "profile"]) {
      for (const key of ["default_zoom_level", "per_host_zoom_levels"]) {
        if (prefs[scope]?.[key] && Object.keys(prefs[scope][key]).length > 0) {
          prefs[scope][key] = {};
          changed = true;
        }
      }
    }
    // --import-chrome-profile clones the user's real profile, so the agent
    // browser ends up looking exactly like their everyday Chrome — same
    // bookmarks, same theme, no way to tell which window an agent is driving.
    // Naming the profile puts a label in Chrome's own toolbar chip.
    if (prefs.profile?.name !== PROFILE_LABEL) {
      prefs.profile = { ...prefs.profile, name: PROFILE_LABEL };
      changed = true;
    }
    if (changed) await writeFile(path, JSON.stringify(prefs));
    return changed;
  } catch {
    // A fresh profile has no Preferences file yet; nothing to reset.
    return false;
  }
}

/**
 * Clear a stale crash mark before launching.
 *
 * Chrome stamps `profile.exit_type` "Crashed" while it runs and rewrites it to
 * "Normal" on a graceful exit — but only if it did not *start* out marked. Once
 * a profile carries the mark, Chrome keeps it until someone answers the
 * "Restore pages?" prompt, and in an agent browser nobody ever does. So a single
 * ungraceful kill marks a profile permanently: every later launch opens with the
 * prompt, and even a clean Browser.close leaves the mark exactly where it was.
 *
 * Established by bisecting a marked profile's Preferences against a fresh one,
 * top-level keys first and then within `profile`, down to this single key: seed
 * "Crashed" and the next clean stop still reads "Crashed"; seed anything else
 * and it reads "Normal".
 *
 * The mark exists to protect a human's tabs. This profile has none worth
 * restoring — the agent opens what it needs — so clearing it costs nothing.
 */
export async function clearStaleCrashMark(profileDir) {
  const path = join(profileDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(path, "utf8"));
    if (!prefs.profile || prefs.profile.exit_type === "Normal") return false;
    prefs.profile = { ...prefs.profile, exit_type: "Normal" };
    await writeFile(path, JSON.stringify(prefs));
    return true;
  } catch {
    // A fresh profile has no Preferences file yet; nothing to clear.
    return false;
  }
}

/** Whether a pid is a browser running against our own profile directory. */
async function ownsOurProfile(pid, profileDir) {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(profileDir);
  } catch {
    return false;
  }
}

/**
 * Terminate ego browsers whose profile directory no longer exists.
 *
 * A harness that points EGO_LINUX_PROFILE (or XDG_DATA_HOME) at a scratch tree
 * gets a browser of its own, and browsers are spawned detached so they outlive
 * whatever started them. A harness that deletes its scratch tree without
 * stopping its browser first leaves that browser running against a profile
 * nobody can reach: ensureBrowser() tracks one browser per state file, so the
 * orphan is invisible to it and simply accumulates — hundreds of MB per stale
 * run, for as long as the machine stays up.
 *
 * A missing profile directory is the unambiguous signal. Chrome cannot function
 * without it, so such a browser is already dead weight rather than someone's
 * live session. Our own profile is created before this runs, which keeps the
 * browser we are about to launch — and any other live one — out of scope.
 *
 * @returns {Promise<number>} How many orphans were signalled.
 */
export async function reapOrphanedBrowsers() {
  if (process.platform === "win32") {
    return reapOrphanedBrowsersWindows();
  }

  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return 0; // no procfs to walk; nothing to reap
  }

  let reaped = 0;
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (pid) => {
        let argv;
        try {
          argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        } catch {
          return; // exited under us, or another user's process
        }
        // Renderers and helpers inherit --user-data-dir but carry --type=;
        // signalling the browser process takes its children with it anyway.
        if (!argv.includes(`--class=${WM_CLASS}`)) return;
        if (argv.some((arg) => arg.startsWith("--type="))) return;

        const flag = argv.find((arg) => arg.startsWith(PROFILE_FLAG));
        if (!flag) return;
        const profileDir = flag.slice(PROFILE_FLAG.length);
        if (profileDir === PROFILE_DIR) return;
        if (!(await definitelyGone(profileDir))) return;

        try {
          process.kill(Number(pid), "SIGTERM");
          reaped += 1;
        } catch {
          // already gone, or not ours to signal
        }
      }),
  );
  return reaped;
}

/**
 * Windows orphan reaper — there is no /proc to walk, so enumerate our-class main
 * processes via CIM and terminate any whose profile directory no longer exists.
 */
async function reapOrphanedBrowsersWindows() {
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--user-data-dir=' -and $_.CommandLine -match '--class=ego-lite-linux' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0) return 0;
    const parsed = JSON.parse(r.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const flag = "--user-data-dir=";
    let reaped = 0;
    for (const p of list) {
      if (!p || typeof p.CommandLine !== "string") continue;
      const idx = p.CommandLine.indexOf(flag);
      if (idx < 0) continue;
      const profileDir = p.CommandLine
        .slice(idx + flag.length)
        .split(/["\s]/)[0]
        .replace(/\\/g, "/");
      if (!profileDir) continue;
      if (profileDir.toLowerCase() === PROFILE_DIR.toLowerCase()) continue;
      if (!(await definitelyGone(profileDir))) continue;
      if (await terminateTree(Number(p.ProcessId), profileDir)) reaped += 1;
    }
    return reaped;
  } catch {
    return 0;
  }
}

/**
 * Clear the profile lock before launching.
 *
 * Chrome's SingletonLock is a symlink named `<host>-<pid>`; a browser that dies
 * without a clean shutdown leaves it behind, and the next launch refuses to
 * start ("Failed to create a ProcessSingleton ... Aborting now").
 *
 * launch() only runs after ensureBrowser() has confirmed no DevTools endpoint
 * answers, so a lock owner that is still alive is an unreachable orphan of ours
 * — a browser we can no longer drive. Since this profile is single-purpose,
 * that orphan is terminated rather than left to block every future run.
 */
async function clearProfileLock(profileDir) {
  const lock = join(profileDir, "SingletonLock");
  let target = null;
  try {
    target = await readlink(lock);
  } catch {
    // Not a symlink (or no lock at all) — fall through to the guards below so a
    // live instance's plain-file locks are never touched either.
  }

  let pid = NaN;
  if (typeof target === "string") {
    pid = Number(target.slice(target.lastIndexOf("-") + 1));
  }

  if (Number.isFinite(pid) && pid > 0) {
    if (await lockOwnerIsAliveOurs(pid, profileDir)) {
      if (process.platform === "win32") {
        // Deleting a live instance's lock files breaks the ProcessSingleton
        // hand-off and lets a second independent Chrome start on the same
        // profile — the multi-browser bug. Never touch them.
        return false;
      }
      // POSIX: a live lock owner is an unreachable orphan of ours. The profile
      // is single-purpose, so terminate it rather than let it block every run.
      try {
        process.kill(pid, "SIGTERM");
        // Give it a moment to release the lock on its own.
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch {
        // already gone
      }
    }
  } else if (
    process.platform === "win32" &&
    (await enumerateOwnBrowserMainProcesses(profileDir)).length > 0
  ) {
    // Couldn't parse the lock, but a live instance is present — leave it alone.
    return false;
  }

  // Owner is dead or absent — safe to clear stale lock files.
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
      rm(join(profileDir, name), { force: true }),
    ),
  );
  return true;
}

/** Is `pid` a live main browser process of ours running against `profileDir`? */
async function lockOwnerIsAliveOurs(pid, profileDir) {
  if (process.platform === "win32") {
    const live = await enumerateOwnBrowserMainProcesses(profileDir);
    return live.some((p) => p.pid === pid);
  }
  return Number.isFinite(pid) && pid > 0 && (await ownsOurProfile(pid, profileDir));
}

async function launch({ headless }) {
  // Never launch into a profile a live browser already owns. ensureBrowser()
  // normally prevents this, but every entry point has to be safe on its own:
  // spawning a second instance over a live one is exactly the multi-browser bug.
  const liveNow = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
  if (liveNow.length > 0) {
    try {
      const { port, wsUrl } = await waitForEndpoint(PROFILE_DIR, { timeoutMs: 20000 });
      return { port, wsUrl, launched: false };
    } catch {
      throw new Error(
        "refusing to launch a second browser: a live instance owns the profile; run `ego-browser --stop` to clear it",
      );
    }
  }

  const binary = await resolveBinary();
  await mkdir(PROFILE_DIR, { recursive: true });
  // Ours now exists, so it cannot be mistaken for an orphan below.
  await reapOrphanedBrowsers();
  await neutralizeZoom(PROFILE_DIR);
  await clearStaleCrashMark(PROFILE_DIR);
  await clearProfileLock(PROFILE_DIR);
  // A stale port file would be read as this launch's port.
  await rm(join(PROFILE_DIR, PORT_FILE), { force: true });

  const debugPort = await pickDebugPort();
  const args = [
    ...LAUNCH_FLAGS,
    `${PROFILE_FLAG}${PROFILE_DIR}`,
    `--remote-debugging-port=${debugPort}`,
    ...(headless ? ["--headless=new"] : []),
    // Optional HTTP proxy for the agent browser, e.g. EGO_LINUX_PROXY=http://host:7890
    // (WSL2 -> Windows Clash). Explicit flags are used instead of relying on
    // http_proxy env propagation: the CLI's own fetch/CDP traffic must never go
    // through the proxy, and loopback/private ranges are always bypassed so CDP
    // and local test pages keep working.
    ...(process.env.EGO_LINUX_PROXY
      ? [
          `--proxy-server=${process.env.EGO_LINUX_PROXY}`,
          "--proxy-bypass-list=<-loopback>;127.0.0.1;localhost;[::1];172.16.0.0/12;10.0.0.0/8;*.local",
        ]
      : []),
    // The harness attaches its CDP session to the active tab and fails with
    // "no active tab to attach session" when there is none, so the browser has
    // to come up holding one. --no-startup-window was tried here and breaks
    // every page operation for that reason.
    //
    // EGO_LINUX_START_URL: first-run direct-to-page. A cold start usually shows
    // an about:blank window that then gets navigated; when the caller asked for
    // a target page up front (`ego-browser --url <url>`), the startup tab IS
    // that page — so the very first window is already the page, no blank one.
    process.env.EGO_LINUX_START_URL || "about:blank",
  ];
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Fixed port: probe it directly (Chrome doesn't write DevToolsActivePort for
  // a fixed port on this Chrome build). Port 0 fallback still reads the file.
  const { port, wsUrl } =
    debugPort > 0
      ? await waitForPortReady(debugPort)
      : await waitForEndpoint(PROFILE_DIR);
  await writeBrowserState({
    port,
    wsUrl,
    pid: child.pid,
    binary,
    headless,
    profileDir: PROFILE_DIR,
  });
  return { port, wsUrl, launched: true };
}

/**
 * Return a live browser-level CDP endpoint, reusing the browser this machine
 * already has open when possible. Each heredoc runs in its own short-lived Node
 * process, so the browser — not this process — is what has to persist.
 */
export async function ensureBrowser({ headless = false } = {}) {
  if (process.env.EGO_LINUX_CDP_URL) {
    return { wsUrl: process.env.EGO_LINUX_CDP_URL, launched: false };
  }

  const state = await readBrowserState();
  if (state?.port) {
    const wsUrl = await probe(state.port);
    if (wsUrl) return { port: state.port, wsUrl, launched: false };
  }

  // Windows: a live process owning our profile IS the single instance. Never
  // launch a second one over it — wait for it to become reachable, then reuse.
  const live = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
  if (live.length > 0) {
    const recovered = await recoverLiveEndpoint(live, 20000);
    if (recovered) {
      return { port: recovered.port, wsUrl: recovered.wsUrl, launched: false };
    }
    throw new Error(
      "the backing browser is running but not reachable via DevTools; run `ego-browser --stop` to clear it",
    );
  }

  // No live instance: launch is the only way forward, guarded by a cross-process
  // mutex so two parallel invocations cannot both spawn a browser.
  return withLaunchLock(async () => {
    // Re-check inside the lock — another process may have launched meanwhile.
    const state2 = await readBrowserState();
    if (state2?.port) {
      const wsUrl = await probe(state2.port);
      if (wsUrl) return { port: state2.port, wsUrl, launched: false };
    }
    return launch({ headless });
  });
}

// --- Cross-process launch mutex ---------------------------------------------
// Each heredoc runs in its own short-lived Node process, so the "is a browser
// running?" decision is not atomic across processes. Two parallel invocations
// can both conclude "none running" and both spawn. The mutex serializes the
// launch: the winner spawns, everyone else waits for its browser.json and reuses.

const LAUNCH_LOCK = join(STATE_DIR, "launch.lock");

async function acquireLaunchLock() {
  await mkdir(STATE_DIR, { recursive: true });
  for (;;) {
    try {
      // Atomic create + write: with flag "wx" the file appears already holding
      // our pid, so no other process can read an empty lock and think it stale.
      await writeFile(
        LAUNCH_LOCK,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        { flag: "wx" },
      );
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EISDIR") throw error;
      // Someone holds the lock. Stale only if its recorded pid is gone; give a
      // slow writer a moment (mid-write windows read as unparsable) before
      // judging it stale, so a reclaim can never race a live launcher.
      let stale = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          const { pid } = JSON.parse(await readFile(LAUNCH_LOCK, "utf8"));
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              return false; // live owner — do not launch
            } catch {
              stale = true; // owner exited
              break;
            }
          } else {
            stale = true;
            break;
          }
        } catch {
          // unreadable / still being written — retry
        }
      }
      if (stale) {
        await rm(LAUNCH_LOCK, { force: true });
        continue; // reclaim and retry
      }
      return false;
    }
  }
}

async function releaseLaunchLock() {
  await rm(LAUNCH_LOCK, { force: true }).catch(() => {});
}

async function withLaunchLock(fn) {
  const acquired = await acquireLaunchLock();
  if (!acquired) {
    // Another process is launching. Wait for it to write browser.json, then
    // reuse its browser instead of starting a second one.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await readBrowserState();
      if (state?.port) {
        const wsUrl = await probe(state.port);
        if (wsUrl) return { port: state.port, wsUrl, launched: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      "another process is launching the browser and it did not become ready",
    );
  }
  try {
    return await fn();
  } finally {
    await releaseLaunchLock();
  }
}

/**
 * Ask the browser to close itself, over CDP.
 *
 * SIGTERM is recorded by Chrome as a crash: the profile keeps `exit_type:
 * "Crashed"`, and every later launch greets the user with "Chrome didn't shut
 * down correctly — Restore pages?". Browser.close is the graceful path, so the
 * profile records a clean exit and there is nothing left to restore.
 */
async function closeBrowserGracefully(port, timeoutMs = 5000) {
  const wsUrl = await probe(port);
  if (!wsUrl) return false;

  return new Promise((resolve) => {
    let socket = null;
    let sent = false;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closing
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish(false);
      return;
    }
    socket.onopen = () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    };
    // Chrome answers and then drops the socket as it goes away; whichever lands
    // first means the request was taken. A close *before* the request went out
    // is a failed connection, not a shutdown.
    socket.onmessage = () => finish(true);
    socket.onclose = () => finish(sent);
    socket.onerror = () => finish(false);
  });
}

/** Wait for a pid to disappear — a browser still exiting still holds the profile lock. */
async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Windows: does the given pid's command line point at our profile directory?
 *
 * Guards the blunt kill against a reused pid (state files go stale, pids get
 * recycled) so we never take down an unrelated browser process.
 */
/**
 * Windows: enumerate our own main browser processes running against a profile.
 *
 * The Linux port's liveness checks read /proc — a filesystem Windows does not
 * have. Command-line matching here mirrors that logic: a process is "ours" when
 * its command line carries our --class marker and a --user-data-dir= flag (the
 * flag Chrome namespaces the profile by), and it is a main browser process
 * rather than a renderer/helper (which add --type=). Returns [] on POSIX, where
 * the original /proc-based paths still apply.
 */
export async function enumerateOwnBrowserMainProcesses(profileDir) {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--user-data-dir=' -and $_.CommandLine -match '--class=ego-lite-linux' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0) return [];
    const parsed = JSON.parse(r.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const dir = profileDir.replace(/\\/g, "/").toLowerCase();
    return list
      .filter((p) => p && typeof p.CommandLine === "string")
      .filter((p) => p.CommandLine.toLowerCase().replace(/\\/g, "/").includes(dir))
      .map((p) => ({ pid: Number(p.ProcessId), cmdline: p.CommandLine }));
  } catch {
    return [];
  }
}

async function ownsOurProfileOnWindows(pid, profileDir) {
  const live = await enumerateOwnBrowserMainProcesses(profileDir);
  return live.some((p) => p.pid === Number(pid));
}

/**
 * Terminate the browser process tree (children included).
 *
 * On POSIX the browser's own SIGTERM handling pulls its children down, so
 * signalling the recorded pid is enough. On Windows process.kill(SIGTERM)
 * terminates only that one process and can silently fail, leaving renderers
 * and helpers holding the profile lock — so use taskkill /T /F, guarded by a
 * command-line check that the pid really belongs to our profile.
 */
async function terminateTree(pid, profileDir) {
  if (process.platform === "win32") {
    if (!(await ownsOurProfileOnWindows(pid, profileDir))) return false;
    try {
      const r = spawnSync(
        "taskkill",
        ["/PID", String(Number(pid)), "/T", "/F"],
        { stdio: "ignore", timeout: 10_000, windowsHide: true },
      );
      return r.status === 0;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Terminate the backing browser and forget it. */
export async function stopBrowser() {
  const state = await readBrowserState();
  let stopped = false;

  if (state?.port) stopped = await closeBrowserGracefully(state.port);
  // Answering the request is not the same as acting on it. A browser that
  // stayed up has to be signalled anyway — otherwise --stop removes the state
  // file that is the only handle on it and leaves it running, unreachable.
  if (stopped && state?.pid && !(await waitForProcessExit(state.pid))) stopped = false;

  // The blunt instrument, only when the browser did not take the polite request.
  // On Windows process.kill(SIGTERM) would leave the child tree behind, so use
  // terminateTree() which kills the whole tree (and verifies the pid is ours).
  if (!stopped && state?.pid) {
    stopped = await terminateTree(state.pid, PROFILE_DIR);
  }

  await rm(BROWSER_STATE_FILE, { force: true });
  // A SIGTERMed Chrome does not always release its profile lock, which would
  // block the next launch. After a graceful close there is nothing left to
  // clear, and this is a no-op.
  await clearProfileLock(PROFILE_DIR);
  return stopped;
}

export async function browserStatus() {
  const state = await readBrowserState();
  if (state?.port) {
    const wsUrl = await probe(state.port);
    if (wsUrl) return { running: true, ...state, wsUrl };
  }
  // The recorded port did not answer. On Windows the probe is not proof the
  // browser is gone — a cold start can outrun the 1.5s probe, and browser.json
  // can go stale. A live process owning our profile is authoritative: if one is
  // there the browser is running (recover its endpoint if it answers), and it
  // must never be reported dead or launched over.
  const live = await enumerateOwnBrowserMainProcesses(PROFILE_DIR);
  if (live.length > 0) {
    const recovered = await recoverLiveEndpoint(live, 4000);
    if (recovered) {
      return {
        running: true,
        ...state,
        port: recovered.port,
        wsUrl: recovered.wsUrl,
        recovered: true,
      };
    }
    return { running: true, ...state, endpointUnknown: true, pid: live[0].pid };
  }
  return { running: false, ...state };
}

// --- Personal takeover mode -------------------------------------------------
// Default mode: drive the user's own workspace-profile Chrome (attached if it
// is already running, launched per the archived personal-browser.json if not).
// The isolated ego-profile behaviour stays reachable via EGO_LINUX_PERSONAL=0
// (the CLI's --isolated), and EGO_LINUX_CDP_URL still forces a direct attach.

/**
 * Is personal mode enabled? Defaults to on; EGO_LINUX_PERSONAL=0/false/no turns
 * it off (the CLI sets this when --isolated is given).
 */
function personalEnabled() {
  const v = (process.env.EGO_LINUX_PERSONAL ?? "").toLowerCase();
  return !["0", "false", "no"].includes(v);
}

/**
 * Pure filter over a CIM row list (Win32_Process JSON): keep main browser
 * processes listening on `port`, optionally restricted to `userDataDir`.
 * Exported separately from the CIM call so it is unit-testable without a
 * running PowerShell.
 *
 * @param {Array<{ProcessId:number,CommandLine:string}>} rows
 * @returns {Array<{pid:number, cmdline:string}>}
 */
export function parseWinCimChrome(rows, { port, userDataDir } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((p) => p && typeof p.CommandLine === "string")
    .filter((p) => p.CommandLine.includes(`--remote-debugging-port=${port}`))
    .filter((p) => !p.CommandLine.match(/(?:^|\s)--type=/))
    .filter((p) =>
      userDataDir ? profileMatches(p.CommandLine, userDataDir) : true,
    )
    .map((p) => ({ pid: Number(p.ProcessId), cmdline: p.CommandLine }));
}

/** Main Chrome processes currently listening on `port` (Windows only). */
export async function findChromeMainOnPort(port) {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (r.status !== 0) return [];
    const parsed = JSON.parse(r.stdout || "[]");
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return parseWinCimChrome(rows, { port });
  } catch {
    return [];
  }
}

/** Report the personal-mode situation without touching any browser. */
export async function personalStatus() {
  const prefs = await loadPrefs();
  if (!prefs) {
    return {
      prefsExists: false,
      debugPort: null,
      running: false,
      ours: false,
      attachable: false,
      reason: "no-prefs",
    };
  }
  const wsUrl = await probe(prefs.debugPort);
  if (!wsUrl) {
    return {
      prefsExists: true,
      debugPort: prefs.debugPort,
      running: false,
      ours: false,
      attachable: false,
    };
  }
  const hit = await findChromeMainOnPort(prefs.debugPort);
  const mine = hit.find((p) => profileMatches(p.cmdline, prefs.userDataDir));
  if (mine) {
    return {
      prefsExists: true,
      debugPort: prefs.debugPort,
      running: true,
      ours: false,
      attachable: true,
    };
  }
  return {
    prefsExists: true,
    debugPort: prefs.debugPort,
    running: true,
    ours: false,
    attachable: false,
    reason: "port-owned-by-other-profile",
  };
}

/**
 * Launch the user's workspace Chrome from the archived prefs and wait for its
 * DevTools endpoint. Records ownership in PERSONAL_STATE_FILE so --stop knows
 * this instance was started by ego and may be closed gracefully.
 */
async function launchPersonal(prefs, { startUrl = null, headless = false } = {}) {
  const args = [
    ...prefs.flags,
    `--user-data-dir=${prefs.userDataDir}`,
    `--remote-debugging-port=${prefs.debugPort}`,
    ...(headless ? ["--headless=new"] : []),
    startUrl || "about:blank",
  ];
  const child = spawn(prefs.binary, args, { detached: true, stdio: "ignore" });
  child.unref();
  const { port, wsUrl } = await waitForPortReady(prefs.debugPort);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    PERSONAL_STATE_FILE,
    JSON.stringify(
      {
        port,
        pid: child.pid,
        binary: prefs.binary,
        userDataDir: prefs.userDataDir,
        startedByEgo: true,
      },
      null,
      2,
    ),
  );
  return { wsUrl, port, launched: true, owned: true, mode: "personal" };
}

/**
 * The single backing-browser resolver used by every personal-mode entry.
 *
 * Returns a live CDP endpoint, reusing the user's already-running workspace
 * Chrome when one is there (identity-checked), launching it per the archived
 * prefs when not, or falling back to the isolated ego-profile behaviour when
 * personal mode is disabled.
 */
export async function resolveBackingBrowser({
  headless = false,
  startUrl = null,
} = {}) {
  if (process.env.EGO_LINUX_CDP_URL) {
    return {
      wsUrl: process.env.EGO_LINUX_CDP_URL,
      port: null,
      launched: false,
      owned: false,
      mode: "personal",
    };
  }
  if (!personalEnabled()) {
    const r = await ensureBrowser({ headless });
    return { ...r, owned: true, mode: "isolated" };
  }
  const prefs = await loadPrefs();
  if (!prefs) {
    const err = new Error(
      "no personal-browser.json; run `ego-browser --prefs <json>` (ask the user first)",
    );
    err.code = "NO_PREFS";
    throw err;
  }
  const wsUrl = await probe(prefs.debugPort);
  if (wsUrl) {
    const hit = await findChromeMainOnPort(prefs.debugPort);
    const mine = hit.find((p) => profileMatches(p.cmdline, prefs.userDataDir));
    if (!mine) {
      throw new Error(
        `port ${prefs.debugPort} is owned by another Chrome/profile; refusing to attach (identity check failed)`,
      );
    }
    return {
      wsUrl,
      port: prefs.debugPort,
      launched: false,
      owned: false,
      mode: "personal",
    };
  }
  return launchPersonal(prefs, { startUrl, headless });
}

/**
 * Gracefully close a personal-mode browser that ego itself launched. An
 * externally-started (attached-only) instance is never touched here.
 */
export async function stopPersonalBrowser() {
  try {
    const state = JSON.parse(await readFile(PERSONAL_STATE_FILE, "utf8"));
    if (!state?.startedByEgo) return { stopped: false, detached: true };
    const ok = await closeBrowserGracefully(state.port);
    await rm(PERSONAL_STATE_FILE, { force: true });
    return { stopped: ok, detached: false };
  } catch {
    return { stopped: false, detached: false };
  }
}
