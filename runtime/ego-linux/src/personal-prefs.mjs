import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PERSONAL_PREFS_FILE, STATE_DIR } from "./paths.mjs";

const FWD = (s) => (s || "").replace(/\\/g, "/");

/**
 * Validate + normalise a user-approved personal-browser prefs object.
 *
 * Paths are normalised to forward slashes (runtime requirement). binary and
 * userDataDir are required; anything else falls back to safe defaults. A
 * caller (the CLI --prefs handler) only ever stores what this returns, so the
 * on-disk file is always in the canonical shape below.
 */
export function normalizePrefs(raw) {
  if (!raw || typeof raw !== "object") return null;
  const binary = typeof raw.binary === "string" ? FWD(raw.binary.trim()) : "";
  const userDataDir =
    typeof raw.userDataDir === "string" ? FWD(raw.userDataDir.trim()) : "";
  if (!binary || !userDataDir) return null;
  const debugPort =
    Number.isInteger(raw.debugPort) && raw.debugPort > 0 ? raw.debugPort : 9222;
  const flags = Array.isArray(raw.flags) ? raw.flags.map(String) : [];
  return {
    binary,
    userDataDir,
    debugPort,
    flags,
    confirmedAt: new Date().toISOString(),
    source: "user-confirmed",
  };
}

/** Read the archived prefs; a missing or unparsable file reads as none. */
export async function loadPrefs() {
  try {
    return normalizePrefs(JSON.parse(await readFile(PERSONAL_PREFS_FILE, "utf8")));
  } catch {
    return null;
  }
}

/** Persist user-approved prefs (must be created through normalizePrefs). */
export async function savePrefs(prefs) {
  const clean = normalizePrefs(prefs);
  if (!clean) {
    throw new Error("invalid prefs: binary and userDataDir are required");
  }
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PERSONAL_PREFS_FILE, JSON.stringify(clean, null, 2));
}

export async function clearPrefs() {
  await rm(PERSONAL_PREFS_FILE, { force: true });
}

/**
 * Does a process command line belong to a browser running against
 * `userDataDir`? Used for takeover identity checks so we never attach to a
 * stranger's Chrome squatting on our debug port.
 *
 * Both sides are lower-cased and slash-normalised; the --user-data-dir value is
 * compared exactly, tolerating an optional surrounding quote.
 */
export function profileMatches(cmdline, userDataDir) {
  if (typeof cmdline !== "string" || typeof userDataDir !== "string") {
    return false;
  }
  const cl = FWD(cmdline).toLowerCase();
  const ud = FWD(userDataDir).toLowerCase();
  const flag = "--user-data-dir=";
  const idx = cl.indexOf(flag);
  if (idx < 0) return false;
  let rest = cl.slice(idx + flag.length);
  if (rest.startsWith('"')) rest = rest.slice(1);
  const value = rest.split(/["\s]/)[0] || "";
  return value === ud;
}
