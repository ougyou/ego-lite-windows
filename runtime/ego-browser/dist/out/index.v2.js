#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, writeSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute, relative, sep } from 'node:path';
import { writeFile, mkdir, rm, copyFile, readdir, readFile, stat, rename } from 'node:fs/promises';
import { loadEnvFile as loadEnvFile$1, stdout, stderr, stdin } from 'node:process';
import { inspect } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as setTimeout$1 } from 'node:timers/promises';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "..");
function agentWorkspace() {
    if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
        return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
    }
    const bundledSkill = resolve(SRC_DIR, "ego-browser");
    if (existsSync(bundledSkill)) {
        return bundledSkill;
    }
    return resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
}
function resolvePath(path) {
    if (path.startsWith("~")) {
        return resolve(process.env.HOME || process.env.USERPROFILE || ".", path.slice(1));
    }
    return resolve(path);
}
function loadEnvFile(path) {
    if (!existsSync(path)) {
        return;
    }
    loadEnvFile$1(path);
}
function loadEnv() {
    loadEnvFile(resolve(REPO_ROOT, ".env"));
    loadEnvFile(resolve(agentWorkspace(), ".env"));
}

loadEnv();
const NAME = process.env.EGO_BROWSER_NAME || "default";
const state = {
    cdpOverride: null,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform: process.platform,
    agentWorkspace: () => agentWorkspace(),
    writeFile,
    preferredTargetId: null,
    // Last observed Network domain state on the default session (tracked in cdp()).
    networkDomainEnabled: false,
};
function setOverrides(overrides) {
    const previous = { ...state };
    Object.assign(state, overrides);
    return () => {
        Object.assign(state, previous);
    };
}

function formatCliLogValue(value) {
    if (typeof value === "string") {
        return value;
    }
    return inspect(value, {
        depth: 6,
        breakLength: Infinity,
        compact: true,
    });
}

const pendingPageNotices = new Map();
const observedPages = new Set();
const pageNoticeListeners = new Set();
/** Record or refresh one discovered Page that Agent code has not used yet. */
function recordUnhandledPage(notice) {
    const key = pageKey(notice.spaceId, notice.targetId);
    if (observedPages.has(key))
        return;
    const merged = {
        ...pendingPageNotices.get(key),
        ...notice,
    };
    pendingPageNotices.set(key, merged);
    for (const listener of [...pageNoticeListeners])
        listener(merged);
}
/** Refresh the URL of an already-discovered Page without creating a new notice. */
function refreshUnhandledPageNotice(spaceId, targetId, url) {
    const key = pageKey(spaceId, targetId);
    const existing = pendingPageNotices.get(key);
    if (!existing)
        return;
    recordUnhandledPage({ ...existing, url });
}
/** Mark a Page as used during this round so it needs no further guidance. */
function markPageObserved(spaceId, targetId) {
    const key = pageKey(spaceId, targetId);
    observedPages.add(key);
    pendingPageNotices.delete(key);
}
/** Remove round state for a Page that no longer exists. */
function forgetPageNotice(spaceId, targetId) {
    const key = pageKey(spaceId, targetId);
    pendingPageNotices.delete(key);
    observedPages.delete(key);
}
/** Remove pending Page state when its task space reaches a terminal state. */
function clearSpacePageNotices(spaceId) {
    const prefix = `${spaceId}:`;
    for (const key of pendingPageNotices.keys()) {
        if (key.startsWith(prefix))
            pendingPageNotices.delete(key);
    }
    for (const key of observedPages) {
        if (key.startsWith(prefix))
            observedPages.delete(key);
    }
}
/** Read pending Page notices without consuming the round summary. */
function peekUnhandledPageNotices() {
    return [...pendingPageNotices.values()].map((notice) => ({ ...notice }));
}
/** Observe future Page discoveries. The caller owns the returned unsubscribe. */
function subscribeUnhandledPageNotices(listener) {
    pageNoticeListeners.add(listener);
    return () => pageNoticeListeners.delete(listener);
}
/** Drain Page notices once when round output is flushed. */
function consumeUnhandledPageNotices() {
    const notices = peekUnhandledPageNotices();
    pendingPageNotices.clear();
    return notices;
}
/** Clear round state. Real runs get a new process; tests can reuse one process. */
function resetPageNotices() {
    pendingPageNotices.clear();
    observedPages.clear();
    pageNoticeListeners.clear();
}
function pageKey(spaceId, targetId) {
    return `${spaceId}:${targetId}`;
}

let buffer = [];
let hardStopMessage = null;
let flushed = false;
let lifecycleHooked = false;
/** Buffer one already-formatted cliLog chunk (the trailing newline is included). */
function bufferOutput(chunk) {
    buffer.push(chunk);
}
/** Create the console object injected into one agent round. */
function createRoundConsole(writeLine = bufferOutput) {
    const append = (prefix, args) => {
        const body = args.map(formatCliLogValue).join(" ");
        writeLine(`${prefix}${body}\n`);
    };
    return Object.freeze({
        log: (...args) => append("", args),
        info: (...args) => append("", args),
        warn: (...args) => append("[warn] ", args),
        error: (...args) => append("[error] ", args),
    });
}
/**
 * Record the owned message of the first hard-stop error seen this run. Later hard stops
 * — the same error re-reported on each loop iteration — are ignored so the agent sees
 * the guidance exactly once.
 */
function markHardStop(message) {
    if (hardStopMessage === null) {
        hardStopMessage = message;
    }
}
/**
 * Emit the run's output exactly once.
 *
 * `thrown` separates a completed script from one ending on an uncaught error. On a clean
 * finish we are the only writer, so a hard stop must print its message here. On an
 * uncaught error the propagating Error already surfaces the message (the host prints it),
 * so we stay silent and only drop the buffer. Non-hard-stop output is flushed either way,
 * so an ordinary failure still shows what the script logged before it threw.
 */
function flushSink(stream, thrown) {
    if (flushed)
        return;
    flushed = true;
    const pageNotices = consumeUnhandledPageNotices();
    if (hardStopMessage !== null) {
        // Drop every buffered line — business logs, success rows, and the repeated error
        // echoes — so the owned guidance is all that remains.
        if (!thrown) {
            stream.write(hardStopMessage.endsWith("\n")
                ? hardStopMessage
                : `${hardStopMessage}\n`);
        }
    }
    else {
        for (const chunk of buffer)
            stream.write(chunk);
        if (pageNotices.length > 0) {
            stream.write(formatPageNotices(pageNotices));
        }
    }
    buffer = [];
}
/** Clear sink state. Real runs get a fresh process; this is only for in-process tests. */
function resetSink() {
    buffer = [];
    hardStopMessage = null;
    flushed = false;
    resetPageNotices();
}
function formatPageNotices(notices) {
    const lines = notices.map((notice) => {
        const source = notice.openerLabel ? ` from ${notice.openerLabel}` : "";
        const url = oneLine(notice.url || "about:blank");
        return `Unhandled page ${notice.label}${source}: ${url}`;
    });
    return `[ego-browser:pages]\n${lines.join("\n")}\n`;
}
function oneLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
/**
 * Flush on process teardown for the SDK path, where the host runs each heredoc directly
 * and never calls the CLI `execute()` wrapper, so lifecycle events are our only hook.
 *
 * A clean finish drains the event loop and reaches `beforeExit`; an uncaught async
 * rejection skips `beforeExit` but still reaches `exit` (`thrown: true`, so a hard stop
 * stays silent and lets the propagating Error surface the message). The stream still
 * accepts writes in both events, so the same `stream` serves both. Registered once.
 */
function installLifecycleFlush(stream, lifecycle = process) {
    if (lifecycleHooked)
        return;
    lifecycleHooked = true;
    const writer = Number.isInteger(stream.fd)
        ? {
            write(chunk) {
                // `exit` cannot wait for a piped Writable to drain. A synchronous fd
                // write preserves the final buffered lines on both lifecycle paths.
                writeSync(stream.fd, chunk);
            },
        }
        : stream;
    lifecycle.on("beforeExit", () => flushSink(writer, false));
    lifecycle.on("exit", () => flushSink(writer, true));
}

/**
 * Shared handling for ego-binding errors.
 *
 * Browser-side failures expose two signals (see the EgoBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as EGO_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isEgoUserControlError), not on the message. EGO_ERROR_MESSAGES is
 * where ego-browser owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */
/** Stable error codes emitted by the native ego bindings. */
const EGO_ERROR_CODES = [
    "EGO_BROWSER_UNAVAILABLE",
    "EGO_CDP_CHANNEL_UNAVAILABLE",
    "EGO_CDP_SEND_FAILED",
    "EGO_INVALID_ARGUMENT",
    "EGO_INVALID_RESULT_PAYLOAD",
    "EGO_OPERATION_FAILED",
    "EGO_RESULT_CONVERSION_FAILED",
    "EGO_SNAPSHOT_FAILED",
    "EGO_TASK_HOST_DISCONNECTED",
    "EGO_TASK_SPACE_INACTIVE",
    "EGO_TASK_SPACE_NOT_FOUND",
    "EGO_TASK_SPACE_NOT_SELECTED",
    "EGO_TASK_SPACE_UNAVAILABLE",
    "EGO_TASK_SPACE_USER_IN_CONTROL",
    "EGO_WEB_CONTENTS_UNAVAILABLE",
];
/**
 * Codes whose wording ego-browser owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const EGO_ERROR_MESSAGES = {
    EGO_TASK_SPACE_INACTIVE: [
        "The user has taken control of this task space and ended the task, so it is no longer assigned to the agent and browser commands are paused.",
        "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own.",
        "Wait until the user explicitly asks you to continue, then claim the space and resume:",
        "  const task = await claimTaskSpace(spaceId)",
        "",
        `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
    ].join("\n"),
    EGO_TASK_SPACE_USER_IN_CONTROL: [
        "The user has taken control of this task space, so browser commands are paused.",
        "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
        "Wait until the user explicitly asks you to continue, then take control back and resume:",
        "  const task = await takeOverTaskSpace(spaceId)",
        "",
        `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
    ].join("\n"),
};
const USER_CONTROL_GUIDANCE = EGO_ERROR_MESSAGES.EGO_TASK_SPACE_USER_IN_CONTROL;
const USER_CONTROL_REASON_MESSAGES = Object.freeze({
    notifications: permissionPrompt("notifications"),
    location: permissionPrompt("location access"),
    camera: permissionPrompt("camera access"),
    microphone: permissionPrompt("microphone access"),
    pan_tilt_zoom_microphone: permissionPrompt("camera control and microphone access"),
    midi: permissionPrompt("MIDI device access"),
    bluetooth: userPromptGuidance("A browser device chooser for Bluetooth has appeared."),
    usb: userPromptGuidance("A browser device chooser for USB has appeared."),
    serial: userPromptGuidance("A browser port chooser for serial access has appeared."),
    hid: userPromptGuidance("A browser device chooser for HID has appeared."),
    protocol_handler: permissionPrompt("protocol handler registration"),
    manual_takeover: USER_CONTROL_GUIDANCE,
});
function permissionPrompt(access) {
    return userPromptGuidance(`A browser permission prompt for ${access} has appeared.`);
}
function userPromptGuidance(firstLine) {
    return [
        firstLine,
        "The user now controls this task space. Wait for the user to handle the prompt.",
        "Resume only after the user confirms, using takeOverTaskSpace(spaceId).",
    ].join("\n");
}
/** Type guard for codes this build knows about. */
function isEgoErrorCode(value) {
    return (typeof value === "string" &&
        EGO_ERROR_CODES.includes(value));
}
/**
 * Pull the stable error_code out of any ego error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
function egoErrorCode(err) {
    if (typeof err === "string") {
        return isEgoErrorCode(err) ? err : undefined;
    }
    if (err && typeof err === "object") {
        const code = err.error_code;
        if (typeof code === "string" && code)
            return code;
    }
    return undefined;
}
/**
 * Resolve any ego error into a stable `{ code, message }` pair.
 *
 * For a code ego-browser owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
function resolveEgoError(err) {
    const code = egoErrorCode(err);
    const message = (code === "EGO_TASK_SPACE_USER_IN_CONTROL"
        ? resolveUserControlMessage(err)
        : isEgoErrorCode(code)
            ? EGO_ERROR_MESSAGES[code]
            : undefined) ??
        nativeErrorText(err) ??
        code ??
        "Unknown ego error";
    return { code, message };
}
function resolveUserControlMessage(err) {
    const nativeText = nativeErrorText(err);
    if (nativeText && Object.hasOwn(USER_CONTROL_REASON_MESSAGES, nativeText)) {
        return USER_CONTROL_REASON_MESSAGES[nativeText];
    }
    return USER_CONTROL_GUIDANCE;
}
/** Whether an ego error means the task is currently under user control. */
function isEgoUserControlError(err) {
    return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}
/**
 * Probe control without turning the expected user-control response into a hard
 * stop. Ego bindings can report failures either by rejecting or by resolving an
 * `{ error, error_code }` object, so both paths must be inspected here.
 */
async function probeAgentControl(invokeSnapshot) {
    let result;
    try {
        result = await invokeSnapshot();
    }
    catch (error) {
        if (isEgoUserControlError(error))
            return false;
        throw error;
    }
    if (isResolvedEgoError(result)) {
        if (isEgoUserControlError(result))
            return false;
        throw buildEgoError(result);
    }
    return true;
}
function isResolvedEgoError(value) {
    return (value !== null &&
        typeof value === "object" &&
        "error" in value &&
        value.error != null);
}
/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isEgoHardStopCode(code) {
    return (code === "EGO_TASK_SPACE_USER_IN_CONTROL" ||
        code === "EGO_TASK_SPACE_INACTIVE");
}
/**
 * Build an Error carrying the resolved message and stable error_code from any ego
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by invokeEgo and the CDP-send failure path so every ego failure surfaces
 * an identical Error shape.
 */
function buildEgoError(err, op) {
    const { code, message } = resolveEgoError(err);
    if (isEgoHardStopCode(code)) {
        // buildEgoError is the single birthplace of every ego error — invokeEgo and the
        // CDP-send failure path both route through it — so recording the hard stop here
        // catches it even when the agent's own try/catch later swallows the thrown Error.
        // The op-less owned message is the one the agent should see, regardless of which
        // operation surfaced it.
        markHardStop(message);
    }
    const error = new Error(op ? `${op}: ${message}` : message);
    if (code)
        error.error_code = code;
    return error;
}
/**
 * Invoke a native binding and normalize synchronous throws, rejected Promises, and
 * resolved `{ error, error_code }` objects. Control-wait probes intentionally bypass
 * this helper because observing user control is their expected result, not a hard stop.
 */
async function invokeEgo(op, invoke) {
    let result;
    try {
        result = await invoke();
    }
    catch (error) {
        throw buildEgoError(error, op);
    }
    if (result &&
        typeof result === "object" &&
        "error" in result &&
        result.error != null) {
        throw buildEgoError(result, op);
    }
    return result;
}
/**
 * The native error message from any ego error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err) {
    if (typeof err === "string") {
        return isEgoErrorCode(err) ? undefined : err;
    }
    if (err && typeof err === "object") {
        const obj = err;
        if (obj.error != null)
            return formatEgoError(obj.error);
        if (typeof obj.message === "string" && obj.message)
            return obj.message;
    }
    return undefined;
}
function formatEgoError(err) {
    if (err == null)
        return String(err);
    if (typeof err === "string")
        return err;
    if (typeof err === "object") {
        const obj = err;
        if (typeof obj.message === "string")
            return obj.message;
        try {
            return JSON.stringify(err);
        }
        catch {
            return String(err);
        }
    }
    return String(err);
}

// This file was generated. Do not modify manually!
var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];

// This file was generated. Do not modify manually!
var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];

// This file was generated. Do not modify manually!
var nonASCIIidentifierChars = "\u200c\u200d\xb7\u0300-\u036f\u0387\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u0669\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u06f0-\u06f9\u0711\u0730-\u074a\u07a6-\u07b0\u07c0-\u07c9\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0897-\u089f\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09cb-\u09cd\u09d7\u09e2\u09e3\u09e6-\u09ef\u09fe\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2\u0ae3\u0ae6-\u0aef\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62\u0b63\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c00-\u0c04\u0c3c\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0c66-\u0c6f\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0ce6-\u0cef\u0cf3\u0d00-\u0d03\u0d3b\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57\u0d62\u0d63\u0d66-\u0d6f\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0de6-\u0def\u0df2\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0e50-\u0e59\u0eb1\u0eb4-\u0ebc\u0ec8-\u0ece\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f3e\u0f3f\u0f71-\u0f84\u0f86\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u102b-\u103e\u1040-\u1049\u1056-\u1059\u105e-\u1060\u1062-\u1064\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17b4-\u17d3\u17dd\u17e0-\u17e9\u180b-\u180d\u180f-\u1819\u18a9\u1920-\u192b\u1930-\u193b\u1946-\u194f\u19d0-\u19da\u1a17-\u1a1b\u1a55-\u1a5e\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1ab0-\u1abd\u1abf-\u1add\u1ae0-\u1aeb\u1b00-\u1b04\u1b34-\u1b44\u1b50-\u1b59\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1bb0-\u1bb9\u1be6-\u1bf3\u1c24-\u1c37\u1c40-\u1c49\u1c50-\u1c59\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9\u1dc0-\u1dff\u200c\u200d\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff\u302a-\u302f\u3099\u309a\u30fb\ua620-\ua629\ua66f\ua674-\ua67d\ua69e\ua69f\ua6f0\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c\ua880\ua881\ua8b4-\ua8c5\ua8d0-\ua8d9\ua8e0-\ua8f1\ua8ff-\ua909\ua926-\ua92d\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9d0-\ua9d9\ua9e5\ua9f0-\ua9f9\uaa29-\uaa36\uaa43\uaa4c\uaa4d\uaa50-\uaa59\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uaaeb-\uaaef\uaaf5\uaaf6\uabe3-\uabea\uabec\uabed\uabf0-\uabf9\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f\uff65";

// This file was generated. Do not modify manually!
var nonASCIIidentifierStartChars = "\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u037f\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u052f\u0531-\u0556\u0559\u0560-\u0588\u05d0-\u05ea\u05ef-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u0860-\u086a\u0870-\u0887\u0889-\u088f\u08a0-\u08c9\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u09fc\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0af9\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c39\u0c3d\u0c58-\u0c5a\u0c5c\u0c5d\u0c60\u0c61\u0c80\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cdc-\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d04-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d54-\u0d56\u0d5f-\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e86-\u0e8a\u0e8c-\u0ea3\u0ea5\u0ea7-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f5\u13f8-\u13fd\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f8\u1700-\u1711\u171f-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1878\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191e\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19b0-\u19c9\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4c\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1c80-\u1c8a\u1c90-\u1cba\u1cbd-\u1cbf\u1ce9-\u1cec\u1cee-\u1cf3\u1cf5\u1cf6\u1cfa\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2118-\u211d\u2124\u2126\u2128\u212a-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309b-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312f\u3131-\u318e\u31a0-\u31bf\u31f0-\u31ff\u3400-\u4dbf\u4e00-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua69d\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua7dc\ua7f1-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua8fd\ua8fe\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\ua9e0-\ua9e4\ua9e6-\ua9ef\ua9fa-\ua9fe\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa7e-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uab30-\uab5a\uab5c-\uab69\uab70-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc";

// These are a run-length and offset encoded representation of the
// >0xffff code points that are a valid part of identifiers. The
// offset starts at 0x10000, and each pair of numbers represents an
// offset to the next range, and then a size of the range.

// Reserved word lists for various dialects of the language

var reservedWords = {
  3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
  5: "class enum extends super const export import",
  6: "enum",
  strict: "implements interface let package private protected public static yield",
  strictBind: "eval arguments"
};

// And the keywords

var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

var keywords$1 = {
  5: ecma5AndLessKeywords,
  "5module": ecma5AndLessKeywords + " export import",
  6: ecma5AndLessKeywords + " const class extends export import super"
};

var keywordRelationalOperator = /^in(stanceof)?$/;

// ## Character categories

var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

// This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
function isInAstralSet(code, set) {
  var pos = 0x10000;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) { return false }
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}

// Test whether a given character code starts an identifier.

function isIdentifierStart(code, astral) {
  if (code < 65) { return code === 36 }
  if (code < 91) { return true }
  if (code < 97) { return code === 95 }
  if (code < 123) { return true }
  if (code <= 0xffff) { return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code)) }
  if (astral === false) { return false }
  return isInAstralSet(code, astralIdentifierStartCodes)
}

// Test whether a given character is part of an identifier.

function isIdentifierChar(code, astral) {
  if (code < 48) { return code === 36 }
  if (code < 58) { return true }
  if (code < 65) { return false }
  if (code < 91) { return true }
  if (code < 97) { return code === 95 }
  if (code < 123) { return true }
  if (code <= 0xffff) { return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code)) }
  if (astral === false) { return false }
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes)
}

// ## Token types

// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.

// All token type variables start with an underscore, to make them
// easy to recognize.

// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// The `startsExpr` property is used to check if the token ends a
// `yield` expression. It is set on all token types that either can
// directly start an expression (like a quotation mark) or can
// continue an expression (like the body of a string).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.

var TokenType = function TokenType(label, conf) {
  if ( conf === void 0 ) conf = {};

  this.label = label;
  this.keyword = conf.keyword;
  this.beforeExpr = !!conf.beforeExpr;
  this.startsExpr = !!conf.startsExpr;
  this.isLoop = !!conf.isLoop;
  this.isAssign = !!conf.isAssign;
  this.prefix = !!conf.prefix;
  this.postfix = !!conf.postfix;
  this.binop = conf.binop || null;
  this.updateContext = null;
};

function binop(name, prec) {
  return new TokenType(name, {beforeExpr: true, binop: prec})
}
var beforeExpr = {beforeExpr: true}, startsExpr = {startsExpr: true};

// Map keyword names to token types.

var keywords = {};

// Succinct definitions of keyword token types
function kw(name, options) {
  if ( options === void 0 ) options = {};

  options.keyword = name;
  return keywords[name] = new TokenType(name, options)
}

var types$1 = {
  num: new TokenType("num", startsExpr),
  regexp: new TokenType("regexp", startsExpr),
  string: new TokenType("string", startsExpr),
  name: new TokenType("name", startsExpr),
  privateId: new TokenType("privateId", startsExpr),
  eof: new TokenType("eof"),

  // Punctuation token types.
  bracketL: new TokenType("[", {beforeExpr: true, startsExpr: true}),
  bracketR: new TokenType("]"),
  braceL: new TokenType("{", {beforeExpr: true, startsExpr: true}),
  braceR: new TokenType("}"),
  parenL: new TokenType("(", {beforeExpr: true, startsExpr: true}),
  parenR: new TokenType(")"),
  comma: new TokenType(",", beforeExpr),
  semi: new TokenType(";", beforeExpr),
  colon: new TokenType(":", beforeExpr),
  dot: new TokenType("."),
  question: new TokenType("?", beforeExpr),
  questionDot: new TokenType("?."),
  arrow: new TokenType("=>", beforeExpr),
  template: new TokenType("template"),
  invalidTemplate: new TokenType("invalidTemplate"),
  ellipsis: new TokenType("...", beforeExpr),
  backQuote: new TokenType("`", startsExpr),
  dollarBraceL: new TokenType("${", {beforeExpr: true, startsExpr: true}),

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  eq: new TokenType("=", {beforeExpr: true, isAssign: true}),
  assign: new TokenType("_=", {beforeExpr: true, isAssign: true}),
  incDec: new TokenType("++/--", {prefix: true, postfix: true, startsExpr: true}),
  prefix: new TokenType("!/~", {beforeExpr: true, prefix: true, startsExpr: true}),
  logicalOR: binop("||", 1),
  logicalAND: binop("&&", 2),
  bitwiseOR: binop("|", 3),
  bitwiseXOR: binop("^", 4),
  bitwiseAND: binop("&", 5),
  equality: binop("==/!=/===/!==", 6),
  relational: binop("</>/<=/>=", 7),
  bitShift: binop("<</>>/>>>", 8),
  plusMin: new TokenType("+/-", {beforeExpr: true, binop: 9, prefix: true, startsExpr: true}),
  modulo: binop("%", 10),
  star: binop("*", 10),
  slash: binop("/", 10),
  starstar: new TokenType("**", {beforeExpr: true}),
  coalesce: binop("??", 1),

  // Keyword token types.
  _break: kw("break"),
  _case: kw("case", beforeExpr),
  _catch: kw("catch"),
  _continue: kw("continue"),
  _debugger: kw("debugger"),
  _default: kw("default", beforeExpr),
  _do: kw("do", {isLoop: true, beforeExpr: true}),
  _else: kw("else", beforeExpr),
  _finally: kw("finally"),
  _for: kw("for", {isLoop: true}),
  _function: kw("function", startsExpr),
  _if: kw("if"),
  _return: kw("return", beforeExpr),
  _switch: kw("switch"),
  _throw: kw("throw", beforeExpr),
  _try: kw("try"),
  _var: kw("var"),
  _const: kw("const"),
  _while: kw("while", {isLoop: true}),
  _with: kw("with"),
  _new: kw("new", {beforeExpr: true, startsExpr: true}),
  _this: kw("this", startsExpr),
  _super: kw("super", startsExpr),
  _class: kw("class", startsExpr),
  _extends: kw("extends", beforeExpr),
  _export: kw("export"),
  _import: kw("import", startsExpr),
  _null: kw("null", startsExpr),
  _true: kw("true", startsExpr),
  _false: kw("false", startsExpr),
  _in: kw("in", {beforeExpr: true, binop: 7}),
  _instanceof: kw("instanceof", {beforeExpr: true, binop: 7}),
  _typeof: kw("typeof", {beforeExpr: true, prefix: true, startsExpr: true}),
  _void: kw("void", {beforeExpr: true, prefix: true, startsExpr: true}),
  _delete: kw("delete", {beforeExpr: true, prefix: true, startsExpr: true})
};

// Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.

var lineBreak = /\r\n?|\n|\u2028|\u2029/;
var lineBreakG = new RegExp(lineBreak.source, "g");

function isNewLine(code) {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029
}

function nextLineBreak(code, from, end) {
  if ( end === void 0 ) end = code.length;

  for (var i = from; i < end; i++) {
    var next = code.charCodeAt(i);
    if (isNewLine(next))
      { return i < end - 1 && next === 13 && code.charCodeAt(i + 1) === 10 ? i + 2 : i + 1 }
  }
  return -1
}

var nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;

var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;

var ref = Object.prototype;
var hasOwnProperty = ref.hasOwnProperty;
var toString = ref.toString;

var hasOwn = Object.hasOwn || (function (obj, propName) { return (
  hasOwnProperty.call(obj, propName)
); });

var isArray = Array.isArray || (function (obj) { return (
  toString.call(obj) === "[object Array]"
); });

var regexpCache = Object.create(null);

function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"))
}

function codePointToString(code) {
  // UTF-16 Decoding
  if (code <= 0xFFFF) { return String.fromCharCode(code) }
  code -= 0x10000;
  return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00)
}

var loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/;

// These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.

var Position = function Position(line, col) {
  this.line = line;
  this.column = col;
};

Position.prototype.offset = function offset (n) {
  return new Position(this.line, this.column + n)
};

var SourceLocation = function SourceLocation(p, start, end) {
  this.start = start;
  this.end = end;
  if (p.sourceFile !== null) { this.source = p.sourceFile; }
};

// The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.

function getLineInfo(input, offset) {
  for (var line = 1, cur = 0;;) {
    var nextBreak = nextLineBreak(input, cur, offset);
    if (nextBreak < 0) { return new Position(line, offset - cur) }
    ++line;
    cur = nextBreak;
  }
}

// A second argument must be given to configure the parser process.
// These options are recognized (only `ecmaVersion` is required):

var defaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must be
  // either 3, 5, 6 (or 2015), 7 (2016), 8 (2017), 9 (2018), 10
  // (2019), 11 (2020), 12 (2021), 13 (2022), 14 (2023), or `"latest"`
  // (the latest version the library supports). This influences
  // support for strict mode, the set of reserved words, and support
  // for new syntax features.
  ecmaVersion: null,
  // `sourceType` indicates the mode the code should be parsed in.
  // Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
  // strict mode and parsing of `import` and `export` declarations.
  sourceType: "script",
  // When set to true, enable strict parsing mode even if `sourceType`
  // is `"script"`.
  strict: false,
  // `onInsertedSemicolon` can be a callback that will be called when
  // a semicolon is automatically inserted. It will be passed the
  // position of the inserted semicolon as an offset, and if
  // `locations` is enabled, it is given the location as a `{line,
  // column}` object as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are only enforced if ecmaVersion >= 5.
  // Set `allowReserved` to a boolean value to explicitly turn this on
  // an off. When this option has the value "never", reserved words
  // and keywords can also not be used as property names.
  allowReserved: null,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program, and an import.meta expression
  // in a script isn't considered an error.
  allowImportExportEverywhere: false,
  // By default, await identifiers are allowed to appear at the top-level scope only if ecmaVersion >= 2022.
  // When enabled, await identifiers are allowed to appear at the top-level scope,
  // but they are still not allowed in non-async functions.
  allowAwaitOutsideFunction: null,
  // When enabled, super identifiers are not constrained to
  // appearing in methods and do not raise an error when they appear elsewhere.
  allowSuperOutsideMethod: null,
  // When enabled, hashbang directive in the beginning of file is
  // allowed and treated as a line comment. Enabled by default when
  // `ecmaVersion` >= 2023.
  allowHashBang: false,
  // By default, the parser will verify that private properties are
  // only used in places where they are valid and have been declared.
  // Set this to false to turn such checks off.
  checkPrivateFields: true,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokens returned from `tokenizer().getToken()`. Note
  // that you are not allowed to call the parser from the
  // callback—that will corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  // When this option has an array as value, objects representing the
  // comments are pushed to it.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false
};

// Interpret and default an options object

var warnedAboutEcmaVersion = false;

function getOptions(opts) {
  var options = {};

  for (var opt in defaultOptions)
    { options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt]; }

  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
      warnedAboutEcmaVersion = true;
      console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.");
    }
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }

  if (options.allowReserved == null)
    { options.allowReserved = options.ecmaVersion < 5; }

  if (!opts || opts.allowHashBang == null)
    { options.allowHashBang = options.ecmaVersion >= 14; }

  if (isArray(options.onToken)) {
    var tokens = options.onToken;
    options.onToken = function (token) { return tokens.push(token); };
  }
  if (isArray(options.onComment))
    { options.onComment = pushComment(options, options.onComment); }

  if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction)
    { throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs") }

  return options
}

function pushComment(options, array) {
  return function(block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? "Block" : "Line",
      value: text,
      start: start,
      end: end
    };
    if (options.locations)
      { comment.loc = new SourceLocation(this, startLoc, endLoc); }
    if (options.ranges)
      { comment.range = [start, end]; }
    array.push(comment);
  }
}

// Each scope gets a bitset that may contain these flags
var
    SCOPE_TOP = 1,
    SCOPE_FUNCTION = 2,
    SCOPE_ASYNC = 4,
    SCOPE_GENERATOR = 8,
    SCOPE_ARROW = 16,
    SCOPE_SIMPLE_CATCH = 32,
    SCOPE_SUPER = 64,
    SCOPE_DIRECT_SUPER = 128,
    SCOPE_CLASS_STATIC_BLOCK = 256,
    SCOPE_CLASS_FIELD_INIT = 512,
    SCOPE_SWITCH = 1024,
    SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK;

function functionFlags(async, generator) {
  return SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | (generator ? SCOPE_GENERATOR : 0)
}

// Used in checkLVal* and declareName to determine the type of a binding
var
    BIND_NONE = 0, // Not a binding
    BIND_VAR = 1, // Var-style binding
    BIND_LEXICAL = 2, // Let- or const-style binding
    BIND_FUNCTION = 3, // Function declaration
    BIND_SIMPLE_CATCH = 4, // Simple (identifier pattern) catch binding
    BIND_OUTSIDE = 5; // Special case for function names as bound inside the function

var Parser = function Parser(options, input, startPos) {
  this.options = options = getOptions(options);
  this.sourceFile = options.sourceFile;
  this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5]);
  var reserved = "";
  if (options.allowReserved !== true) {
    reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3];
    if (options.sourceType === "module") { reserved += " await"; }
  }
  this.reservedWords = wordsRegexp(reserved);
  var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
  this.reservedWordsStrict = wordsRegexp(reservedStrict);
  this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind);
  this.input = String(input);

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.
  this.containsEsc = false;

  // Set up token state

  // The current position of the tokenizer in the input.
  if (startPos) {
    this.pos = startPos;
    this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1;
    this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
  } else {
    this.pos = this.lineStart = 0;
    this.curLine = 1;
  }

  // Properties of the current token:
  // Its type
  this.type = types$1.eof;
  // For tokens that include more information than their type, the value
  this.value = null;
  // Its start and end offset
  this.start = this.end = this.pos;
  // And, if locations are used, the {line, column} object
  // corresponding to those offsets
  this.startLoc = this.endLoc = this.curPosition();

  // Position information for the previous token
  this.lastTokEndLoc = this.lastTokStartLoc = null;
  this.lastTokStart = this.lastTokEnd = this.pos;

  // The context stack is used to superficially track syntactic
  // context to predict whether a regular expression is allowed in a
  // given position.
  this.context = this.initialContext();
  this.exprAllowed = true;

  // Figure out if it's a module code.
  this.inModule = options.sourceType === "module";
  this.strict = this.inModule || options.strict === true || this.strictDirective(this.pos);

  // Used to signify the start of a potential arrow function
  this.potentialArrowAt = -1;
  this.potentialArrowInForAwait = false;

  // Positions to delayed-check that yield/await does not exist in default parameters.
  this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
  // Labels in scope.
  this.labels = [];
  // Thus-far undefined exports.
  this.undefinedExports = Object.create(null);

  // If enabled, skip leading hashbang line.
  if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!")
    { this.skipLineComment(2); }

  // Scope tracking for duplicate variable names (see scope.js)
  this.scopeStack = [];
  this.enterScope(
    this.options.sourceType === "commonjs"
      // In commonjs, the top-level scope behaves like a function scope
      ? SCOPE_FUNCTION
      : SCOPE_TOP
  );

  // For RegExp validation
  this.regexpState = null;

  // The stack of private names.
  // Each element has two properties: 'declared' and 'used'.
  // When it exited from the outermost class definition, all used private names must be declared.
  this.privateNameStack = [];
};

var prototypeAccessors = { inFunction: { configurable: true },inGenerator: { configurable: true },inAsync: { configurable: true },canAwait: { configurable: true },allowReturn: { configurable: true },allowSuper: { configurable: true },allowDirectSuper: { configurable: true },treatFunctionsAsVar: { configurable: true },allowNewDotTarget: { configurable: true },allowUsing: { configurable: true },inClassStaticBlock: { configurable: true } };

Parser.prototype.parse = function parse () {
    var this$1$1 = this;

  var node = this.options.program || this.startNode();
  this.nextToken();
  return this.catchStackOverflow(function () { return this$1$1.parseTopLevel(node); })
};

prototypeAccessors.inFunction.get = function () { return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0 };

prototypeAccessors.inGenerator.get = function () { return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0 };

prototypeAccessors.inAsync.get = function () { return (this.currentVarScope().flags & SCOPE_ASYNC) > 0 };

prototypeAccessors.canAwait.get = function () {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref = this.scopeStack[i];
      var flags = ref.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) { return false }
    if (flags & SCOPE_FUNCTION) { return (flags & SCOPE_ASYNC) > 0 }
  }
  return (this.inModule && this.options.ecmaVersion >= 13) || this.options.allowAwaitOutsideFunction
};

prototypeAccessors.allowReturn.get = function () {
  if (this.inFunction) { return true }
  if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) { return true }
  return false
};

prototypeAccessors.allowSuper.get = function () {
  var ref = this.currentThisScope();
    var flags = ref.flags;
  return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod
};

prototypeAccessors.allowDirectSuper.get = function () { return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0 };

prototypeAccessors.treatFunctionsAsVar.get = function () { return this.treatFunctionsAsVarInScope(this.currentScope()) };

prototypeAccessors.allowNewDotTarget.get = function () {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref = this.scopeStack[i];
      var flags = ref.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) ||
        ((flags & SCOPE_FUNCTION) && !(flags & SCOPE_ARROW))) { return true }
  }
  return false
};

prototypeAccessors.allowUsing.get = function () {
  var ref = this.currentScope();
    var flags = ref.flags;
  if (flags & SCOPE_SWITCH) { return false }
  if (!this.inModule && flags & SCOPE_TOP) { return false }
  return true
};

prototypeAccessors.inClassStaticBlock.get = function () {
  return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0
};

Parser.extend = function extend () {
    var plugins = [], len = arguments.length;
    while ( len-- ) plugins[ len ] = arguments[ len ];

  var cls = this;
  for (var i = 0; i < plugins.length; i++) { cls = plugins[i](cls); }
  return cls
};

Parser.parse = function parse (input, options) {
  return new this(options, input).parse()
};

Parser.parseExpressionAt = function parseExpressionAt (input, pos, options) {
  var parser = new this(options, input, pos);
  parser.nextToken();
  return parser.parseExpression()
};

Parser.tokenizer = function tokenizer (input, options) {
  return new this(options, input)
};

Object.defineProperties( Parser.prototype, prototypeAccessors );

var pp$9 = Parser.prototype;

// ## Parser utilities

var literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/;
pp$9.strictDirective = function(start) {
  if (this.options.ecmaVersion < 5) { return false }
  for (;;) {
    // Try to find string literal.
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    var match = literal.exec(this.input.slice(start));
    if (!match) { return false }
    if ((match[1] || match[2]) === "use strict") {
      skipWhiteSpace.lastIndex = start + match[0].length;
      var spaceAfter = skipWhiteSpace.exec(this.input), end = spaceAfter.index + spaceAfter[0].length;
      var next = this.input.charAt(end);
      return next === ";" || next === "}" ||
        (lineBreak.test(spaceAfter[0]) &&
         !(/[(`.[+\-/*%<>=,?^&]/.test(next) || next === "!" && this.input.charAt(end + 1) === "="))
    }
    start += match[0].length;

    // Skip semicolon, if any.
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    if (this.input[start] === ";")
      { start++; }
  }
};

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

pp$9.eat = function(type) {
  if (this.type === type) {
    this.next();
    return true
  } else {
    return false
  }
};

// Tests whether parsed token is a contextual keyword.

pp$9.isContextual = function(name) {
  return this.type === types$1.name && this.value === name && !this.containsEsc
};

// Consumes contextual keyword if possible.

pp$9.eatContextual = function(name) {
  if (!this.isContextual(name)) { return false }
  this.next();
  return true
};

pp$9.catchStackOverflow = function(f) {
  try {
    return f()
  } catch (e) {
    if (e instanceof Error && (/\bstack\b.*\b(exceeded|overflow)\b/i.test(e.message) || /\btoo much recursion\b/i.test(e.message)))
      { this.raise(this.start, "Not enough stack space to parse input"); }
    else
      { throw e }
  }
};

// Asserts that following token is given contextual keyword.

pp$9.expectContextual = function(name) {
  if (!this.eatContextual(name)) { this.unexpected(); }
};

// Test whether a semicolon can be inserted at the current position.

pp$9.canInsertSemicolon = function() {
  return this.type === types$1.eof ||
    this.type === types$1.braceR ||
    lineBreak.test(this.input.slice(this.lastTokEnd, this.start))
};

pp$9.insertSemicolon = function() {
  if (this.canInsertSemicolon()) {
    if (this.options.onInsertedSemicolon)
      { this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc); }
    return true
  }
};

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.

pp$9.semicolon = function() {
  if (!this.eat(types$1.semi) && !this.insertSemicolon()) { this.unexpected(); }
};

pp$9.afterTrailingComma = function(tokType, notNext) {
  if (this.type === tokType) {
    if (this.options.onTrailingComma)
      { this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc); }
    if (!notNext)
      { this.next(); }
    return true
  }
};

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.

pp$9.expect = function(type) {
  this.eat(type) || this.unexpected();
};

// Raise an unexpected token error.

pp$9.unexpected = function(pos) {
  this.raise(pos != null ? pos : this.start, "Unexpected token");
};

var DestructuringErrors = function DestructuringErrors() {
  this.shorthandAssign =
  this.trailingComma =
  this.parenthesizedAssign =
  this.parenthesizedBind =
  this.doubleProto =
    -1;
};

pp$9.checkPatternErrors = function(refDestructuringErrors, isAssign) {
  if (!refDestructuringErrors) { return }
  if (refDestructuringErrors.trailingComma > -1)
    { this.raiseRecoverable(refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element"); }
  var parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind;
  if (parens > -1) { this.raiseRecoverable(parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern"); }
};

pp$9.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
  if (!refDestructuringErrors) { return false }
  var shorthandAssign = refDestructuringErrors.shorthandAssign;
  var doubleProto = refDestructuringErrors.doubleProto;
  if (!andThrow) { return shorthandAssign >= 0 || doubleProto >= 0 }
  if (shorthandAssign >= 0)
    { this.raise(shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns"); }
  if (doubleProto >= 0)
    { this.raiseRecoverable(doubleProto, "Redefinition of __proto__ property"); }
};

pp$9.checkYieldAwaitInDefaultParams = function() {
  if (this.yieldPos && (!this.awaitPos || this.yieldPos < this.awaitPos))
    { this.raise(this.yieldPos, "Yield expression cannot be a default value"); }
  if (this.awaitPos)
    { this.raise(this.awaitPos, "Await expression cannot be a default value"); }
};

pp$9.isSimpleAssignTarget = function(expr) {
  if (expr.type === "ParenthesizedExpression")
    { return this.isSimpleAssignTarget(expr.expression) }
  return expr.type === "Identifier" || expr.type === "MemberExpression"
};

var pp$8 = Parser.prototype;

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.

pp$8.parseTopLevel = function(node) {
  var exports$1 = Object.create(null);
  if (!node.body) { node.body = []; }
  while (this.type !== types$1.eof) {
    var stmt = this.parseStatement(null, true, exports$1);
    node.body.push(stmt);
  }
  if (this.inModule)
    { for (var i = 0, list = Object.keys(this.undefinedExports); i < list.length; i += 1)
      {
        var name = list[i];

        this.raiseRecoverable(this.undefinedExports[name].start, ("Export '" + name + "' is not defined"));
      } }
  this.adaptDirectivePrologue(node.body);
  this.next();
  node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType;
  return this.finishNode(node, "Program")
};

var loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"};

pp$8.isLet = function(context) {
  if (this.options.ecmaVersion < 6 || !this.isContextual("let")) { return false }
  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length, nextCh = this.fullCharCodeAt(next);
  // For ambiguous cases, determine if a LexicalDeclaration (or only a
  // Statement) is allowed here. If context is not empty then only a Statement
  // is allowed. However, `let [` is an explicit negative lookahead for
  // ExpressionStatement, so special-case it first.
  if (nextCh === 91 || nextCh === 92) { return true } // '[', '\'
  if (context) { return false }

  if (nextCh === 123) { return true } // '{'
  if (isIdentifierStart(nextCh)) {
    var start = next;
    do { next += nextCh <= 0xffff ? 1 : 2; }
    while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)))
    if (nextCh === 92) { return true }
    var ident = this.input.slice(start, next);
    if (!keywordRelationalOperator.test(ident)) { return true }
  }
  return false
};

// check 'async [no LineTerminator here] function'
// - 'async /*foo*/ function' is OK.
// - 'async /*\n*/ function' is invalid.
pp$8.isAsyncFunction = function() {
  if (this.options.ecmaVersion < 8 || !this.isContextual("async"))
    { return false }

  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length, after;
  return !lineBreak.test(this.input.slice(this.pos, next)) &&
    this.input.slice(next, next + 8) === "function" &&
    (next + 8 === this.input.length ||
     !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92 /* '\' */))
};

pp$8.isUsingKeyword = function(isAwaitUsing, isFor) {
  if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using"))
    { return false }

  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length;

  if (lineBreak.test(this.input.slice(this.pos, next))) { return false }

  if (isAwaitUsing) {
    var usingEndPos = next + 5 /* using */, after;
    if (this.input.slice(next, usingEndPos) !== "using" ||
      usingEndPos === this.input.length ||
      isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) ||
      after === 92 /* '\' */
    ) { return false }

    skipWhiteSpace.lastIndex = usingEndPos;
    var skipAfterUsing = skipWhiteSpace.exec(this.input);
    next = usingEndPos + skipAfterUsing[0].length;
    if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) { return false }
  }

  var ch = this.fullCharCodeAt(next);
  if (!isIdentifierStart(ch) && ch !== 92 /* '\' */) { return false }
  var idStart = next;
  do { next += ch <= 0xffff ? 1 : 2; }
  while (isIdentifierChar(ch = this.fullCharCodeAt(next)))
  if (ch === 92) { return true }
  var id = this.input.slice(idStart, next);
  if (keywordRelationalOperator.test(id)) { return false }
  if (isFor && !isAwaitUsing && id === "of") {
    // Look ahead for using declaration with initializer, i.e., `for (using of = ...)`
    skipWhiteSpace.lastIndex = next;
    var skipAfterOf = skipWhiteSpace.exec(this.input);
    next = next + skipAfterOf[0].length;
    if (this.input.charCodeAt(next) !== 61 /* '=' */ ||
      // Check for ==, === and => operators
      (ch = this.input.charCodeAt(next + 1)) === 61 /* '=' */ || ch === 62 /* '>' */) {
      return false
    }
  }
  return true
};

pp$8.isAwaitUsing = function(isFor) {
  return this.isUsingKeyword(true, isFor)
};

pp$8.isUsing = function(isFor) {
  return this.isUsingKeyword(false, isFor)
};

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

pp$8.parseStatement = function(context, topLevel, exports$1) {
  var starttype = this.type, node = this.startNode(), kind;

  if (this.isLet(context)) {
    starttype = types$1._var;
    kind = "let";
  }

  // Most types of statements are recognized by the keyword they
  // start with. Many are trivial to parse, some require a bit of
  // complexity.

  switch (starttype) {
  case types$1._break: case types$1._continue: return this.parseBreakContinueStatement(node, starttype.keyword)
  case types$1._debugger: return this.parseDebuggerStatement(node)
  case types$1._do: return this.parseDoStatement(node)
  case types$1._for: return this.parseForStatement(node)
  case types$1._function:
    // Function as sole body of either an if statement or a labeled statement
    // works, but not when it is part of a labeled statement that is the sole
    // body of an if statement.
    if ((context && (this.strict || context !== "if" && context !== "label")) && this.options.ecmaVersion >= 6) { this.unexpected(); }
    return this.parseFunctionStatement(node, false, !context)
  case types$1._class:
    if (context) { this.unexpected(); }
    return this.parseClass(node, true)
  case types$1._if: return this.parseIfStatement(node)
  case types$1._return: return this.parseReturnStatement(node)
  case types$1._switch: return this.parseSwitchStatement(node)
  case types$1._throw: return this.parseThrowStatement(node)
  case types$1._try: return this.parseTryStatement(node)
  case types$1._const: case types$1._var:
    kind = kind || this.value;
    if (context && kind !== "var") { this.unexpected(); }
    return this.parseVarStatement(node, kind)
  case types$1._while: return this.parseWhileStatement(node)
  case types$1._with: return this.parseWithStatement(node)
  case types$1.braceL: return this.parseBlock(true, node)
  case types$1.semi: return this.parseEmptyStatement(node)
  case types$1._export:
  case types$1._import:
    if (this.options.ecmaVersion > 10 && starttype === types$1._import) {
      skipWhiteSpace.lastIndex = this.pos;
      var skip = skipWhiteSpace.exec(this.input);
      var next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next);
      if (nextCh === 40 || nextCh === 46) // '(' or '.'
        { return this.parseExpressionStatement(node, this.parseExpression()) }
    }

    if (!this.options.allowImportExportEverywhere) {
      if (!topLevel)
        { this.raise(this.start, "'import' and 'export' may only appear at the top level"); }
      if (!this.inModule)
        { this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'"); }
    }
    return starttype === types$1._import ? this.parseImport(node) : this.parseExport(node, exports$1)

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
  default:
    if (this.isAsyncFunction()) {
      if (context) { this.unexpected(); }
      this.next();
      return this.parseFunctionStatement(node, true, !context)
    }

    var usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null;
    if (usingKind) {
      if (!this.allowUsing) {
        this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
      }
      if (context) {
        // Cases like `for (;;) using x = ...;`, `if (true) await using x = ...;`, etc. are not allowed.
        this.raise(this.start, "Using declaration is not allowed in single-statement positions");
      }
      if (usingKind === "await using") {
        if (!this.canAwait) {
          this.raise(this.start, "Await using cannot appear outside of async function");
        }
        this.next();
      }
      this.next();
      this.parseVar(node, false, usingKind);
      this.semicolon();
      return this.finishNode(node, "VariableDeclaration")
    }

    var maybeName = this.value, expr = this.parseExpression();
    if (starttype === types$1.name && expr.type === "Identifier" && this.eat(types$1.colon))
      { return this.parseLabeledStatement(node, maybeName, expr, context) }
    else { return this.parseExpressionStatement(node, expr) }
  }
};

pp$8.parseBreakContinueStatement = function(node, keyword) {
  var isBreak = keyword === "break";
  this.next();
  if (this.eat(types$1.semi) || this.insertSemicolon()) { node.label = null; }
  else if (this.type !== types$1.name) { this.unexpected(); }
  else {
    node.label = this.parseIdent();
    this.semicolon();
  }

  // Verify that there is an actual destination to break or
  // continue to.
  var i = 0;
  for (; i < this.labels.length; ++i) {
    var lab = this.labels[i];
    if (node.label == null || lab.name === node.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) { break }
      if (node.label && isBreak) { break }
    }
  }
  if (i === this.labels.length) { this.raise(node.start, "Unsyntactic " + keyword); }
  return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement")
};

pp$8.parseDebuggerStatement = function(node) {
  this.next();
  this.semicolon();
  return this.finishNode(node, "DebuggerStatement")
};

pp$8.parseDoStatement = function(node) {
  this.next();
  this.labels.push(loopLabel);
  node.body = this.parseStatement("do");
  this.labels.pop();
  this.expect(types$1._while);
  node.test = this.parseParenExpression();
  if (this.options.ecmaVersion >= 6)
    { this.eat(types$1.semi); }
  else
    { this.semicolon(); }
  return this.finishNode(node, "DoWhileStatement")
};

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

pp$8.parseForStatement = function(node) {
  this.next();
  var awaitAt = (this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await")) ? this.lastTokStart : -1;
  this.labels.push(loopLabel);
  this.enterScope(0);
  this.expect(types$1.parenL);
  if (this.type === types$1.semi) {
    if (awaitAt > -1) { this.unexpected(awaitAt); }
    return this.parseFor(node, null)
  }
  var isLet = this.isLet();
  if (this.type === types$1._var || this.type === types$1._const || isLet) {
    var init$1 = this.startNode(), kind = isLet ? "let" : this.value;
    this.next();
    this.parseVar(init$1, true, kind);
    this.finishNode(init$1, "VariableDeclaration");
    return this.parseForAfterInit(node, init$1, awaitAt)
  }
  var startsWithLet = this.isContextual("let"), isForOf = false;

  var usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null;
  if (usingKind) {
    var init$2 = this.startNode();
    this.next();
    if (usingKind === "await using") {
      if (!this.canAwait) {
        this.raise(this.start, "Await using cannot appear outside of async function");
      }
      this.next();
    }
    this.parseVar(init$2, true, usingKind);
    this.finishNode(init$2, "VariableDeclaration");
    return this.parseForAfterInit(node, init$2, awaitAt)
  }
  var containsEsc = this.containsEsc;
  var refDestructuringErrors = new DestructuringErrors;
  var initPos = this.start;
  var init = awaitAt > -1
    ? this.parseExprSubscripts(refDestructuringErrors, "await")
    : this.parseExpression(true, refDestructuringErrors);
  if (this.type === types$1._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
    if (awaitAt > -1) { // implies `ecmaVersion >= 9` (see declaration of awaitAt)
      if (this.type === types$1._in) { this.unexpected(awaitAt); }
      node.await = true;
    } else if (isForOf && this.options.ecmaVersion >= 8) {
      if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") { this.unexpected(); }
      else if (this.options.ecmaVersion >= 9) { node.await = false; }
    }
    if (startsWithLet && isForOf) { this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'."); }
    this.toAssignable(init, false, refDestructuringErrors);
    this.checkLValPattern(init);
    return this.parseForIn(node, init)
  } else {
    this.checkExpressionErrors(refDestructuringErrors, true);
  }
  if (awaitAt > -1) { this.unexpected(awaitAt); }
  return this.parseFor(node, init)
};

// Helper method to parse for loop after variable initialization
pp$8.parseForAfterInit = function(node, init, awaitAt) {
  if ((this.type === types$1._in || (this.options.ecmaVersion >= 6 && this.isContextual("of"))) && init.declarations.length === 1) {
    if (this.type === types$1._in) {
      if ((init.kind === "using" || init.kind === "await using") && !init.declarations[0].init) {
        this.raise(this.start, "Using declaration is not allowed in for-in loops");
      }
      if (this.options.ecmaVersion >= 9 && awaitAt > -1) { this.unexpected(awaitAt); }
    } else if (this.options.ecmaVersion >= 9) { node.await = awaitAt > -1; }
    return this.parseForIn(node, init)
  }
  if (awaitAt > -1) { this.unexpected(awaitAt); }
  return this.parseFor(node, init)
};

pp$8.parseFunctionStatement = function(node, isAsync, declarationPosition) {
  this.next();
  return this.parseFunction(node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync)
};

pp$8.parseIfStatement = function(node) {
  this.next();
  node.test = this.parseParenExpression();
  // allow function declarations in branches, but only in non-strict mode
  node.consequent = this.parseStatement("if");
  node.alternate = this.eat(types$1._else) ? this.parseStatement("if") : null;
  return this.finishNode(node, "IfStatement")
};

pp$8.parseReturnStatement = function(node) {
  if (!this.allowReturn)
    { this.raise(this.start, "'return' outside of function"); }
  this.next();

  // In `return` (and `break`/`continue`), the keywords with
  // optional arguments, we eagerly look for a semicolon or the
  // possibility to insert one.

  if (this.eat(types$1.semi) || this.insertSemicolon()) { node.argument = null; }
  else { node.argument = this.parseExpression(); this.semicolon(); }
  return this.finishNode(node, "ReturnStatement")
};

pp$8.parseSwitchStatement = function(node) {
  this.next();
  node.discriminant = this.parseParenExpression();
  node.cases = [];
  this.expect(types$1.braceL);
  this.labels.push(switchLabel);
  this.enterScope(SCOPE_SWITCH);

  // Statements under must be grouped (by label) in SwitchCase
  // nodes. `cur` is used to keep the node that we are currently
  // adding statements to.

  var cur;
  for (var sawDefault = false; this.type !== types$1.braceR;) {
    if (this.type === types$1._case || this.type === types$1._default) {
      var isCase = this.type === types$1._case;
      if (cur) { this.finishNode(cur, "SwitchCase"); }
      node.cases.push(cur = this.startNode());
      cur.consequent = [];
      this.next();
      if (isCase) {
        cur.test = this.parseExpression();
      } else {
        if (sawDefault) { this.raiseRecoverable(this.lastTokStart, "Multiple default clauses"); }
        sawDefault = true;
        cur.test = null;
      }
      this.expect(types$1.colon);
    } else {
      if (!cur) { this.unexpected(); }
      cur.consequent.push(this.parseStatement(null));
    }
  }
  this.exitScope();
  if (cur) { this.finishNode(cur, "SwitchCase"); }
  this.next(); // Closing brace
  this.labels.pop();
  return this.finishNode(node, "SwitchStatement")
};

pp$8.parseThrowStatement = function(node) {
  this.next();
  if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start)))
    { this.raise(this.lastTokEnd, "Illegal newline after throw"); }
  node.argument = this.parseExpression();
  this.semicolon();
  return this.finishNode(node, "ThrowStatement")
};

// Reused empty array added for node fields that are always empty.

var empty$1 = [];

pp$8.parseCatchClauseParam = function() {
  var param = this.parseBindingAtom();
  var simple = param.type === "Identifier";
  this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0);
  this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL);
  this.expect(types$1.parenR);

  return param
};

pp$8.parseTryStatement = function(node) {
  this.next();
  node.block = this.parseBlock();
  node.handler = null;
  if (this.type === types$1._catch) {
    var clause = this.startNode();
    this.next();
    if (this.eat(types$1.parenL)) {
      clause.param = this.parseCatchClauseParam();
    } else {
      if (this.options.ecmaVersion < 10) { this.unexpected(); }
      clause.param = null;
      this.enterScope(0);
    }
    clause.body = this.parseBlock(false);
    this.exitScope();
    node.handler = this.finishNode(clause, "CatchClause");
  }
  node.finalizer = this.eat(types$1._finally) ? this.parseBlock() : null;
  if (!node.handler && !node.finalizer)
    { this.raise(node.start, "Missing catch or finally clause"); }
  return this.finishNode(node, "TryStatement")
};

pp$8.parseVarStatement = function(node, kind, allowMissingInitializer) {
  this.next();
  this.parseVar(node, false, kind, allowMissingInitializer);
  this.semicolon();
  return this.finishNode(node, "VariableDeclaration")
};

pp$8.parseWhileStatement = function(node) {
  this.next();
  node.test = this.parseParenExpression();
  this.labels.push(loopLabel);
  node.body = this.parseStatement("while");
  this.labels.pop();
  return this.finishNode(node, "WhileStatement")
};

pp$8.parseWithStatement = function(node) {
  if (this.strict) { this.raise(this.start, "'with' in strict mode"); }
  this.next();
  node.object = this.parseParenExpression();
  node.body = this.parseStatement("with");
  return this.finishNode(node, "WithStatement")
};

pp$8.parseEmptyStatement = function(node) {
  this.next();
  return this.finishNode(node, "EmptyStatement")
};

pp$8.parseLabeledStatement = function(node, maybeName, expr, context) {
  for (var i$1 = 0, list = this.labels; i$1 < list.length; i$1 += 1)
    {
    var label = list[i$1];

    if (label.name === maybeName)
      { this.raise(expr.start, "Label '" + maybeName + "' is already declared");
  } }
  var kind = this.type.isLoop ? "loop" : this.type === types$1._switch ? "switch" : null;
  for (var i = this.labels.length - 1; i >= 0; i--) {
    var label$1 = this.labels[i];
    if (label$1.statementStart === node.start) {
      // Update information about previous labels on this node
      label$1.statementStart = this.start;
      label$1.kind = kind;
    } else { break }
  }
  this.labels.push({name: maybeName, kind: kind, statementStart: this.start});
  node.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label");
  this.labels.pop();
  node.label = expr;
  return this.finishNode(node, "LabeledStatement")
};

pp$8.parseExpressionStatement = function(node, expr) {
  node.expression = expr;
  this.semicolon();
  return this.finishNode(node, "ExpressionStatement")
};

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

pp$8.parseBlock = function(createNewLexicalScope, node, exitStrict) {
  if ( createNewLexicalScope === void 0 ) createNewLexicalScope = true;
  if ( node === void 0 ) node = this.startNode();

  node.body = [];
  this.expect(types$1.braceL);
  if (createNewLexicalScope) { this.enterScope(0); }
  while (this.type !== types$1.braceR) {
    var stmt = this.parseStatement(null);
    node.body.push(stmt);
  }
  if (exitStrict) { this.strict = false; }
  this.next();
  if (createNewLexicalScope) { this.exitScope(); }
  return this.finishNode(node, "BlockStatement")
};

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

pp$8.parseFor = function(node, init) {
  node.init = init;
  this.expect(types$1.semi);
  node.test = this.type === types$1.semi ? null : this.parseExpression();
  this.expect(types$1.semi);
  node.update = this.type === types$1.parenR ? null : this.parseExpression();
  this.expect(types$1.parenR);
  node.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node, "ForStatement")
};

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

pp$8.parseForIn = function(node, init) {
  var isForIn = this.type === types$1._in;
  this.next();

  if (
    init.type === "VariableDeclaration" &&
    init.declarations[0].init != null &&
    (
      !isForIn ||
      this.options.ecmaVersion < 8 ||
      this.strict ||
      init.kind !== "var" ||
      init.declarations[0].id.type !== "Identifier"
    )
  ) {
    this.raise(
      init.start,
      ((isForIn ? "for-in" : "for-of") + " loop variable declaration may not have an initializer")
    );
  }
  node.left = init;
  node.right = isForIn ? this.parseExpression() : this.parseMaybeAssign();
  this.expect(types$1.parenR);
  node.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement")
};

// Parse a list of variable declarations.

pp$8.parseVar = function(node, isFor, kind, allowMissingInitializer) {
  node.declarations = [];
  node.kind = kind;
  for (;;) {
    var decl = this.startNode();
    this.parseVarId(decl, kind);
    if (this.eat(types$1.eq)) {
      decl.init = this.parseMaybeAssign(isFor);
    } else if (!allowMissingInitializer && kind === "const" && !(this.type === types$1._in || (this.options.ecmaVersion >= 6 && this.isContextual("of")))) {
      this.unexpected();
    } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== types$1._in && !this.isContextual("of")) {
      this.raise(this.lastTokEnd, ("Missing initializer in " + kind + " declaration"));
    } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === types$1._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
    } else {
      decl.init = null;
    }
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
    if (!this.eat(types$1.comma)) { break }
  }
  return node
};

pp$8.parseVarId = function(decl, kind) {
  decl.id = kind === "using" || kind === "await using"
    ? this.parseIdent()
    : this.parseBindingAtom();

  this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false);
};

var FUNC_STATEMENT = 1, FUNC_HANGING_STATEMENT = 2, FUNC_NULLABLE_ID = 4;

// Parse a function declaration or literal (depending on the
// `statement & FUNC_STATEMENT`).

// Remove `allowExpressionBody` for 7.0.0, as it is only called with false
pp$8.parseFunction = function(node, statement, allowExpressionBody, isAsync, forInit) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
    if (this.type === types$1.star && (statement & FUNC_HANGING_STATEMENT))
      { this.unexpected(); }
    node.generator = this.eat(types$1.star);
  }
  if (this.options.ecmaVersion >= 8)
    { node.async = !!isAsync; }

  if (statement & FUNC_STATEMENT) {
    node.id = (statement & FUNC_NULLABLE_ID) && this.type !== types$1.name ? null : this.parseIdent();
    if (node.id && !(statement & FUNC_HANGING_STATEMENT))
      // If it is a regular function declaration in sloppy mode, then it is
      // subject to Annex B semantics (BIND_FUNCTION). Otherwise, the binding
      // mode depends on properties of the current scope (see
      // treatFunctionsAsVar).
      { this.checkLValSimple(node.id, (this.strict || node.generator || node.async) ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION); }
  }

  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(node.async, node.generator));

  if (!(statement & FUNC_STATEMENT))
    { node.id = this.type === types$1.name ? this.parseIdent() : null; }

  this.parseFunctionParams(node);
  this.parseFunctionBody(node, allowExpressionBody, false, forInit);

  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, (statement & FUNC_STATEMENT) ? "FunctionDeclaration" : "FunctionExpression")
};

pp$8.parseFunctionParams = function(node) {
  this.expect(types$1.parenL);
  node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
};

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

pp$8.parseClass = function(node, isStatement) {
  this.next();

  // ecma-262 14.6 Class Definitions
  // A class definition is always strict mode code.
  var oldStrict = this.strict;
  this.strict = true;

  this.parseClassId(node, isStatement);
  this.parseClassSuper(node);
  var privateNameMap = this.enterClassBody();
  var classBody = this.startNode();
  var hadConstructor = false;
  classBody.body = [];
  this.expect(types$1.braceL);
  while (this.type !== types$1.braceR) {
    var element = this.parseClassElement(node.superClass !== null);
    if (element) {
      classBody.body.push(element);
      if (element.type === "MethodDefinition" && element.kind === "constructor") {
        if (hadConstructor) { this.raiseRecoverable(element.start, "Duplicate constructor in the same class"); }
        hadConstructor = true;
      } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
        this.raiseRecoverable(element.key.start, ("Identifier '#" + (element.key.name) + "' has already been declared"));
      }
    }
  }
  this.strict = oldStrict;
  this.next();
  node.body = this.finishNode(classBody, "ClassBody");
  this.exitClassBody();
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression")
};

pp$8.parseClassElement = function(constructorAllowsSuper) {
  if (this.eat(types$1.semi)) { return null }

  var ecmaVersion = this.options.ecmaVersion;
  var node = this.startNode();
  var keyName = "";
  var isGenerator = false;
  var isAsync = false;
  var kind = "method";
  var isStatic = false;

  if (this.eatContextual("static")) {
    // Parse static init block
    if (ecmaVersion >= 13 && this.eat(types$1.braceL)) {
      this.parseClassStaticBlock(node);
      return node
    }
    if (this.isClassElementNameStart() || this.type === types$1.star) {
      isStatic = true;
    } else {
      keyName = "static";
    }
  }
  node.static = isStatic;
  if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
    if ((this.isClassElementNameStart() || this.type === types$1.star) && !this.canInsertSemicolon()) {
      isAsync = true;
    } else {
      keyName = "async";
    }
  }
  if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(types$1.star)) {
    isGenerator = true;
  }
  if (!keyName && !isAsync && !isGenerator) {
    var lastValue = this.value;
    if (this.eatContextual("get") || this.eatContextual("set")) {
      if (this.isClassElementNameStart()) {
        kind = lastValue;
      } else {
        keyName = lastValue;
      }
    }
  }

  // Parse element name
  if (keyName) {
    // 'async', 'get', 'set', or 'static' were not a keyword contextually.
    // The last token is any of those. Make it the element name.
    node.computed = false;
    node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc);
    node.key.name = keyName;
    this.finishNode(node.key, "Identifier");
  } else {
    this.parseClassElementName(node);
  }

  // Parse element value
  if (ecmaVersion < 13 || this.type === types$1.parenL || kind !== "method" || isGenerator || isAsync) {
    var isConstructor = !node.static && checkKeyName(node, "constructor");
    var allowsDirectSuper = isConstructor && constructorAllowsSuper;
    // Couldn't move this check into the 'parseClassMethod' method for backward compatibility.
    if (isConstructor && kind !== "method") { this.raise(node.key.start, "Constructor can't have get/set modifier"); }
    node.kind = isConstructor ? "constructor" : kind;
    this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper);
  } else {
    this.parseClassField(node);
  }

  return node
};

pp$8.isClassElementNameStart = function() {
  return (
    this.type === types$1.name ||
    this.type === types$1.privateId ||
    this.type === types$1.num ||
    this.type === types$1.string ||
    this.type === types$1.bracketL ||
    this.type.keyword
  )
};

pp$8.parseClassElementName = function(element) {
  if (this.type === types$1.privateId) {
    if (this.value === "constructor") {
      this.raise(this.start, "Classes can't have an element named '#constructor'");
    }
    element.computed = false;
    element.key = this.parsePrivateIdent();
  } else {
    this.parsePropertyName(element);
  }
};

pp$8.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
  // Check key and flags
  var key = method.key;
  if (method.kind === "constructor") {
    if (isGenerator) { this.raise(key.start, "Constructor can't be a generator"); }
    if (isAsync) { this.raise(key.start, "Constructor can't be an async method"); }
  } else if (method.static && checkKeyName(method, "prototype")) {
    this.raise(key.start, "Classes may not have a static property named prototype");
  }

  // Parse value
  var value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper);

  // Check value
  if (method.kind === "get" && value.params.length !== 0)
    { this.raiseRecoverable(value.start, "getter should have no params"); }
  if (method.kind === "set" && value.params.length !== 1)
    { this.raiseRecoverable(value.start, "setter should have exactly one param"); }
  if (method.kind === "set" && value.params[0].type === "RestElement")
    { this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params"); }

  return this.finishNode(method, "MethodDefinition")
};

pp$8.parseClassField = function(field) {
  if (checkKeyName(field, "constructor")) {
    this.raise(field.key.start, "Classes can't have a field named 'constructor'");
  } else if (field.static && checkKeyName(field, "prototype")) {
    this.raise(field.key.start, "Classes can't have a static field named 'prototype'");
  }

  if (this.eat(types$1.eq)) {
    // To raise SyntaxError if 'arguments' exists in the initializer.
    this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER);
    field.value = this.parseMaybeAssign();
    this.exitScope();
  } else {
    field.value = null;
  }
  this.semicolon();

  return this.finishNode(field, "PropertyDefinition")
};

pp$8.parseClassStaticBlock = function(node) {
  node.body = [];

  var oldLabels = this.labels;
  this.labels = [];
  this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER);
  while (this.type !== types$1.braceR) {
    var stmt = this.parseStatement(null);
    node.body.push(stmt);
  }
  this.next();
  this.exitScope();
  this.labels = oldLabels;

  return this.finishNode(node, "StaticBlock")
};

pp$8.parseClassId = function(node, isStatement) {
  if (this.type === types$1.name) {
    node.id = this.parseIdent();
    if (isStatement)
      { this.checkLValSimple(node.id, BIND_LEXICAL, false); }
  } else {
    if (isStatement === true)
      { this.unexpected(); }
    node.id = null;
  }
};

pp$8.parseClassSuper = function(node) {
  node.superClass = this.eat(types$1._extends) ? this.parseExprSubscripts(null, false) : null;
};

pp$8.enterClassBody = function() {
  var element = {declared: Object.create(null), used: []};
  this.privateNameStack.push(element);
  return element.declared
};

pp$8.exitClassBody = function() {
  var ref = this.privateNameStack.pop();
  var declared = ref.declared;
  var used = ref.used;
  if (!this.options.checkPrivateFields) { return }
  var len = this.privateNameStack.length;
  var parent = len === 0 ? null : this.privateNameStack[len - 1];
  for (var i = 0; i < used.length; ++i) {
    var id = used[i];
    if (!hasOwn(declared, id.name)) {
      if (parent) {
        parent.used.push(id);
      } else {
        this.raiseRecoverable(id.start, ("Private field '#" + (id.name) + "' must be declared in an enclosing class"));
      }
    }
  }
};

function isPrivateNameConflicted(privateNameMap, element) {
  var name = element.key.name;
  var curr = privateNameMap[name];

  var next = "true";
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind;
  }

  // `class { get #a(){}; static set #a(_){} }` is also conflict.
  if (
    curr === "iget" && next === "iset" ||
    curr === "iset" && next === "iget" ||
    curr === "sget" && next === "sset" ||
    curr === "sset" && next === "sget"
  ) {
    privateNameMap[name] = "true";
    return false
  } else if (!curr) {
    privateNameMap[name] = next;
    return false
  } else {
    return true
  }
}

function checkKeyName(node, name) {
  var computed = node.computed;
  var key = node.key;
  return !computed && (
    key.type === "Identifier" && key.name === name ||
    key.type === "Literal" && key.value === name
  )
}

// Parses module export declaration.

pp$8.parseExportAllDeclaration = function(node, exports$1) {
  if (this.options.ecmaVersion >= 11) {
    if (this.eatContextual("as")) {
      node.exported = this.parseModuleExportName();
      this.checkExport(exports$1, node.exported, this.lastTokStart);
    } else {
      node.exported = null;
    }
  }
  this.expectContextual("from");
  if (this.type !== types$1.string) { this.unexpected(); }
  node.source = this.parseExprAtom();
  if (this.options.ecmaVersion >= 16)
    { node.attributes = this.parseWithClause(); }
  this.semicolon();
  return this.finishNode(node, "ExportAllDeclaration")
};

pp$8.parseExport = function(node, exports$1) {
  this.next();
  // export * from '...'
  if (this.eat(types$1.star)) {
    return this.parseExportAllDeclaration(node, exports$1)
  }
  if (this.eat(types$1._default)) { // export default ...
    this.checkExport(exports$1, "default", this.lastTokStart);
    node.declaration = this.parseExportDefaultDeclaration();
    return this.finishNode(node, "ExportDefaultDeclaration")
  }
  // export var|const|let|function|class ...
  if (this.shouldParseExportStatement()) {
    node.declaration = this.parseExportDeclaration(node);
    if (node.declaration.type === "VariableDeclaration")
      { this.checkVariableExport(exports$1, node.declaration.declarations); }
    else
      { this.checkExport(exports$1, node.declaration.id, node.declaration.id.start); }
    node.specifiers = [];
    node.source = null;
    if (this.options.ecmaVersion >= 16)
      { node.attributes = []; }
  } else { // export { x, y as z } [from '...']
    node.declaration = null;
    node.specifiers = this.parseExportSpecifiers(exports$1);
    if (this.eatContextual("from")) {
      if (this.type !== types$1.string) { this.unexpected(); }
      node.source = this.parseExprAtom();
      if (this.options.ecmaVersion >= 16)
        { node.attributes = this.parseWithClause(); }
    } else {
      for (var i = 0, list = node.specifiers; i < list.length; i += 1) {
        // check for keywords used as local names
        var spec = list[i];

        this.checkUnreserved(spec.local);
        // check if export is defined
        this.checkLocalExport(spec.local);

        if (spec.local.type === "Literal") {
          this.raise(spec.local.start, "A string literal cannot be used as an exported binding without `from`.");
        }
      }

      node.source = null;
      if (this.options.ecmaVersion >= 16)
        { node.attributes = []; }
    }
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration")
};

pp$8.parseExportDeclaration = function(node) {
  return this.parseStatement(null)
};

pp$8.parseExportDefaultDeclaration = function() {
  var isAsync;
  if (this.type === types$1._function || (isAsync = this.isAsyncFunction())) {
    var fNode = this.startNode();
    this.next();
    if (isAsync) { this.next(); }
    return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync)
  } else if (this.type === types$1._class) {
    var cNode = this.startNode();
    return this.parseClass(cNode, "nullableID")
  } else {
    var declaration = this.parseMaybeAssign();
    this.semicolon();
    return declaration
  }
};

pp$8.checkExport = function(exports$1, name, pos) {
  if (!exports$1) { return }
  if (typeof name !== "string")
    { name = name.type === "Identifier" ? name.name : name.value; }
  if (hasOwn(exports$1, name))
    { this.raiseRecoverable(pos, "Duplicate export '" + name + "'"); }
  exports$1[name] = true;
};

pp$8.checkPatternExport = function(exports$1, pat) {
  var type = pat.type;
  if (type === "Identifier")
    { this.checkExport(exports$1, pat, pat.start); }
  else if (type === "ObjectPattern")
    { for (var i = 0, list = pat.properties; i < list.length; i += 1)
      {
        var prop = list[i];

        this.checkPatternExport(exports$1, prop);
      } }
  else if (type === "ArrayPattern")
    { for (var i$1 = 0, list$1 = pat.elements; i$1 < list$1.length; i$1 += 1) {
      var elt = list$1[i$1];

        if (elt) { this.checkPatternExport(exports$1, elt); }
    } }
  else if (type === "Property")
    { this.checkPatternExport(exports$1, pat.value); }
  else if (type === "AssignmentPattern")
    { this.checkPatternExport(exports$1, pat.left); }
  else if (type === "RestElement")
    { this.checkPatternExport(exports$1, pat.argument); }
};

pp$8.checkVariableExport = function(exports$1, decls) {
  if (!exports$1) { return }
  for (var i = 0, list = decls; i < list.length; i += 1)
    {
    var decl = list[i];

    this.checkPatternExport(exports$1, decl.id);
  }
};

pp$8.shouldParseExportStatement = function() {
  return this.type.keyword === "var" ||
    this.type.keyword === "const" ||
    this.type.keyword === "class" ||
    this.type.keyword === "function" ||
    this.isLet() ||
    this.isAsyncFunction()
};

// Parses a comma-separated list of module exports.

pp$8.parseExportSpecifier = function(exports$1) {
  var node = this.startNode();
  node.local = this.parseModuleExportName();

  node.exported = this.eatContextual("as") ? this.parseModuleExportName() : node.local;
  this.checkExport(
    exports$1,
    node.exported,
    node.exported.start
  );

  return this.finishNode(node, "ExportSpecifier")
};

pp$8.parseExportSpecifiers = function(exports$1) {
  var nodes = [], first = true;
  // export { x, y as z } [from '...']
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) { break }
    } else { first = false; }

    nodes.push(this.parseExportSpecifier(exports$1));
  }
  return nodes
};

// Parses import declaration.

pp$8.parseImport = function(node) {
  this.next();

  // import '...'
  if (this.type === types$1.string) {
    node.specifiers = empty$1;
    node.source = this.parseExprAtom();
  } else {
    node.specifiers = this.parseImportSpecifiers();
    this.expectContextual("from");
    node.source = this.type === types$1.string ? this.parseExprAtom() : this.unexpected();
  }
  if (this.options.ecmaVersion >= 16)
    { node.attributes = this.parseWithClause(); }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration")
};

// Parses a comma-separated list of module imports.

pp$8.parseImportSpecifier = function() {
  var node = this.startNode();
  node.imported = this.parseModuleExportName();

  if (this.eatContextual("as")) {
    node.local = this.parseIdent();
  } else {
    this.checkUnreserved(node.imported);
    node.local = node.imported;
  }
  this.checkLValSimple(node.local, BIND_LEXICAL);

  return this.finishNode(node, "ImportSpecifier")
};

pp$8.parseImportDefaultSpecifier = function() {
  // import defaultObj, { x, y as z } from '...'
  var node = this.startNode();
  node.local = this.parseIdent();
  this.checkLValSimple(node.local, BIND_LEXICAL);
  return this.finishNode(node, "ImportDefaultSpecifier")
};

pp$8.parseImportNamespaceSpecifier = function() {
  var node = this.startNode();
  this.next();
  this.expectContextual("as");
  node.local = this.parseIdent();
  this.checkLValSimple(node.local, BIND_LEXICAL);
  return this.finishNode(node, "ImportNamespaceSpecifier")
};

pp$8.parseImportSpecifiers = function() {
  var nodes = [], first = true;
  if (this.type === types$1.name) {
    nodes.push(this.parseImportDefaultSpecifier());
    if (!this.eat(types$1.comma)) { return nodes }
  }
  if (this.type === types$1.star) {
    nodes.push(this.parseImportNamespaceSpecifier());
    return nodes
  }
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) { break }
    } else { first = false; }

    nodes.push(this.parseImportSpecifier());
  }
  return nodes
};

pp$8.parseWithClause = function() {
  var nodes = [];
  if (!this.eat(types$1._with)) {
    return nodes
  }
  this.expect(types$1.braceL);
  var attributeKeys = {};
  var first = true;
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) { break }
    } else { first = false; }

    var attr = this.parseImportAttribute();
    var keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value;
    if (hasOwn(attributeKeys, keyName))
      { this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'"); }
    attributeKeys[keyName] = true;
    nodes.push(attr);
  }
  return nodes
};

pp$8.parseImportAttribute = function() {
  var node = this.startNode();
  node.key = this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
  this.expect(types$1.colon);
  if (this.type !== types$1.string) {
    this.unexpected();
  }
  node.value = this.parseExprAtom();
  return this.finishNode(node, "ImportAttribute")
};

pp$8.parseModuleExportName = function() {
  if (this.options.ecmaVersion >= 13 && this.type === types$1.string) {
    var stringLiteral = this.parseLiteral(this.value);
    if (loneSurrogate.test(stringLiteral.value)) {
      this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.");
    }
    return stringLiteral
  }
  return this.parseIdent(true)
};

// Set `ExpressionStatement#directive` property for directive prologues.
pp$8.adaptDirectivePrologue = function(statements) {
  for (var i = 0; i < statements.length && this.isDirectiveCandidate(statements[i]); ++i) {
    statements[i].directive = statements[i].expression.raw.slice(1, -1);
  }
};
pp$8.isDirectiveCandidate = function(statement) {
  return (
    this.options.ecmaVersion >= 5 &&
    statement.type === "ExpressionStatement" &&
    statement.expression.type === "Literal" &&
    typeof statement.expression.value === "string" &&
    // Reject parenthesized strings.
    (this.input[statement.start] === "\"" || this.input[statement.start] === "'")
  )
};

var pp$7 = Parser.prototype;

// Convert existing expression atom to assignable pattern
// if possible.

pp$7.toAssignable = function(node, isBinding, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
    case "Identifier":
      if (this.inAsync && node.name === "await")
        { this.raise(node.start, "Cannot use 'await' as identifier inside an async function"); }
      break

    case "ObjectPattern":
    case "ArrayPattern":
    case "AssignmentPattern":
    case "RestElement":
      break

    case "ObjectExpression":
      node.type = "ObjectPattern";
      if (refDestructuringErrors) { this.checkPatternErrors(refDestructuringErrors, true); }
      for (var i = 0, list = node.properties; i < list.length; i += 1) {
        var prop = list[i];

      this.toAssignable(prop, isBinding);
        // Early error:
        //   AssignmentRestProperty[Yield, Await] :
        //     `...` DestructuringAssignmentTarget[Yield, Await]
        //
        //   It is a Syntax Error if |DestructuringAssignmentTarget| is an |ArrayLiteral| or an |ObjectLiteral|.
        if (
          prop.type === "RestElement" &&
          (prop.argument.type === "ArrayPattern" || prop.argument.type === "ObjectPattern")
        ) {
          this.raise(prop.argument.start, "Unexpected token");
        }
      }
      break

    case "Property":
      // AssignmentProperty has type === "Property"
      if (node.kind !== "init") { this.raise(node.key.start, "Object pattern can't contain getter or setter"); }
      this.toAssignable(node.value, isBinding);
      break

    case "ArrayExpression":
      node.type = "ArrayPattern";
      if (refDestructuringErrors) { this.checkPatternErrors(refDestructuringErrors, true); }
      this.toAssignableList(node.elements, isBinding);
      break

    case "SpreadElement":
      node.type = "RestElement";
      this.toAssignable(node.argument, isBinding);
      if (node.argument.type === "AssignmentPattern")
        { this.raise(node.argument.start, "Rest elements cannot have a default value"); }
      break

    case "AssignmentExpression":
      if (node.operator !== "=") { this.raise(node.left.end, "Only '=' operator can be used for specifying default value."); }
      node.type = "AssignmentPattern";
      delete node.operator;
      this.toAssignable(node.left, isBinding);
      break

    case "ParenthesizedExpression":
      this.toAssignable(node.expression, isBinding, refDestructuringErrors);
      break

    case "ChainExpression":
      this.raiseRecoverable(node.start, "Optional chaining cannot appear in left-hand side");
      break

    case "MemberExpression":
      if (!isBinding) { break }

    default:
      this.raise(node.start, "Assigning to rvalue");
    }
  } else if (refDestructuringErrors) { this.checkPatternErrors(refDestructuringErrors, true); }
  return node
};

// Convert list of expression atoms to binding list.

pp$7.toAssignableList = function(exprList, isBinding) {
  var end = exprList.length;
  for (var i = 0; i < end; i++) {
    var elt = exprList[i];
    if (elt) { this.toAssignable(elt, isBinding); }
  }
  if (end) {
    var last = exprList[end - 1];
    if (this.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier")
      { this.unexpected(last.argument.start); }
  }
  return exprList
};

// Parses spread element.

pp$7.parseSpread = function(refDestructuringErrors) {
  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeAssign(false, refDestructuringErrors);
  return this.finishNode(node, "SpreadElement")
};

pp$7.parseRestBinding = function() {
  var node = this.startNode();
  this.next();

  // RestElement inside of a function parameter must be an identifier
  if (this.options.ecmaVersion === 6 && this.type !== types$1.name)
    { this.unexpected(); }

  node.argument = this.parseBindingAtom();

  return this.finishNode(node, "RestElement")
};

// Parses lvalue (assignable) atom.

pp$7.parseBindingAtom = function() {
  if (this.options.ecmaVersion >= 6) {
    switch (this.type) {
    case types$1.bracketL:
      var node = this.startNode();
      this.next();
      node.elements = this.parseBindingList(types$1.bracketR, true, true);
      return this.finishNode(node, "ArrayPattern")

    case types$1.braceL:
      return this.parseObj(true)
    }
  }
  return this.parseIdent()
};

pp$7.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowModifiers) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (first) { first = false; }
    else { this.expect(types$1.comma); }
    if (allowEmpty && this.type === types$1.comma) {
      elts.push(null);
    } else if (allowTrailingComma && this.afterTrailingComma(close)) {
      break
    } else if (this.type === types$1.ellipsis) {
      var rest = this.parseRestBinding();
      this.parseBindingListItem(rest);
      elts.push(rest);
      if (this.type === types$1.comma) { this.raiseRecoverable(this.start, "Comma is not permitted after the rest element"); }
      this.expect(close);
      break
    } else {
      elts.push(this.parseAssignableListItem(allowModifiers));
    }
  }
  return elts
};

pp$7.parseAssignableListItem = function(allowModifiers) {
  var elem = this.parseMaybeDefault(this.start, this.startLoc);
  this.parseBindingListItem(elem);
  return elem
};

pp$7.parseBindingListItem = function(param) {
  return param
};

// Parses assignment pattern around given atom if possible.

pp$7.parseMaybeDefault = function(startPos, startLoc, left) {
  left = left || this.parseBindingAtom();
  if (this.options.ecmaVersion < 6 || !this.eat(types$1.eq)) { return left }
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.right = this.parseMaybeAssign();
  return this.finishNode(node, "AssignmentPattern")
};

// The following three functions all verify that a node is an lvalue —
// something that can be bound, or assigned to. In order to do so, they perform
// a variety of checks:
//
// - Check that none of the bound/assigned-to identifiers are reserved words.
// - Record name declarations for bindings in the appropriate scope.
// - Check duplicate argument names, if checkClashes is set.
//
// If a complex binding pattern is encountered (e.g., object and array
// destructuring), the entire pattern is recursively checked.
//
// There are three versions of checkLVal*() appropriate for different
// circumstances:
//
// - checkLValSimple() shall be used if the syntactic construct supports
//   nothing other than identifiers and member expressions. Parenthesized
//   expressions are also correctly handled. This is generally appropriate for
//   constructs for which the spec says
//
//   > It is a Syntax Error if AssignmentTargetType of [the production] is not
//   > simple.
//
//   It is also appropriate for checking if an identifier is valid and not
//   defined elsewhere, like import declarations or function/class identifiers.
//
//   Examples where this is used include:
//     a += …;
//     import a from '…';
//   where a is the node to be checked.
//
// - checkLValPattern() shall be used if the syntactic construct supports
//   anything checkLValSimple() supports, as well as object and array
//   destructuring patterns. This is generally appropriate for constructs for
//   which the spec says
//
//   > It is a Syntax Error if [the production] is neither an ObjectLiteral nor
//   > an ArrayLiteral and AssignmentTargetType of [the production] is not
//   > simple.
//
//   Examples where this is used include:
//     (a = …);
//     const a = …;
//     try { … } catch (a) { … }
//   where a is the node to be checked.
//
// - checkLValInnerPattern() shall be used if the syntactic construct supports
//   anything checkLValPattern() supports, as well as default assignment
//   patterns, rest elements, and other constructs that may appear within an
//   object or array destructuring pattern.
//
//   As a special case, function parameters also use checkLValInnerPattern(),
//   as they also support defaults and rest constructs.
//
// These functions deliberately support both assignment and binding constructs,
// as the logic for both is exceedingly similar. If the node is the target of
// an assignment, then bindingType should be set to BIND_NONE. Otherwise, it
// should be set to the appropriate BIND_* constant, like BIND_VAR or
// BIND_LEXICAL.
//
// If the function is called with a non-BIND_NONE bindingType, then
// additionally a checkClashes object may be specified to allow checking for
// duplicate argument names. checkClashes is ignored if the provided construct
// is an assignment (i.e., bindingType is BIND_NONE).

pp$7.checkLValSimple = function(expr, bindingType, checkClashes) {
  if ( bindingType === void 0 ) bindingType = BIND_NONE;

  var isBind = bindingType !== BIND_NONE;

  switch (expr.type) {
  case "Identifier":
    if (this.strict && this.reservedWordsStrictBind.test(expr.name))
      { this.raiseRecoverable(expr.start, (isBind ? "Binding " : "Assigning to ") + expr.name + " in strict mode"); }
    if (isBind) {
      if (bindingType === BIND_LEXICAL && expr.name === "let")
        { this.raiseRecoverable(expr.start, "let is disallowed as a lexically bound name"); }
      if (checkClashes) {
        if (hasOwn(checkClashes, expr.name))
          { this.raiseRecoverable(expr.start, "Argument name clash"); }
        checkClashes[expr.name] = true;
      }
      if (bindingType !== BIND_OUTSIDE) { this.declareName(expr.name, bindingType, expr.start); }
    }
    break

  case "ChainExpression":
    this.raiseRecoverable(expr.start, "Optional chaining cannot appear in left-hand side");
    break

  case "MemberExpression":
    if (isBind) { this.raiseRecoverable(expr.start, "Binding member expression"); }
    break

  case "ParenthesizedExpression":
    if (isBind) { this.raiseRecoverable(expr.start, "Binding parenthesized expression"); }
    return this.checkLValSimple(expr.expression, bindingType, checkClashes)

  default:
    this.raise(expr.start, (isBind ? "Binding" : "Assigning to") + " rvalue");
  }
};

pp$7.checkLValPattern = function(expr, bindingType, checkClashes) {
  if ( bindingType === void 0 ) bindingType = BIND_NONE;

  switch (expr.type) {
  case "ObjectPattern":
    for (var i = 0, list = expr.properties; i < list.length; i += 1) {
      var prop = list[i];

    this.checkLValInnerPattern(prop, bindingType, checkClashes);
    }
    break

  case "ArrayPattern":
    for (var i$1 = 0, list$1 = expr.elements; i$1 < list$1.length; i$1 += 1) {
      var elem = list$1[i$1];

    if (elem) { this.checkLValInnerPattern(elem, bindingType, checkClashes); }
    }
    break

  default:
    this.checkLValSimple(expr, bindingType, checkClashes);
  }
};

pp$7.checkLValInnerPattern = function(expr, bindingType, checkClashes) {
  if ( bindingType === void 0 ) bindingType = BIND_NONE;

  switch (expr.type) {
  case "Property":
    // AssignmentProperty has type === "Property"
    this.checkLValInnerPattern(expr.value, bindingType, checkClashes);
    break

  case "AssignmentPattern":
    this.checkLValPattern(expr.left, bindingType, checkClashes);
    break

  case "RestElement":
    this.checkLValPattern(expr.argument, bindingType, checkClashes);
    break

  default:
    this.checkLValPattern(expr, bindingType, checkClashes);
  }
};

// The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design


var TokContext = function TokContext(token, isExpr, preserveSpace, override, generator) {
  this.token = token;
  this.isExpr = !!isExpr;
  this.preserveSpace = !!preserveSpace;
  this.override = override;
  this.generator = !!generator;
};

var types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", false),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, function (p) { return p.tryReadTemplateToken(); }),
  f_stat: new TokContext("function", false),
  f_expr: new TokContext("function", true),
  f_expr_gen: new TokContext("function", true, false, null, true),
  f_gen: new TokContext("function", false, false, null, true)
};

var pp$6 = Parser.prototype;

pp$6.initialContext = function() {
  return [types.b_stat]
};

pp$6.curContext = function() {
  return this.context[this.context.length - 1]
};

pp$6.braceIsBlock = function(prevType) {
  var parent = this.curContext();
  if (parent === types.f_expr || parent === types.f_stat)
    { return true }
  if (prevType === types$1.colon && (parent === types.b_stat || parent === types.b_expr))
    { return !parent.isExpr }

  // The check for `tt.name && exprAllowed` detects whether we are
  // after a `yield` or `of` construct. See the `updateContext` for
  // `tt.name`.
  if (prevType === types$1._return || prevType === types$1.name && this.exprAllowed)
    { return lineBreak.test(this.input.slice(this.lastTokEnd, this.start)) }
  if (prevType === types$1._else || prevType === types$1.semi || prevType === types$1.eof || prevType === types$1.parenR || prevType === types$1.arrow)
    { return true }
  if (prevType === types$1.braceL)
    { return parent === types.b_stat }
  if (prevType === types$1._var || prevType === types$1._const || prevType === types$1.name)
    { return false }
  return !this.exprAllowed
};

pp$6.inGeneratorContext = function() {
  for (var i = this.context.length - 1; i >= 1; i--) {
    var context = this.context[i];
    if (context.token === "function")
      { return context.generator }
  }
  return false
};

pp$6.updateContext = function(prevType) {
  var update, type = this.type;
  if (type.keyword && prevType === types$1.dot)
    { this.exprAllowed = false; }
  else if (update = type.updateContext)
    { update.call(this, prevType); }
  else
    { this.exprAllowed = type.beforeExpr; }
};

// Used to handle edge cases when token context could not be inferred correctly during tokenization phase

pp$6.overrideContext = function(tokenCtx) {
  if (this.curContext() !== tokenCtx) {
    this.context[this.context.length - 1] = tokenCtx;
  }
};

// Token-specific context update code

types$1.parenR.updateContext = types$1.braceR.updateContext = function() {
  if (this.context.length === 1) {
    this.exprAllowed = true;
    return
  }
  var out = this.context.pop();
  if (out === types.b_stat && this.curContext().token === "function") {
    out = this.context.pop();
  }
  this.exprAllowed = !out.isExpr;
};

types$1.braceL.updateContext = function(prevType) {
  this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
  this.exprAllowed = true;
};

types$1.dollarBraceL.updateContext = function() {
  this.context.push(types.b_tmpl);
  this.exprAllowed = true;
};

types$1.parenL.updateContext = function(prevType) {
  var statementParens = prevType === types$1._if || prevType === types$1._for || prevType === types$1._with || prevType === types$1._while;
  this.context.push(statementParens ? types.p_stat : types.p_expr);
  this.exprAllowed = true;
};

types$1.incDec.updateContext = function() {
  // tokExprAllowed stays unchanged
};

types$1._function.updateContext = types$1._class.updateContext = function(prevType) {
  if (prevType.beforeExpr && prevType !== types$1._else &&
      !(prevType === types$1.semi && this.curContext() !== types.p_stat) &&
      !(prevType === types$1._return && lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) &&
      !((prevType === types$1.colon || prevType === types$1.braceL) && this.curContext() === types.b_stat))
    { this.context.push(types.f_expr); }
  else
    { this.context.push(types.f_stat); }
  this.exprAllowed = false;
};

types$1.colon.updateContext = function() {
  if (this.curContext().token === "function") { this.context.pop(); }
  this.exprAllowed = true;
};

types$1.backQuote.updateContext = function() {
  if (this.curContext() === types.q_tmpl)
    { this.context.pop(); }
  else
    { this.context.push(types.q_tmpl); }
  this.exprAllowed = false;
};

types$1.star.updateContext = function(prevType) {
  if (prevType === types$1._function) {
    var index = this.context.length - 1;
    if (this.context[index] === types.f_expr)
      { this.context[index] = types.f_expr_gen; }
    else
      { this.context[index] = types.f_gen; }
  }
  this.exprAllowed = true;
};

types$1.name.updateContext = function(prevType) {
  var allowed = false;
  if (this.options.ecmaVersion >= 6 && prevType !== types$1.dot) {
    if (this.value === "of" && !this.exprAllowed ||
        this.value === "yield" && this.inGeneratorContext())
      { allowed = true; }
  }
  this.exprAllowed = allowed;
};

// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser


var pp$5 = Parser.prototype;

// Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.

pp$5.checkPropClash = function(prop, propHash, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 9 && prop.type === "SpreadElement")
    { return }
  if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand))
    { return }
  var key = prop.key;
  var name;
  switch (key.type) {
  case "Identifier": name = key.name; break
  case "Literal": name = String(key.value); break
  default: return
  }
  var kind = prop.kind;
  if (this.options.ecmaVersion >= 6) {
    if (name === "__proto__" && kind === "init") {
      if (propHash.proto) {
        if (refDestructuringErrors) {
          if (refDestructuringErrors.doubleProto < 0) {
            refDestructuringErrors.doubleProto = key.start;
          }
        } else {
          this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
        }
      }
      propHash.proto = true;
    }
    return
  }
  name = "$" + name;
  var other = propHash[name];
  if (other) {
    var redefinition;
    if (kind === "init") {
      redefinition = this.strict && other.init || other.get || other.set;
    } else {
      redefinition = other.init || other[kind];
    }
    if (redefinition)
      { this.raiseRecoverable(key.start, "Redefinition of property"); }
  } else {
    other = propHash[name] = {
      init: false,
      get: false,
      set: false
    };
  }
  other[kind] = true;
};

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.

// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).

pp$5.parseExpression = function(forInit, refDestructuringErrors) {
  var this$1$1 = this;

  return this.catchStackOverflow(function () {
    var startPos = this$1$1.start, startLoc = this$1$1.startLoc;
    var expr = this$1$1.parseMaybeAssign(forInit, refDestructuringErrors);
    if (this$1$1.type === types$1.comma) {
      var node = this$1$1.startNodeAt(startPos, startLoc);
      node.expressions = [expr];
      while (this$1$1.eat(types$1.comma)) { node.expressions.push(this$1$1.parseMaybeAssign(forInit, refDestructuringErrors)); }
      return this$1$1.finishNode(node, "SequenceExpression")
    }
    return expr
  })
};

// Parse an assignment expression. This includes applications of
// operators like `+=`.

pp$5.parseMaybeAssign = function(forInit, refDestructuringErrors, afterLeftParse) {
  if (this.isContextual("yield")) {
    if (this.inGenerator) { return this.parseYield(forInit) }
    // The tokenizer will assume an expression is allowed after
    // `yield`, but this isn't that kind of yield
    else { this.exprAllowed = false; }
  }

  var ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1;
  if (refDestructuringErrors) {
    oldParenAssign = refDestructuringErrors.parenthesizedAssign;
    oldTrailingComma = refDestructuringErrors.trailingComma;
    oldDoubleProto = refDestructuringErrors.doubleProto;
    refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1;
  } else {
    refDestructuringErrors = new DestructuringErrors;
    ownDestructuringErrors = true;
  }

  var startPos = this.start, startLoc = this.startLoc;
  if (this.type === types$1.parenL || this.type === types$1.name) {
    this.potentialArrowAt = this.start;
    this.potentialArrowInForAwait = forInit === "await";
  }
  var left = this.parseMaybeConditional(forInit, refDestructuringErrors);
  if (afterLeftParse) { left = afterLeftParse.call(this, left, startPos, startLoc); }
  if (this.type.isAssign) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    if (this.type === types$1.eq)
      { left = this.toAssignable(left, false, refDestructuringErrors); }
    if (!ownDestructuringErrors) {
      refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = refDestructuringErrors.doubleProto = -1;
    }
    if (refDestructuringErrors.shorthandAssign >= left.start)
      { refDestructuringErrors.shorthandAssign = -1; } // reset because shorthand default was used correctly
    if (this.type === types$1.eq)
      { this.checkLValPattern(left); }
    else
      { this.checkLValSimple(left); }
    node.left = left;
    this.next();
    node.right = this.parseMaybeAssign(forInit);
    if (oldDoubleProto > -1) { refDestructuringErrors.doubleProto = oldDoubleProto; }
    return this.finishNode(node, "AssignmentExpression")
  } else {
    if (ownDestructuringErrors) { this.checkExpressionErrors(refDestructuringErrors, true); }
  }
  if (oldParenAssign > -1) { refDestructuringErrors.parenthesizedAssign = oldParenAssign; }
  if (oldTrailingComma > -1) { refDestructuringErrors.trailingComma = oldTrailingComma; }
  return left
};

// Parse a ternary conditional (`?:`) operator.

pp$5.parseMaybeConditional = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseExprOps(forInit, refDestructuringErrors);
  if (this.checkExpressionErrors(refDestructuringErrors)) { return expr }
  if (!(expr.type === "ArrowFunctionExpression" && expr.start === startPos) && this.eat(types$1.question)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    this.expect(types$1.colon);
    node.alternate = this.parseMaybeAssign(forInit);
    return this.finishNode(node, "ConditionalExpression")
  }
  return expr
};

// Start the precedence parser.

pp$5.parseExprOps = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseMaybeUnary(refDestructuringErrors, false, false, forInit);
  if (this.checkExpressionErrors(refDestructuringErrors)) { return expr }
  return expr.start === startPos && expr.type === "ArrowFunctionExpression" ? expr : this.parseExprOp(expr, startPos, startLoc, -1, forInit)
};

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

pp$5.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, forInit) {
  var prec = this.type.binop;
  if (prec != null && (!forInit || this.type !== types$1._in)) {
    if (prec > minPrec) {
      var logical = this.type === types$1.logicalOR || this.type === types$1.logicalAND;
      var coalesce = this.type === types$1.coalesce;
      if (coalesce) {
        // Handle the precedence of `tt.coalesce` as equal to the range of logical expressions.
        // In other words, `node.right` shouldn't contain logical expressions in order to check the mixed error.
        prec = types$1.logicalAND.binop;
      }
      var op = this.value;
      this.next();
      var startPos = this.start, startLoc = this.startLoc;
      var right = this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), startPos, startLoc, prec, forInit);
      var node = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical || coalesce);
      if ((logical && this.type === types$1.coalesce) || (coalesce && (this.type === types$1.logicalOR || this.type === types$1.logicalAND))) {
        this.raiseRecoverable(this.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
      }
      return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, forInit)
    }
  }
  return left
};

pp$5.buildBinary = function(startPos, startLoc, left, right, op, logical) {
  if (right.type === "PrivateIdentifier") { this.raise(right.start, "Private identifier can only be left side of binary expression"); }
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.operator = op;
  node.right = right;
  return this.finishNode(node, logical ? "LogicalExpression" : "BinaryExpression")
};

// Parse unary operators, both prefix and postfix.

pp$5.parseMaybeUnary = function(refDestructuringErrors, sawUnary, incDec, forInit) {
  var startPos = this.start, startLoc = this.startLoc, expr;
  if (this.isContextual("await") && this.canAwait) {
    expr = this.parseAwait(forInit);
    sawUnary = true;
  } else if (this.type.prefix) {
    var node = this.startNode(), update = this.type === types$1.incDec;
    node.operator = this.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary(null, true, update, forInit);
    this.checkExpressionErrors(refDestructuringErrors, true);
    if (update) { this.checkLValSimple(node.argument); }
    else if (this.strict && node.operator === "delete" && isLocalVariableAccess(node.argument))
      { this.raiseRecoverable(node.start, "Deleting local variable in strict mode"); }
    else if (node.operator === "delete" && isPrivateFieldAccess(node.argument))
      { this.raiseRecoverable(node.start, "Private fields can not be deleted"); }
    else { sawUnary = true; }
    expr = this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
  } else if (!sawUnary && this.type === types$1.privateId) {
    if ((forInit || this.privateNameStack.length === 0) && this.options.checkPrivateFields) { this.unexpected(); }
    expr = this.parsePrivateIdent();
    // only could be private fields in 'in', such as #x in obj
    if (this.type !== types$1._in) { this.unexpected(); }
  } else {
    expr = this.parseExprSubscripts(refDestructuringErrors, forInit);
    if (this.checkExpressionErrors(refDestructuringErrors)) { return expr }
    while (this.type.postfix && !this.canInsertSemicolon()) {
      var node$1 = this.startNodeAt(startPos, startLoc);
      node$1.operator = this.value;
      node$1.prefix = false;
      node$1.argument = expr;
      this.checkLValSimple(expr);
      this.next();
      expr = this.finishNode(node$1, "UpdateExpression");
    }
  }

  if (!incDec && this.eat(types$1.starstar)) {
    if (sawUnary)
      { this.unexpected(this.lastTokStart); }
    else
      { return this.buildBinary(startPos, startLoc, expr, this.parseMaybeUnary(null, false, false, forInit), "**", false) }
  } else {
    return expr
  }
};

function isLocalVariableAccess(node) {
  return (
    node.type === "Identifier" ||
    node.type === "ParenthesizedExpression" && isLocalVariableAccess(node.expression)
  )
}

function isPrivateFieldAccess(node) {
  return (
    node.type === "MemberExpression" && node.property.type === "PrivateIdentifier" ||
    node.type === "ChainExpression" && isPrivateFieldAccess(node.expression) ||
    node.type === "ParenthesizedExpression" && isPrivateFieldAccess(node.expression)
  )
}

// Parse call, dot, and `[]`-subscript expressions.

pp$5.parseExprSubscripts = function(refDestructuringErrors, forInit) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr = this.parseExprAtom(refDestructuringErrors, forInit);
  if (expr.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")")
    { return expr }
  var result = this.parseSubscripts(expr, startPos, startLoc, false, forInit);
  if (refDestructuringErrors && result.type === "MemberExpression") {
    if (refDestructuringErrors.parenthesizedAssign >= result.start) { refDestructuringErrors.parenthesizedAssign = -1; }
    if (refDestructuringErrors.parenthesizedBind >= result.start) { refDestructuringErrors.parenthesizedBind = -1; }
    if (refDestructuringErrors.trailingComma >= result.start) { refDestructuringErrors.trailingComma = -1; }
  }
  return result
};

pp$5.parseSubscripts = function(base, startPos, startLoc, noCalls, forInit) {
  var maybeAsyncArrow = this.options.ecmaVersion >= 8 && base.type === "Identifier" && base.name === "async" &&
      this.lastTokEnd === base.end && !this.canInsertSemicolon() && base.end - base.start === 5 &&
      this.potentialArrowAt === base.start;
  var optionalChained = false;

  while (true) {
    var element = this.parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit);

    if (element.optional) { optionalChained = true; }
    if (element === base || element.type === "ArrowFunctionExpression") {
      if (optionalChained) {
        var chainNode = this.startNodeAt(startPos, startLoc);
        chainNode.expression = element;
        element = this.finishNode(chainNode, "ChainExpression");
      }
      return element
    }

    base = element;
  }
};

pp$5.shouldParseAsyncArrow = function() {
  return !this.canInsertSemicolon() && this.eat(types$1.arrow)
};

pp$5.parseSubscriptAsyncArrow = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit)
};

pp$5.parseSubscript = function(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
  var optionalSupported = this.options.ecmaVersion >= 11;
  var optional = optionalSupported && this.eat(types$1.questionDot);
  if (noCalls && optional) { this.raise(this.lastTokStart, "Optional chaining cannot appear in the callee of new expressions"); }

  var computed = this.eat(types$1.bracketL);
  if (computed || (optional && this.type !== types$1.parenL && this.type !== types$1.backQuote) || this.eat(types$1.dot)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.object = base;
    if (computed) {
      node.property = this.parseExpression();
      this.expect(types$1.bracketR);
    } else if (this.type === types$1.privateId && base.type !== "Super") {
      node.property = this.parsePrivateIdent();
    } else {
      node.property = this.parseIdent(this.options.allowReserved !== "never");
    }
    node.computed = !!computed;
    if (optionalSupported) {
      node.optional = optional;
    }
    base = this.finishNode(node, "MemberExpression");
  } else if (!noCalls && this.eat(types$1.parenL)) {
    var refDestructuringErrors = new DestructuringErrors, oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    var exprList = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors);
    if (maybeAsyncArrow && !optional && this.shouldParseAsyncArrow()) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      if (this.awaitIdentPos > 0)
        { this.raise(this.awaitIdentPos, "Cannot use 'await' as identifier inside an async function"); }
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.parseSubscriptAsyncArrow(startPos, startLoc, exprList, forInit)
    }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;
    this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos;
    var node$1 = this.startNodeAt(startPos, startLoc);
    node$1.callee = base;
    node$1.arguments = exprList;
    if (optionalSupported) {
      node$1.optional = optional;
    }
    base = this.finishNode(node$1, "CallExpression");
  } else if (this.type === types$1.backQuote) {
    if (optional || optionalChained) {
      this.raise(this.start, "Optional chaining cannot appear in the tag of tagged template expressions");
    }
    var node$2 = this.startNodeAt(startPos, startLoc);
    node$2.tag = base;
    node$2.quasi = this.parseTemplate({isTagged: true});
    base = this.finishNode(node$2, "TaggedTemplateExpression");
  }
  return base
};

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.

pp$5.parseExprAtom = function(refDestructuringErrors, forInit, forNew) {
  // If a division operator appears in an expression position, the
  // tokenizer got confused, and we force it to read a regexp instead.
  if (this.type === types$1.slash) { this.readRegexp(); }

  var node, canBeArrow = this.potentialArrowAt === this.start;
  switch (this.type) {
  case types$1._super:
    if (!this.allowSuper)
      { this.raise(this.start, "'super' keyword outside a method"); }
    node = this.startNode();
    this.next();
    if (this.type === types$1.parenL && !this.allowDirectSuper)
      { this.raise(node.start, "super() call outside constructor of a subclass"); }
    // The `super` keyword can appear at below:
    // SuperProperty:
    //     super [ Expression ]
    //     super . IdentifierName
    // SuperCall:
    //     super ( Arguments )
    if (this.type !== types$1.dot && this.type !== types$1.bracketL && this.type !== types$1.parenL)
      { this.unexpected(); }
    return this.finishNode(node, "Super")

  case types$1._this:
    node = this.startNode();
    this.next();
    return this.finishNode(node, "ThisExpression")

  case types$1.name:
    var startPos = this.start, startLoc = this.startLoc, containsEsc = this.containsEsc;
    var id = this.parseIdent(false);
    if (this.options.ecmaVersion >= 8 && !containsEsc && id.name === "async" && !this.canInsertSemicolon() && this.eat(types$1._function)) {
      this.overrideContext(types.f_expr);
      return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit)
    }
    if (canBeArrow && !this.canInsertSemicolon()) {
      if (this.eat(types$1.arrow))
        { return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], false, forInit) }
      if (this.options.ecmaVersion >= 8 && id.name === "async" && this.type === types$1.name && !containsEsc &&
          (!this.potentialArrowInForAwait || this.value !== "of" || this.containsEsc)) {
        id = this.parseIdent(false);
        if (this.canInsertSemicolon() || !this.eat(types$1.arrow))
          { this.unexpected(); }
        return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], true, forInit)
      }
    }
    return id

  case types$1.regexp:
    var value = this.value;
    node = this.parseLiteral(value.value);
    node.regex = {pattern: value.pattern, flags: value.flags};
    return node

  case types$1.num: case types$1.string:
    return this.parseLiteral(this.value)

  case types$1._null: case types$1._true: case types$1._false:
    node = this.startNode();
    node.value = this.type === types$1._null ? null : this.type === types$1._true;
    node.raw = this.type.keyword;
    this.next();
    return this.finishNode(node, "Literal")

  case types$1.parenL:
    var start = this.start, expr = this.parseParenAndDistinguishExpression(canBeArrow, forInit);
    if (refDestructuringErrors) {
      if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr))
        { refDestructuringErrors.parenthesizedAssign = start; }
      if (refDestructuringErrors.parenthesizedBind < 0)
        { refDestructuringErrors.parenthesizedBind = start; }
    }
    return expr

  case types$1.bracketL:
    node = this.startNode();
    this.next();
    node.elements = this.parseExprList(types$1.bracketR, true, true, refDestructuringErrors);
    return this.finishNode(node, "ArrayExpression")

  case types$1.braceL:
    this.overrideContext(types.b_expr);
    return this.parseObj(false, refDestructuringErrors)

  case types$1._function:
    node = this.startNode();
    this.next();
    return this.parseFunction(node, 0)

  case types$1._class:
    return this.parseClass(this.startNode(), false)

  case types$1._new:
    return this.parseNew()

  case types$1.backQuote:
    return this.parseTemplate()

  case types$1._import:
    if (this.options.ecmaVersion >= 11) {
      return this.parseExprImport(forNew)
    } else {
      return this.unexpected()
    }

  default:
    return this.parseExprAtomDefault()
  }
};

pp$5.parseExprAtomDefault = function() {
  this.unexpected();
};

pp$5.parseExprImport = function(forNew) {
  var node = this.startNode();

  // Consume `import` as an identifier for `import.meta`.
  // Because `this.parseIdent(true)` doesn't check escape sequences, it needs the check of `this.containsEsc`.
  if (this.containsEsc) { this.raiseRecoverable(this.start, "Escape sequence in keyword import"); }
  this.next();

  if (this.type === types$1.parenL && !forNew) {
    return this.parseDynamicImport(node)
  } else if (this.type === types$1.dot) {
    var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
    meta.name = "import";
    node.meta = this.finishNode(meta, "Identifier");
    return this.parseImportMeta(node)
  } else {
    this.unexpected();
  }
};

pp$5.parseDynamicImport = function(node) {
  this.next(); // skip `(`

  // Parse node.source.
  node.source = this.parseMaybeAssign();

  if (this.options.ecmaVersion >= 16) {
    if (!this.eat(types$1.parenR)) {
      this.expect(types$1.comma);
      if (!this.afterTrailingComma(types$1.parenR)) {
        node.options = this.parseMaybeAssign();
        if (!this.eat(types$1.parenR)) {
          this.expect(types$1.comma);
          if (!this.afterTrailingComma(types$1.parenR)) {
            this.unexpected();
          }
        }
      } else {
        node.options = null;
      }
    } else {
      node.options = null;
    }
  } else {
    // Verify ending.
    if (!this.eat(types$1.parenR)) {
      var errorPos = this.start;
      if (this.eat(types$1.comma) && this.eat(types$1.parenR)) {
        this.raiseRecoverable(errorPos, "Trailing comma is not allowed in import()");
      } else {
        this.unexpected(errorPos);
      }
    }
  }

  return this.finishNode(node, "ImportExpression")
};

pp$5.parseImportMeta = function(node) {
  this.next(); // skip `.`

  var containsEsc = this.containsEsc;
  node.property = this.parseIdent(true);

  if (node.property.name !== "meta")
    { this.raiseRecoverable(node.property.start, "The only valid meta property for import is 'import.meta'"); }
  if (containsEsc)
    { this.raiseRecoverable(node.start, "'import.meta' must not contain escaped characters"); }
  if (this.options.sourceType !== "module" && !this.options.allowImportExportEverywhere)
    { this.raiseRecoverable(node.start, "Cannot use 'import.meta' outside a module"); }

  return this.finishNode(node, "MetaProperty")
};

pp$5.parseLiteral = function(value) {
  var node = this.startNode();
  node.value = value;
  node.raw = this.input.slice(this.start, this.end);
  if (node.raw.charCodeAt(node.raw.length - 1) === 110)
    { node.bigint = node.value != null ? node.value.toString() : node.raw.slice(0, -1).replace(/_/g, ""); }
  this.next();
  return this.finishNode(node, "Literal")
};

pp$5.parseParenExpression = function() {
  this.expect(types$1.parenL);
  var val = this.parseExpression();
  this.expect(types$1.parenR);
  return val
};

pp$5.shouldParseArrow = function(exprList) {
  return !this.canInsertSemicolon()
};

pp$5.parseParenAndDistinguishExpression = function(canBeArrow, forInit) {
  var startPos = this.start, startLoc = this.startLoc, val, allowTrailingComma = this.options.ecmaVersion >= 8;
  if (this.options.ecmaVersion >= 6) {
    this.next();

    var innerStartPos = this.start, innerStartLoc = this.startLoc;
    var exprList = [], first = true, lastIsComma = false;
    var refDestructuringErrors = new DestructuringErrors, oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, spreadStart;
    this.yieldPos = 0;
    this.awaitPos = 0;
    // Do not save awaitIdentPos to allow checking awaits nested in parameters
    while (this.type !== types$1.parenR) {
      first ? first = false : this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(types$1.parenR, true)) {
        lastIsComma = true;
        break
      } else if (this.type === types$1.ellipsis) {
        spreadStart = this.start;
        exprList.push(this.parseParenItem(this.parseRestBinding()));
        if (this.type === types$1.comma) {
          this.raiseRecoverable(
            this.start,
            "Comma is not permitted after the rest element"
          );
        }
        break
      } else {
        exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
      }
    }
    var innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc;
    this.expect(types$1.parenR);

    if (canBeArrow && this.shouldParseArrow(exprList) && this.eat(types$1.arrow)) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      return this.parseParenArrowList(startPos, startLoc, exprList, forInit)
    }

    if (!exprList.length || lastIsComma) { this.unexpected(this.lastTokStart); }
    if (spreadStart) { this.unexpected(spreadStart); }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;

    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }
  } else {
    val = this.parseParenExpression();
  }

  if (this.options.preserveParens) {
    var par = this.startNodeAt(startPos, startLoc);
    par.expression = val;
    return this.finishNode(par, "ParenthesizedExpression")
  } else {
    return val
  }
};

pp$5.parseParenItem = function(item) {
  return item
};

pp$5.parseParenArrowList = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, false, forInit)
};

// New's precedence is slightly tricky. It must allow its argument to
// be a `[]` or dot subscript expression, but not a call — at least,
// not without wrapping it in parentheses. Thus, it uses the noCalls
// argument to parseSubscripts to prevent it from consuming the
// argument list.

var empty = [];

pp$5.parseNew = function() {
  if (this.containsEsc) { this.raiseRecoverable(this.start, "Escape sequence in keyword new"); }
  var node = this.startNode();
  this.next();
  if (this.options.ecmaVersion >= 6 && this.type === types$1.dot) {
    var meta = this.startNodeAt(node.start, node.loc && node.loc.start);
    meta.name = "new";
    node.meta = this.finishNode(meta, "Identifier");
    this.next();
    var containsEsc = this.containsEsc;
    node.property = this.parseIdent(true);
    if (node.property.name !== "target")
      { this.raiseRecoverable(node.property.start, "The only valid meta property for new is 'new.target'"); }
    if (containsEsc)
      { this.raiseRecoverable(node.start, "'new.target' must not contain escaped characters"); }
    if (!this.allowNewDotTarget)
      { this.raiseRecoverable(node.start, "'new.target' can only be used in functions and class static block"); }
    return this.finishNode(node, "MetaProperty")
  }
  var startPos = this.start, startLoc = this.startLoc;
  node.callee = this.parseSubscripts(this.parseExprAtom(null, false, true), startPos, startLoc, true, false);
  if (node.callee.type === "Super")
    { this.raiseRecoverable(startPos, "Invalid use of 'super'"); }
  if (this.eat(types$1.parenL)) { node.arguments = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false); }
  else { node.arguments = empty; }
  return this.finishNode(node, "NewExpression")
};

// Parse template expression.

pp$5.parseTemplateElement = function(ref) {
  var isTagged = ref.isTagged;

  var elem = this.startNode();
  if (this.type === types$1.invalidTemplate) {
    if (!isTagged) {
      this.raiseRecoverable(this.start, "Bad escape sequence in untagged template literal");
    }
    elem.value = {
      raw: this.value.replace(/\r\n?/g, "\n"),
      cooked: null
    };
  } else {
    elem.value = {
      raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
      cooked: this.value
    };
  }
  this.next();
  elem.tail = this.type === types$1.backQuote;
  return this.finishNode(elem, "TemplateElement")
};

pp$5.parseTemplate = function(ref) {
  if ( ref === void 0 ) ref = {};
  var isTagged = ref.isTagged; if ( isTagged === void 0 ) isTagged = false;

  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement({isTagged: isTagged});
  node.quasis = [curElt];
  while (!curElt.tail) {
    if (this.type === types$1.eof) { this.raise(this.pos, "Unterminated template literal"); }
    this.expect(types$1.dollarBraceL);
    node.expressions.push(this.parseExpression());
    this.expect(types$1.braceR);
    node.quasis.push(curElt = this.parseTemplateElement({isTagged: isTagged}));
  }
  this.next();
  return this.finishNode(node, "TemplateLiteral")
};

pp$5.isAsyncProp = function(prop) {
  return !prop.computed && prop.key.type === "Identifier" && prop.key.name === "async" &&
    (this.type === types$1.name || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword || (this.options.ecmaVersion >= 9 && this.type === types$1.star)) &&
    !lineBreak.test(this.input.slice(this.lastTokEnd, this.start))
};

// Parse an object literal or binding pattern.

pp$5.parseObj = function(isPattern, refDestructuringErrors) {
  var node = this.startNode(), first = true, propHash = {};
  node.properties = [];
  this.next();
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.options.ecmaVersion >= 5 && this.afterTrailingComma(types$1.braceR)) { break }
    } else { first = false; }

    var prop = this.parseProperty(isPattern, refDestructuringErrors);
    if (!isPattern) { this.checkPropClash(prop, propHash, refDestructuringErrors); }
    node.properties.push(prop);
  }
  return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression")
};

pp$5.parseProperty = function(isPattern, refDestructuringErrors) {
  var prop = this.startNode(), isGenerator, isAsync, startPos, startLoc;
  if (this.options.ecmaVersion >= 9 && this.eat(types$1.ellipsis)) {
    if (isPattern) {
      prop.argument = this.parseIdent(false);
      if (this.type === types$1.comma) {
        this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
      }
      return this.finishNode(prop, "RestElement")
    }
    // Parse argument.
    prop.argument = this.parseMaybeAssign(false, refDestructuringErrors);
    // To disallow trailing comma via `this.toAssignable()`.
    if (this.type === types$1.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
      refDestructuringErrors.trailingComma = this.start;
    }
    // Finish
    return this.finishNode(prop, "SpreadElement")
  }
  if (this.options.ecmaVersion >= 6) {
    prop.method = false;
    prop.shorthand = false;
    if (isPattern || refDestructuringErrors) {
      startPos = this.start;
      startLoc = this.startLoc;
    }
    if (!isPattern)
      { isGenerator = this.eat(types$1.star); }
  }
  var containsEsc = this.containsEsc;
  this.parsePropertyName(prop);
  if (!isPattern && !containsEsc && this.options.ecmaVersion >= 8 && !isGenerator && this.isAsyncProp(prop)) {
    isAsync = true;
    isGenerator = this.options.ecmaVersion >= 9 && this.eat(types$1.star);
    this.parsePropertyName(prop);
  } else {
    isAsync = false;
  }
  this.parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc);
  return this.finishNode(prop, "Property")
};

pp$5.parseGetterSetter = function(prop) {
  var kind = prop.key.name;
  this.parsePropertyName(prop);
  prop.value = this.parseMethod(false);
  prop.kind = kind;
  var paramCount = prop.kind === "get" ? 0 : 1;
  if (prop.value.params.length !== paramCount) {
    var start = prop.value.start;
    if (prop.kind === "get")
      { this.raiseRecoverable(start, "getter should have no params"); }
    else
      { this.raiseRecoverable(start, "setter should have exactly one param"); }
  } else {
    if (prop.kind === "set" && prop.value.params[0].type === "RestElement")
      { this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params"); }
  }
};

pp$5.parsePropertyValue = function(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
  if ((isGenerator || isAsync) && this.type === types$1.colon)
    { this.unexpected(); }

  if (this.eat(types$1.colon)) {
    prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
    prop.kind = "init";
  } else if (this.options.ecmaVersion >= 6 && this.type === types$1.parenL) {
    if (isPattern) { this.unexpected(); }
    prop.method = true;
    prop.value = this.parseMethod(isGenerator, isAsync);
    prop.kind = "init";
  } else if (!isPattern && !containsEsc &&
             this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" &&
             (prop.key.name === "get" || prop.key.name === "set") &&
             (this.type !== types$1.comma && this.type !== types$1.braceR && this.type !== types$1.eq)) {
    if (isGenerator || isAsync) { this.unexpected(); }
    this.parseGetterSetter(prop);
  } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
    if (isGenerator || isAsync) { this.unexpected(); }
    this.checkUnreserved(prop.key);
    if (prop.key.name === "await" && !this.awaitIdentPos)
      { this.awaitIdentPos = startPos; }
    if (isPattern) {
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else if (this.type === types$1.eq && refDestructuringErrors) {
      if (refDestructuringErrors.shorthandAssign < 0)
        { refDestructuringErrors.shorthandAssign = this.start; }
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else {
      prop.value = this.copyNode(prop.key);
    }
    prop.kind = "init";
    prop.shorthand = true;
  } else { this.unexpected(); }
};

pp$5.parsePropertyName = function(prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(types$1.bracketL)) {
      prop.computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(types$1.bracketR);
      return prop.key
    } else {
      prop.computed = false;
    }
  }
  return prop.key = this.type === types$1.num || this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never")
};

// Initialize empty function node.

pp$5.initFunction = function(node) {
  node.id = null;
  if (this.options.ecmaVersion >= 6) { node.generator = node.expression = false; }
  if (this.options.ecmaVersion >= 8) { node.async = false; }
};

// Parse object or class method.

pp$5.parseMethod = function(isGenerator, isAsync, allowDirectSuper) {
  var node = this.startNode(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;

  this.initFunction(node);
  if (this.options.ecmaVersion >= 6)
    { node.generator = isGenerator; }
  if (this.options.ecmaVersion >= 8)
    { node.async = !!isAsync; }

  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(isAsync, node.generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0));

  this.expect(types$1.parenL);
  node.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
  this.parseFunctionBody(node, false, true, false);

  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, "FunctionExpression")
};

// Parse arrow function expression with given parameters.

pp$5.parseArrowExpression = function(node, params, isAsync, forInit) {
  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;

  this.enterScope(functionFlags(isAsync, false) | SCOPE_ARROW);
  this.initFunction(node);
  if (this.options.ecmaVersion >= 8) { node.async = !!isAsync; }

  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;

  node.params = this.toAssignableList(params, true);
  this.parseFunctionBody(node, true, false, forInit);

  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node, "ArrowFunctionExpression")
};

// Parse function body and check parameters.

pp$5.parseFunctionBody = function(node, isArrowFunction, isMethod, forInit) {
  var isExpression = isArrowFunction && this.type !== types$1.braceL;
  var oldStrict = this.strict, useStrict = false;

  if (isExpression) {
    node.body = this.parseMaybeAssign(forInit);
    node.expression = true;
    this.checkParams(node, false);
  } else {
    var nonSimple = this.options.ecmaVersion >= 7 && !this.isSimpleParamList(node.params);
    if (!oldStrict || nonSimple) {
      useStrict = this.strictDirective(this.end);
      // If this is a strict mode function, verify that argument names
      // are not repeated, and it does not try to bind the words `eval`
      // or `arguments`.
      if (useStrict && nonSimple)
        { this.raiseRecoverable(node.start, "Illegal 'use strict' directive in function with non-simple parameter list"); }
    }
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    var oldLabels = this.labels;
    this.labels = [];
    if (useStrict) { this.strict = true; }

    // Add the params to varDeclaredNames to ensure that an error is thrown
    // if a let/const declaration in the function clashes with one of the params.
    this.checkParams(node, !oldStrict && !useStrict && !isArrowFunction && !isMethod && this.isSimpleParamList(node.params));
    // Ensure the function name isn't a forbidden identifier in strict mode, e.g. 'eval'
    if (this.strict && node.id) { this.checkLValSimple(node.id, BIND_OUTSIDE); }
    node.body = this.parseBlock(false, undefined, useStrict && !oldStrict);
    node.expression = false;
    this.adaptDirectivePrologue(node.body.body);
    this.labels = oldLabels;
  }
  this.exitScope();
};

pp$5.isSimpleParamList = function(params) {
  for (var i = 0, list = params; i < list.length; i += 1)
    {
    var param = list[i];

    if (param.type !== "Identifier") { return false
  } }
  return true
};

// Checks function params for various disallowed patterns such as using "eval"
// or "arguments" and duplicate parameters.

pp$5.checkParams = function(node, allowDuplicates) {
  var nameHash = Object.create(null);
  for (var i = 0, list = node.params; i < list.length; i += 1)
    {
    var param = list[i];

    this.checkLValInnerPattern(param, BIND_VAR, allowDuplicates ? null : nameHash);
  }
};

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

pp$5.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (!first) {
      this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(close)) { break }
    } else { first = false; }

    var elt = (void 0);
    if (allowEmpty && this.type === types$1.comma)
      { elt = null; }
    else if (this.type === types$1.ellipsis) {
      elt = this.parseSpread(refDestructuringErrors);
      if (refDestructuringErrors && this.type === types$1.comma && refDestructuringErrors.trailingComma < 0)
        { refDestructuringErrors.trailingComma = this.start; }
    } else {
      elt = this.parseMaybeAssign(false, refDestructuringErrors);
    }
    elts.push(elt);
  }
  return elts
};

pp$5.checkUnreserved = function(ref) {
  var start = ref.start;
  var end = ref.end;
  var name = ref.name;

  if (this.inGenerator && name === "yield")
    { this.raiseRecoverable(start, "Cannot use 'yield' as identifier inside a generator"); }
  if (this.inAsync && name === "await")
    { this.raiseRecoverable(start, "Cannot use 'await' as identifier inside an async function"); }
  if (!(this.currentThisScope().flags & SCOPE_VAR) && name === "arguments")
    { this.raiseRecoverable(start, "Cannot use 'arguments' in class field initializer"); }
  if (this.inClassStaticBlock && (name === "arguments" || name === "await"))
    { this.raise(start, ("Cannot use " + name + " in class static initialization block")); }
  if (this.keywords.test(name))
    { this.raise(start, ("Unexpected keyword '" + name + "'")); }
  if (this.options.ecmaVersion < 6 &&
    this.input.slice(start, end).indexOf("\\") !== -1) { return }
  var re = this.strict ? this.reservedWordsStrict : this.reservedWords;
  if (re.test(name)) {
    if (!this.inAsync && name === "await")
      { this.raiseRecoverable(start, "Cannot use keyword 'await' outside an async function"); }
    this.raiseRecoverable(start, ("The keyword '" + name + "' is reserved"));
  }
};

// Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.

pp$5.parseIdent = function(liberal) {
  var node = this.parseIdentNode();
  this.next(!!liberal);
  this.finishNode(node, "Identifier");
  if (!liberal) {
    this.checkUnreserved(node);
    if (node.name === "await" && !this.awaitIdentPos)
      { this.awaitIdentPos = node.start; }
  }
  return node
};

pp$5.parseIdentNode = function() {
  var node = this.startNode();
  if (this.type === types$1.name) {
    node.name = this.value;
  } else if (this.type.keyword) {
    node.name = this.type.keyword;

    // To fix https://github.com/acornjs/acorn/issues/575
    // `class` and `function` keywords push new context into this.context.
    // But there is no chance to pop the context if the keyword is consumed as an identifier such as a property name.
    // If the previous token is a dot, this does not apply because the context-managing code already ignored the keyword
    if ((node.name === "class" || node.name === "function") &&
      (this.lastTokEnd !== this.lastTokStart + 1 || this.input.charCodeAt(this.lastTokStart) !== 46)) {
      this.context.pop();
    }
    this.type = types$1.name;
  } else {
    this.unexpected();
  }
  return node
};

pp$5.parsePrivateIdent = function() {
  var node = this.startNode();
  if (this.type === types$1.privateId) {
    node.name = this.value;
  } else {
    this.unexpected();
  }
  this.next();
  this.finishNode(node, "PrivateIdentifier");

  // For validating existence
  if (this.options.checkPrivateFields) {
    if (this.privateNameStack.length === 0) {
      this.raise(node.start, ("Private field '#" + (node.name) + "' must be declared in an enclosing class"));
    } else {
      this.privateNameStack[this.privateNameStack.length - 1].used.push(node);
    }
  }

  return node
};

// Parses yield expression inside generator.

pp$5.parseYield = function(forInit) {
  if (!this.yieldPos) { this.yieldPos = this.start; }

  var node = this.startNode();
  this.next();
  if (this.type === types$1.semi || this.canInsertSemicolon() || (this.type !== types$1.star && !this.type.startsExpr)) {
    node.delegate = false;
    node.argument = null;
  } else {
    node.delegate = this.eat(types$1.star);
    node.argument = this.parseMaybeAssign(forInit);
  }
  return this.finishNode(node, "YieldExpression")
};

pp$5.parseAwait = function(forInit) {
  if (!this.awaitPos) { this.awaitPos = this.start; }

  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeUnary(null, true, false, forInit);
  return this.finishNode(node, "AwaitExpression")
};

var pp$4 = Parser.prototype;

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

pp$4.raise = function(pos, message) {
  var loc = getLineInfo(this.input, pos);
  message += " (" + loc.line + ":" + loc.column + ")";
  if (this.sourceFile) {
    message += " in " + this.sourceFile;
  }
  var err = new SyntaxError(message);
  err.pos = pos; err.loc = loc; err.raisedAt = this.pos;
  throw err
};

pp$4.raiseRecoverable = pp$4.raise;

pp$4.curPosition = function() {
  if (this.options.locations) {
    return new Position(this.curLine, this.pos - this.lineStart)
  }
};

var pp$3 = Parser.prototype;

var Scope = function Scope(flags) {
  this.flags = flags;
  // A list of var-declared names in the current lexical scope
  this.var = [];
  // A list of lexically-declared names in the current lexical scope
  this.lexical = [];
  // A list of lexically-declared FunctionDeclaration names in the current lexical scope
  this.functions = [];
};

// The functions in this module keep track of declared variables in the current scope in order to detect duplicate variable names.

pp$3.enterScope = function(flags) {
  this.scopeStack.push(new Scope(flags));
};

pp$3.exitScope = function() {
  this.scopeStack.pop();
};

// The spec says:
// > At the top level of a function, or script, function declarations are
// > treated like var declarations rather than like lexical declarations.
pp$3.treatFunctionsAsVarInScope = function(scope) {
  return (scope.flags & SCOPE_FUNCTION) || !this.inModule && (scope.flags & SCOPE_TOP)
};

pp$3.declareName = function(name, bindingType, pos) {
  var redeclared = false;
  if (bindingType === BIND_LEXICAL) {
    var scope = this.currentScope();
    redeclared = scope.lexical.indexOf(name) > -1 || scope.functions.indexOf(name) > -1 || scope.var.indexOf(name) > -1;
    scope.lexical.push(name);
    if (this.inModule && (scope.flags & SCOPE_TOP))
      { delete this.undefinedExports[name]; }
  } else if (bindingType === BIND_SIMPLE_CATCH) {
    var scope$1 = this.currentScope();
    scope$1.lexical.push(name);
  } else if (bindingType === BIND_FUNCTION) {
    var scope$2 = this.currentScope();
    if (this.treatFunctionsAsVar)
      { redeclared = scope$2.lexical.indexOf(name) > -1; }
    else
      { redeclared = scope$2.lexical.indexOf(name) > -1 || scope$2.var.indexOf(name) > -1; }
    scope$2.functions.push(name);
  } else {
    for (var i = this.scopeStack.length - 1; i >= 0; --i) {
      var scope$3 = this.scopeStack[i];
      if (scope$3.lexical.indexOf(name) > -1 && !((scope$3.flags & SCOPE_SIMPLE_CATCH) && scope$3.lexical[0] === name) ||
          !this.treatFunctionsAsVarInScope(scope$3) && scope$3.functions.indexOf(name) > -1) {
        redeclared = true;
        break
      }
      scope$3.var.push(name);
      if (this.inModule && (scope$3.flags & SCOPE_TOP))
        { delete this.undefinedExports[name]; }
      if (scope$3.flags & SCOPE_VAR) { break }
    }
  }
  if (redeclared) { this.raiseRecoverable(pos, ("Identifier '" + name + "' has already been declared")); }
};

pp$3.checkLocalExport = function(id) {
  // scope.functions must be empty as Module code is always strict.
  if (this.scopeStack[0].lexical.indexOf(id.name) === -1 &&
      this.scopeStack[0].var.indexOf(id.name) === -1) {
    this.undefinedExports[id.name] = id;
  }
};

pp$3.currentScope = function() {
  return this.scopeStack[this.scopeStack.length - 1]
};

pp$3.currentVarScope = function() {
  for (var i = this.scopeStack.length - 1;; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) { return scope }
  }
};

// Could be useful for `this`, `new.target`, `super()`, `super.property`, and `super[property]`.
pp$3.currentThisScope = function() {
  for (var i = this.scopeStack.length - 1;; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) &&
        !(scope.flags & SCOPE_ARROW)) { return scope }
  }
};

var Node = function Node(parser, pos, loc) {
  this.type = "";
  this.start = pos;
  this.end = 0;
  if (parser.options.locations)
    { this.loc = new SourceLocation(parser, loc); }
  if (parser.options.directSourceFile)
    { this.sourceFile = parser.options.directSourceFile; }
  if (parser.options.ranges)
    { this.range = [pos, 0]; }
};

// Start an AST node, attaching a start offset.

var pp$2 = Parser.prototype;

pp$2.startNode = function() {
  return new Node(this, this.start, this.startLoc)
};

pp$2.startNodeAt = function(pos, loc) {
  return new Node(this, pos, loc)
};

// Finish an AST node, adding `type` and `end` properties.

function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations)
    { node.loc.end = loc; }
  if (this.options.ranges)
    { node.range[1] = pos; }
  return node
}

pp$2.finishNode = function(node, type) {
  return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc)
};

// Finish node at given position

pp$2.finishNodeAt = function(node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc)
};

pp$2.copyNode = function(node) {
  var newNode = new Node(this, node.start, this.startLoc);
  for (var prop in node) { newNode[prop] = node[prop]; }
  return newNode
};

// This file was generated by "bin/generate-unicode-script-values.js". Do not modify manually!
var scriptValuesAddedInUnicode = "Berf Beria_Erfe Gara Garay Gukh Gurung_Khema Hrkt Katakana_Or_Hiragana Kawi Kirat_Rai Krai Nag_Mundari Nagm Ol_Onal Onao Sidetic Sidt Sunu Sunuwar Tai_Yo Tayo Todhri Todr Tolong_Siki Tols Tulu_Tigalari Tutg Unknown Zzzz";

// This file contains Unicode properties extracted from the ECMAScript specification.
// The lists are extracted like so:
// $$('#table-binary-unicode-properties > figure > table > tbody > tr > td:nth-child(1) code').map(el => el.innerText)

// #table-binary-unicode-properties
var ecma9BinaryProperties = "ASCII ASCII_Hex_Digit AHex Alphabetic Alpha Any Assigned Bidi_Control Bidi_C Bidi_Mirrored Bidi_M Case_Ignorable CI Cased Changes_When_Casefolded CWCF Changes_When_Casemapped CWCM Changes_When_Lowercased CWL Changes_When_NFKC_Casefolded CWKCF Changes_When_Titlecased CWT Changes_When_Uppercased CWU Dash Default_Ignorable_Code_Point DI Deprecated Dep Diacritic Dia Emoji Emoji_Component Emoji_Modifier Emoji_Modifier_Base Emoji_Presentation Extender Ext Grapheme_Base Gr_Base Grapheme_Extend Gr_Ext Hex_Digit Hex IDS_Binary_Operator IDSB IDS_Trinary_Operator IDST ID_Continue IDC ID_Start IDS Ideographic Ideo Join_Control Join_C Logical_Order_Exception LOE Lowercase Lower Math Noncharacter_Code_Point NChar Pattern_Syntax Pat_Syn Pattern_White_Space Pat_WS Quotation_Mark QMark Radical Regional_Indicator RI Sentence_Terminal STerm Soft_Dotted SD Terminal_Punctuation Term Unified_Ideograph UIdeo Uppercase Upper Variation_Selector VS White_Space space XID_Continue XIDC XID_Start XIDS";
var ecma10BinaryProperties = ecma9BinaryProperties + " Extended_Pictographic";
var ecma11BinaryProperties = ecma10BinaryProperties;
var ecma12BinaryProperties = ecma11BinaryProperties + " EBase EComp EMod EPres ExtPict";
var ecma13BinaryProperties = ecma12BinaryProperties;
var ecma14BinaryProperties = ecma13BinaryProperties;

var unicodeBinaryProperties = {
  9: ecma9BinaryProperties,
  10: ecma10BinaryProperties,
  11: ecma11BinaryProperties,
  12: ecma12BinaryProperties,
  13: ecma13BinaryProperties,
  14: ecma14BinaryProperties
};

// #table-binary-unicode-properties-of-strings
var ecma14BinaryPropertiesOfStrings = "Basic_Emoji Emoji_Keycap_Sequence RGI_Emoji_Modifier_Sequence RGI_Emoji_Flag_Sequence RGI_Emoji_Tag_Sequence RGI_Emoji_ZWJ_Sequence RGI_Emoji";

var unicodeBinaryPropertiesOfStrings = {
  9: "",
  10: "",
  11: "",
  12: "",
  13: "",
  14: ecma14BinaryPropertiesOfStrings
};

// #table-unicode-general-category-values
var unicodeGeneralCategoryValues = "Cased_Letter LC Close_Punctuation Pe Connector_Punctuation Pc Control Cc cntrl Currency_Symbol Sc Dash_Punctuation Pd Decimal_Number Nd digit Enclosing_Mark Me Final_Punctuation Pf Format Cf Initial_Punctuation Pi Letter L Letter_Number Nl Line_Separator Zl Lowercase_Letter Ll Mark M Combining_Mark Math_Symbol Sm Modifier_Letter Lm Modifier_Symbol Sk Nonspacing_Mark Mn Number N Open_Punctuation Ps Other C Other_Letter Lo Other_Number No Other_Punctuation Po Other_Symbol So Paragraph_Separator Zp Private_Use Co Punctuation P punct Separator Z Space_Separator Zs Spacing_Mark Mc Surrogate Cs Symbol S Titlecase_Letter Lt Unassigned Cn Uppercase_Letter Lu";

// #table-unicode-script-values
var ecma9ScriptValues = "Adlam Adlm Ahom Anatolian_Hieroglyphs Hluw Arabic Arab Armenian Armn Avestan Avst Balinese Bali Bamum Bamu Bassa_Vah Bass Batak Batk Bengali Beng Bhaiksuki Bhks Bopomofo Bopo Brahmi Brah Braille Brai Buginese Bugi Buhid Buhd Canadian_Aboriginal Cans Carian Cari Caucasian_Albanian Aghb Chakma Cakm Cham Cham Cherokee Cher Common Zyyy Coptic Copt Qaac Cuneiform Xsux Cypriot Cprt Cyrillic Cyrl Deseret Dsrt Devanagari Deva Duployan Dupl Egyptian_Hieroglyphs Egyp Elbasan Elba Ethiopic Ethi Georgian Geor Glagolitic Glag Gothic Goth Grantha Gran Greek Grek Gujarati Gujr Gurmukhi Guru Han Hani Hangul Hang Hanunoo Hano Hatran Hatr Hebrew Hebr Hiragana Hira Imperial_Aramaic Armi Inherited Zinh Qaai Inscriptional_Pahlavi Phli Inscriptional_Parthian Prti Javanese Java Kaithi Kthi Kannada Knda Katakana Kana Kayah_Li Kali Kharoshthi Khar Khmer Khmr Khojki Khoj Khudawadi Sind Lao Laoo Latin Latn Lepcha Lepc Limbu Limb Linear_A Lina Linear_B Linb Lisu Lisu Lycian Lyci Lydian Lydi Mahajani Mahj Malayalam Mlym Mandaic Mand Manichaean Mani Marchen Marc Masaram_Gondi Gonm Meetei_Mayek Mtei Mende_Kikakui Mend Meroitic_Cursive Merc Meroitic_Hieroglyphs Mero Miao Plrd Modi Mongolian Mong Mro Mroo Multani Mult Myanmar Mymr Nabataean Nbat New_Tai_Lue Talu Newa Newa Nko Nkoo Nushu Nshu Ogham Ogam Ol_Chiki Olck Old_Hungarian Hung Old_Italic Ital Old_North_Arabian Narb Old_Permic Perm Old_Persian Xpeo Old_South_Arabian Sarb Old_Turkic Orkh Oriya Orya Osage Osge Osmanya Osma Pahawh_Hmong Hmng Palmyrene Palm Pau_Cin_Hau Pauc Phags_Pa Phag Phoenician Phnx Psalter_Pahlavi Phlp Rejang Rjng Runic Runr Samaritan Samr Saurashtra Saur Sharada Shrd Shavian Shaw Siddham Sidd SignWriting Sgnw Sinhala Sinh Sora_Sompeng Sora Soyombo Soyo Sundanese Sund Syloti_Nagri Sylo Syriac Syrc Tagalog Tglg Tagbanwa Tagb Tai_Le Tale Tai_Tham Lana Tai_Viet Tavt Takri Takr Tamil Taml Tangut Tang Telugu Telu Thaana Thaa Thai Thai Tibetan Tibt Tifinagh Tfng Tirhuta Tirh Ugaritic Ugar Vai Vaii Warang_Citi Wara Yi Yiii Zanabazar_Square Zanb";
var ecma10ScriptValues = ecma9ScriptValues + " Dogra Dogr Gunjala_Gondi Gong Hanifi_Rohingya Rohg Makasar Maka Medefaidrin Medf Old_Sogdian Sogo Sogdian Sogd";
var ecma11ScriptValues = ecma10ScriptValues + " Elymaic Elym Nandinagari Nand Nyiakeng_Puachue_Hmong Hmnp Wancho Wcho";
var ecma12ScriptValues = ecma11ScriptValues + " Chorasmian Chrs Diak Dives_Akuru Khitan_Small_Script Kits Yezi Yezidi";
var ecma13ScriptValues = ecma12ScriptValues + " Cypro_Minoan Cpmn Old_Uyghur Ougr Tangsa Tnsa Toto Vithkuqi Vith";
var ecma14ScriptValues = ecma13ScriptValues + " " + scriptValuesAddedInUnicode;

var unicodeScriptValues = {
  9: ecma9ScriptValues,
  10: ecma10ScriptValues,
  11: ecma11ScriptValues,
  12: ecma12ScriptValues,
  13: ecma13ScriptValues,
  14: ecma14ScriptValues
};

var data = {};
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary: wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script: wordsRegexp(unicodeScriptValues[ecmaVersion])
    }
  };
  d.nonBinary.Script_Extensions = d.nonBinary.Script;

  d.nonBinary.gc = d.nonBinary.General_Category;
  d.nonBinary.sc = d.nonBinary.Script;
  d.nonBinary.scx = d.nonBinary.Script_Extensions;
}

for (var i = 0, list = [9, 10, 11, 12, 13, 14]; i < list.length; i += 1) {
  var ecmaVersion = list[i];

  buildUnicodeData(ecmaVersion);
}

var pp$1 = Parser.prototype;

// Track disjunction structure to determine whether a duplicate
// capture group name is allowed because it is in a separate branch.
var BranchID = function BranchID(parent, base) {
  // Parent disjunction branch
  this.parent = parent;
  // Identifies this set of sibling branches
  this.base = base || this;
};

BranchID.prototype.separatedFrom = function separatedFrom (alt) {
  // A branch is separate from another branch if they or any of
  // their parents are siblings in a given disjunction
  for (var self = this; self; self = self.parent) {
    for (var other = alt; other; other = other.parent) {
      if (self.base === other.base && self !== other) { return true }
    }
  }
  return false
};

BranchID.prototype.sibling = function sibling () {
  return new BranchID(this.parent, this.base)
};

var RegExpValidationState = function RegExpValidationState(parser) {
  this.parser = parser;
  this.validFlags = "gim" + (parser.options.ecmaVersion >= 6 ? "uy" : "") + (parser.options.ecmaVersion >= 9 ? "s" : "") + (parser.options.ecmaVersion >= 13 ? "d" : "") + (parser.options.ecmaVersion >= 15 ? "v" : "");
  this.unicodeProperties = data[parser.options.ecmaVersion >= 14 ? 14 : parser.options.ecmaVersion];
  this.source = "";
  this.flags = "";
  this.start = 0;
  this.switchU = false;
  this.switchV = false;
  this.switchN = false;
  this.pos = 0;
  this.lastIntValue = 0;
  this.lastStringValue = "";
  this.lastAssertionIsQuantifiable = false;
  this.numCapturingParens = 0;
  this.maxBackReference = 0;
  this.groupNames = Object.create(null);
  this.backReferenceNames = [];
  this.branchID = null;
};

RegExpValidationState.prototype.reset = function reset (start, pattern, flags) {
  var unicodeSets = flags.indexOf("v") !== -1;
  var unicode = flags.indexOf("u") !== -1;
  this.start = start | 0;
  this.source = pattern + "";
  this.flags = flags;
  if (unicodeSets && this.parser.options.ecmaVersion >= 15) {
    this.switchU = true;
    this.switchV = true;
    this.switchN = true;
  } else {
    this.switchU = unicode && this.parser.options.ecmaVersion >= 6;
    this.switchV = false;
    this.switchN = unicode && this.parser.options.ecmaVersion >= 9;
  }
};

RegExpValidationState.prototype.raise = function raise (message) {
  this.parser.raiseRecoverable(this.start, ("Invalid regular expression: /" + (this.source) + "/: " + message));
};

// If u flag is given, this returns the code point at the index (it combines a surrogate pair).
// Otherwise, this returns the code unit of the index (can be a part of a surrogate pair).
RegExpValidationState.prototype.at = function at (i, forceU) {
    if ( forceU === void 0 ) forceU = false;

  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return -1
  }
  var c = s.charCodeAt(i);
  if (!(forceU || this.switchU) || c <= 0xD7FF || c >= 0xE000 || i + 1 >= l) {
    return c
  }
  var next = s.charCodeAt(i + 1);
  return next >= 0xDC00 && next <= 0xDFFF ? (c << 10) + next - 0x35FDC00 : c
};

RegExpValidationState.prototype.nextIndex = function nextIndex (i, forceU) {
    if ( forceU === void 0 ) forceU = false;

  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return l
  }
  var c = s.charCodeAt(i), next;
  if (!(forceU || this.switchU) || c <= 0xD7FF || c >= 0xE000 || i + 1 >= l ||
      (next = s.charCodeAt(i + 1)) < 0xDC00 || next > 0xDFFF) {
    return i + 1
  }
  return i + 2
};

RegExpValidationState.prototype.current = function current (forceU) {
    if ( forceU === void 0 ) forceU = false;

  return this.at(this.pos, forceU)
};

RegExpValidationState.prototype.lookahead = function lookahead (forceU) {
    if ( forceU === void 0 ) forceU = false;

  return this.at(this.nextIndex(this.pos, forceU), forceU)
};

RegExpValidationState.prototype.advance = function advance (forceU) {
    if ( forceU === void 0 ) forceU = false;

  this.pos = this.nextIndex(this.pos, forceU);
};

RegExpValidationState.prototype.eat = function eat (ch, forceU) {
    if ( forceU === void 0 ) forceU = false;

  if (this.current(forceU) === ch) {
    this.advance(forceU);
    return true
  }
  return false
};

RegExpValidationState.prototype.eatChars = function eatChars (chs, forceU) {
    if ( forceU === void 0 ) forceU = false;

  var pos = this.pos;
  for (var i = 0, list = chs; i < list.length; i += 1) {
    var ch = list[i];

      var current = this.at(pos, forceU);
    if (current === -1 || current !== ch) {
      return false
    }
    pos = this.nextIndex(pos, forceU);
  }
  this.pos = pos;
  return true
};

/**
 * Validate the flags part of a given RegExpLiteral.
 *
 * @param {RegExpValidationState} state The state to validate RegExp.
 * @returns {void}
 */
pp$1.validateRegExpFlags = function(state) {
  var validFlags = state.validFlags;
  var flags = state.flags;

  var u = false;
  var v = false;

  for (var i = 0; i < flags.length; i++) {
    var flag = flags.charAt(i);
    if (validFlags.indexOf(flag) === -1) {
      this.raise(state.start, "Invalid regular expression flag");
    }
    if (flags.indexOf(flag, i + 1) > -1) {
      this.raise(state.start, "Duplicate regular expression flag");
    }
    if (flag === "u") { u = true; }
    if (flag === "v") { v = true; }
  }
  if (this.options.ecmaVersion >= 15 && u && v) {
    this.raise(state.start, "Invalid regular expression flag");
  }
};

function hasProp(obj) {
  for (var _ in obj) { return true }
  return false
}

/**
 * Validate the pattern part of a given RegExpLiteral.
 *
 * @param {RegExpValidationState} state The state to validate RegExp.
 * @returns {void}
 */
pp$1.validateRegExpPattern = function(state) {
  this.regexp_pattern(state);

  // The goal symbol for the parse is |Pattern[~U, ~N]|. If the result of
  // parsing contains a |GroupName|, reparse with the goal symbol
  // |Pattern[~U, +N]| and use this result instead. Throw a *SyntaxError*
  // exception if _P_ did not conform to the grammar, if any elements of _P_
  // were not matched by the parse, or if any Early Error conditions exist.
  if (!state.switchN && this.options.ecmaVersion >= 9 && hasProp(state.groupNames)) {
    state.switchN = true;
    this.regexp_pattern(state);
  }
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-Pattern
pp$1.regexp_pattern = function(state) {
  state.pos = 0;
  state.lastIntValue = 0;
  state.lastStringValue = "";
  state.lastAssertionIsQuantifiable = false;
  state.numCapturingParens = 0;
  state.maxBackReference = 0;
  state.groupNames = Object.create(null);
  state.backReferenceNames.length = 0;
  state.branchID = null;

  this.regexp_disjunction(state);

  if (state.pos !== state.source.length) {
    // Make the same messages as V8.
    if (state.eat(0x29 /* ) */)) {
      state.raise("Unmatched ')'");
    }
    if (state.eat(0x5D /* ] */) || state.eat(0x7D /* } */)) {
      state.raise("Lone quantifier brackets");
    }
  }
  if (state.maxBackReference > state.numCapturingParens) {
    state.raise("Invalid escape");
  }
  for (var i = 0, list = state.backReferenceNames; i < list.length; i += 1) {
    var name = list[i];

    if (!state.groupNames[name]) {
      state.raise("Invalid named capture referenced");
    }
  }
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-Disjunction
pp$1.regexp_disjunction = function(state) {
  var trackDisjunction = this.options.ecmaVersion >= 16;
  if (trackDisjunction) { state.branchID = new BranchID(state.branchID, null); }
  this.regexp_alternative(state);
  while (state.eat(0x7C /* | */)) {
    if (trackDisjunction) { state.branchID = state.branchID.sibling(); }
    this.regexp_alternative(state);
  }
  if (trackDisjunction) { state.branchID = state.branchID.parent; }

  // Make the same message as V8.
  if (this.regexp_eatQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  if (state.eat(0x7B /* { */)) {
    state.raise("Lone quantifier brackets");
  }
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-Alternative
pp$1.regexp_alternative = function(state) {
  while (state.pos < state.source.length && this.regexp_eatTerm(state)) {}
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-Term
pp$1.regexp_eatTerm = function(state) {
  if (this.regexp_eatAssertion(state)) {
    // Handle `QuantifiableAssertion Quantifier` alternative.
    // `state.lastAssertionIsQuantifiable` is true if the last eaten Assertion
    // is a QuantifiableAssertion.
    if (state.lastAssertionIsQuantifiable && this.regexp_eatQuantifier(state)) {
      // Make the same message as V8.
      if (state.switchU) {
        state.raise("Invalid quantifier");
      }
    }
    return true
  }

  if (state.switchU ? this.regexp_eatAtom(state) : this.regexp_eatExtendedAtom(state)) {
    this.regexp_eatQuantifier(state);
    return true
  }

  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-Assertion
pp$1.regexp_eatAssertion = function(state) {
  var start = state.pos;
  state.lastAssertionIsQuantifiable = false;

  // ^, $
  if (state.eat(0x5E /* ^ */) || state.eat(0x24 /* $ */)) {
    return true
  }

  // \b \B
  if (state.eat(0x5C /* \ */)) {
    if (state.eat(0x42 /* B */) || state.eat(0x62 /* b */)) {
      return true
    }
    state.pos = start;
  }

  // Lookahead / Lookbehind
  if (state.eat(0x28 /* ( */) && state.eat(0x3F /* ? */)) {
    var lookbehind = false;
    if (this.options.ecmaVersion >= 9) {
      lookbehind = state.eat(0x3C /* < */);
    }
    if (state.eat(0x3D /* = */) || state.eat(0x21 /* ! */)) {
      this.regexp_disjunction(state);
      if (!state.eat(0x29 /* ) */)) {
        state.raise("Unterminated group");
      }
      state.lastAssertionIsQuantifiable = !lookbehind;
      return true
    }
  }

  state.pos = start;
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-Quantifier
pp$1.regexp_eatQuantifier = function(state, noError) {
  if ( noError === void 0 ) noError = false;

  if (this.regexp_eatQuantifierPrefix(state, noError)) {
    state.eat(0x3F /* ? */);
    return true
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-QuantifierPrefix
pp$1.regexp_eatQuantifierPrefix = function(state, noError) {
  return (
    state.eat(0x2A /* * */) ||
    state.eat(0x2B /* + */) ||
    state.eat(0x3F /* ? */) ||
    this.regexp_eatBracedQuantifier(state, noError)
  )
};
pp$1.regexp_eatBracedQuantifier = function(state, noError) {
  var start = state.pos;
  if (state.eat(0x7B /* { */)) {
    var min = 0, max = -1;
    if (this.regexp_eatDecimalDigits(state)) {
      min = state.lastIntValue;
      if (state.eat(0x2C /* , */) && this.regexp_eatDecimalDigits(state)) {
        max = state.lastIntValue;
      }
      if (state.eat(0x7D /* } */)) {
        // SyntaxError in https://www.ecma-international.org/ecma-262/8.0/#sec-term
        if (max !== -1 && max < min && !noError) {
          state.raise("numbers out of order in {} quantifier");
        }
        return true
      }
    }
    if (state.switchU && !noError) {
      state.raise("Incomplete quantifier");
    }
    state.pos = start;
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-Atom
pp$1.regexp_eatAtom = function(state) {
  return (
    this.regexp_eatPatternCharacters(state) ||
    state.eat(0x2E /* . */) ||
    this.regexp_eatReverseSolidusAtomEscape(state) ||
    this.regexp_eatCharacterClass(state) ||
    this.regexp_eatUncapturingGroup(state) ||
    this.regexp_eatCapturingGroup(state)
  )
};
pp$1.regexp_eatReverseSolidusAtomEscape = function(state) {
  var start = state.pos;
  if (state.eat(0x5C /* \ */)) {
    if (this.regexp_eatAtomEscape(state)) {
      return true
    }
    state.pos = start;
  }
  return false
};
pp$1.regexp_eatUncapturingGroup = function(state) {
  var start = state.pos;
  if (state.eat(0x28 /* ( */)) {
    if (state.eat(0x3F /* ? */)) {
      if (this.options.ecmaVersion >= 16) {
        var addModifiers = this.regexp_eatModifiers(state);
        var hasHyphen = state.eat(0x2D /* - */);
        if (addModifiers || hasHyphen) {
          for (var i = 0; i < addModifiers.length; i++) {
            var modifier = addModifiers.charAt(i);
            if (addModifiers.indexOf(modifier, i + 1) > -1) {
              state.raise("Duplicate regular expression modifiers");
            }
          }
          if (hasHyphen) {
            var removeModifiers = this.regexp_eatModifiers(state);
            if (!addModifiers && !removeModifiers && state.current() === 0x3A /* : */) {
              state.raise("Invalid regular expression modifiers");
            }
            for (var i$1 = 0; i$1 < removeModifiers.length; i$1++) {
              var modifier$1 = removeModifiers.charAt(i$1);
              if (
                removeModifiers.indexOf(modifier$1, i$1 + 1) > -1 ||
                addModifiers.indexOf(modifier$1) > -1
              ) {
                state.raise("Duplicate regular expression modifiers");
              }
            }
          }
        }
      }
      if (state.eat(0x3A /* : */)) {
        this.regexp_disjunction(state);
        if (state.eat(0x29 /* ) */)) {
          return true
        }
        state.raise("Unterminated group");
      }
    }
    state.pos = start;
  }
  return false
};
pp$1.regexp_eatCapturingGroup = function(state) {
  if (state.eat(0x28 /* ( */)) {
    if (this.options.ecmaVersion >= 9) {
      this.regexp_groupSpecifier(state);
    } else if (state.current() === 0x3F /* ? */) {
      state.raise("Invalid group");
    }
    this.regexp_disjunction(state);
    if (state.eat(0x29 /* ) */)) {
      state.numCapturingParens += 1;
      return true
    }
    state.raise("Unterminated group");
  }
  return false
};
// RegularExpressionModifiers ::
//   [empty]
//   RegularExpressionModifiers RegularExpressionModifier
pp$1.regexp_eatModifiers = function(state) {
  var modifiers = "";
  var ch = 0;
  while ((ch = state.current()) !== -1 && isRegularExpressionModifier(ch)) {
    modifiers += codePointToString(ch);
    state.advance();
  }
  return modifiers
};
// RegularExpressionModifier :: one of
//   `i` `m` `s`
function isRegularExpressionModifier(ch) {
  return ch === 0x69 /* i */ || ch === 0x6d /* m */ || ch === 0x73 /* s */
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-ExtendedAtom
pp$1.regexp_eatExtendedAtom = function(state) {
  return (
    state.eat(0x2E /* . */) ||
    this.regexp_eatReverseSolidusAtomEscape(state) ||
    this.regexp_eatCharacterClass(state) ||
    this.regexp_eatUncapturingGroup(state) ||
    this.regexp_eatCapturingGroup(state) ||
    this.regexp_eatInvalidBracedQuantifier(state) ||
    this.regexp_eatExtendedPatternCharacter(state)
  )
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-InvalidBracedQuantifier
pp$1.regexp_eatInvalidBracedQuantifier = function(state) {
  if (this.regexp_eatBracedQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-SyntaxCharacter
pp$1.regexp_eatSyntaxCharacter = function(state) {
  var ch = state.current();
  if (isSyntaxCharacter(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true
  }
  return false
};
function isSyntaxCharacter(ch) {
  return (
    ch === 0x24 /* $ */ ||
    ch >= 0x28 /* ( */ && ch <= 0x2B /* + */ ||
    ch === 0x2E /* . */ ||
    ch === 0x3F /* ? */ ||
    ch >= 0x5B /* [ */ && ch <= 0x5E /* ^ */ ||
    ch >= 0x7B /* { */ && ch <= 0x7D /* } */
  )
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-PatternCharacter
// But eat eager.
pp$1.regexp_eatPatternCharacters = function(state) {
  var start = state.pos;
  var ch = 0;
  while ((ch = state.current()) !== -1 && !isSyntaxCharacter(ch)) {
    state.advance();
  }
  return state.pos !== start
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-ExtendedPatternCharacter
pp$1.regexp_eatExtendedPatternCharacter = function(state) {
  var ch = state.current();
  if (
    ch !== -1 &&
    ch !== 0x24 /* $ */ &&
    !(ch >= 0x28 /* ( */ && ch <= 0x2B /* + */) &&
    ch !== 0x2E /* . */ &&
    ch !== 0x3F /* ? */ &&
    ch !== 0x5B /* [ */ &&
    ch !== 0x5E /* ^ */ &&
    ch !== 0x7C /* | */
  ) {
    state.advance();
    return true
  }
  return false
};

// GroupSpecifier ::
//   [empty]
//   `?` GroupName
pp$1.regexp_groupSpecifier = function(state) {
  if (state.eat(0x3F /* ? */)) {
    if (!this.regexp_eatGroupName(state)) { state.raise("Invalid group"); }
    var trackDisjunction = this.options.ecmaVersion >= 16;
    var known = state.groupNames[state.lastStringValue];
    if (known) {
      if (trackDisjunction) {
        for (var i = 0, list = known; i < list.length; i += 1) {
          var altID = list[i];

          if (!altID.separatedFrom(state.branchID))
            { state.raise("Duplicate capture group name"); }
        }
      } else {
        state.raise("Duplicate capture group name");
      }
    }
    if (trackDisjunction) {
      (known || (state.groupNames[state.lastStringValue] = [])).push(state.branchID);
    } else {
      state.groupNames[state.lastStringValue] = true;
    }
  }
};

// GroupName ::
//   `<` RegExpIdentifierName `>`
// Note: this updates `state.lastStringValue` property with the eaten name.
pp$1.regexp_eatGroupName = function(state) {
  state.lastStringValue = "";
  if (state.eat(0x3C /* < */)) {
    if (this.regexp_eatRegExpIdentifierName(state) && state.eat(0x3E /* > */)) {
      return true
    }
    state.raise("Invalid capture group name");
  }
  return false
};

// RegExpIdentifierName ::
//   RegExpIdentifierStart
//   RegExpIdentifierName RegExpIdentifierPart
// Note: this updates `state.lastStringValue` property with the eaten name.
pp$1.regexp_eatRegExpIdentifierName = function(state) {
  state.lastStringValue = "";
  if (this.regexp_eatRegExpIdentifierStart(state)) {
    state.lastStringValue += codePointToString(state.lastIntValue);
    while (this.regexp_eatRegExpIdentifierPart(state)) {
      state.lastStringValue += codePointToString(state.lastIntValue);
    }
    return true
  }
  return false
};

// RegExpIdentifierStart ::
//   UnicodeIDStart
//   `$`
//   `_`
//   `\` RegExpUnicodeEscapeSequence[+U]
pp$1.regexp_eatRegExpIdentifierStart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);

  if (ch === 0x5C /* \ */ && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierStart(ch)) {
    state.lastIntValue = ch;
    return true
  }

  state.pos = start;
  return false
};
function isRegExpIdentifierStart(ch) {
  return isIdentifierStart(ch, true) || ch === 0x24 /* $ */ || ch === 0x5F /* _ */
}

// RegExpIdentifierPart ::
//   UnicodeIDContinue
//   `$`
//   `_`
//   `\` RegExpUnicodeEscapeSequence[+U]
//   <ZWNJ>
//   <ZWJ>
pp$1.regexp_eatRegExpIdentifierPart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);

  if (ch === 0x5C /* \ */ && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierPart(ch)) {
    state.lastIntValue = ch;
    return true
  }

  state.pos = start;
  return false
};
function isRegExpIdentifierPart(ch) {
  return isIdentifierChar(ch, true) || ch === 0x24 /* $ */ || ch === 0x5F /* _ */ || ch === 0x200C /* <ZWNJ> */ || ch === 0x200D /* <ZWJ> */
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-AtomEscape
pp$1.regexp_eatAtomEscape = function(state) {
  if (
    this.regexp_eatBackReference(state) ||
    this.regexp_eatCharacterClassEscape(state) ||
    this.regexp_eatCharacterEscape(state) ||
    (state.switchN && this.regexp_eatKGroupName(state))
  ) {
    return true
  }
  if (state.switchU) {
    // Make the same message as V8.
    if (state.current() === 0x63 /* c */) {
      state.raise("Invalid unicode escape");
    }
    state.raise("Invalid escape");
  }
  return false
};
pp$1.regexp_eatBackReference = function(state) {
  var start = state.pos;
  if (this.regexp_eatDecimalEscape(state)) {
    var n = state.lastIntValue;
    if (state.switchU) {
      // For SyntaxError in https://www.ecma-international.org/ecma-262/8.0/#sec-atomescape
      if (n > state.maxBackReference) {
        state.maxBackReference = n;
      }
      return true
    }
    if (n <= state.numCapturingParens) {
      return true
    }
    state.pos = start;
  }
  return false
};
pp$1.regexp_eatKGroupName = function(state) {
  if (state.eat(0x6B /* k */)) {
    if (this.regexp_eatGroupName(state)) {
      state.backReferenceNames.push(state.lastStringValue);
      return true
    }
    state.raise("Invalid named reference");
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-CharacterEscape
pp$1.regexp_eatCharacterEscape = function(state) {
  return (
    this.regexp_eatControlEscape(state) ||
    this.regexp_eatCControlLetter(state) ||
    this.regexp_eatZero(state) ||
    this.regexp_eatHexEscapeSequence(state) ||
    this.regexp_eatRegExpUnicodeEscapeSequence(state, false) ||
    (!state.switchU && this.regexp_eatLegacyOctalEscapeSequence(state)) ||
    this.regexp_eatIdentityEscape(state)
  )
};
pp$1.regexp_eatCControlLetter = function(state) {
  var start = state.pos;
  if (state.eat(0x63 /* c */)) {
    if (this.regexp_eatControlLetter(state)) {
      return true
    }
    state.pos = start;
  }
  return false
};
pp$1.regexp_eatZero = function(state) {
  if (state.current() === 0x30 /* 0 */ && !isDecimalDigit(state.lookahead())) {
    state.lastIntValue = 0;
    state.advance();
    return true
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-ControlEscape
pp$1.regexp_eatControlEscape = function(state) {
  var ch = state.current();
  if (ch === 0x74 /* t */) {
    state.lastIntValue = 0x09; /* \t */
    state.advance();
    return true
  }
  if (ch === 0x6E /* n */) {
    state.lastIntValue = 0x0A; /* \n */
    state.advance();
    return true
  }
  if (ch === 0x76 /* v */) {
    state.lastIntValue = 0x0B; /* \v */
    state.advance();
    return true
  }
  if (ch === 0x66 /* f */) {
    state.lastIntValue = 0x0C; /* \f */
    state.advance();
    return true
  }
  if (ch === 0x72 /* r */) {
    state.lastIntValue = 0x0D; /* \r */
    state.advance();
    return true
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-ControlLetter
pp$1.regexp_eatControlLetter = function(state) {
  var ch = state.current();
  if (isControlLetter(ch)) {
    state.lastIntValue = ch % 0x20;
    state.advance();
    return true
  }
  return false
};
function isControlLetter(ch) {
  return (
    (ch >= 0x41 /* A */ && ch <= 0x5A /* Z */) ||
    (ch >= 0x61 /* a */ && ch <= 0x7A /* z */)
  )
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-RegExpUnicodeEscapeSequence
pp$1.regexp_eatRegExpUnicodeEscapeSequence = function(state, forceU) {
  if ( forceU === void 0 ) forceU = false;

  var start = state.pos;
  var switchU = forceU || state.switchU;

  if (state.eat(0x75 /* u */)) {
    if (this.regexp_eatFixedHexDigits(state, 4)) {
      var lead = state.lastIntValue;
      if (switchU && lead >= 0xD800 && lead <= 0xDBFF) {
        var leadSurrogateEnd = state.pos;
        if (state.eat(0x5C /* \ */) && state.eat(0x75 /* u */) && this.regexp_eatFixedHexDigits(state, 4)) {
          var trail = state.lastIntValue;
          if (trail >= 0xDC00 && trail <= 0xDFFF) {
            state.lastIntValue = (lead - 0xD800) * 0x400 + (trail - 0xDC00) + 0x10000;
            return true
          }
        }
        state.pos = leadSurrogateEnd;
        state.lastIntValue = lead;
      }
      return true
    }
    if (
      switchU &&
      state.eat(0x7B /* { */) &&
      this.regexp_eatHexDigits(state) &&
      state.eat(0x7D /* } */) &&
      isValidUnicode(state.lastIntValue)
    ) {
      return true
    }
    if (switchU) {
      state.raise("Invalid unicode escape");
    }
    state.pos = start;
  }

  return false
};
function isValidUnicode(ch) {
  return ch >= 0 && ch <= 0x10FFFF
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-IdentityEscape
pp$1.regexp_eatIdentityEscape = function(state) {
  if (state.switchU) {
    if (this.regexp_eatSyntaxCharacter(state)) {
      return true
    }
    if (state.eat(0x2F /* / */)) {
      state.lastIntValue = 0x2F; /* / */
      return true
    }
    return false
  }

  var ch = state.current();
  if (ch !== 0x63 /* c */ && (!state.switchN || ch !== 0x6B /* k */)) {
    state.lastIntValue = ch;
    state.advance();
    return true
  }

  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-DecimalEscape
pp$1.regexp_eatDecimalEscape = function(state) {
  state.lastIntValue = 0;
  var ch = state.current();
  if (ch >= 0x31 /* 1 */ && ch <= 0x39 /* 9 */) {
    do {
      state.lastIntValue = 10 * state.lastIntValue + (ch - 0x30 /* 0 */);
      state.advance();
    } while ((ch = state.current()) >= 0x30 /* 0 */ && ch <= 0x39 /* 9 */)
    return true
  }
  return false
};

// Return values used by character set parsing methods, needed to
// forbid negation of sets that can match strings.
var CharSetNone = 0; // Nothing parsed
var CharSetOk = 1; // Construct parsed, cannot contain strings
var CharSetString = 2; // Construct parsed, can contain strings

// https://www.ecma-international.org/ecma-262/8.0/#prod-CharacterClassEscape
pp$1.regexp_eatCharacterClassEscape = function(state) {
  var ch = state.current();

  if (isCharacterClassEscape(ch)) {
    state.lastIntValue = -1;
    state.advance();
    return CharSetOk
  }

  var negate = false;
  if (
    state.switchU &&
    this.options.ecmaVersion >= 9 &&
    ((negate = ch === 0x50 /* P */) || ch === 0x70 /* p */)
  ) {
    state.lastIntValue = -1;
    state.advance();
    var result;
    if (
      state.eat(0x7B /* { */) &&
      (result = this.regexp_eatUnicodePropertyValueExpression(state)) &&
      state.eat(0x7D /* } */)
    ) {
      if (negate && result === CharSetString) { state.raise("Invalid property name"); }
      return result
    }
    state.raise("Invalid property name");
  }

  return CharSetNone
};

function isCharacterClassEscape(ch) {
  return (
    ch === 0x64 /* d */ ||
    ch === 0x44 /* D */ ||
    ch === 0x73 /* s */ ||
    ch === 0x53 /* S */ ||
    ch === 0x77 /* w */ ||
    ch === 0x57 /* W */
  )
}

// UnicodePropertyValueExpression ::
//   UnicodePropertyName `=` UnicodePropertyValue
//   LoneUnicodePropertyNameOrValue
pp$1.regexp_eatUnicodePropertyValueExpression = function(state) {
  var start = state.pos;

  // UnicodePropertyName `=` UnicodePropertyValue
  if (this.regexp_eatUnicodePropertyName(state) && state.eat(0x3D /* = */)) {
    var name = state.lastStringValue;
    if (this.regexp_eatUnicodePropertyValue(state)) {
      var value = state.lastStringValue;
      this.regexp_validateUnicodePropertyNameAndValue(state, name, value);
      return CharSetOk
    }
  }
  state.pos = start;

  // LoneUnicodePropertyNameOrValue
  if (this.regexp_eatLoneUnicodePropertyNameOrValue(state)) {
    var nameOrValue = state.lastStringValue;
    return this.regexp_validateUnicodePropertyNameOrValue(state, nameOrValue)
  }
  return CharSetNone
};

pp$1.regexp_validateUnicodePropertyNameAndValue = function(state, name, value) {
  if (!hasOwn(state.unicodeProperties.nonBinary, name))
    { state.raise("Invalid property name"); }
  if (!state.unicodeProperties.nonBinary[name].test(value))
    { state.raise("Invalid property value"); }
};

pp$1.regexp_validateUnicodePropertyNameOrValue = function(state, nameOrValue) {
  if (state.unicodeProperties.binary.test(nameOrValue)) { return CharSetOk }
  if (state.switchV && state.unicodeProperties.binaryOfStrings.test(nameOrValue)) { return CharSetString }
  state.raise("Invalid property name");
};

// UnicodePropertyName ::
//   UnicodePropertyNameCharacters
pp$1.regexp_eatUnicodePropertyName = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyNameCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== ""
};

function isUnicodePropertyNameCharacter(ch) {
  return isControlLetter(ch) || ch === 0x5F /* _ */
}

// UnicodePropertyValue ::
//   UnicodePropertyValueCharacters
pp$1.regexp_eatUnicodePropertyValue = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyValueCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== ""
};
function isUnicodePropertyValueCharacter(ch) {
  return isUnicodePropertyNameCharacter(ch) || isDecimalDigit(ch)
}

// LoneUnicodePropertyNameOrValue ::
//   UnicodePropertyValueCharacters
pp$1.regexp_eatLoneUnicodePropertyNameOrValue = function(state) {
  return this.regexp_eatUnicodePropertyValue(state)
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-CharacterClass
pp$1.regexp_eatCharacterClass = function(state) {
  if (state.eat(0x5B /* [ */)) {
    var negate = state.eat(0x5E /* ^ */);
    var result = this.regexp_classContents(state);
    if (!state.eat(0x5D /* ] */))
      { state.raise("Unterminated character class"); }
    if (negate && result === CharSetString)
      { state.raise("Negated character class may contain strings"); }
    return true
  }
  return false
};

// https://tc39.es/ecma262/#prod-ClassContents
// https://www.ecma-international.org/ecma-262/8.0/#prod-ClassRanges
pp$1.regexp_classContents = function(state) {
  if (state.current() === 0x5D /* ] */) { return CharSetOk }
  if (state.switchV) { return this.regexp_classSetExpression(state) }
  this.regexp_nonEmptyClassRanges(state);
  return CharSetOk
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-NonemptyClassRanges
// https://www.ecma-international.org/ecma-262/8.0/#prod-NonemptyClassRangesNoDash
pp$1.regexp_nonEmptyClassRanges = function(state) {
  while (this.regexp_eatClassAtom(state)) {
    var left = state.lastIntValue;
    if (state.eat(0x2D /* - */) && this.regexp_eatClassAtom(state)) {
      var right = state.lastIntValue;
      if (state.switchU && (left === -1 || right === -1)) {
        state.raise("Invalid character class");
      }
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
    }
  }
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-ClassAtom
// https://www.ecma-international.org/ecma-262/8.0/#prod-ClassAtomNoDash
pp$1.regexp_eatClassAtom = function(state) {
  var start = state.pos;

  if (state.eat(0x5C /* \ */)) {
    if (this.regexp_eatClassEscape(state)) {
      return true
    }
    if (state.switchU) {
      // Make the same message as V8.
      var ch$1 = state.current();
      if (ch$1 === 0x63 /* c */ || isOctalDigit(ch$1)) {
        state.raise("Invalid class escape");
      }
      state.raise("Invalid escape");
    }
    state.pos = start;
  }

  var ch = state.current();
  if (ch !== 0x5D /* ] */) {
    state.lastIntValue = ch;
    state.advance();
    return true
  }

  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-ClassEscape
pp$1.regexp_eatClassEscape = function(state) {
  var start = state.pos;

  if (state.eat(0x62 /* b */)) {
    state.lastIntValue = 0x08; /* <BS> */
    return true
  }

  if (state.switchU && state.eat(0x2D /* - */)) {
    state.lastIntValue = 0x2D; /* - */
    return true
  }

  if (!state.switchU && state.eat(0x63 /* c */)) {
    if (this.regexp_eatClassControlLetter(state)) {
      return true
    }
    state.pos = start;
  }

  return (
    this.regexp_eatCharacterClassEscape(state) ||
    this.regexp_eatCharacterEscape(state)
  )
};

// https://tc39.es/ecma262/#prod-ClassSetExpression
// https://tc39.es/ecma262/#prod-ClassUnion
// https://tc39.es/ecma262/#prod-ClassIntersection
// https://tc39.es/ecma262/#prod-ClassSubtraction
pp$1.regexp_classSetExpression = function(state) {
  var result = CharSetOk, subResult;
  if (this.regexp_eatClassSetRange(state)) ; else if (subResult = this.regexp_eatClassSetOperand(state)) {
    if (subResult === CharSetString) { result = CharSetString; }
    // https://tc39.es/ecma262/#prod-ClassIntersection
    var start = state.pos;
    while (state.eatChars([0x26, 0x26] /* && */)) {
      if (
        state.current() !== 0x26 /* & */ &&
        (subResult = this.regexp_eatClassSetOperand(state))
      ) {
        if (subResult !== CharSetString) { result = CharSetOk; }
        continue
      }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) { return result }
    // https://tc39.es/ecma262/#prod-ClassSubtraction
    while (state.eatChars([0x2D, 0x2D] /* -- */)) {
      if (this.regexp_eatClassSetOperand(state)) { continue }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) { return result }
  } else {
    state.raise("Invalid character in character class");
  }
  // https://tc39.es/ecma262/#prod-ClassUnion
  for (;;) {
    if (this.regexp_eatClassSetRange(state)) { continue }
    subResult = this.regexp_eatClassSetOperand(state);
    if (!subResult) { return result }
    if (subResult === CharSetString) { result = CharSetString; }
  }
};

// https://tc39.es/ecma262/#prod-ClassSetRange
pp$1.regexp_eatClassSetRange = function(state) {
  var start = state.pos;
  if (this.regexp_eatClassSetCharacter(state)) {
    var left = state.lastIntValue;
    if (state.eat(0x2D /* - */) && this.regexp_eatClassSetCharacter(state)) {
      var right = state.lastIntValue;
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
      return true
    }
    state.pos = start;
  }
  return false
};

// https://tc39.es/ecma262/#prod-ClassSetOperand
pp$1.regexp_eatClassSetOperand = function(state) {
  if (this.regexp_eatClassSetCharacter(state)) { return CharSetOk }
  return this.regexp_eatClassStringDisjunction(state) || this.regexp_eatNestedClass(state)
};

// https://tc39.es/ecma262/#prod-NestedClass
pp$1.regexp_eatNestedClass = function(state) {
  var start = state.pos;
  if (state.eat(0x5B /* [ */)) {
    var negate = state.eat(0x5E /* ^ */);
    var result = this.regexp_classContents(state);
    if (state.eat(0x5D /* ] */)) {
      if (negate && result === CharSetString) {
        state.raise("Negated character class may contain strings");
      }
      return result
    }
    state.pos = start;
  }
  if (state.eat(0x5C /* \ */)) {
    var result$1 = this.regexp_eatCharacterClassEscape(state);
    if (result$1) {
      return result$1
    }
    state.pos = start;
  }
  return null
};

// https://tc39.es/ecma262/#prod-ClassStringDisjunction
pp$1.regexp_eatClassStringDisjunction = function(state) {
  var start = state.pos;
  if (state.eatChars([0x5C, 0x71] /* \q */)) {
    if (state.eat(0x7B /* { */)) {
      var result = this.regexp_classStringDisjunctionContents(state);
      if (state.eat(0x7D /* } */)) {
        return result
      }
    } else {
      // Make the same message as V8.
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return null
};

// https://tc39.es/ecma262/#prod-ClassStringDisjunctionContents
pp$1.regexp_classStringDisjunctionContents = function(state) {
  var result = this.regexp_classString(state);
  while (state.eat(0x7C /* | */)) {
    if (this.regexp_classString(state) === CharSetString) { result = CharSetString; }
  }
  return result
};

// https://tc39.es/ecma262/#prod-ClassString
// https://tc39.es/ecma262/#prod-NonEmptyClassString
pp$1.regexp_classString = function(state) {
  var count = 0;
  while (this.regexp_eatClassSetCharacter(state)) { count++; }
  return count === 1 ? CharSetOk : CharSetString
};

// https://tc39.es/ecma262/#prod-ClassSetCharacter
pp$1.regexp_eatClassSetCharacter = function(state) {
  var start = state.pos;
  if (state.eat(0x5C /* \ */)) {
    if (
      this.regexp_eatCharacterEscape(state) ||
      this.regexp_eatClassSetReservedPunctuator(state)
    ) {
      return true
    }
    if (state.eat(0x62 /* b */)) {
      state.lastIntValue = 0x08; /* <BS> */
      return true
    }
    state.pos = start;
    return false
  }
  var ch = state.current();
  if (ch < 0 || ch === state.lookahead() && isClassSetReservedDoublePunctuatorCharacter(ch)) { return false }
  if (isClassSetSyntaxCharacter(ch)) { return false }
  state.advance();
  state.lastIntValue = ch;
  return true
};

// https://tc39.es/ecma262/#prod-ClassSetReservedDoublePunctuator
function isClassSetReservedDoublePunctuatorCharacter(ch) {
  return (
    ch === 0x21 /* ! */ ||
    ch >= 0x23 /* # */ && ch <= 0x26 /* & */ ||
    ch >= 0x2A /* * */ && ch <= 0x2C /* , */ ||
    ch === 0x2E /* . */ ||
    ch >= 0x3A /* : */ && ch <= 0x40 /* @ */ ||
    ch === 0x5E /* ^ */ ||
    ch === 0x60 /* ` */ ||
    ch === 0x7E /* ~ */
  )
}

// https://tc39.es/ecma262/#prod-ClassSetSyntaxCharacter
function isClassSetSyntaxCharacter(ch) {
  return (
    ch === 0x28 /* ( */ ||
    ch === 0x29 /* ) */ ||
    ch === 0x2D /* - */ ||
    ch === 0x2F /* / */ ||
    ch >= 0x5B /* [ */ && ch <= 0x5D /* ] */ ||
    ch >= 0x7B /* { */ && ch <= 0x7D /* } */
  )
}

// https://tc39.es/ecma262/#prod-ClassSetReservedPunctuator
pp$1.regexp_eatClassSetReservedPunctuator = function(state) {
  var ch = state.current();
  if (isClassSetReservedPunctuator(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true
  }
  return false
};

// https://tc39.es/ecma262/#prod-ClassSetReservedPunctuator
function isClassSetReservedPunctuator(ch) {
  return (
    ch === 0x21 /* ! */ ||
    ch === 0x23 /* # */ ||
    ch === 0x25 /* % */ ||
    ch === 0x26 /* & */ ||
    ch === 0x2C /* , */ ||
    ch === 0x2D /* - */ ||
    ch >= 0x3A /* : */ && ch <= 0x3E /* > */ ||
    ch === 0x40 /* @ */ ||
    ch === 0x60 /* ` */ ||
    ch === 0x7E /* ~ */
  )
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-ClassControlLetter
pp$1.regexp_eatClassControlLetter = function(state) {
  var ch = state.current();
  if (isDecimalDigit(ch) || ch === 0x5F /* _ */) {
    state.lastIntValue = ch % 0x20;
    state.advance();
    return true
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-HexEscapeSequence
pp$1.regexp_eatHexEscapeSequence = function(state) {
  var start = state.pos;
  if (state.eat(0x78 /* x */)) {
    if (this.regexp_eatFixedHexDigits(state, 2)) {
      return true
    }
    if (state.switchU) {
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-DecimalDigits
pp$1.regexp_eatDecimalDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isDecimalDigit(ch = state.current())) {
    state.lastIntValue = 10 * state.lastIntValue + (ch - 0x30 /* 0 */);
    state.advance();
  }
  return state.pos !== start
};
function isDecimalDigit(ch) {
  return ch >= 0x30 /* 0 */ && ch <= 0x39 /* 9 */
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-HexDigits
pp$1.regexp_eatHexDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isHexDigit(ch = state.current())) {
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return state.pos !== start
};
function isHexDigit(ch) {
  return (
    (ch >= 0x30 /* 0 */ && ch <= 0x39 /* 9 */) ||
    (ch >= 0x41 /* A */ && ch <= 0x46 /* F */) ||
    (ch >= 0x61 /* a */ && ch <= 0x66 /* f */)
  )
}
function hexToInt(ch) {
  if (ch >= 0x41 /* A */ && ch <= 0x46 /* F */) {
    return 10 + (ch - 0x41 /* A */)
  }
  if (ch >= 0x61 /* a */ && ch <= 0x66 /* f */) {
    return 10 + (ch - 0x61 /* a */)
  }
  return ch - 0x30 /* 0 */
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-annexB-LegacyOctalEscapeSequence
// Allows only 0-377(octal) i.e. 0-255(decimal).
pp$1.regexp_eatLegacyOctalEscapeSequence = function(state) {
  if (this.regexp_eatOctalDigit(state)) {
    var n1 = state.lastIntValue;
    if (this.regexp_eatOctalDigit(state)) {
      var n2 = state.lastIntValue;
      if (n1 <= 3 && this.regexp_eatOctalDigit(state)) {
        state.lastIntValue = n1 * 64 + n2 * 8 + state.lastIntValue;
      } else {
        state.lastIntValue = n1 * 8 + n2;
      }
    } else {
      state.lastIntValue = n1;
    }
    return true
  }
  return false
};

// https://www.ecma-international.org/ecma-262/8.0/#prod-OctalDigit
pp$1.regexp_eatOctalDigit = function(state) {
  var ch = state.current();
  if (isOctalDigit(ch)) {
    state.lastIntValue = ch - 0x30; /* 0 */
    state.advance();
    return true
  }
  state.lastIntValue = 0;
  return false
};
function isOctalDigit(ch) {
  return ch >= 0x30 /* 0 */ && ch <= 0x37 /* 7 */
}

// https://www.ecma-international.org/ecma-262/8.0/#prod-Hex4Digits
// https://www.ecma-international.org/ecma-262/8.0/#prod-HexDigit
// And HexDigit HexDigit in https://www.ecma-international.org/ecma-262/8.0/#prod-HexEscapeSequence
pp$1.regexp_eatFixedHexDigits = function(state, length) {
  var start = state.pos;
  state.lastIntValue = 0;
  for (var i = 0; i < length; ++i) {
    var ch = state.current();
    if (!isHexDigit(ch)) {
      state.pos = start;
      return false
    }
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return true
};

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.

var Token = function Token(p) {
  this.type = p.type;
  this.value = p.value;
  this.start = p.start;
  this.end = p.end;
  if (p.options.locations)
    { this.loc = new SourceLocation(p, p.startLoc, p.endLoc); }
  if (p.options.ranges)
    { this.range = [p.start, p.end]; }
};

// ## Tokenizer

var pp = Parser.prototype;

// Move to the next token

pp.next = function(ignoreEscapeSequenceInKeyword) {
  if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc)
    { this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword); }
  if (this.options.onToken)
    { this.options.onToken(new Token(this)); }

  this.lastTokEnd = this.end;
  this.lastTokStart = this.start;
  this.lastTokEndLoc = this.endLoc;
  this.lastTokStartLoc = this.startLoc;
  this.nextToken();
};

pp.getToken = function() {
  this.next();
  return new Token(this)
};

// If we're in an ES6 environment, make parsers iterable
if (typeof Symbol !== "undefined")
  { pp[Symbol.iterator] = function() {
    var this$1$1 = this;

    return {
      next: function () {
        var token = this$1$1.getToken();
        return {
          done: token.type === types$1.eof,
          value: token
        }
      }
    }
  }; }

// Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).

// Read a single token, updating the parser object's token-related
// properties.

pp.nextToken = function() {
  var curContext = this.curContext();
  if (!curContext || !curContext.preserveSpace) { this.skipSpace(); }

  this.start = this.pos;
  if (this.options.locations) { this.startLoc = this.curPosition(); }
  if (this.pos >= this.input.length) { return this.finishToken(types$1.eof) }

  if (curContext.override) { return curContext.override(this) }
  else { this.readToken(this.fullCharCodeAtPos()); }
};

pp.readToken = function(code) {
  // Identifier or keyword. '\uXXXX' sequences are allowed in
  // identifiers, so '\' also dispatches to that.
  if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92 /* '\' */)
    { return this.readWord() }

  return this.getTokenFromCode(code)
};

pp.fullCharCodeAt = function(pos) {
  var code = this.input.charCodeAt(pos);
  if (code <= 0xd7ff || code >= 0xdc00) { return code }
  var next = this.input.charCodeAt(pos + 1);
  return next <= 0xdbff || next >= 0xe000 ? code : (code << 10) + next - 0x35fdc00
};

pp.fullCharCodeAtPos = function() {
  return this.fullCharCodeAt(this.pos)
};

pp.skipBlockComment = function() {
  var startLoc = this.options.onComment && this.curPosition();
  var start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
  if (end === -1) { this.raise(this.pos - 2, "Unterminated comment"); }
  this.pos = end + 2;
  if (this.options.locations) {
    for (var nextBreak = (void 0), pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1;) {
      ++this.curLine;
      pos = this.lineStart = nextBreak;
    }
  }
  if (this.options.onComment)
    { this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos,
                           startLoc, this.curPosition()); }
};

pp.skipLineComment = function(startSkip) {
  var start = this.pos;
  var startLoc = this.options.onComment && this.curPosition();
  var ch = this.input.charCodeAt(this.pos += startSkip);
  while (this.pos < this.input.length && !isNewLine(ch)) {
    ch = this.input.charCodeAt(++this.pos);
  }
  if (this.options.onComment)
    { this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos,
                           startLoc, this.curPosition()); }
};

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

pp.skipSpace = function() {
  loop: while (this.pos < this.input.length) {
    var ch = this.input.charCodeAt(this.pos);
    switch (ch) {
    case 32: case 160: // ' '
      ++this.pos;
      break
    case 13:
      if (this.input.charCodeAt(this.pos + 1) === 10) {
        ++this.pos;
      }
    case 10: case 8232: case 8233:
      ++this.pos;
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      break
    case 47: // '/'
      switch (this.input.charCodeAt(this.pos + 1)) {
      case 42: // '*'
        this.skipBlockComment();
        break
      case 47:
        this.skipLineComment(2);
        break
      default:
        break loop
      }
      break
    default:
      if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++this.pos;
      } else {
        break loop
      }
    }
  }
};

// Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.

pp.finishToken = function(type, val) {
  this.end = this.pos;
  if (this.options.locations) { this.endLoc = this.curPosition(); }
  var prevType = this.type;
  this.type = type;
  this.value = val;

  this.updateContext(prevType);
};

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next >= 48 && next <= 57) { return this.readNumber(true) }
  var next2 = this.input.charCodeAt(this.pos + 2);
  if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) { // 46 = dot '.'
    this.pos += 3;
    return this.finishToken(types$1.ellipsis)
  } else {
    ++this.pos;
    return this.finishToken(types$1.dot)
  }
};

pp.readToken_slash = function() { // '/'
  var next = this.input.charCodeAt(this.pos + 1);
  if (this.exprAllowed) { ++this.pos; return this.readRegexp() }
  if (next === 61) { return this.finishOp(types$1.assign, 2) }
  return this.finishOp(types$1.slash, 1)
};

pp.readToken_mult_modulo_exp = function(code) { // '%*'
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  var tokentype = code === 42 ? types$1.star : types$1.modulo;

  // exponentiation operator ** and **=
  if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
    ++size;
    tokentype = types$1.starstar;
    next = this.input.charCodeAt(this.pos + 2);
  }

  if (next === 61) { return this.finishOp(types$1.assign, size + 1) }
  return this.finishOp(tokentype, size)
};

pp.readToken_pipe_amp = function(code) { // '|&'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (this.options.ecmaVersion >= 12) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 === 61) { return this.finishOp(types$1.assign, 3) }
    }
    return this.finishOp(code === 124 ? types$1.logicalOR : types$1.logicalAND, 2)
  }
  if (next === 61) { return this.finishOp(types$1.assign, 2) }
  return this.finishOp(code === 124 ? types$1.bitwiseOR : types$1.bitwiseAND, 1)
};

pp.readToken_caret = function() { // '^'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) { return this.finishOp(types$1.assign, 2) }
  return this.finishOp(types$1.bitwiseXOR, 1)
};

pp.readToken_plus_min = function(code) { // '+-'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 &&
        (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
      // A `-->` line comment
      this.skipLineComment(3);
      this.skipSpace();
      return this.nextToken()
    }
    return this.finishOp(types$1.incDec, 2)
  }
  if (next === 61) { return this.finishOp(types$1.assign, 2) }
  return this.finishOp(types$1.plusMin, 1)
};

pp.readToken_lt_gt = function(code) { // '<>'
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
    if (this.input.charCodeAt(this.pos + size) === 61) { return this.finishOp(types$1.assign, size + 1) }
    return this.finishOp(types$1.bitShift, size)
  }
  if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 &&
      this.input.charCodeAt(this.pos + 3) === 45) {
    // `<!--`, an XML-style comment that should be interpreted as a line comment
    this.skipLineComment(4);
    this.skipSpace();
    return this.nextToken()
  }
  if (next === 61) { size = 2; }
  return this.finishOp(types$1.relational, size)
};

pp.readToken_eq_excl = function(code) { // '=!'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) { return this.finishOp(types$1.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2) }
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) { // '=>'
    this.pos += 2;
    return this.finishToken(types$1.arrow)
  }
  return this.finishOp(code === 61 ? types$1.eq : types$1.prefix, 1)
};

pp.readToken_question = function() { // '?'
  var ecmaVersion = this.options.ecmaVersion;
  if (ecmaVersion >= 11) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 46) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 < 48 || next2 > 57) { return this.finishOp(types$1.questionDot, 2) }
    }
    if (next === 63) {
      if (ecmaVersion >= 12) {
        var next2$1 = this.input.charCodeAt(this.pos + 2);
        if (next2$1 === 61) { return this.finishOp(types$1.assign, 3) }
      }
      return this.finishOp(types$1.coalesce, 2)
    }
  }
  return this.finishOp(types$1.question, 1)
};

pp.readToken_numberSign = function() { // '#'
  var ecmaVersion = this.options.ecmaVersion;
  var code = 35; // '#'
  if (ecmaVersion >= 13) {
    ++this.pos;
    code = this.fullCharCodeAtPos();
    if (isIdentifierStart(code, true) || code === 92 /* '\' */) {
      return this.finishToken(types$1.privateId, this.readWord1())
    }
  }

  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};

pp.getTokenFromCode = function(code) {
  switch (code) {
  // The interpretation of a dot depends on whether it is followed
  // by a digit or another two dots.
  case 46: // '.'
    return this.readToken_dot()

  // Punctuation tokens.
  case 40: ++this.pos; return this.finishToken(types$1.parenL)
  case 41: ++this.pos; return this.finishToken(types$1.parenR)
  case 59: ++this.pos; return this.finishToken(types$1.semi)
  case 44: ++this.pos; return this.finishToken(types$1.comma)
  case 91: ++this.pos; return this.finishToken(types$1.bracketL)
  case 93: ++this.pos; return this.finishToken(types$1.bracketR)
  case 123: ++this.pos; return this.finishToken(types$1.braceL)
  case 125: ++this.pos; return this.finishToken(types$1.braceR)
  case 58: ++this.pos; return this.finishToken(types$1.colon)

  case 96: // '`'
    if (this.options.ecmaVersion < 6) { break }
    ++this.pos;
    return this.finishToken(types$1.backQuote)

  case 48: // '0'
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 120 || next === 88) { return this.readRadixNumber(16) } // '0x', '0X' - hex number
    if (this.options.ecmaVersion >= 6) {
      if (next === 111 || next === 79) { return this.readRadixNumber(8) } // '0o', '0O' - octal number
      if (next === 98 || next === 66) { return this.readRadixNumber(2) } // '0b', '0B' - binary number
    }

  // Anything else beginning with a digit is an integer, octal
  // number, or float.
  case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
    return this.readNumber(false)

  // Quotes produce strings.
  case 34: case 39: // '"', "'"
    return this.readString(code)

  // Operators are parsed inline in tiny state machines. '=' (61) is
  // often referred to. `finishOp` simply skips the amount of
  // characters it is given as second argument, and returns a token
  // of the type given by its first argument.
  case 47: // '/'
    return this.readToken_slash()

  case 37: case 42: // '%*'
    return this.readToken_mult_modulo_exp(code)

  case 124: case 38: // '|&'
    return this.readToken_pipe_amp(code)

  case 94: // '^'
    return this.readToken_caret()

  case 43: case 45: // '+-'
    return this.readToken_plus_min(code)

  case 60: case 62: // '<>'
    return this.readToken_lt_gt(code)

  case 61: case 33: // '=!'
    return this.readToken_eq_excl(code)

  case 63: // '?'
    return this.readToken_question()

  case 126: // '~'
    return this.finishOp(types$1.prefix, 1)

  case 35: // '#'
    return this.readToken_numberSign()
  }

  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};

pp.finishOp = function(type, size) {
  var str = this.input.slice(this.pos, this.pos + size);
  this.pos += size;
  return this.finishToken(type, str)
};

pp.readRegexp = function() {
  var escaped, inClass, start = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) { this.raise(start, "Unterminated regular expression"); }
    var ch = this.input.charAt(this.pos);
    if (lineBreak.test(ch)) { this.raise(start, "Unterminated regular expression"); }
    if (!escaped) {
      if (ch === "[") { inClass = true; }
      else if (ch === "]" && inClass) { inClass = false; }
      else if (ch === "/" && !inClass) { break }
      escaped = ch === "\\";
    } else { escaped = false; }
    ++this.pos;
  }
  var pattern = this.input.slice(start, this.pos);
  ++this.pos;
  var flagsStart = this.pos;
  var flags = this.readWord1();
  if (this.containsEsc) { this.unexpected(flagsStart); }

  // Validate pattern
  var state = this.regexpState || (this.regexpState = new RegExpValidationState(this));
  state.reset(start, pattern, flags);
  this.validateRegExpFlags(state);
  this.validateRegExpPattern(state);

  // Create Literal#value property value.
  var value = null;
  try {
    value = new RegExp(pattern, flags);
  } catch (e) {
    // ESTree requires null if it failed to instantiate RegExp object.
    // https://github.com/estree/estree/blob/a27003adf4fd7bfad44de9cef372a2eacd527b1c/es5.md#regexpliteral
  }

  return this.finishToken(types$1.regexp, {pattern: pattern, flags: flags, value: value})
};

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
  // `len` is used for character escape sequences. In that case, disallow separators.
  var allowSeparators = this.options.ecmaVersion >= 12 && len === undefined;

  // `maybeLegacyOctalNumericLiteral` is true if it doesn't have prefix (0x,0o,0b)
  // and isn't fraction part nor exponent part. In that case, if the first digit
  // is zero then disallow separators.
  var isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48;

  var start = this.pos, total = 0, lastCode = 0;
  for (var i = 0, e = len == null ? Infinity : len; i < e; ++i, ++this.pos) {
    var code = this.input.charCodeAt(this.pos), val = (void 0);

    if (allowSeparators && code === 95) {
      if (isLegacyOctalNumericLiteral) { this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals"); }
      if (lastCode === 95) { this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore"); }
      if (i === 0) { this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits"); }
      lastCode = code;
      continue
    }

    if (code >= 97) { val = code - 97 + 10; } // a
    else if (code >= 65) { val = code - 65 + 10; } // A
    else if (code >= 48 && code <= 57) { val = code - 48; } // 0-9
    else { val = Infinity; }
    if (val >= radix) { break }
    lastCode = code;
    total = total * radix + val;
  }

  if (allowSeparators && lastCode === 95) { this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits"); }
  if (this.pos === start || len != null && this.pos - start !== len) { return null }

  return total
};

function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8)
  }

  // `parseFloat(value)` stops parsing at the first numeric separator then returns a wrong value.
  return parseFloat(str.replace(/_/g, ""))
}

function stringToBigInt(str) {
  if (typeof BigInt !== "function") {
    return null
  }

  // `BigInt(value)` throws syntax error if the string contains numeric separators.
  return BigInt(str.replace(/_/g, ""))
}

pp.readRadixNumber = function(radix) {
  var start = this.pos;
  this.pos += 2; // 0x
  var val = this.readInt(radix);
  if (val == null) { this.raise(this.start + 2, "Expected number in radix " + radix); }
  if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
    val = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
  } else if (isIdentifierStart(this.fullCharCodeAtPos())) { this.raise(this.pos, "Identifier directly after number"); }
  return this.finishToken(types$1.num, val)
};

// Read an integer, octal integer, or floating-point number.

pp.readNumber = function(startsWithDot) {
  var start = this.pos;
  if (!startsWithDot && this.readInt(10, undefined, true) === null) { this.raise(start, "Invalid number"); }
  var octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48;
  if (octal && this.strict) { this.raise(start, "Invalid number"); }
  var next = this.input.charCodeAt(this.pos);
  if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
    var val$1 = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
    if (isIdentifierStart(this.fullCharCodeAtPos())) { this.raise(this.pos, "Identifier directly after number"); }
    return this.finishToken(types$1.num, val$1)
  }
  if (octal && /[89]/.test(this.input.slice(start, this.pos))) { octal = false; }
  if (next === 46 && !octal) { // '.'
    ++this.pos;
    this.readInt(10);
    next = this.input.charCodeAt(this.pos);
  }
  if ((next === 69 || next === 101) && !octal) { // 'eE'
    next = this.input.charCodeAt(++this.pos);
    if (next === 43 || next === 45) { ++this.pos; } // '+-'
    if (this.readInt(10) === null) { this.raise(start, "Invalid number"); }
  }
  if (isIdentifierStart(this.fullCharCodeAtPos())) { this.raise(this.pos, "Identifier directly after number"); }

  var val = stringToNumber(this.input.slice(start, this.pos), octal);
  return this.finishToken(types$1.num, val)
};

// Read a string value, interpreting backslash-escapes.

pp.readCodePoint = function() {
  var ch = this.input.charCodeAt(this.pos), code;

  if (ch === 123) { // '{'
    if (this.options.ecmaVersion < 6) { this.unexpected(); }
    var codePos = ++this.pos;
    code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
    ++this.pos;
    if (code > 0x10FFFF) { this.invalidStringToken(codePos, "Code point out of bounds"); }
  } else {
    code = this.readHexChar(4);
  }
  return code
};

pp.readString = function(quote) {
  var out = "", chunkStart = ++this.pos;
  for (;;) {
    if (this.pos >= this.input.length) { this.raise(this.start, "Unterminated string constant"); }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === quote) { break }
    if (ch === 92) { // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(false);
      chunkStart = this.pos;
    } else if (ch === 0x2028 || ch === 0x2029) {
      if (this.options.ecmaVersion < 10) { this.raise(this.start, "Unterminated string constant"); }
      ++this.pos;
      if (this.options.locations) {
        this.curLine++;
        this.lineStart = this.pos;
      }
    } else {
      if (isNewLine(ch)) { this.raise(this.start, "Unterminated string constant"); }
      ++this.pos;
    }
  }
  out += this.input.slice(chunkStart, this.pos++);
  return this.finishToken(types$1.string, out)
};

// Reads template string tokens.

var INVALID_TEMPLATE_ESCAPE_ERROR = {};

pp.tryReadTemplateToken = function() {
  this.inTemplateElement = true;
  try {
    this.readTmplToken();
  } catch (err) {
    if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
      this.readInvalidTemplateToken();
    } else {
      throw err
    }
  }

  this.inTemplateElement = false;
};

pp.invalidStringToken = function(position, message) {
  if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
    throw INVALID_TEMPLATE_ESCAPE_ERROR
  } else {
    this.raise(position, message);
  }
};

pp.readTmplToken = function() {
  var out = "", chunkStart = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) { this.raise(this.start, "Unterminated template"); }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) { // '`', '${'
      if (this.pos === this.start && (this.type === types$1.template || this.type === types$1.invalidTemplate)) {
        if (ch === 36) {
          this.pos += 2;
          return this.finishToken(types$1.dollarBraceL)
        } else {
          ++this.pos;
          return this.finishToken(types$1.backQuote)
        }
      }
      out += this.input.slice(chunkStart, this.pos);
      return this.finishToken(types$1.template, out)
    }
    if (ch === 92) { // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(true);
      chunkStart = this.pos;
    } else if (isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos);
      ++this.pos;
      switch (ch) {
      case 13:
        if (this.input.charCodeAt(this.pos) === 10) { ++this.pos; }
      case 10:
        out += "\n";
        break
      default:
        out += String.fromCharCode(ch);
        break
      }
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      chunkStart = this.pos;
    } else {
      ++this.pos;
    }
  }
};

// Reads a template token to search for the end, without validating any escape sequences
pp.readInvalidTemplateToken = function() {
  for (; this.pos < this.input.length; this.pos++) {
    switch (this.input[this.pos]) {
    case "\\":
      ++this.pos;
      break

    case "$":
      if (this.input[this.pos + 1] !== "{") { break }
      // fall through
    case "`":
      return this.finishToken(types$1.invalidTemplate, this.input.slice(this.start, this.pos))

    case "\r":
      if (this.input[this.pos + 1] === "\n") { ++this.pos; }
      // fall through
    case "\n": case "\u2028": case "\u2029":
      ++this.curLine;
      this.lineStart = this.pos + 1;
      break
    }
  }
  this.raise(this.start, "Unterminated template");
};

// Used to read escaped characters

pp.readEscapedChar = function(inTemplate) {
  var ch = this.input.charCodeAt(++this.pos);
  ++this.pos;
  switch (ch) {
  case 110: return "\n" // 'n' -> '\n'
  case 114: return "\r" // 'r' -> '\r'
  case 120: return String.fromCharCode(this.readHexChar(2)) // 'x'
  case 117: return codePointToString(this.readCodePoint()) // 'u'
  case 116: return "\t" // 't' -> '\t'
  case 98: return "\b" // 'b' -> '\b'
  case 118: return "\u000b" // 'v' -> '\u000b'
  case 102: return "\f" // 'f' -> '\f'
  case 13: if (this.input.charCodeAt(this.pos) === 10) { ++this.pos; } // '\r\n'
  case 10: // ' \n'
    if (this.options.locations) { this.lineStart = this.pos; ++this.curLine; }
    return ""
  case 56:
  case 57:
    if (this.strict) {
      this.invalidStringToken(
        this.pos - 1,
        "Invalid escape sequence"
      );
    }
    if (inTemplate) {
      var codePos = this.pos - 1;

      this.invalidStringToken(
        codePos,
        "Invalid escape sequence in template string"
      );
    }
  default:
    if (ch >= 48 && ch <= 55) {
      var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
      var octal = parseInt(octalStr, 8);
      if (octal > 255) {
        octalStr = octalStr.slice(0, -1);
        octal = parseInt(octalStr, 8);
      }
      this.pos += octalStr.length - 1;
      ch = this.input.charCodeAt(this.pos);
      if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
        this.invalidStringToken(
          this.pos - 1 - octalStr.length,
          inTemplate
            ? "Octal literal in template string"
            : "Octal literal in strict mode"
        );
      }
      return String.fromCharCode(octal)
    }
    if (isNewLine(ch)) {
      // Unicode new line characters after \ get removed from output in both
      // template literals and strings
      if (this.options.locations) { this.lineStart = this.pos; ++this.curLine; }
      return ""
    }
    return String.fromCharCode(ch)
  }
};

// Used to read character escape sequences ('\x', '\u', '\U').

pp.readHexChar = function(len) {
  var codePos = this.pos;
  var n = this.readInt(16, len);
  if (n === null) { this.invalidStringToken(codePos, "Bad character escape sequence"); }
  return n
};

// Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.

pp.readWord1 = function() {
  this.containsEsc = false;
  var word = "", first = true, chunkStart = this.pos;
  var astral = this.options.ecmaVersion >= 6;
  while (this.pos < this.input.length) {
    var ch = this.fullCharCodeAtPos();
    if (isIdentifierChar(ch, astral)) {
      this.pos += ch <= 0xffff ? 1 : 2;
    } else if (ch === 92) { // "\"
      this.containsEsc = true;
      word += this.input.slice(chunkStart, this.pos);
      var escStart = this.pos;
      if (this.input.charCodeAt(++this.pos) !== 117) // "u"
        { this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX"); }
      ++this.pos;
      var esc = this.readCodePoint();
      if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral))
        { this.invalidStringToken(escStart, "Invalid Unicode escape"); }
      word += codePointToString(esc);
      chunkStart = this.pos;
    } else {
      break
    }
    first = false;
  }
  return word + this.input.slice(chunkStart, this.pos)
};

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

pp.readWord = function() {
  var word = this.readWord1();
  var type = types$1.name;
  if (this.keywords.test(word)) {
    type = keywords[word];
  }
  return this.finishToken(type, word)
};

// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/acornjs/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/acornjs/acorn/issues


var version = "8.17.0";

Parser.acorn = {
  Parser: Parser,
  version: version,
  defaultOptions: defaultOptions,
  Position: Position,
  SourceLocation: SourceLocation,
  getLineInfo: getLineInfo,
  Node: Node,
  TokenType: TokenType,
  tokTypes: types$1,
  keywordTypes: keywords,
  TokContext: TokContext,
  tokContexts: types,
  isIdentifierChar: isIdentifierChar,
  isIdentifierStart: isIdentifierStart,
  Token: Token,
  isNewLine: isNewLine,
  lineBreak: lineBreak,
  lineBreakG: lineBreakG,
  nonASCIIwhitespace: nonASCIIwhitespace
};

// The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and returns
// an abstract syntax tree as specified by the [ESTree spec][estree].
//
// [estree]: https://github.com/estree/estree

function parse(input, options) {
  return Parser.parse(input, options)
}

const option = (kind, description, values) => ({ kind, description, values });
const timeout = option("positiveMilliseconds", "Maximum duration in milliseconds.");
const actionTimeout = option("positiveMilliseconds", "Maximum wait for the element to become usable in milliseconds; defaults to 3000.");
const delay = option("nonNegativeNumber", "Input delay in milliseconds.");
const button = option("string", "Mouse button.", ["left", "middle", "right"]);
const position = option("point", "CSS-pixel offset from the element's top-left corner.");
const force = option("boolean", "Bypass pointer interception checks.");
const label = option("nonEmptyString", "Concise user-visible action description shown with the native mouse highlight.");
/**
 * Single source of truth for the v2 surface shown to Agents. Runtime option
 * validation, default help, and the generated Markdown reference all consume
 * this schema. Legacy helpers intentionally remain outside it.
 */
const PUBLIC_API_SCHEMA = [
    {
        name: "profiles",
        signature: "await profiles()",
        summary: "List browser profiles available for new task spaces.",
    },
    {
        name: "listTaskSpaces",
        signature: "await listTaskSpaces()",
        summary: "List Agent-owned and user-owned spaces available to reuse or claim.",
    },
    {
        name: "taskSpace",
        signature: "await taskSpace(nameOrId, { profileId? })",
        summary: "Reuse or create an Agent-owned task space; a new space starts with managed Page p1, and profileId applies only when creating it.",
        options: {
            profileId: option("nonEmptyString", "Browser profile id returned by profiles(); new spaces only."),
        },
    },
    {
        name: "claimTaskSpace",
        signature: "await claimTaskSpace(spaceId)",
        summary: "Claim a user-owned or inactive space after user approval and return TaskSpace.",
    },
    {
        name: "takeOverTaskSpace",
        signature: "await takeOverTaskSpace(spaceId)",
        summary: "Resume an Agent-owned space after user approval and return TaskSpace.",
    },
    {
        name: "TaskSpace.spaceId",
        signature: "task.spaceId",
        summary: "Stable numeric identifier for this task space.",
    },
    {
        name: "TaskSpace.name",
        signature: "task.name",
        summary: "Human-readable task-space name.",
    },
    {
        name: "TaskSpace.ownership",
        signature: "task.ownership",
        summary: "Ownership state captured when this TaskSpace was created.",
    },
    {
        name: "TaskSpace.page",
        signature: "task.page(label)",
        summary: "Create a lazy Page handle for a durable page label.",
    },
    {
        name: "TaskSpace.userPage",
        signature: "task.userPage()",
        summary: "Return the tab active at the claim/takeover boundary, when one was captured.",
    },
    {
        name: "TaskSpace.pages",
        signature: "await task.pages()",
        summary: "List the managed Page handles in this space.",
    },
    {
        name: "TaskSpace.tabs",
        signature: "await task.tabs()",
        summary: "List managed Pages and unmanaged tabs in this space.",
    },
    {
        name: "TaskSpace.newPage",
        signature: "await task.newPage()",
        summary: "Create and durably label a blank Page.",
    },
    {
        name: "TaskSpace.adopt",
        signature: "await task.adopt(unmanagedPage, { as? })",
        summary: "Bring an unmanaged tab under the Page lifecycle.",
        options: { as: option("string", "Permanent Page label.") },
    },
    {
        name: "TaskSpace.release",
        signature: "await task.release(label)",
        summary: "Stop managing an unknown-origin Page without closing it.",
    },
    {
        name: "TaskSpace.waitForControl",
        signature: "await task.waitForControl({ interval?, timeout? })",
        summary: "Wait for Agent control without taking it from the user.",
        options: {
            interval: option("positiveMilliseconds", "Polling interval in milliseconds."),
            timeout,
        },
    },
    {
        name: "TaskSpace.handOff",
        signature: "await task.handOff()",
        summary: "Give control of this space to the user.",
    },
    {
        name: "TaskSpace.finish",
        signature: "await task.finish({ keep })",
        summary: "Finish the task and return a receipt with retained and closed managed Page labels; an empty list closes the space when no protected tabs remain.",
        options: {
            keep: option("pageRetention", 'Required Page retention policy: "all" or an array of managed Page labels.'),
        },
    },
    {
        name: "TaskSpace.cdp",
        signature: "await task.cdp(method, params?, { timeout? })",
        summary: "Send a Target or Browser domain CDP command.",
        options: { timeout },
    },
    {
        name: "Page.label",
        signature: "page.label",
        summary: "Durable Page label used to restore the tab across rounds.",
    },
    {
        name: "Page.spaceId",
        signature: "page.spaceId",
        summary: "Numeric identifier of the Page's task space.",
    },
    {
        name: "Page.openedBy",
        signature: "page.openedBy",
        summary: "Conservative origin attribution for this Page.",
    },
    {
        name: "Page.targetId",
        signature: "page.targetId",
        summary: "Internal browser target identifier for advanced Target-domain CDP only.",
    },
    {
        name: "Page.goto",
        signature: "await page.goto(url, { referer?, timeout?, waitUntil? })",
        summary: "Navigate this Page in place. Timeout errors report whether the new document committed, plus its URL and readyState when available.",
        options: {
            referer: option("nonEmptyString", "HTTP Referer header for the navigation."),
            timeout,
            waitUntil: option("string", "Completion state; defaults to load. networkidle requires 500ms without network activity.", ["commit", "domcontentloaded", "load", "networkidle"]),
        },
    },
    {
        name: "Page.reload",
        signature: "await page.reload({ timeout?, waitUntil? })",
        summary: "Reload this Page and wait for the selected navigation state.",
        options: {
            timeout,
            waitUntil: option("string", "Completion state; defaults to load. networkidle requires 500ms without network activity.", ["commit", "domcontentloaded", "load", "networkidle"]),
        },
    },
    {
        name: "Page.snapshot",
        signature: "await page.snapshot({ scope?, root?, includeActionMarks?, includeStableLocator? })",
        summary: "Return a semantic snapshot of the current viewport, full Page, or one snapshot-ref subtree with Page provenance.",
        options: {
            scope: option("string", "Snapshot scope; defaults to only_within_viewport, including visible iframe content returned by the browser. Use subtree with an iframe root ref to focus on that frame.", ["full_page", "only_within_viewport", "subtree"]),
            root: option("nonEmptyString", "Valid Page snapshot ref such as @21; required only when scope is subtree. Partial snapshots preserve existing node identities."),
            includeActionMarks: option("boolean", "Include action marks."),
            includeStableLocator: option("boolean", "Include stable locators."),
        },
    },
    {
        name: "Page.screenshot",
        signature: "await page.screenshot({ path?, fullPage?, clip?, scale?, raw? })",
        summary: "Capture this Page to a PNG file.",
        options: {
            path: option("string", "Output path; missing parent directories are created."),
            fullPage: option("boolean", "Capture the full scrollable page."),
            clip: option("clip", "CSS-pixel clipping rectangle."),
            scale: option("string", "Output scale mode; css uses CSS-pixel sizing and is the default.", ["css"]),
            raw: option("boolean", "Bypass device-pixel-ratio correction."),
        },
    },
    {
        name: "Page.url",
        signature: "await page.url()",
        summary: "Read this Page's current URL.",
    },
    {
        name: "Page.waitForURL",
        signature: "await page.waitForURL(urlMatcher, { timeout? })",
        summary: "Wait for an exact URL, Playwright-style glob, RegExp, or synchronous predicate receiving a URL object.",
        options: { timeout },
    },
    {
        name: "Page.waitForEvent",
        signature: "await page.waitForEvent(event, { timeout? })",
        summary: 'Wait for this Page\'s next "popup" or "download"; arm the promise before the triggering action.',
        options: { timeout },
    },
    {
        name: "Download.page",
        signature: "download.page()",
        summary: "Return the Page that started this download.",
    },
    {
        name: "Download.url",
        signature: "download.url()",
        summary: "Return the download URL.",
    },
    {
        name: "Download.suggestedFilename",
        signature: "download.suggestedFilename()",
        summary: "Return Chromium's suggested file name.",
    },
    {
        name: "Download.saveAs",
        signature: "await download.saveAs(absolutePath)",
        summary: "Wait for completion and copy the download to an absolute path, creating missing parent directories.",
    },
    {
        name: "Download.path",
        signature: "await download.path()",
        summary: "Wait for completion and return the round-local temporary file path.",
    },
    {
        name: "Download.failure",
        signature: "await download.failure()",
        summary: "Wait for completion and return null or the failure reason.",
    },
    {
        name: "Download.cancel",
        signature: "await download.cancel()",
        summary: "Cancel this download by its Chromium download identifier.",
    },
    {
        name: "Download.delete",
        signature: "await download.delete()",
        summary: "Delete this download's round-local temporary files.",
    },
    {
        name: "Page.waitForTimeout",
        signature: "await page.waitForTimeout(timeout)",
        summary: "Wait a fixed number of milliseconds without activating this Page.",
    },
    {
        name: "Page.title",
        signature: "await page.title()",
        summary: "Read this Page's current title.",
    },
    {
        name: "Page.info",
        signature: "await page.info()",
        summary: "Read URL, title, viewport, scroll, and dialog state.",
    },
    {
        name: "Page.acceptDialog",
        signature: "await page.acceptDialog(promptText?)",
        summary: "Accept this Page's JavaScript dialog, optionally supplying prompt text; return false when none is open.",
    },
    {
        name: "Page.dismissDialog",
        signature: "await page.dismissDialog()",
        summary: "Dismiss this Page's JavaScript dialog; return false when none is open.",
    },
    {
        name: "Page.evaluate",
        signature: "await page.evaluate(fnOrString, argument?)",
        summary: "Run JavaScript in this Page; callbacks receive JSON data but cannot capture Node.js variables. Safety-timeout errors report executionStopped, pageResponsive, and mayHaveLateEffects.",
    },
    {
        name: "Page.waitForFunction",
        signature: "await page.waitForFunction(fnOrString, argument?, { timeout?, polling? })",
        summary: "Wait until a Page function or expression returns a truthy value.",
        options: {
            timeout,
            polling: option("positiveMilliseconds", "Polling interval in milliseconds; defaults to 100."),
        },
    },
    {
        name: "Page.fetch",
        signature: "await page.fetch(url, options?)",
        summary: "Run window.fetch in this Page, obey browser CORS, and return a structured response.",
        options: {
            timeout,
            saveAs: option("nonEmptyString", "Write the response body to this path without text conversion."),
            method: option("string", "HTTP method."),
            headers: option("stringRecord", "Request headers."),
            body: option("string", "Request body."),
            cache: option("string", "Fetch cache mode.", [
                "default",
                "no-store",
                "reload",
                "no-cache",
                "force-cache",
                "only-if-cached",
            ]),
            credentials: option("string", "Fetch credentials mode.", [
                "omit",
                "same-origin",
                "include",
            ]),
            integrity: option("string", "Subresource integrity value."),
            keepalive: option("boolean", "Allow the request to outlive the page."),
            mode: option("string", "Fetch request mode.", [
                "cors",
                "no-cors",
                "same-origin",
            ]),
            redirect: option("string", "Redirect handling mode.", [
                "follow",
                "error",
                "manual",
            ]),
            referrer: option("string", "Request referrer."),
            referrerPolicy: option("string", "Request referrer policy."),
        },
    },
    {
        name: "Page.cdp",
        signature: "await page.cdp(method, params?, { timeout? })",
        summary: "Send a CDP command through this Page's target session.",
        options: { timeout },
    },
    {
        name: "Page.waitForSelector",
        signature: "await page.waitForSelector(selector, { timeout?, state? })",
        summary: "Wait for an element state in this Page.",
        options: {
            timeout,
            state: option("string", "Required element state.", [
                "attached",
                "detached",
                "visible",
                "hidden",
            ]),
        },
    },
    {
        name: "Page.waitForLoadState",
        signature: "await page.waitForLoadState(state?, { timeout?, idleMs? })",
        summary: "Wait for DOM content, load, or network-idle state; no state defaults to load.",
        options: {
            timeout,
            idleMs: option("positiveMilliseconds", "Required network-idle window in milliseconds."),
        },
    },
    {
        name: "Page.events",
        signature: "await page.events()",
        summary: "Read and clear CDP events buffered for this Page.",
    },
    {
        name: "Page.click",
        signature: "await page.click(selector, { button?, clickCount?, delay?, position?, force?, timeout?, label? })",
        summary: "Click an element with native CDP input.",
        options: {
            button,
            clickCount: option("positiveInteger", "Number of clicks."),
            delay,
            position,
            force,
            timeout: actionTimeout,
            label,
        },
    },
    {
        name: "Page.dblclick",
        signature: "await page.dblclick(selector, { button?, delay?, position?, force?, timeout?, label? })",
        summary: "Double-click an element with native CDP input.",
        options: { button, delay, position, force, timeout: actionTimeout, label },
    },
    {
        name: "Page.hover",
        signature: "await page.hover(selector, { position?, force?, timeout?, label? })",
        summary: "Move the mouse over an element.",
        options: { position, force, timeout: actionTimeout, label },
    },
    {
        name: "Page.dragAndDrop",
        signature: "await page.dragAndDrop(source, target, { button?, sourcePosition?, targetPosition?, force?, timeout?, label? })",
        summary: "Drag from one element to another.",
        options: {
            button,
            sourcePosition: position,
            targetPosition: position,
            force,
            timeout: actionTimeout,
            label,
        },
    },
    {
        name: "Page.fill",
        signature: "await page.fill(selector, value, { clearFirst?, timeout? })",
        summary: "Fill the selected field, its editing host, or its unique fillable descendant, then confirm editing took effect.",
        options: {
            clearFirst: option("boolean", "Clear the current value before filling."),
            timeout: actionTimeout,
        },
    },
    {
        name: "Page.selectOption",
        signature: "await page.selectOption(selector, valueOrValues, { timeout? })",
        summary: "Select by a value-or-label string or { value?, label?, index? }; arrays select multiple options, while null or [] clears the selection. The select must be enabled, but disabled options remain programmatically selectable.",
        options: { timeout: actionTimeout },
    },
    {
        name: "Page.focus",
        signature: "await page.focus(selector, { timeout? })",
        summary: "Focus the element, its nearest interactive ancestor, or its unique editable descendant.",
        options: { timeout: actionTimeout },
    },
    {
        name: "Page.press",
        signature: "await page.press(selector, chord, { delay?, timeout? })",
        summary: "Focus one element and press a key or shortcut chord. Named keys are case-insensitive; single-character keys preserve case.",
        options: { delay, timeout: actionTimeout },
    },
    {
        name: "Page.setInputFiles",
        signature: "await page.setInputFiles(selector, pathOrPaths)",
        summary: "Set files on a file input resolved from the input, its label, or a unique descendant.",
    },
    {
        name: "Page.waitForFileChooser",
        signature: "page.waitForFileChooser({ timeout? })",
        summary: "Wait for a dynamically created file chooser.",
        options: { timeout },
    },
    {
        name: "FileChooser.isMultiple",
        signature: "fileChooser.isMultiple()",
        summary: "Report whether the chooser accepts multiple files.",
    },
    {
        name: "FileChooser.setFiles",
        signature: "await fileChooser.setFiles(pathOrPaths)",
        summary: "Set files on an intercepted chooser and return any JavaScript dialog opened by the upload.",
    },
    {
        name: "Page.close",
        signature: "await page.close()",
        summary: "Close this Page after confirming its tab disappeared.",
    },
    {
        name: "Page.mouse.click",
        signature: "await page.mouse.click(x, y, { button?, clickCount?, delay?, label? })",
        summary: "Click CSS-pixel coordinates with native CDP input.",
        options: {
            button,
            clickCount: option("positiveInteger", "Number of clicks."),
            delay,
            label,
        },
    },
    {
        name: "Page.mouse.move",
        signature: "await page.mouse.move(x, y, { steps?, label? })",
        summary: "Move the mouse to CSS-pixel coordinates.",
        options: {
            steps: option("positiveInteger", "Number of movement steps."),
            label,
        },
    },
    {
        name: "Page.mouse.down",
        signature: "await page.mouse.down({ button?, clickCount? })",
        summary: "Press a mouse button at the current Page position.",
        options: {
            button,
            clickCount: option("positiveInteger", "Click count reported to the page."),
        },
    },
    {
        name: "Page.mouse.up",
        signature: "await page.mouse.up({ button?, clickCount? })",
        summary: "Release a mouse button at the current Page position.",
        options: {
            button,
            clickCount: option("positiveInteger", "Click count reported to the page."),
        },
    },
    {
        name: "Page.mouse.wheel",
        signature: "await page.mouse.wheel(deltaX, deltaY, { label? })",
        summary: "Perform a short wheel-input motion at the current Page position; move or click over the intended scroll container first in each process.",
        options: { label },
    },
    {
        name: "Page.keyboard.down",
        signature: "await page.keyboard.down(key)",
        summary: "Press and hold a keyboard key.",
    },
    {
        name: "Page.keyboard.up",
        signature: "await page.keyboard.up(key)",
        summary: "Release a keyboard key.",
    },
    {
        name: "Page.keyboard.press",
        signature: "await page.keyboard.press(chord, { delay? })",
        summary: "Press and release a key or portable shortcut chord. Named keys are case-insensitive; single-character keys preserve case.",
        options: { delay },
    },
    {
        name: "Page.keyboard.type",
        signature: "await page.keyboard.type(text, { delay? })",
        summary: "Type text using physical keys where possible.",
        options: { delay },
    },
    {
        name: "Page.keyboard.insertText",
        signature: "await page.keyboard.insertText(text)",
        summary: "Insert text without synthesizing key presses.",
    },
    {
        name: "Page.keyboard.paste",
        signature: "await page.keyboard.paste(textOrContent)",
        summary: "Send native paste with a string or { text, html? }, then restore the clipboard.",
    },
];
const entriesByName = new Map(PUBLIC_API_SCHEMA.map((entry) => [entry.name, entry]));
function publicApiEntry(name) {
    return entriesByName.get(name);
}
/** Validate an option object using the same schema shown in help and docs. */
function validatePublicApiOptions(name, value) {
    const entry = publicApiEntry(name);
    if (!entry?.options) {
        throw new Error(`public API schema has no options for ${name}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(validationMessage(entry, `${displayName(name)} options must be an object`));
    }
    for (const [key, optionValue] of Object.entries(value)) {
        const specification = entry.options[key];
        if (!specification) {
            throw new TypeError(validationMessage(entry, `${displayName(name)} received unknown option: ${key}`));
        }
        if (optionValue === undefined)
            continue;
        try {
            validateOptionValue(displayName(name), key, optionValue, specification);
        }
        catch (error) {
            if (error instanceof TypeError) {
                throw new TypeError(validationMessage(entry, error.message), {
                    cause: error,
                });
            }
            throw error;
        }
    }
}
function validationMessage(entry, message) {
    return `${message}. Expected: ${entry.signature}`;
}
function displayName(name) {
    return name
        .replace(/^TaskSpace/, "task")
        .replace(/^Page/, "page")
        .replace(/^Download/, "download");
}
function validateOptionValue(apiName, optionName, value, specification) {
    let valid = false;
    switch (specification.kind) {
        case "boolean":
            valid = typeof value === "boolean";
            break;
        case "clip":
            valid = isClip(value);
            break;
        case "finiteNumber":
            valid = typeof value === "number" && Number.isFinite(value);
            break;
        case "nonNegativeNumber":
            valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
            break;
        case "nonEmptyString":
            valid = typeof value === "string" && value.length > 0;
            break;
        case "pageRetention":
            valid =
                value === "all" ||
                    (Array.isArray(value) &&
                        value.every((item) => typeof item === "string" && item.length > 0) &&
                        new Set(value).size === value.length);
            break;
        case "positiveInteger":
            valid = Number.isInteger(value) && value > 0;
            break;
        case "positiveMilliseconds":
            valid = typeof value === "number" && Number.isFinite(value) && value > 0;
            break;
        case "string":
            valid = typeof value === "string";
            break;
        case "stringRecord":
            valid =
                isPlainObject(value) &&
                    Object.values(value).every((item) => typeof item === "string");
            break;
        case "point":
            valid = isPoint(value);
            break;
    }
    if (!valid) {
        if (specification.kind === "positiveMilliseconds") {
            throw new TypeError(`${optionName} must be a positive number of milliseconds`);
        }
        if (specification.kind === "nonNegativeNumber") {
            throw new TypeError(`${apiName} ${optionName} must be non-negative`);
        }
        if (specification.kind === "nonEmptyString") {
            throw new TypeError(`${apiName} ${optionName} must be a non-empty string`);
        }
        if (specification.kind === "positiveInteger") {
            throw new TypeError(`${apiName} ${optionName} must be a positive integer`);
        }
        if (specification.kind === "pageRetention") {
            throw new TypeError(`${apiName} ${optionName} must be "all" or an array of unique non-empty Page labels`);
        }
        if (specification.kind === "stringRecord") {
            throw new TypeError(`${apiName} ${optionName} must be an object with string values`);
        }
        throw new TypeError(`${apiName} ${optionName} must be ${specification.kind}`);
    }
    if (specification.values && !specification.values.includes(value)) {
        throw new TypeError(`${apiName} ${optionName} must be one of ${specification.values.join(", ")}`);
    }
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isPoint(value) {
    if (!isPlainObject(value))
        return false;
    const keys = Object.keys(value);
    return (keys.length === 2 &&
        keys.includes("x") &&
        keys.includes("y") &&
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        typeof value.y === "number" &&
        Number.isFinite(value.y));
}
function isClip(value) {
    if (!isPlainObject(value))
        return false;
    const keys = Object.keys(value);
    const allowed = new Set(["x", "y", "width", "height", "scale"]);
    return (keys.every((key) => allowed.has(key)) &&
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        typeof value.y === "number" &&
        Number.isFinite(value.y) &&
        typeof value.width === "number" &&
        Number.isFinite(value.width) &&
        value.width > 0 &&
        typeof value.height === "number" &&
        Number.isFinite(value.height) &&
        value.height > 0 &&
        (value.scale === undefined ||
            (typeof value.scale === "number" &&
                Number.isFinite(value.scale) &&
                value.scale > 0)));
}

let cache = null;
function help(helpers, ...names) {
    const docs = getDocsMap();
    if (names.length === 0) {
        return PUBLIC_API_SCHEMA.map(publicEntryToHelpDoc);
    }
    if (names[0] === "legacy") {
        if (names.length === 1) {
            return [...docs.values()].filter((doc) => doc.name in helpers && !publicApiEntry(doc.name));
        }
        return helpLegacyNames(docs, names.slice(1));
    }
    if (names.length === 1) {
        const publicEntry = findPublicEntry(names[0]);
        if (publicEntry)
            return publicEntryToHelpDoc(publicEntry);
        if (names[0] in helpers) {
            return `Legacy helper hidden from default help: ${names[0]}. Use help("legacy", "${names[0]}").`;
        }
        return `Unknown helper: ${names[0]}`;
    }
    return names.map((name) => {
        const publicEntry = findPublicEntry(name);
        if (publicEntry)
            return publicEntryToHelpDoc(publicEntry);
        return {
            name,
            signature: name,
            description: `Legacy helper hidden from default help. Use help("legacy", "${name}").`,
            params: [],
            returns: null,
            async: false,
        };
    });
}
function formatHelp(doc) {
    const lines = [];
    if (doc.public) {
        lines.push(doc.name, "");
    }
    if (doc.description) {
        lines.push(doc.description);
    }
    for (const p of doc.params) {
        const opt = p.optional ? "?" : "";
        const type = p.type ? `: ${p.type}` : "";
        const desc = p.description ? ` — ${p.description}` : "";
        const def = p.default ? ` (default: ${p.default})` : "";
        lines.push(`@param ${p.rest ? "..." : ""}${p.name}${opt}${type}${desc}${def}`);
    }
    if (doc.returns) {
        lines.push(`@returns ${doc.returns}`);
    }
    lines.push("");
    lines.push(doc.signature);
    return lines.join("\n");
}
function getDocsMap() {
    if (cache)
        return cache;
    cache = new Map();
    const source = readSelf();
    if (!source)
        return cache;
    const comments = [];
    let ast;
    try {
        ast = parse(source, {
            ecmaVersion: "latest",
            sourceType: "module",
            onComment: comments,
            locations: true,
        });
    }
    catch {
        return cache;
    }
    const commentsByEndLine = new Map();
    for (const c of comments) {
        if (c.type === "Block") {
            commentsByEndLine.set(c.loc.end.line, c);
        }
    }
    walkFunctions(ast, (node) => {
        const name = extractFunctionName(node);
        if (!name)
            return;
        const startLine = node.loc.start.line;
        const jsDoc = commentsByEndLine.get(startLine - 1);
        const parsed = jsDoc ? parseJSDoc(jsDoc.value) : null;
        const params = extractParams(node, parsed);
        const isAsync = node.async === true;
        const paramSig = params
            .map((p) => {
            const rest = p.rest ? "..." : "";
            const opt = p.optional ? "?" : "";
            return `${rest}${p.name}${opt}`;
        })
            .join(", ");
        const retStr = parsed?.returns || (isAsync ? "Promise<...>" : null);
        const signature = `${name}(${paramSig})${retStr ? ` → ${retStr}` : ""}`;
        cache.set(name, {
            name,
            signature,
            description: parsed?.description || null,
            params,
            returns: retStr,
            async: isAsync,
        });
    });
    walkAliases(ast, (name, target) => {
        const existing = cache.get(target);
        if (existing && !cache.has(name)) {
            cache.set(name, { ...existing, name });
        }
    });
    return cache;
}
function helpLegacyNames(docs, names) {
    const resolved = names
        .map((name) => docs.get(name))
        .filter(Boolean);
    if (resolved.length !== names.length) {
        const missing = names.find((name) => !docs.has(name));
        return `Unknown legacy helper: ${missing}`;
    }
    return resolved.length === 1 ? resolved[0] : resolved;
}
function findPublicEntry(name) {
    const normalized = name
        .replace(/^task\./, "TaskSpace.")
        .replace(/^page\./, "Page.");
    return publicApiEntry(normalized);
}
function publicEntryToHelpDoc(entry) {
    const options = entry.options
        ? Object.entries(entry.options)
            .map(([name, specification]) => {
            const values = specification.values
                ? ` (${specification.values.join(" | ")})`
                : "";
            return `${name}${values}: ${specification.description}`;
        })
            .join(" ")
        : "";
    return {
        name: entry.name,
        signature: entry.signature,
        description: options
            ? `${entry.summary} Options: ${options}`
            : entry.summary,
        params: [],
        returns: null,
        async: entry.signature.startsWith("await "),
        public: true,
    };
}
function readSelf() {
    try {
        const selfPath = fileURLToPath(import.meta.url);
        return readFileSync(selfPath, "utf-8");
    }
    catch {
        return null;
    }
}
function walkFunctions(node, visitor) {
    if (!node || typeof node !== "object")
        return;
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression") {
        visitor(node);
    }
    for (const key of Object.keys(node)) {
        if (key === "type" || key === "loc" || key === "start" || key === "end")
            continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) {
                if (item && typeof item.type === "string")
                    walkFunctions(item, visitor);
            }
        }
        else if (child && typeof child.type === "string") {
            walkFunctions(child, visitor);
        }
    }
}
function walkAliases(node, visitor) {
    if (!node || typeof node !== "object")
        return;
    if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations || []) {
            if (decl.id?.type === "Identifier" && decl.init?.type === "Identifier") {
                visitor(decl.id.name, decl.init.name);
            }
        }
    }
    for (const key of Object.keys(node)) {
        if (key === "type" || key === "loc" || key === "start" || key === "end")
            continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) {
                if (item && typeof item.type === "string")
                    walkAliases(item, visitor);
            }
        }
        else if (child && typeof child.type === "string") {
            walkAliases(child, visitor);
        }
    }
}
function extractFunctionName(node) {
    if (node.id?.name)
        return node.id.name;
    return null;
}
function extractParams(node, jsdoc) {
    return (node.params || []).map((p) => {
        const info = resolveParam(p);
        const jsdocParam = jsdoc?.params.find((jp) => jp.name === info.name);
        return {
            ...info,
            type: jsdocParam?.type || null,
            description: jsdocParam?.description || null,
        };
    });
}
function parseJSDoc(raw) {
    const lines = raw.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim());
    const descLines = [];
    const params = [];
    let returns = null;
    for (const line of lines) {
        const paramMatch = line.match(/^@param\s+(?:\{([^}]*)\}\s+)?(\[?\w+\]?)(?:(?:\s+[-–—]\s*|\s+)(.+))?\s*$/);
        if (paramMatch) {
            const name = paramMatch[2].replace(/^\[|\]$/g, "");
            params.push({
                name,
                type: paramMatch[1] || null,
                description: paramMatch[3] || null,
            });
            continue;
        }
        const returnsMatch = line.match(/^@returns?\s+(?:\{([^}]*)\}\s*)?(.*)/);
        if (returnsMatch) {
            returns = returnsMatch[1] || returnsMatch[2] || null;
            continue;
        }
        if (line.startsWith("@"))
            continue;
        if (line)
            descLines.push(line);
    }
    return {
        description: descLines.join(" ").trim() || null,
        params,
        returns,
    };
}
function resolveParam(node) {
    if (node.type === "RestElement") {
        const inner = resolveParam(node.argument);
        return { ...inner, rest: true, optional: true };
    }
    if (node.type === "AssignmentPattern") {
        const inner = resolveParam(node.left);
        const defStr = nodeToString(node.right);
        return { ...inner, optional: true, default: defStr };
    }
    if (node.type === "Identifier") {
        return { name: node.name, optional: false, rest: false, default: null };
    }
    if (node.type === "ObjectPattern") {
        const props = (node.properties || [])
            .map((p) => p.key?.name || "?")
            .join(", ");
        return { name: `{${props}}`, optional: false, rest: false, default: null };
    }
    if (node.type === "ArrayPattern") {
        return { name: "[...]", optional: false, rest: false, default: null };
    }
    return { name: "?", optional: false, rest: false, default: null };
}
function nodeToString(node) {
    if (!node)
        return "?";
    if (node.type === "Literal")
        return JSON.stringify(node.value);
    if (node.type === "ObjectExpression")
        return "{}";
    if (node.type === "ArrayExpression")
        return "[]";
    if (node.type === "Identifier")
        return node.name;
    return "...";
}

const STALE_SKILL_PREFIX = "[ego-browser:skill-stale]";
// These are the public top-level members exposed by the formal 1.3 Skill. Keep
// the guard narrow: 1.2.3 globals remain supported, while unpublished beta
// namespaces do not become a new compatibility surface.
const EGO_BROWSER_13_MEMBERS = new Set([
    "helper",
    "site",
    "showTaskState",
    "snapshot",
    "listProfile",
    "listTaskSpace",
    "newTaskSpace",
    "switchTaskSpace",
    "claimTaskSpace",
    "handOffTaskSpace",
    "takeOverTaskSpace",
    "waitForAgentControlTaskSpace",
    "completeTaskSpace",
    "closeTaskSpace",
]);
class EgoBrowserSkillStaleError extends Error {
    constructor(member) {
        super([
            `${STALE_SKILL_PREFIX} This script uses the old egoBrowser.${member} API.`,
            "Re-read the installed ego-browser skill and retry with the current TaskSpace/Page API. Start with:",
            "  const task = await taskSpace(nameOrId)",
        ].join("\n"));
        this.name = "EgoBrowserSkillStaleError";
    }
}
/** Create the migration-only namespace installed in place of the 1.3 facade. */
function createStaleEgoBrowserGuard() {
    return new Proxy(Object.create(null), {
        get(_target, property) {
            if (typeof property !== "string" ||
                !EGO_BROWSER_13_MEMBERS.has(property)) {
                return undefined;
            }
            const error = new EgoBrowserSkillStaleError(property);
            // A stale Skill is a round-level mismatch. Mark it even if the script
            // catches the Error so unrelated business output cannot hide the remedy.
            markHardStop(error.message);
            throw error;
        },
    });
}
/** Install the guard for SDK hosts that expose helpers directly on globalThis. */
function installStaleEgoBrowserGuard(target) {
    Object.defineProperty(target, "egoBrowser", {
        value: createStaleEgoBrowserGuard(),
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
// Upper bound for buffered CDP events. The runtime can be long-lived (installEgoSdk
// inside the browser); without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const FRAME_LIFECYCLE_LOST = /Frame with the given frameId is not found|No frame with given id found|No target with given id/i;
const BROWSER_LEVEL = (method) => method.startsWith("Target.") || method.startsWith("Browser.");
const OOPIF_AUTO_ATTACH_PARAMS = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    // Ego Lite can pause an excluded dedicated worker without attaching it,
    // leaving no session through which the harness can resume that worker.
    filter: [
        { type: "iframe", exclude: false },
        { type: "worker", exclude: false },
        { exclude: true },
    ],
};
const DIALOG_BLOCKED_METHOD = (method) => method.startsWith("Input.") ||
    method.startsWith("Runtime.") ||
    method === "DOM.setFileInputFiles" ||
    method === "Page.navigate";
let nextMessageId = 1;
const pending = new Map();
const browserEvents = [];
const browserEventSubscribers = new Set();
const pageEventSubscribers = new Map();
const targetStates = new Map();
const sessionTargets = new Map();
const childTargets = new Map();
const parentTargets = new Map();
let defaultTargetId = null;
let userControlProbeState = "idle";
let userControlStopError = null;
let userControlProbeGeneration = 0;
let callbackRuntime;
class CdpRequestTimeoutError extends Error {
    code = "EGO_CDP_REQUEST_TIMEOUT";
    method;
    timeoutMs;
    sessionId;
    constructor(method, timeoutMs, sessionId) {
        super(`CDP request timed out: ${method}`);
        this.name = "CdpRequestTimeoutError";
        this.method = method;
        this.timeoutMs = timeoutMs;
        this.sessionId = sessionId;
    }
}
function isCdpRequestTimeoutError(error) {
    return (error instanceof CdpRequestTimeoutError ||
        (Boolean(error) &&
            typeof error === "object" &&
            error.code === "EGO_CDP_REQUEST_TIMEOUT"));
}
/** The CDP session that issued a failed command is gone. */
function isSessionLostError(error) {
    return error instanceof Error && SESSION_LOST.test(error.message);
}
/** A frame or iframe target vanished between enumeration and use. */
function isFrameLifecycleError(error) {
    return error instanceof Error && FRAME_LIFECYCLE_LOST.test(error.message);
}
/**
 * A frame or its session disappeared mid-operation. Callers that have not yet
 * dispatched input may rediscover frame sessions and retry.
 */
function isRetryableFrameLifecycleError(error) {
    return isSessionLostError(error) || isFrameLifecycleError(error);
}
/**
 * Signals that a modal JavaScript dialog prevented a CDP command from
 * completing. The dialog remains open; Page-level code decides whether to
 * expose it in an action receipt or surface this error to the caller.
 */
class PageDialogOpenedError extends Error {
    code = "EGO_PAGE_DIALOG_OPENED";
    method;
    sessionId;
    dialog;
    constructor(method, sessionId, dialog) {
        super(`a JavaScript dialog opened while ${method} was running; handle the dialog before continuing`);
        this.name = "PageDialogOpenedError";
        this.method = method;
        this.sessionId = sessionId;
        this.dialog = { ...dialog };
    }
}
function isPageDialogOpenedError(error) {
    return (error instanceof PageDialogOpenedError ||
        (Boolean(error) &&
            typeof error === "object" &&
            error.code === "EGO_PAGE_DIALOG_OPENED"));
}
function targetState(targetId) {
    let target = targetStates.get(targetId);
    if (!target) {
        target = {
            sessionId: null,
            sessionAt: 0,
            sessionInflight: null,
            events: [],
            pageEventsEnabled: false,
            networkDomainEnabled: false,
            networkEnableInflight: null,
            autoAttachEnabled: false,
            autoAttachInflight: null,
            inflightNetworkRequests: new Map(),
            ignoredFaviconRequestIds: new Set(),
            lastNetworkActivityAt: state.now(),
            pendingDialog: null,
            fileChooserInterception: null,
        };
        targetStates.set(targetId, target);
    }
    return target;
}
function registerSession(targetId, sessionId) {
    const target = targetState(targetId);
    if (target.sessionId === sessionId) {
        target.sessionAt = Date.now();
        sessionTargets.set(sessionId, targetId);
        return;
    }
    if (target.sessionId && target.sessionId !== sessionId) {
        sessionTargets.delete(target.sessionId);
    }
    target.sessionId = sessionId;
    target.sessionAt = Date.now();
    target.pageEventsEnabled = false;
    target.networkDomainEnabled = false;
    target.networkEnableInflight = null;
    target.autoAttachEnabled = false;
    target.autoAttachInflight = null;
    target.inflightNetworkRequests.clear();
    target.ignoredFaviconRequestIds.clear();
    target.lastNetworkActivityAt = state.now();
    target.pendingDialog = null;
    sessionTargets.set(sessionId, targetId);
}
function registerTargetParent(targetId, parentTargetId) {
    const previousParent = parentTargets.get(targetId);
    if (previousParent === parentTargetId) {
        // A renderer swap can reattach the same frame target after a new document
        // request has already started in the parent session.
        migrateFrameRequests(targetId, parentTargetId);
        return;
    }
    if (previousParent) {
        const previousChildren = childTargets.get(previousParent);
        previousChildren?.delete(targetId);
        if (previousChildren?.size === 0)
            childTargets.delete(previousParent);
    }
    parentTargets.set(targetId, parentTargetId);
    let children = childTargets.get(parentTargetId);
    if (!children) {
        children = new Set();
        childTargets.set(parentTargetId, children);
    }
    children.add(targetId);
    migrateFrameRequests(targetId, parentTargetId);
}
function migrateFrameRequests(targetId, parentTargetId) {
    const destination = targetState(targetId);
    const rootTargetId = pageRootTargetId(parentTargetId);
    for (const sourceTargetId of pageTreeTargetIds(rootTargetId)) {
        if (sourceTargetId === targetId)
            continue;
        const source = targetStates.get(sourceTargetId);
        if (!source)
            continue;
        for (const [requestId, request] of source.inflightNetworkRequests) {
            if (request.frameId !== targetId)
                continue;
            source.inflightNetworkRequests.delete(requestId);
            destination.inflightNetworkRequests.set(requestId, request);
            destination.lastNetworkActivityAt = Math.max(destination.lastNetworkActivityAt, source.lastNetworkActivityAt);
        }
    }
}
function pageRootTargetId(targetId) {
    let current = targetId;
    const visited = new Set();
    while (parentTargets.has(current) && !visited.has(current)) {
        visited.add(current);
        current = parentTargets.get(current);
    }
    return current;
}
function pageTreeTargetIds(rootTargetId) {
    const result = [];
    const visit = (targetId) => {
        result.push(targetId);
        for (const childTargetId of childTargets.get(targetId) || []) {
            visit(childTargetId);
        }
    };
    visit(rootTargetId);
    return result;
}
function unregisterTargetParent(targetId) {
    const parentTargetId = parentTargets.get(targetId);
    if (!parentTargetId)
        return;
    parentTargets.delete(targetId);
    const siblings = childTargets.get(parentTargetId);
    siblings?.delete(targetId);
    if (siblings?.size === 0)
        childTargets.delete(parentTargetId);
}
function clearTargetSession(targetId, { remove = false } = {}) {
    const target = targetStates.get(targetId);
    if (!target)
        return;
    rejectFileChooserInterception(target, new Error("file chooser session was detached"));
    if (target.sessionId) {
        sessionTargets.delete(target.sessionId);
    }
    if (remove) {
        targetStates.delete(targetId);
        if (defaultTargetId === targetId)
            defaultTargetId = null;
        return;
    }
    target.sessionId = null;
    target.sessionAt = 0;
    target.sessionInflight = null;
    target.events.length = 0;
    target.pageEventsEnabled = false;
    target.networkDomainEnabled = false;
    target.networkEnableInflight = null;
    target.autoAttachEnabled = false;
    target.autoAttachInflight = null;
    target.inflightNetworkRequests.clear();
    target.ignoredFaviconRequestIds.clear();
    target.lastNetworkActivityAt = state.now();
    target.pendingDialog = null;
    target.fileChooserInterception = null;
}
function clearTargetSessionTree(targetId, { remove = false } = {}) {
    for (const childTargetId of [...(childTargets.get(targetId) || [])]) {
        clearTargetSessionTree(childTargetId, { remove: true });
    }
    clearTargetSession(targetId, { remove });
    if (remove) {
        childTargets.delete(targetId);
        unregisterTargetParent(targetId);
    }
}
function capEvents(events) {
    if (events.length > MAX_BUFFERED_EVENTS) {
        events.splice(0, events.length - MAX_BUFFERED_EVENTS);
    }
}
function isBrowserRuntime() {
    return Boolean(globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function");
}
function browserEgo() {
    if (!globalThis.ego) {
        throw new Error("browser runtime is not available");
    }
    return globalThis.ego;
}
/** Keep exceptions from crossing the native-to-JavaScript callback boundary. */
function guardNativeCallback(label, callback) {
    try {
        callback();
    }
    catch (error) {
        try {
            console.error(`[ego-browser] ${label} failed:`, error);
        }
        catch {
            // Error reporting must not re-enter the native callback failure.
        }
    }
}
function dispatchCdpMessage(payload) {
    guardNativeCallback("onCDPMessage", () => handleMessage(payload));
}
function dispatchCdpSendError(message, errorCode) {
    guardNativeCallback("onSendCDPMessageError", () => handleSendError(message, errorCode));
}
function bindRuntimeCallbacks(runtime) {
    if (callbackRuntime && callbackRuntime !== runtime) {
        releaseRuntimeCallbacks(callbackRuntime);
    }
    runtime.onCDPMessage = dispatchCdpMessage;
    runtime.onSendCDPMessageError = dispatchCdpSendError;
    callbackRuntime = runtime;
}
/** Release only callbacks installed by this runtime, preserving foreign owners. */
function releaseRuntimeCallbacks(runtime = callbackRuntime) {
    if (!runtime)
        return;
    if (runtime.onCDPMessage === dispatchCdpMessage) {
        runtime.onCDPMessage = undefined;
    }
    if (runtime.onSendCDPMessageError === dispatchCdpSendError) {
        runtime.onSendCDPMessageError = undefined;
    }
    if (callbackRuntime === runtime)
        callbackRuntime = undefined;
}
/** Stop all runtime work before an embedded Node context is discarded. */
function disposeBrowserRuntime(runtime = callbackRuntime) {
    releaseRuntimeCallbacks(runtime);
    rejectAllPending(new Error("ego-browser runtime was disposed"));
    browserEventSubscribers.clear();
    pageEventSubscribers.clear();
    invalidateSession();
}
/** Subscribe to Target/Browser events without consuming the legacy event queue. */
function subscribeBrowserEvents(listener) {
    if (typeof listener !== "function") {
        throw new TypeError("browser event listener must be a function");
    }
    browserEventSubscribers.add(listener);
    return () => browserEventSubscribers.delete(listener);
}
/** Subscribe to session events for one browser target. */
function subscribePageEvents(targetId, listener) {
    if (typeof targetId !== "string" || targetId.length === 0) {
        throw new TypeError("page event subscription requires a targetId");
    }
    if (typeof listener !== "function") {
        throw new TypeError("page event listener must be a function");
    }
    let listeners = pageEventSubscribers.get(targetId);
    if (!listeners) {
        listeners = new Set();
        pageEventSubscribers.set(targetId, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0)
            pageEventSubscribers.delete(targetId);
    };
}
function rawCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const runtime = browserEgo();
    bindRuntimeCallbacks(runtime);
    const id = nextMessageId++;
    const payload = JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new CdpRequestTimeoutError(method, timeoutMs, sessionId));
        }, timeoutMs);
        pending.set(id, {
            method,
            sessionId,
            resolve: (response) => {
                clearTimeout(timer);
                resolve(response);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        try {
            runtime.sendCDPMessage(payload);
        }
        catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(buildEgoError(error));
        }
    });
}
async function browserCdp(method, params = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
    // Test mock: cdpOverride bypasses everything including session injection.
    // Include the effective timeout so tests can verify timing contracts without
    // waiting for a real CDP deadline.
    if (state.cdpOverride) {
        return state.cdpOverride(method, params, sessionId, timeoutMs);
    }
    const explicit = sessionId !== undefined;
    let effective = sessionId;
    if (!explicit && !BROWSER_LEVEL(method)) {
        effective = await ensureSession();
    }
    const dialog = effective ? pendingDialog(effective) : null;
    if (dialog && DIALOG_BLOCKED_METHOD(method)) {
        throw new PageDialogOpenedError(method, effective, dialog);
    }
    try {
        const response = await rawCdp(method, params, effective, timeoutMs);
        recordCommandState(method, params, effective, response);
        return response;
    }
    catch (error) {
        const lost = SESSION_LOST.test(error?.message || "");
        if (lost && !explicit && !BROWSER_LEVEL(method)) {
            const lostTargetId = effective
                ? sessionTargets.get(effective)
                : defaultTargetId;
            if (lostTargetId)
                clearTargetSession(lostTargetId);
            const fresh = await ensureSession(lostTargetId);
            const response = await rawCdp(method, params, fresh, timeoutMs);
            recordCommandState(method, params, fresh, response);
            return response;
        }
        throw error;
    }
}
function recordCommandState(method, params, sessionId, response) {
    if (method === "Target.attachToTarget") {
        const attachedSessionId = response.result?.sessionId || response.sessionId;
        if (params?.targetId && attachedSessionId) {
            registerSession(params.targetId, attachedSessionId);
        }
        return;
    }
    if (method === "Target.detachFromTarget" && params?.sessionId) {
        const targetId = sessionTargets.get(params.sessionId);
        if (targetId)
            clearTargetSession(targetId);
        return;
    }
    if (!sessionId)
        return;
    const targetId = sessionTargets.get(sessionId);
    if (!targetId)
        return;
    const target = targetStates.get(targetId);
    if (!target)
        return;
    if (method === "Network.enable") {
        if (!target.networkDomainEnabled) {
            target.lastNetworkActivityAt = state.now();
        }
        target.networkDomainEnabled = true;
    }
    if (method === "Network.disable") {
        target.networkDomainEnabled = false;
        target.inflightNetworkRequests.clear();
        target.ignoredFaviconRequestIds.clear();
        target.lastNetworkActivityAt = state.now();
    }
    if (method === "Target.setAutoAttach") {
        target.autoAttachEnabled = params?.autoAttach === true;
    }
}
async function ensureSession(requestedTargetId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const cachedTargetId = requestedTargetId || state.preferredTargetId || defaultTargetId;
    const cached = cachedTargetId ? targetStates.get(cachedTargetId) : undefined;
    if (cached?.sessionId && Date.now() - cached.sessionAt < SESSION_TTL_MS) {
        await Promise.all([
            enablePageEvents(cached.sessionId, timeoutMs),
            enableNetworkTrackingForSession(cached.sessionId, false, timeoutMs),
            enableOopifAutoAttach(cached.sessionId, timeoutMs),
        ]);
        cached.sessionAt = Date.now();
        return cached.sessionId;
    }
    let targetId = requestedTargetId;
    if (!targetId) {
        const result = await invokeEgo("listTabs", () => browserEgo().listTabs());
        const tabs = result?.tabs || result?.targetInfos || [];
        const preferred = state.preferredTargetId
            ? tabs.find((tab) => tab.targetId === state.preferredTargetId)
            : null;
        const active = preferred || tabs.find((tab) => tab.active) || tabs[tabs.length - 1];
        if (!active) {
            throw new Error("no active tab to attach session");
        }
        targetId = active.targetId;
    }
    defaultTargetId = targetId;
    const target = targetState(targetId);
    if (target.sessionInflight) {
        return target.sessionInflight;
    }
    target.sessionInflight = (async () => {
        try {
            if (!target.sessionId) {
                const attached = await rawCdp("Target.attachToTarget", { targetId, flatten: true }, undefined, timeoutMs);
                const sessionId = attached.result?.sessionId || attached.sessionId;
                if (!sessionId) {
                    throw new Error("Target.attachToTarget returned no sessionId");
                }
                registerSession(targetId, sessionId);
            }
            await Promise.all([
                enablePageEvents(target.sessionId, timeoutMs),
                enableNetworkTrackingForSession(target.sessionId, false, timeoutMs),
                enableOopifAutoAttach(target.sessionId, timeoutMs),
            ]);
            target.sessionAt = Date.now();
            return target.sessionId;
        }
        finally {
            target.sessionInflight = null;
        }
    })();
    return target.sessionInflight;
}
/**
 * Attach sessions for every live OOPIF that belongs to one top-level Page.
 * Standard CDP reports an iframe target's parent as a frame id. The frame tree
 * and target metadata together recover the nearest Page/OOPIF target ancestor
 * without admitting unrelated iframe targets.
 */
async function ensureFrameSessions(pageTargetId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    if (typeof pageTargetId !== "string" || pageTargetId.length === 0) {
        throw new TypeError("ensureFrameSessions requires a non-empty targetId");
    }
    const deadline = state.now() + Math.max(1, timeoutMs);
    const remaining = () => Math.max(1, deadline - state.now());
    const pageSessionId = await ensureSession(pageTargetId, remaining());
    const [response, frameTreeResponse] = await Promise.all([
        browserCdp("Target.getTargets", {}, undefined, remaining()),
        browserCdp("Page.getFrameTree", {}, pageSessionId, remaining()),
    ]);
    const targetInfos = response?.result?.targetInfos || response?.targetInfos || [];
    const frameTree = frameTreeResponse?.result?.frameTree || frameTreeResponse?.frameTree;
    const frameParents = new Map();
    const collectFrameGraph = (tree, recursiveParentId) => {
        const frameId = tree?.frame?.id;
        if (typeof frameId !== "string")
            return;
        const protocolParentId = tree?.frame?.parentId;
        frameParents.set(frameId, typeof protocolParentId === "string"
            ? protocolParentId
            : recursiveParentId);
        for (const child of tree?.childFrames || []) {
            collectFrameGraph(child, frameId);
        }
    };
    if (frameTree)
        collectFrameGraph(frameTree, undefined);
    const rootFrameId = frameTree?.frame?.id;
    const iframeInfos = targetInfos.filter((info) => info?.type === "iframe" && typeof info.targetId === "string");
    const iframeInfoByTarget = new Map(iframeInfos.map((info) => [info.targetId, info]));
    const reportedParentFrameId = (info) => {
        const parentFrameId = info?.parentFrameId ?? info?.parentId;
        return typeof parentFrameId === "string" ? parentFrameId : undefined;
    };
    const parentFrameIdOf = (frameId) => {
        if (frameParents.has(frameId))
            return frameParents.get(frameId);
        return reportedParentFrameId(iframeInfoByTarget.get(frameId));
    };
    const ancestryToPage = (frameId) => {
        let current = frameId;
        let depth = 0;
        const visited = new Set();
        while (current && !visited.has(current)) {
            if (current === pageTargetId || current === rootFrameId) {
                return { belongs: true, depth };
            }
            visited.add(current);
            current = parentFrameIdOf(current);
            depth += 1;
        }
        return { belongs: false, depth };
    };
    const descendants = iframeInfos
        .map((info) => ({ info, ancestry: ancestryToPage(info.targetId) }))
        .filter(({ ancestry }) => ancestry.belongs)
        .sort((left, right) => left.ancestry.depth - right.ancestry.depth)
        .map(({ info }) => info);
    const liveTargetIds = new Set(descendants.map((info) => info.targetId));
    const allLiveIframeTargetIds = new Set(iframeInfos.map((info) => info.targetId));
    const knownDescendants = [];
    const collectKnownDescendants = (parentTargetId) => {
        for (const childTargetId of childTargets.get(parentTargetId) || []) {
            knownDescendants.push(childTargetId);
            collectKnownDescendants(childTargetId);
        }
    };
    collectKnownDescendants(pageTargetId);
    for (const knownTargetId of [...knownDescendants].reverse()) {
        // Target.getTargets and Page.getFrameTree are separate snapshots. A live
        // target can momentarily be absent from the frame tree during a swap, so
        // only target disappearance is authoritative enough to discard a session.
        if (!allLiveIframeTargetIds.has(knownTargetId)) {
            clearTargetSessionTree(knownTargetId, { remove: true });
        }
    }
    for (const knownTargetId of knownDescendants) {
        if (allLiveIframeTargetIds.has(knownTargetId) &&
            !liveTargetIds.has(knownTargetId)) {
            const info = iframeInfoByTarget.get(knownTargetId);
            if (info) {
                descendants.push(info);
                liveTargetIds.add(knownTargetId);
            }
        }
    }
    const nearestTargetParent = (info) => {
        const ancestry = ancestryToPage(info.targetId);
        if (!ancestry.belongs) {
            const knownParentTargetId = parentTargets.get(info.targetId);
            if (knownParentTargetId)
                return knownParentTargetId;
        }
        let current = parentFrameIdOf(info.targetId);
        const visited = new Set();
        while (current && !visited.has(current)) {
            if (current === pageTargetId || current === rootFrameId) {
                return pageTargetId;
            }
            if (liveTargetIds.has(current))
                return current;
            visited.add(current);
            current = parentFrameIdOf(current);
        }
        return pageTargetId;
    };
    const sessionByTarget = new Map([
        [pageTargetId, pageSessionId],
    ]);
    const vanishedTargetIds = new Set();
    for (const info of descendants) {
        let sessionId;
        try {
            sessionId = await ensureSession(info.targetId, remaining());
        }
        catch (error) {
            // Target.getTargets is a snapshot: an OOPIF can be destroyed between
            // enumeration and attach. Such a frame is no longer part of the page, so
            // drop it rather than fail (or restart) the whole discovery. Errors on
            // the Page target itself are raised by ensureSession above and are not
            // retried here.
            if (!isRetryableFrameLifecycleError(error))
                throw error;
            vanishedTargetIds.add(info.targetId);
            liveTargetIds.delete(info.targetId);
            clearTargetSessionTree(info.targetId, { remove: true });
            continue;
        }
        registerTargetParent(info.targetId, nearestTargetParent(info));
        sessionByTarget.set(info.targetId, sessionId);
    }
    const sessions = new Map();
    const collectFrameSessions = (tree, inheritedSessionId, isRoot = false) => {
        const frameId = tree?.frame?.id;
        if (typeof frameId !== "string" || vanishedTargetIds.has(frameId))
            return;
        const sessionId = sessionByTarget.get(frameId) || inheritedSessionId;
        if (!isRoot)
            sessions.set(frameId, sessionId);
        for (const child of tree?.childFrames || []) {
            collectFrameSessions(child, sessionId);
        }
    };
    if (frameTree)
        collectFrameSessions(frameTree, pageSessionId, true);
    for (const info of descendants) {
        if (vanishedTargetIds.has(info.targetId))
            continue;
        if (!sessions.has(info.targetId)) {
            sessions.set(info.targetId, sessionByTarget.get(info.targetId));
        }
    }
    sessions.parentFrameIds = new Map([...sessions.keys()].map((frameId) => [frameId, parentFrameIdOf(frameId)]));
    return sessions;
}
function invalidateSession(targetId = undefined) {
    if (targetId) {
        clearTargetSessionTree(targetId, { remove: true });
        return;
    }
    for (const knownTargetId of [...targetStates.keys()]) {
        clearTargetSession(knownTargetId, { remove: true });
    }
    browserEvents.length = 0;
    childTargets.clear();
    parentTargets.clear();
    defaultTargetId = null;
    resetUserControlProbe();
}
function setPreferredTarget(targetId) {
    state.preferredTargetId = targetId || null;
}
function clearPreferredTarget() {
    state.preferredTargetId = null;
}
function drainBrowserEvents(sessionId = undefined) {
    const targetId = sessionId
        ? sessionTargets.get(sessionId)
        : state.preferredTargetId || defaultTargetId;
    const target = targetId ? targetStates.get(targetId) : undefined;
    const out = browserEvents.splice(0, browserEvents.length);
    if (target)
        out.push(...target.events.splice(0, target.events.length));
    return out;
}
/** Drain only events routed to one Page session. */
function drainPageEvents(sessionId) {
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
    const target = targetId ? targetStates.get(targetId) : undefined;
    return target ? target.events.splice(0, target.events.length) : [];
}
function pendingDialog(sessionId) {
    const targetId = sessionId
        ? sessionTargets.get(sessionId)
        : state.preferredTargetId || defaultTargetId;
    const dialog = targetId ? targetStates.get(targetId)?.pendingDialog : null;
    return dialog ? { ...dialog } : null;
}
/** Ensure Network events are available on every selected Page/OOPIF session. */
async function ensureNetworkTracking(sessionIds, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const unique = [...new Set(sessionIds.filter(Boolean))];
    await Promise.all(unique.map((sessionId) => enableNetworkTrackingForSession(sessionId, true, timeoutMs)));
}
/** Read continuous network state without consuming the public Page event queue. */
function networkActivity(sessionIds) {
    let tracking = sessionIds.length > 0;
    let inflight = 0;
    let lastActivityAt = 0;
    for (const sessionId of new Set(sessionIds)) {
        const targetId = sessionTargets.get(sessionId);
        const target = targetId ? targetStates.get(targetId) : undefined;
        if (!target ||
            target.sessionId !== sessionId ||
            !target.networkDomainEnabled) {
            tracking = false;
            continue;
        }
        inflight += target.inflightNetworkRequests.size;
        lastActivityAt = Math.max(lastActivityAt, target.lastNetworkActivityAt);
    }
    return { tracking, inflight, lastActivityAt };
}
/** Refresh and return the main and known OOPIF sessions for one Page. */
async function pageNetworkSessions(sessionId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const targetId = sessionTargets.get(sessionId);
    if (!targetId) {
        throw new Error("cannot resolve Page network sessions from a detached session");
    }
    const frameSessions = await ensureFrameSessions(targetId, timeoutMs);
    const currentMainSession = targetStates.get(targetId)?.sessionId;
    if (!currentMainSession) {
        throw new Error("Page session was detached while refreshing network state");
    }
    return [...new Set([currentMainSession, ...frameSessions.values()])];
}
/**
 * Suppress the operating-system file picker and observe the next chooser in
 * one Page session. The caller owns the short-lived interception and must
 * dispose it after setting files or completing an input action.
 */
function prepareFileChooser(sessionId, { timeoutMs, cancel }) {
    const targetId = sessionTargets.get(sessionId);
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (!target) {
        throw new Error("cannot intercept a file chooser without a Page session");
    }
    if (target.fileChooserInterception) {
        throw new Error("this Page is already waiting for a file chooser");
    }
    let observed;
    let resolveEvent;
    let rejectEvent;
    const event = new Promise((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
    });
    // A safety interceptor normally consumes peek() instead of awaiting event.
    // Attach a rejection observer so disposal never creates an unhandled promise.
    void event.catch(() => { });
    const interception = {
        cancelPromise: undefined,
        event,
        reject: rejectEvent,
        resolve(value) {
            if (observed)
                return;
            observed = value;
            clearTimeout(interception.timer);
            resolveEvent(value);
            if (cancel) {
                // An empty file list completes the intercepted chooser without opening
                // the native picker or changing the input's current selection.
                interception.cancelPromise = rawCdp("DOM.setFileInputFiles", { files: [], backendNodeId: value.backendNodeId }, sessionId).catch(() => { });
            }
        },
        peek() {
            return observed;
        },
        async dispose(reason) {
            if (target.fileChooserInterception !== interception)
                return;
            target.fileChooserInterception = null;
            clearTimeout(interception.timer);
            if (!observed && reason)
                rejectEvent(reason);
            await interception.ready.catch(() => { });
            await interception.cancelPromise;
            const disable = rawCdp("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId).catch(() => { });
            if (target.pendingDialog) {
                return;
            }
            await disable;
        },
    };
    target.fileChooserInterception = interception;
    interception.ready = rawCdp("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId)
        .then(() => {
        interception.timer = setTimeout(() => {
            const error = new Error(`page.waitForFileChooser timed out after ${timeoutMs}ms`);
            error.code = "EGO_FILE_CHOOSER_TIMEOUT";
            if (target.fileChooserInterception === interception) {
                target.fileChooserInterception = null;
                rejectEvent(error);
                void rawCdp("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId).catch(() => { });
            }
        }, timeoutMs);
    })
        .catch((error) => {
        if (target.fileChooserInterception === interception) {
            target.fileChooserInterception = null;
        }
        rejectEvent(error);
        throw error;
    });
    return interception;
}
async function enablePageEvents(sessionId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (!target || target.pageEventsEnabled) {
        return;
    }
    try {
        await rawCdp("Page.enable", {}, sessionId, timeoutMs);
        target.pageEventsEnabled = true;
    }
    catch {
        // Dialog tracking is best-effort. Do not make all helpers fail on targets
        // that reject Page.enable, such as unusual internal pages.
    }
}
async function enableNetworkTrackingForSession(sessionId, required = false, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (!target || target.sessionId !== sessionId) {
        if (required) {
            throw new Error("cannot track network activity for a detached Page session");
        }
        return;
    }
    if (target.networkDomainEnabled)
        return;
    let inflight = target.networkEnableInflight;
    const reusedInflight = Boolean(inflight);
    if (!inflight) {
        inflight = rawCdp("Network.enable", {}, sessionId, timeoutMs).then(() => {
            // Events and an OOPIF request migration can race ahead of this response.
            // Network.disable and session replacement already clear stale state, so
            // enabling must preserve everything observed for the current session.
            if (target.sessionId === sessionId && !target.networkDomainEnabled) {
                target.lastNetworkActivityAt = state.now();
                target.networkDomainEnabled = true;
            }
        });
        target.networkEnableInflight = inflight;
        void inflight.then(() => {
            if (target.networkEnableInflight === inflight) {
                target.networkEnableInflight = null;
            }
        }, () => {
            if (target.networkEnableInflight === inflight) {
                target.networkEnableInflight = null;
            }
        });
    }
    try {
        await (reusedInflight
            ? waitForSharedCdpRequest(inflight, "Network.enable", sessionId, timeoutMs)
            : inflight);
    }
    catch (error) {
        if (required)
            throw error;
    }
    if (required && !target.networkDomainEnabled) {
        throw new Error("network tracking was interrupted by a detached Page session");
    }
}
async function enableOopifAutoAttach(sessionId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (!target || target.sessionId !== sessionId || target.autoAttachEnabled) {
        return;
    }
    let inflight = target.autoAttachInflight;
    const reusedInflight = Boolean(inflight);
    if (!inflight) {
        inflight = rawCdp("Target.setAutoAttach", OOPIF_AUTO_ATTACH_PARAMS, sessionId, timeoutMs).then(() => {
            if (target.sessionId === sessionId)
                target.autoAttachEnabled = true;
        });
        target.autoAttachInflight = inflight;
        void inflight.then(() => {
            if (target.autoAttachInflight === inflight) {
                target.autoAttachInflight = null;
            }
        }, () => {
            if (target.autoAttachInflight === inflight) {
                target.autoAttachInflight = null;
            }
        });
    }
    try {
        await (reusedInflight
            ? waitForSharedCdpRequest(inflight, "Target.setAutoAttach", sessionId, timeoutMs)
            : inflight);
    }
    catch {
        // Page APIs still work on bridges without auto-attach. Frame discovery can
        // attach explicitly later, but exact network-idle tracking needs support.
    }
}
/** Bound one caller's wait without cancelling the shared CDP request. */
function waitForSharedCdpRequest(request, method, sessionId, timeoutMs) {
    const callerTimeoutMs = Math.max(1, timeoutMs);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new CdpRequestTimeoutError(method, callerTimeoutMs, sessionId));
        }, callerTimeoutMs);
        request.then(() => {
            clearTimeout(timer);
            resolve();
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function initializeAutoAttachedTarget(sessionId, waitingForDebugger) {
    // Invoke every initializer before awaiting any result. Chromium can pause an
    // OOPIF at attachment, so waiting for Network.enable before sending resume
    // would deadlock if the protocol response depends on renderer progress.
    const pageEvents = enablePageEvents(sessionId);
    const networkEvents = enableNetworkTrackingForSession(sessionId);
    const nestedFrames = enableOopifAutoAttach(sessionId);
    const resume = waitingForDebugger
        ? rawCdp("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => { })
        : Promise.resolve();
    void Promise.allSettled([pageEvents, networkEvents, nestedFrames, resume]);
}
function finishNetworkRequest(targetId, requestId) {
    const now = state.now();
    const rootTargetId = pageRootTargetId(targetId);
    for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
        const pageTarget = targetStates.get(pageTargetId);
        if (!pageTarget)
            continue;
        if (pageTarget.inflightNetworkRequests.delete(requestId)) {
            pageTarget.lastNetworkActivityAt = now;
        }
    }
}
function isIgnoredFaviconRequest(targetId, requestId) {
    const rootTargetId = pageRootTargetId(targetId);
    return pageTreeTargetIds(rootTargetId).some((pageTargetId) => targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.has(requestId));
}
function clearIgnoredFaviconRequest(targetId, requestId) {
    const rootTargetId = pageRootTargetId(targetId);
    let deleted = false;
    for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
        deleted =
            Boolean(targetStates
                .get(pageTargetId)
                ?.ignoredFaviconRequestIds.delete(requestId)) || deleted;
    }
    return deleted;
}
function recordNetworkEvent(targetId, target, data) {
    // A response to Network.disable can be followed by a queued terminal event.
    // Ignore it once tracking is off, while still accepting events that race the
    // response to our own Network.enable request.
    if (!target.networkDomainEnabled && !target.networkEnableInflight)
        return;
    const requestId = data?.params?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0)
        return;
    if (data.method === "Network.requestWillBeSent") {
        const url = data.params?.request?.url;
        // Chromium can omit the terminal event for its automatic favicon request.
        // Playwright excludes favicons from network-idle accounting for the same
        // reason, so they must never leave a permanent in-flight entry here.
        if ((typeof url === "string" && url.endsWith("/favicon.ico")) ||
            isIgnoredFaviconRequest(targetId, requestId)) {
            target.ignoredFaviconRequestIds.add(requestId);
            if (target.inflightNetworkRequests.delete(requestId)) {
                target.lastNetworkActivityAt = state.now();
            }
            return;
        }
        target.networkDomainEnabled = true;
        target.inflightNetworkRequests.set(requestId, {
            requestId,
            ...(typeof data.params?.frameId === "string"
                ? { frameId: data.params.frameId }
                : {}),
            ...(typeof data.params?.loaderId === "string"
                ? { loaderId: data.params.loaderId }
                : {}),
            ...(typeof data.params?.type === "string"
                ? { type: data.params.type }
                : {}),
        });
        target.lastNetworkActivityAt = state.now();
        return;
    }
    if (data.method === "Network.loadingFinished" ||
        data.method === "Network.loadingFailed") {
        target.networkDomainEnabled = true;
        if (clearIgnoredFaviconRequest(targetId, requestId))
            return;
        finishNetworkRequest(targetId, requestId);
        target.lastNetworkActivityAt = state.now();
    }
}
// Local send failures for ego.sendCDPMessage() arrive here instead of as a CDP
// response. The callback carries no request id, so task-level failures reject
// every pending request. User-control failures first probe the native task state:
// the CDP callback does not carry the permission reason, while ordinary native
// calls may do so on newer Ego Lite builds.
function handleSendError(message, error_code) {
    if (pending.size === 0)
        return;
    if (error_code !== "EGO_TASK_SPACE_USER_IN_CONTROL") {
        rejectAllPending(buildEgoError({ error: message, error_code }));
        return;
    }
    if (userControlProbeState === "stopped" && userControlStopError) {
        rejectAllPending(userControlStopError);
        return;
    }
    if (userControlProbeState === "probing")
        return;
    userControlProbeState = "probing";
    const generation = ++userControlProbeGeneration;
    void probeUserControlReason(message, error_code, generation);
}
async function probeUserControlReason(message, error_code, generation) {
    const fallback = { error: message, error_code };
    const runtime = browserEgo();
    if (typeof runtime.setAgentTaskState !== "function") {
        stopForUserControl(fallback, generation);
        return;
    }
    try {
        const result = await runtime.setAgentTaskState("Waiting for the user");
        if (generation !== userControlProbeGeneration)
            return;
        if (isEgoUserControlError(result)) {
            stopForUserControl(result, generation);
            return;
        }
        if (result && typeof result === "object" && "error" in result) {
            stopForUserControl(fallback, generation);
            return;
        }
        // Control came back between the failed send and the probe. The original
        // command still failed, but it must not create a new global hard stop.
        userControlProbeState = "idle";
        userControlStopError = null;
        rejectAllPending(nativeSendError(message, error_code));
    }
    catch (error) {
        if (generation !== userControlProbeGeneration)
            return;
        stopForUserControl(isEgoUserControlError(error) ? error : fallback, generation);
    }
}
function stopForUserControl(errorLike, generation) {
    if (generation !== userControlProbeGeneration)
        return;
    userControlStopError = buildEgoError(errorLike);
    userControlProbeState = "stopped";
    rejectAllPending(userControlStopError);
}
function rejectAllPending(error) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries)
        entry.reject(error);
}
function nativeSendError(message, error_code) {
    const error = new Error(message || error_code || "CDP send failed");
    if (error_code)
        error.error_code = error_code;
    return error;
}
function resetUserControlProbe() {
    userControlProbeGeneration += 1;
    userControlProbeState = "idle";
    userControlStopError = null;
}
function handleMessage(message) {
    let data;
    try {
        data = JSON.parse(message);
    }
    catch {
        return;
    }
    if (Object.hasOwn(data, "id")) {
        const entry = pending.get(data.id);
        if (!entry) {
            return;
        }
        pending.delete(data.id);
        if (data.error) {
            const error = new Error(data.error.message || data.error);
            if (entry.sessionId)
                error.sessionId = entry.sessionId;
            entry.reject(error);
            return;
        }
        if (userControlProbeState === "stopped") {
            // A successful command proves control has returned. Re-arm detection so a
            // later, separate takeover can run its own reason probe.
            resetUserControlProbe();
        }
        entry.resolve(data);
        return;
    }
    if (data.method === "Target.detachedFromTarget" ||
        data.method === "Target.targetDestroyed") {
        const targetId = data.params?.targetId ||
            data.params?.targetInfo?.targetId ||
            (data.params?.sessionId
                ? sessionTargets.get(data.params.sessionId)
                : undefined);
        if (targetId) {
            clearTargetSessionTree(targetId, {
                remove: data.method === "Target.targetDestroyed",
            });
        }
    }
    else if (data.method === "Target.attachedToTarget") {
        const sessionId = data.params?.sessionId;
        const targetId = data.params?.targetInfo?.targetId;
        const targetType = data.params?.targetInfo?.type;
        const reportedParentFrameId = data.params?.targetInfo?.parentFrameId ||
            data.params?.targetInfo?.parentId;
        // Target.attachedToTarget is emitted on the nearest owning target session.
        // Prefer that target edge over parentFrameId, which may name a same-process
        // frame and is not itself a debuggable target.
        const sourceTargetId = data.sessionId
            ? sessionTargets.get(data.sessionId)
            : undefined;
        const parentTargetId = sourceTargetId || reportedParentFrameId;
        if (sessionId && targetId)
            registerSession(targetId, sessionId);
        if (targetId && parentTargetId && targetId !== parentTargetId) {
            registerTargetParent(targetId, parentTargetId);
        }
        if (sessionId && targetType === "iframe") {
            initializeAutoAttachedTarget(sessionId, data.params?.waitingForDebugger === true);
        }
        else if (sessionId && data.params?.waitingForDebugger === true) {
            // A foreign auto-attach configuration may still deliver other related
            // target types. Never leave an unrelated worker paused by this runtime.
            void rawCdp("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => { });
        }
    }
    const sessionId = data.sessionId;
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (target && typeof data.method === "string") {
        recordNetworkEvent(targetId, target, data);
    }
    if (data.method === "Page.javascriptDialogOpening") {
        if (target) {
            target.pendingDialog = data.params || {};
            rejectCommandsBlockedByDialog(sessionId, target.pendingDialog);
        }
    }
    else if (data.method === "Page.javascriptDialogClosed") {
        if (target)
            target.pendingDialog = null;
    }
    else if (data.method === "Page.fileChooserOpened") {
        target?.fileChooserInterception?.resolve(data.params || {});
    }
    if (typeof data.method === "string" && BROWSER_LEVEL(data.method)) {
        for (const listener of [...browserEventSubscribers]) {
            guardNativeCallback("browser event subscriber", () => listener(data));
        }
    }
    if (targetId && typeof data.method === "string") {
        for (const listener of [...(pageEventSubscribers.get(targetId) || [])]) {
            guardNativeCallback("page event subscriber", () => listener(data));
        }
    }
    const events = target ? target.events : browserEvents;
    events.push(data);
    capEvents(events);
}
function rejectCommandsBlockedByDialog(sessionId, dialog) {
    if (!sessionId)
        return;
    for (const [id, entry] of pending) {
        if (entry.sessionId !== sessionId || !DIALOG_BLOCKED_METHOD(entry.method)) {
            continue;
        }
        pending.delete(id);
        entry.reject(new PageDialogOpenedError(entry.method, sessionId, dialog));
    }
}
function rejectFileChooserInterception(target, error) {
    const interception = target.fileChooserInterception;
    if (!interception)
        return;
    target.fileChooserInterception = null;
    clearTimeout(interception.timer);
    interception.reject(error);
}
function browserSnapshotRefsToRefMap(refMap, refs = []) {
    refMap.clear();
    for (const ref of refs) {
        if (!ref || typeof ref !== "object") {
            continue;
        }
        if (ref.backendNodeId === undefined || ref.backendNodeId === null) {
            continue;
        }
        refMap.addWithFrame(String(ref.refId ?? ref.backendNodeId), ref.backendNodeId, ref.role, ref.name, undefined, ref.frameId);
    }
}

let hasWarnedAboutFunctionJs = false;
/**
 * Send a raw Chrome DevTools Protocol command.
 * @param {string} method CDP method name, for example Runtime.evaluate.
 * @param {object} [params] CDP command parameters.
 * @param {string} [sessionId] Optional attached target session id.
 * @returns {Promise<object>} CDP result object.
 */
async function cdp(method, params = {}, sessionId = undefined) {
    const result = state.cdpOverride
        ? await state.cdpOverride(method, params, sessionId)
        : (await browserCdp(method, params, sessionId)).result || {};
    if (!sessionId &&
        (method === "Network.enable" || method === "Network.disable")) {
        // Mirror the default session's Network domain state so helpers like
        // waitForNetworkIdle can restore it instead of tearing down a domain
        // the caller still relies on for drainEvents().
        state.networkDomainEnabled = method === "Network.enable";
    }
    return result;
}
/**
 * Evaluate JavaScript in the current page or a target tab.
 * @param {string | Function} expression JavaScript source string or a function whose body should be evaluated.
 *   Passing a function is accepted as a convenience but emits a one-time warning to stderr so callers can
 *   switch to the canonical string form. Top-level return statements in strings are auto-wrapped in an IIFE.
 * @param {string} [targetId] Optional target id to attach and evaluate in.
 * @returns {Promise<any>} Runtime.evaluate return-by-value result.
 */
async function js(expression, targetId = undefined) {
    if (typeof expression === "function") {
        const source = expression.toString();
        if (!hasWarnedAboutFunctionJs) {
            hasWarnedAboutFunctionJs = true;
            process.stderr.write(`[ego-browser] js() received a function and auto-wrapped it (${jsSnippet(source, 80)}).\n` +
                `  js() is a thin wrapper over CDP Runtime.evaluate; it takes a string expression,\n` +
                `  not a Puppeteer/Playwright-style callable. Auto-wrap does NOT capture closure\n` +
                `  variables and has NO args channel.\n` +
                `  Prefer:\n` +
                `    js(\`<expression>\`)  // pure expression or explicit IIFE\n`);
        }
        expression = `(${source})()`;
    }
    else if (typeof expression !== "string") {
        throw new TypeError(`js() expects a string expression or function, got ${expression === null ? "null" : typeof expression}`);
    }
    const sessionId = targetId
        ? (await cdp("Target.attachToTarget", { targetId, flatten: true }))
            .sessionId
        : undefined;
    let finalExpression = expression;
    if (hasReturnStatement(expression) && !expression.trim().startsWith("(")) {
        finalExpression = `(function(){${expression}})()`;
    }
    return runtimeEvaluate(finalExpression, sessionId, true);
}
async function runtimeEvaluate(expression, sessionId = undefined, awaitPromise = false) {
    try {
        const response = await cdp("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        }, sessionId);
        return runtimeValue(response, expression);
    }
    catch (error) {
        if (/timed out/i.test(error?.message || "")) {
            throw new Error(`Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`);
        }
        throw error;
    }
}
function runtimeValue(response, expression) {
    const result = response.result || {};
    const details = response.exceptionDetails;
    if (details || result.subtype === "error") {
        const desc = jsExceptionDescription(result, details);
        const loc = details?.lineNumber !== undefined && details?.columnNumber !== undefined
            ? ` at line ${details.lineNumber}, column ${details.columnNumber}`
            : "";
        throw new Error(`JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`);
    }
    if (Object.hasOwn(result, "value")) {
        return result.value;
    }
    if (Object.hasOwn(result, "unserializableValue")) {
        return decodeUnserializableJsValue(result.unserializableValue);
    }
    return null;
}
function jsExceptionDescription(result, details) {
    let desc = result.description;
    const exception = details?.exception;
    if (!desc && exception && typeof exception === "object") {
        desc = exception.description;
        if (desc === undefined && Object.hasOwn(exception, "value")) {
            desc = String(exception.value);
        }
        if (desc === undefined) {
            desc = exception.className;
        }
    }
    return desc || details?.text || "JavaScript evaluation failed";
}
function decodeUnserializableJsValue(value) {
    if (value === "NaN") {
        return Number.NaN;
    }
    if (value === "Infinity") {
        return Number.POSITIVE_INFINITY;
    }
    if (value === "-Infinity") {
        return Number.NEGATIVE_INFINITY;
    }
    if (value === "-0") {
        return -0;
    }
    if (value.endsWith("n")) {
        return BigInt(value.slice(0, -1));
    }
    return value;
}
function jsSnippet(expression, limit = 160) {
    const snippet = expression.trim().replace(/\n/g, "\\n");
    return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}
function hasReturnStatement(expression) {
    let i = 0;
    let stateName = "code";
    let quote = "";
    while (i < expression.length) {
        const ch = expression[i];
        const next = expression[i + 1] || "";
        if (stateName === "code") {
            if (ch === "'" || ch === '"' || ch === "`") {
                stateName = "string";
                quote = ch;
                i += 1;
                continue;
            }
            if (ch === "/" && next === "/") {
                stateName = "line_comment";
                i += 2;
                continue;
            }
            if (ch === "/" && next === "*") {
                stateName = "block_comment";
                i += 2;
                continue;
            }
            if (expression.startsWith("return", i)) {
                const before = i > 0 ? expression[i - 1] : "";
                const after = expression[i + 6] || "";
                if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
                    return true;
                }
            }
            i += 1;
            continue;
        }
        if (stateName === "line_comment") {
            if (ch === "\n") {
                stateName = "code";
            }
            i += 1;
            continue;
        }
        if (stateName === "block_comment") {
            if (ch === "*" && next === "/") {
                stateName = "code";
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (stateName === "string") {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === quote) {
                stateName = "code";
                quote = "";
            }
            i += 1;
        }
    }
    return false;
}

class RefMap {
    map;
    allowFallback;
    constructor({ allowFallback = true } = {}) {
        this.map = new Map();
        this.allowFallback = allowFallback;
    }
    add(refId, backendNodeId, role, name, nth = undefined) {
        this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
    }
    addWithFrame(refId, backendNodeId, role, name, nth = undefined, frameId = undefined, frameProvenance = undefined) {
        this.map.set(refId, {
            backendNodeId,
            role,
            name,
            nth,
            frameId,
            ...(frameProvenance ? { frameProvenance } : {}),
        });
    }
    get(refId) {
        return this.map.get(refId);
    }
    clear() {
        this.map.clear();
    }
}
function parseRef(input) {
    const trimmed = String(input || "").trim();
    for (const candidate of [
        trimmed.startsWith("@") ? trimmed.slice(1) : null,
        trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
        trimmed,
    ]) {
        if (candidate && /^\d+$/.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Browser-side helpers shared by selector actions that need composed-tree
 * relationships. Keep action policy at each call site: pointer actions and
 * editing actions intentionally do not retarget in the same way.
 */
const COMPOSED_PARENT_HELPER = `
  function composedParent(element) {
    if (element?.assignedSlot) return element.assignedSlot;
    if (element?.parentElement) return element.parentElement;
    const root = element?.getRootNode ? element.getRootNode() : null;
    return root && root.nodeType === 11 ? root.host : null;
  }
`;
const COMPOSED_TREE_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  function composedChildren(element) {
    if (!element) return [];
    if (String(element.tagName || "").toUpperCase() === "SLOT") {
      const assigned = element.assignedElements?.({ flatten: true }) || [];
      if (assigned.length > 0) return assigned;
    }
    const container = element.shadowRoot || element;
    return Array.from(container.children || []);
  }
  function nearestComposedAncestor(element, predicate) {
    let current = composedParent(element);
    while (current) {
      if (predicate(current)) return current;
      current = composedParent(current);
    }
    return null;
  }
  function composedDescendantMatches(root, predicate, stopAtMatch = false) {
    const matches = [];
    const visit = (parent) => {
      for (const child of composedChildren(parent)) {
        const matched = predicate(child);
        if (matched) matches.push(child);
        if (!(matched && stopAtMatch)) visit(child);
      }
    };
    visit(root);
    return matches;
  }
`;
const ACTION_TARGET_STATE_FUNCTIONS = `
  const nativeActionControlTags = new Set([
    "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP"
  ]);
  const ariaDisabledActionRoles = new Set([
    "application", "button", "composite", "gridcell", "group", "input",
    "link", "menuitem", "scrollbar", "separator", "tab", "checkbox",
    "columnheader", "combobox", "grid", "listbox", "menu", "menubar",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "radiogroup",
    "row", "rowheader", "searchbox", "select", "slider", "spinbutton",
    "switch", "tablist", "textbox", "toolbar", "tree", "treegrid",
    "treeitem"
  ]);
  function actionStateRole(element) {
    const explicit = String(element?.getAttribute?.("role") || "")
      .trim().toLowerCase().split(/\\s+/)[0];
    if (explicit) return explicit;
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "INPUT") return "input";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA" || element?.isContentEditable) return "textbox";
    if (tag === "OPTION") return "option";
    if (tag === "OPTGROUP" || tag === "FIELDSET") return "group";
    if (
      (tag === "A" || tag === "AREA") &&
      element?.hasAttribute?.("href")
    ) return "link";
    return "";
  }
  function supportsAriaDisabled(element) {
    return ariaDisabledActionRoles.has(actionStateRole(element));
  }
  function actionStateOwner(element) {
    let current = element;
    while (current) {
      if (supportsAriaDisabled(current)) return current;
      current = composedParent(current);
    }
    return null;
  }
  function isNativelyDisabledForAction(element) {
    let current = element;
    while (current) {
      const tag = String(current.tagName || "").toUpperCase();
      if (
        nativeActionControlTags.has(tag) &&
        (current.disabled === true || current.matches?.(":disabled"))
      ) {
        return true;
      }
      current = composedParent(current);
    }
    return false;
  }
  function hasInheritedAriaDisabled(element) {
    let current = actionStateOwner(element);
    while (current) {
      const value = String(
        current.getAttribute?.("aria-disabled") ?? ""
      ).trim().toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      current = composedParent(current);
    }
    return false;
  }
  function isActionTargetDisabled(element) {
    return (
      isNativelyDisabledForAction(element) ||
      hasInheritedAriaDisabled(element)
    );
  }
`;
/** Browser-side enabled semantics shared by resolution and final input checks. */
const ACTION_TARGET_STATE_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  ${ACTION_TARGET_STATE_FUNCTIONS}
`;
const SCROLL_TARGET_FUNCTIONS = `
  function actionPointForElement(target) {
    const view = target?.ownerDocument?.defaultView;
    if (!view) return null;
    const rects = Array.from(target.getClientRects?.() || []).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    if (rects.length === 0) {
      const rect = target.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      rects.push(rect);
    }
    let best = null;
    for (const rect of rects) {
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(view.innerWidth, rect.right);
      const bottom = Math.min(view.innerHeight, rect.bottom);
      const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      const distanceX = centerX - Math.max(0, Math.min(view.innerWidth, centerX));
      const distanceY = centerY - Math.max(0, Math.min(view.innerHeight, centerY));
      const viewportDistance = distanceX * distanceX + distanceY * distanceY;
      if (
        !best ||
        visibleArea > best.visibleArea ||
        (visibleArea === best.visibleArea && viewportDistance < best.viewportDistance)
      ) {
        best = { rect, left, top, right, bottom, visibleArea, viewportDistance };
      }
    }
    if (best.visibleArea > 0) {
      return {
        x: (best.left + best.right) / 2,
        y: (best.top + best.bottom) / 2,
      };
    }
    return {
      x: (best.rect.left + best.rect.right) / 2,
      y: (best.rect.top + best.rect.bottom) / 2,
    };
  }
  function visibleScrollArea(rect, view) {
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(view.innerWidth, rect.right),
      bottom: Math.min(view.innerHeight, rect.bottom),
    };
  }
  function scrollRequestForPoint(target, point) {
    const view = target?.ownerDocument?.defaultView;
    if (!view) return null;
    let ancestor = composedParent(target);
    while (ancestor) {
      if (
        ancestor !== target.ownerDocument.body &&
        ancestor !== target.ownerDocument.documentElement
      ) {
        const style = view.getComputedStyle(ancestor);
        const canScrollX =
          /^(auto|scroll|overlay)$/.test(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth + 1;
        const canScrollY =
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight + 1;
        if (canScrollX || canScrollY) {
          const area = visibleScrollArea(ancestor.getBoundingClientRect(), view);
          if (area.right > area.left && area.bottom > area.top) {
            let deltaX = canScrollX &&
                (point.x < area.left || point.x >= area.right)
              ? point.x - (area.left + area.right) / 2
              : 0;
            let deltaY = canScrollY &&
                (point.y < area.top || point.y >= area.bottom)
              ? point.y - (area.top + area.bottom) / 2
              : 0;
            if (
              (deltaX < 0 && ancestor.scrollLeft <= 0) ||
              (deltaX > 0 && ancestor.scrollLeft >= ancestor.scrollWidth - ancestor.clientWidth - 1)
            ) deltaX = 0;
            if (
              (deltaY < 0 && ancestor.scrollTop <= 0) ||
              (deltaY > 0 && ancestor.scrollTop >= ancestor.scrollHeight - ancestor.clientHeight - 1)
            ) deltaY = 0;
            if (deltaX || deltaY) {
              return {
                x: (area.left + area.right) / 2,
                y: (area.top + area.bottom) / 2,
                deltaX,
                deltaY,
              };
            }
          }
        }
      }
      ancestor = composedParent(ancestor);
    }
    if (
      point.x >= 0 && point.y >= 0 &&
      point.x < view.innerWidth && point.y < view.innerHeight
    ) return null;
    return {
      x: Math.max(0, Math.min(view.innerWidth - 1, point.x)),
      y: Math.max(0, Math.min(view.innerHeight - 1, point.y)),
      deltaX: point.x - view.innerWidth / 2,
      deltaY: point.y - view.innerHeight / 2,
    };
  }
`;
/** Browser-side scroll targeting shared by candidate selection and actions. */
const SCROLL_TARGET_HELPERS = `
  ${COMPOSED_PARENT_HELPER}
  ${SCROLL_TARGET_FUNCTIONS}
`;
/** Editing semantics layered on top of the shared composed-tree traversal. */
const EDIT_ACTION_TARGET_HELPERS = `
  ${COMPOSED_TREE_HELPERS}
  ${ACTION_TARGET_STATE_FUNCTIONS}
  function isExplicitContentEditable(element) {
    return Boolean(
      element?.hasAttribute?.("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    );
  }
  function isFillableInput(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    return new Set([
      "", "color", "date", "datetime-local", "email", "month", "number",
      "password", "range", "search", "tel", "text", "time", "url", "week"
    ]).has(String(element.type || "").toLowerCase());
  }
  function isFillableActionTarget(element) {
    return isExplicitContentEditable(element) || isFillableInput(element);
  }
  function isEditableFocusTarget(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    const editableRole = new Set([
      "textbox", "searchbox", "combobox", "spinbutton"
    ]).has(
      String(element?.getAttribute?.("role") || "").toLowerCase()
    );
    return (
      (isFillableActionTarget(element) || tag === "SELECT" || editableRole) &&
      !isActionTargetDisabled(element)
    );
  }
  function isStrongFocusTarget(element) {
    if (
      !element?.isConnected ||
      isActionTargetDisabled(element) ||
      element.closest?.("[inert]")
    ) {
      return false;
    }
    if (isEditableFocusTarget(element)) return true;
    const tag = String(element.tagName || "").toUpperCase();
    if (["BUTTON", "SELECT", "TEXTAREA", "SUMMARY", "IFRAME"].includes(tag)) {
      return true;
    }
    if (tag === "INPUT") return String(element.type || "").toLowerCase() !== "hidden";
    if ((tag === "A" || tag === "AREA") && element.hasAttribute("href")) return true;
    if ((tag === "AUDIO" || tag === "VIDEO") && element.hasAttribute("controls")) {
      return true;
    }
    return new Set([
      "button", "checkbox", "link", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "radio", "slider", "switch", "tab", "treeitem"
    ]).has(String(element.getAttribute?.("role") || "").toLowerCase());
  }
`;
// Shared by resolver-level candidate selection and the final pointer check.
// Keeping one composed-tree definition prevents the two stages from disagreeing
// about shadow descendants, interactive ancestors, or modal blockers.
const HIT_TARGET_HELPERS = `
  ${ACTION_TARGET_STATE_HELPERS}
  ${SCROLL_TARGET_FUNCTIONS}
  function isExplicitInteractiveElement(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "SUMMARY", "LABEL"].includes(tag)) {
      return true;
    }
    if (tag === "A" && element.hasAttribute?.("href")) return true;
    if (
      element?.hasAttribute?.("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    ) return true;
    return new Set([
      "button",
      "checkbox",
      "link",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "radio",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem"
    ]).has(String(element?.getAttribute?.("role") || "").toLowerCase());
  }
  function isInteractiveElement(element) {
    return isExplicitInteractiveElement(element) || Boolean(element?.isContentEditable);
  }
  function hitElementAtPoint(target, point) {
    const roots = [];
    let parent = target;
    while (parent) {
      const root = parent.getRootNode ? parent.getRootNode() : null;
      if (!root || typeof root.elementsFromPoint !== "function") break;
      roots.push(root);
      if (root.nodeType === 9) break;
      parent = root.host;
    }
    let hitElement;
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const root = roots[index];
      const elements = root.elementsFromPoint(point.x, point.y);
      const innerElement = elements[0] || root.elementFromPoint(point.x, point.y);
      if (!innerElement) break;
      hitElement = innerElement;
      if (index > 0 && innerElement !== roots[index - 1].host) break;
    }
    return hitElement;
  }
  function interceptingElementAtPoint(target, point) {
    const hitElement = hitElementAtPoint(target, point);
    let current = hitElement;
    while (current && current !== target) current = composedParent(current);
    if (current === target) return null;

    current = target;
    while (current && current !== hitElement) current = composedParent(current);
    if (current === hitElement && isInteractiveElement(hitElement)) return null;

    return hitElement || document.documentElement;
  }
  function accessibleName(element) {
    const labelledBy = String(element?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => element.ownerDocument?.getElementById(id)?.textContent || "")
      .join(" ");
    const heading = element?.querySelector?.("h1,h2,h3,h4,h5,h6")?.textContent || "";
    return String(
      element?.getAttribute?.("aria-label") ||
      labelledBy ||
      heading ||
      element?.getAttribute?.("title") ||
      ""
    ).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  function describeHitTarget(element) {
    let modal = element;
    while (modal) {
      if (
        modal.getAttribute?.("role") === "dialog" ||
        modal.getAttribute?.("aria-modal") === "true"
      ) {
        const name = accessibleName(modal);
        return name ? 'dialog "' + name.replaceAll('"', '\\"') + '"' : "dialog";
      }
      modal = composedParent(modal);
    }
    const tag = String(element.tagName || "unknown").toLowerCase();
    const id = element.id
      ? ' id="' + String(element.id).slice(0, 80).replaceAll('"', '&quot;') + '"'
      : "";
    const role = element.getAttribute?.("role")
      ? ' role="' + String(element.getAttribute("role")).slice(0, 80).replaceAll('"', '&quot;') + '"'
      : "";
    const href = tag === "a" && element.hasAttribute?.("href")
      ? ' href="' + String(element.getAttribute("href")).slice(0, 120).replaceAll('"', '&quot;') + '"'
      : "";
    return "<" + tag + id + role + href + ">";
  }
`;

let snapshotLocatorBatchSequence = 0;
class ElementResolutionError extends Error {
    kind;
    constructor(message, kind) {
        super(message);
        this.name = "ElementResolutionError";
        this.kind = kind;
    }
}
function exceptionText(result) {
    const d = result?.exceptionDetails;
    return d?.exception?.description || d?.text || "evaluation error";
}
function matchCountKind(message) {
    const m = /matched (\d+)/.exec(message);
    const n = m ? Number(m[1]) : 0;
    return n > 1 ? "permanent" : "transient";
}
async function resolveElementCenter(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map()) {
    const refId = parseRef(selectorOrRef);
    if (refId) {
        const entry = refMap.get(refId);
        if (!entry) {
            throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
        }
        assertRefProvenance(refMap, entry, refId);
        const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
        if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
            try {
                const result = await send(cdp, "DOM.getBoxModel", { backendNodeId: entry.backendNodeId }, effectiveSessionId);
                return {
                    ...boxModelCenter(result.model),
                    sessionId: effectiveSessionId,
                };
            }
            catch (error) {
                if (refMap.allowFallback === false)
                    throw exactRefError(error, refId);
                if (error instanceof ElementResolutionError) {
                    // The node resolved but has no usable box model (not rendered yet).
                    // Propagate the retryable state instead of falling back to role/name,
                    // which could silently target a different node with the same label.
                    throw error;
                }
                // The backend node can become stale after DOM updates; fall back to role/name lookup below.
            }
        }
        if (refMap.allowFallback === false)
            throw staleRefError(refId);
        const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
        const result = await send(cdp, "DOM.getBoxModel", { backendNodeId }, effectiveSessionId);
        return { ...boxModelCenter(result.model), sessionId: effectiveSessionId };
    }
    const locator = parseLocatorOrThrow(selectorOrRef);
    if (locator) {
        return resolveLocatorCenter(cdp, sessionId, locator, iframeSessions);
    }
    for (const candidateSessionId of pageSessions(sessionId, iframeSessions)) {
        const result = await send(cdp, "Runtime.evaluate", {
            expression: buildSelectorCenterJs(selectorOrRef),
            returnByValue: true,
            awaitPromise: false,
        }, candidateSessionId);
        if (result.exceptionDetails) {
            throw invalidSelectorError(selectorOrRef, result);
        }
        const value = result.result?.value;
        if (typeof value?.x === "number" && typeof value?.y === "number") {
            return { x: value.x, y: value.y, sessionId: candidateSessionId };
        }
    }
    throw new ElementResolutionError(`Element not found: ${selectorOrRef}`, "transient");
}
async function resolveElementObjectId(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map(), options = {}) {
    const refId = parseRef(selectorOrRef);
    if (refId) {
        const entry = refMap.get(refId);
        if (!entry) {
            throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
        }
        assertRefProvenance(refMap, entry, refId);
        if (entry.frameProvenance === "unknown") {
            return resolveRefObjectIdWithRecoveredFrame(cdp, sessionId, iframeSessions, refId, entry);
        }
        const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
        if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
            try {
                const result = await send(cdp, "DOM.resolveNode", {
                    backendNodeId: entry.backendNodeId,
                    objectGroup: "ego-browser",
                }, effectiveSessionId);
                const objectId = result.object?.objectId;
                if (objectId) {
                    return {
                        objectId,
                        sessionId: effectiveSessionId,
                        ...(entry.frameId ? { frameId: entry.frameId } : {}),
                    };
                }
            }
            catch (error) {
                if (refMap.allowFallback === false)
                    throw exactRefError(error, refId);
                // The backend node can become stale after DOM updates; fall back to role/name lookup below.
            }
        }
        if (refMap.allowFallback === false)
            throw staleRefError(refId);
        const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
        const result = await send(cdp, "DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, effectiveSessionId);
        const objectId = result.object?.objectId;
        if (!objectId) {
            throw new ElementResolutionError(`No objectId for ref ${refId}`, "permanent");
        }
        return {
            objectId,
            sessionId: effectiveSessionId,
            ...(entry.frameId ? { frameId: entry.frameId } : {}),
        };
    }
    const locator = parseLocatorOrThrow(selectorOrRef);
    if (locator) {
        return resolveLocatorObjectId(cdp, sessionId, locator, iframeSessions, options);
    }
    const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
    if (options.strict) {
        return resolveRawSelectorObjectId(cdp, contexts, parseRawSelector(selectorOrRef), { actionability: options.actionability });
    }
    for (const context of contexts) {
        const result = await evaluateInContext(cdp, context, buildFindElementJs(selectorOrRef), false, "ego-browser");
        if (result.exceptionDetails) {
            throw invalidSelectorError(selectorOrRef, result);
        }
        const objectId = result.result?.objectId;
        if (objectId) {
            return {
                objectId,
                sessionId: context.sessionId,
                ...(context.frameId ? { frameId: context.frameId } : {}),
            };
        }
    }
    throw new ElementResolutionError(`Element not found: ${selectorOrRef}`, "transient");
}
function staleRefError(refId) {
    return new ElementResolutionError(`Stale ref: @${refId}; take a new snapshot`, "permanent");
}
function exactRefError(error, refId) {
    return /(?:no node|could not find node|cannot find node) with given/i.test(String(error))
        ? staleRefError(refId)
        : error;
}
function assertRefProvenance(refMap, entry, refId) {
    if (refMap.allowFallback === false && entry.frameProvenance === "unknown") {
        throw new ElementResolutionError(`Ref @${refId} has unknown frame provenance; take a new snapshot or use a locator`, "permanent");
    }
}
async function resolveRefObjectIdWithRecoveredFrame(cdp, sessionId, iframeSessions, refId, entry) {
    const allContexts = pageContexts(sessionId, iframeSessions);
    const frameContexts = allContexts.slice(1);
    // Unknown provenance means the snapshot placed this ref under an iframe, so
    // frames are searched first. The main document remains a fallback in case
    // the snapshot text misattributed a page-owned node to a frame.
    let matches = await collectBackendNodeMatches(cdp, frameContexts, entry.backendNodeId);
    if (matches.size === 0) {
        matches = await collectBackendNodeMatches(cdp, allContexts.slice(0, 1), entry.backendNodeId);
    }
    let match;
    if (matches.size === 1) {
        match = [...matches.values()][0];
    }
    else if (matches.size > 1) {
        const semanticMatches = [...matches.values()].filter((candidate) => candidate.role === normalizeRole(entry.role) &&
            candidate.name === entry.name);
        if (semanticMatches.length === 1) {
            match = semanticMatches[0];
        }
        else {
            throw new ElementResolutionError(`Ref @${refId} matched ${matches.size} frame contexts because its frame provenance is missing`, "permanent");
        }
    }
    else {
        // strictGlobal resolves before findUniqueRoleMatch consults actionability,
        // so passing it here would only imply a filter that never runs. Ambiguity
        // across the whole page is the answer this recovery path wants anyway.
        match = await findUniqueRoleMatch(cdp, allContexts, entry.role, entry.name, `ref @${refId}`, { strictGlobal: true });
    }
    const result = await send(cdp, "DOM.resolveNode", {
        backendNodeId: match.backendNodeId,
        objectGroup: "ego-browser",
    }, match.sessionId);
    const objectId = result.object?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`No objectId for ref @${refId}`, "permanent");
    }
    const frameId = match.frameId || match.ownerFrameId;
    return {
        objectId,
        sessionId: match.sessionId,
        ...(frameId ? { frameId } : {}),
    };
}
async function collectBackendNodeMatches(cdp, contexts, backendNodeId) {
    const matches = new Map();
    if (contexts.length === 0)
        return matches;
    const trees = await Promise.allSettled(contexts.map(async (context) => ({
        context,
        result: await send(cdp, "Accessibility.getFullAXTree", context.frameId ? { frameId: context.frameId } : {}, context.sessionId),
    })));
    for (const tree of trees) {
        if (tree.status !== "fulfilled")
            continue;
        const { context, result } = tree.value;
        for (const node of result.nodes || []) {
            if (node.ignored || node.backendDOMNodeId !== backendNodeId)
                continue;
            const frameId = context.ownerFrameId || context.frameId;
            const key = `${context.sessionId}\u0000${node.backendDOMNodeId}`;
            const existing = matches.get(key);
            if (!existing || (!existing.frameId && frameId)) {
                matches.set(key, {
                    backendNodeId: node.backendDOMNodeId,
                    sessionId: context.sessionId,
                    role: normalizeRole(extractAxString(node.role)),
                    name: extractAxString(node.name),
                    ...(frameId ? { frameId } : {}),
                });
            }
        }
    }
    return matches;
}
/**
 * Validate many native snapshot locators together. DOM locator counts are
 * queried once per execution context, matching nodes are described in
 * parallel, and one object group releases every temporary handle.
 */
async function validateLocatorBackendNodes(cdp, sessionId, iframeSessions, candidates) {
    const parsed = candidates
        .map((candidate) => ({
        candidate,
        locator: parseLocator(candidate.locator),
    }))
        .filter((entry) => entry.locator);
    const roleCandidates = parsed.filter((entry) => entry.locator.kind === "role");
    const domCandidates = parsed.filter((entry) => entry.locator.kind !== "role");
    const [roleMatches, domMatches] = await Promise.all([
        validateRoleLocatorBackendNodes(cdp, sessionId, iframeSessions, roleCandidates),
        validateDomLocatorBackendNodes(cdp, sessionId, iframeSessions, domCandidates),
    ]);
    return new Set([...roleMatches, ...domMatches]);
}
async function validateRoleLocatorBackendNodes(cdp, sessionId, iframeSessions, entries) {
    const valid = new Set();
    if (entries.length === 0)
        return valid;
    const available = (await Promise.all(pageContexts(sessionId, iframeSessions).map(async (context) => {
        try {
            const tree = await send(cdp, "Accessibility.getFullAXTree", context.frameId ? { frameId: context.frameId } : {}, context.sessionId);
            return { context, tree };
        }
        catch {
            // A detached frame must not discard locators from healthy contexts.
            return undefined;
        }
    }))).filter((item) => item !== undefined);
    for (const entry of entries) {
        const rawMatches = available.flatMap(({ context, tree }) => (tree?.nodes || [])
            .filter((node) => !node.ignored &&
            normalizeRole(extractAxString(node.role)) === entry.locator.role &&
            roleNameMatches(extractAxString(node.name), entry.locator.name, entry.locator.nameMode) &&
            Number.isInteger(node.backendDOMNodeId))
            .map((node) => ({
            backendNodeId: node.backendDOMNodeId,
            frameId: context.frameId,
            sessionId: context.sessionId,
        })));
        const framedNodeKeys = new Set(rawMatches
            .filter((match) => match.frameId)
            .map((match) => `${match.sessionId}\u0000${match.backendNodeId}`));
        const matches = rawMatches.filter((match) => match.frameId ||
            !framedNodeKeys.has(`${match.sessionId}\u0000${match.backendNodeId}`));
        if (matches.length === 1 &&
            matches[0].backendNodeId === entry.candidate.backendNodeId &&
            locatorContextMatchesCandidate(matches[0], entry.candidate, sessionId, iframeSessions)) {
            valid.add(entry.candidate.index);
        }
    }
    return valid;
}
async function validateDomLocatorBackendNodes(cdp, sessionId, iframeSessions, entries) {
    const valid = new Set();
    if (entries.length === 0)
        return valid;
    const candidateContexts = await availableRuntimePageContexts(cdp, sessionId, iframeSessions);
    const countedContexts = (await Promise.all(candidateContexts.map(async (context) => {
        try {
            const result = await evaluateInContext(cdp, context, buildBatchLocatorCountJs(entries.map((entry) => entry.locator)), true);
            const counts = result.result?.value;
            if (result.exceptionDetails ||
                !Array.isArray(counts) ||
                counts.length !== entries.length ||
                counts.some((count) => !Number.isInteger(count) || count < -1)) {
                return undefined;
            }
            return { context, counts };
        }
        catch {
            // Count failures are scoped to the frame that disappeared.
            return undefined;
        }
    }))).filter((item) => item !== undefined);
    const contexts = countedContexts.map(({ context }) => context);
    const countsByContext = countedContexts.map(({ counts }) => counts);
    const contextForEntry = entries.map((_, entryIndex) => {
        let total = 0;
        let matchedContext = -1;
        for (let contextIndex = 0; contextIndex < contexts.length; contextIndex++) {
            const count = countsByContext[contextIndex][entryIndex];
            if (count < 0)
                return -1;
            total += count;
            if (count === 1)
                matchedContext = contextIndex;
        }
        return total === 1 ? matchedContext : -1;
    });
    const objectGroup = `ego-browser-snapshot-locators-${++snapshotLocatorBatchSequence}`;
    const usedSessions = new Set();
    try {
        const resolved = (await Promise.all(contexts.map(async (context, contextIndex) => {
            const localEntries = entries
                .map((entry, entryIndex) => ({ entry, entryIndex }))
                .filter(({ entryIndex }) => contextForEntry[entryIndex] === contextIndex);
            if (localEntries.length === 0)
                return [];
            usedSessions.add(context.sessionId);
            try {
                const evaluated = await evaluateInContext(cdp, context, buildBatchLocatorObjectsJs(localEntries.map(({ entry }) => entry.locator)), false, objectGroup);
                const batchObjectId = evaluated.result?.objectId;
                if (!batchObjectId || evaluated.exceptionDetails)
                    return [];
                const properties = await send(cdp, "Runtime.getProperties", { objectId: batchObjectId, ownProperties: true }, context.sessionId);
                return localEntries.flatMap(({ entry }, localIndex) => {
                    const property = (properties.result || []).find((candidate) => candidate.name === String(localIndex));
                    const objectId = property?.value?.objectId;
                    return objectId ? [{ entry, context, objectId }] : [];
                });
            }
            catch {
                return [];
            }
        }))).flat();
        await Promise.all(resolved.map(async ({ entry, context, objectId }) => {
            try {
                const described = await send(cdp, "DOM.describeNode", { objectId, depth: 0 }, context.sessionId);
                if (described?.node?.backendNodeId === entry.candidate.backendNodeId &&
                    locatorContextMatchesCandidate(context, entry.candidate, sessionId, iframeSessions)) {
                    valid.add(entry.candidate.index);
                }
            }
            catch {
                // A stale node is unsafe to advertise as a stable locator.
            }
        }));
    }
    finally {
        await Promise.all([...usedSessions].map((candidateSessionId) => send(cdp, "Runtime.releaseObjectGroup", { objectGroup }, candidateSessionId).catch(() => { })));
    }
    return valid;
}
function locatorContextMatchesCandidate(context, candidate, pageSessionId, iframeSessions) {
    if (!candidate.frameId)
        return true;
    const expectedSessionId = resolveFrameSession(candidate.frameId, pageSessionId, iframeSessions);
    const expectedFrameId = expectedSessionId === pageSessionId ? candidate.frameId : undefined;
    return (context.sessionId === expectedSessionId &&
        context.frameId === expectedFrameId);
}
async function resolveRawSelectorObjectId(cdp, contexts, selector, { actionability = undefined } = {}) {
    const match = await findUniqueRawSelectorContext(cdp, contexts, selector, {
        actionability,
    });
    const result = await evaluateInContext(cdp, match, match.actionable
        ? `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}[0] || null)()`
        : buildFindElementJs(selector.raw), false, "ego-browser");
    if (result.exceptionDetails) {
        throw invalidSelectorError(selector.raw, result);
    }
    const objectId = result.result?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`Element not found: ${selector.raw}`, "transient");
    }
    return {
        objectId,
        sessionId: match.sessionId,
        ...(match.ownerFrameId || match.frameId
            ? { frameId: match.ownerFrameId || match.frameId }
            : {}),
    };
}
async function findUniqueRawSelectorContext(cdp, contexts, selector, { actionability = undefined } = {}) {
    if (actionability) {
        const mainCount = await rawSelectorCount(cdp, contexts[0], selector);
        const mainActionable = mainCount
            ? await rawSelectorActionableCount(cdp, contexts[0], selector, actionability)
            : 0;
        if (mainActionable === 1) {
            return { ...contexts[0], actionable: true };
        }
        if (mainActionable > 1) {
            throw await rawSelectorCountError(cdp, [contexts[0]], selector, mainCount);
        }
        const matches = [];
        let totalCount = mainCount;
        let actionableCount = 0;
        for (const context of contexts.slice(1)) {
            const count = await rawSelectorCount(cdp, context, selector);
            totalCount += count;
            if (count === 0)
                continue;
            const actionable = await rawSelectorActionableCount(cdp, context, selector, actionability);
            actionableCount += actionable;
            if (actionable > 0)
                matches.push({ ...context, actionable });
        }
        if (totalCount === 0) {
            throw new ElementResolutionError(`Selector ${selector.raw} matched 0 elements`, "transient");
        }
        if (actionableCount === 1) {
            return { ...matches[0], actionable: true };
        }
        if (actionableCount === 0) {
            const blocker = await firstActionabilityBlocker(cdp, contexts, buildRawSelectorElementsJs(selector), actionability);
            throw new ElementResolutionError(`Selector ${selector.raw} matched ${totalCount} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`, "transient");
        }
        throw await rawSelectorCountError(cdp, matches, selector, totalCount);
    }
    const mainCount = await rawSelectorCount(cdp, contexts[0], selector);
    if (mainCount > 1) {
        throw await rawSelectorCountError(cdp, [contexts[0]], selector, mainCount);
    }
    if (mainCount === 1)
        return contexts[0];
    const matches = [];
    let count = 0;
    for (const context of contexts.slice(1)) {
        const candidateCount = await rawSelectorCount(cdp, context, selector);
        count += candidateCount;
        if (candidateCount > 0) {
            matches.push({ count: candidateCount, ...context });
        }
    }
    if (count === 0) {
        throw new ElementResolutionError(`Selector ${selector.raw} matched 0 elements`, "transient");
    }
    if (count > 1) {
        throw await rawSelectorCountError(cdp, matches, selector, count);
    }
    return matches[0];
}
async function rawSelectorCount(cdp, context, selector) {
    const result = await evaluateInContext(cdp, context, buildRawSelectorCountJs(selector), true);
    if (result.exceptionDetails) {
        throw invalidSelectorError(selector.raw, result);
    }
    return Number(result.result?.value || 0);
}
async function rawSelectorActionableCount(cdp, context, selector, actionability) {
    const result = await evaluateInContext(cdp, context, `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}.length)()`, true);
    if (result.exceptionDetails) {
        throw invalidSelectorError(selector.raw, result);
    }
    return Number(result.result?.value || 0);
}
async function rawSelectorCountError(cdp, contexts, selector, count) {
    return ambiguityError(`Selector ${selector.raw} matched ${count} elements`, await collectMatchDiagnostics(cdp, contexts, buildRawSelectorElementsJs(selector)));
}
function invalidSelectorError(raw, result) {
    const hint = numericCssIdHint(raw);
    return new ElementResolutionError(`Invalid selector: ${raw}${hint ? `. ${hint}` : ""}: ${exceptionText(result)}`, "permanent");
}
function numericCssIdHint(raw) {
    const value = String(raw || "").trim();
    const prefix = value.startsWith("loc=css:")
        ? "loc=css:"
        : value.startsWith("css:")
            ? "css:"
            : "";
    const match = /^#([0-9][A-Za-z0-9_-]*)$/.exec(value.slice(prefix.length));
    if (!match)
        return undefined;
    const selector = `[id=${JSON.stringify(match[1])}]`;
    return `CSS ids beginning with a digit must be escaped; use ${prefix}${selector}`;
}
function resolveFrameSession(frameId, sessionId, iframeSessions) {
    if (!frameId) {
        return sessionId;
    }
    if (iframeSessions instanceof Map) {
        return iframeSessions.get(frameId) || sessionId;
    }
    return iframeSessions?.[frameId] || sessionId;
}
function pageSessions(sessionId, iframeSessions) {
    const sessions = [sessionId];
    const frameSessionIds = iframeSessions instanceof Map
        ? iframeSessions.values()
        : Object.values(iframeSessions || {});
    for (const frameSessionId of frameSessionIds) {
        if (frameSessionId && !sessions.includes(frameSessionId)) {
            sessions.push(frameSessionId);
        }
    }
    return sessions;
}
function pageContexts(sessionId, iframeSessions) {
    const contexts = [
        { sessionId, frameId: undefined, ownerFrameId: undefined },
    ];
    const entries = iframeSessions instanceof Map
        ? iframeSessions.entries()
        : Object.entries(iframeSessions || {});
    for (const [frameId, frameSessionId] of entries) {
        contexts.push({
            sessionId: frameSessionId,
            frameId: frameSessionId === sessionId ? frameId : undefined,
            ownerFrameId: frameId,
        });
    }
    return contexts;
}
async function runtimePageContexts(cdp, sessionId, iframeSessions) {
    const contexts = pageContexts(sessionId, iframeSessions);
    return Promise.all(contexts.map((context) => runtimePageContext(cdp, context)));
}
async function availableRuntimePageContexts(cdp, sessionId, iframeSessions) {
    const settled = await Promise.allSettled(pageContexts(sessionId, iframeSessions).map((context) => runtimePageContext(cdp, context)));
    return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}
async function runtimePageContext(cdp, context) {
    if (!context.frameId)
        return context;
    try {
        const result = await send(cdp, "Page.createIsolatedWorld", {
            frameId: context.frameId,
            worldName: "ego-browser-locator",
            grantUniveralAccess: true,
        }, context.sessionId);
        if (!Number.isInteger(result?.executionContextId)) {
            throw new Error("Page.createIsolatedWorld returned no context id");
        }
        return { ...context, contextId: result.executionContextId };
    }
    catch (error) {
        throw new ElementResolutionError(`Frame ${context.frameId} is not ready: ${error?.message || String(error)}`, "transient");
    }
}
function evaluateInContext(cdp, context, expression, returnByValue, objectGroup) {
    return send(cdp, "Runtime.evaluate", {
        expression,
        returnByValue,
        awaitPromise: false,
        ...(context.contextId !== undefined
            ? { contextId: context.contextId }
            : {}),
        ...(objectGroup ? { objectGroup } : {}),
    }, context.sessionId);
}
async function resolveLocatorCenter(cdp, sessionId, locator, iframeSessions) {
    const sessions = pageSessions(sessionId, iframeSessions);
    if (locator.kind === "role") {
        const match = await findUniqueRoleMatch(cdp, pageContexts(sessionId, iframeSessions), locator.role, locator.name, locator.raw, { nameMode: locator.nameMode });
        const result = await send(cdp, "DOM.getBoxModel", { backendNodeId: match.backendNodeId }, match.sessionId);
        return { ...boxModelCenter(result.model), sessionId: match.sessionId };
    }
    const match = sessions.length === 1
        ? { sessionId: sessions[0] }
        : await findUniqueLocatorContext(cdp, sessions.map((candidateSessionId) => ({
            sessionId: candidateSessionId,
        })), locator);
    const result = await evaluateInContext(cdp, match, buildLocatorCenterJs(locator), true);
    if (result.exceptionDetails) {
        throw new ElementResolutionError(`Invalid selector: ${locator.raw}: ${exceptionText(result)}`, "permanent");
    }
    const value = result.result?.value;
    if (value?.error) {
        const kind = matchCountKind(value.error);
        if (kind === "permanent") {
            throw await locatorCountError(cdp, [match], locator, matchCount(value.error));
        }
        throw new ElementResolutionError(value.error, kind);
    }
    if (typeof value?.x !== "number" || typeof value?.y !== "number") {
        throw new ElementResolutionError(`Element not found: ${locator.raw}`, "transient");
    }
    return { x: value.x, y: value.y, sessionId: match.sessionId };
}
async function resolveLocatorObjectId(cdp, sessionId, locator, iframeSessions, options = {}) {
    if (locator.kind === "role") {
        const match = await findUniqueRoleMatch(cdp, pageContexts(sessionId, iframeSessions), locator.role, locator.name, locator.raw, {
            nameMode: locator.nameMode,
            strictGlobal: options.strictGlobal,
            actionability: options.actionability,
        });
        const result = await send(cdp, "DOM.resolveNode", {
            backendNodeId: match.backendNodeId,
            objectGroup: "ego-browser",
        }, match.sessionId);
        const objectId = result.object?.objectId;
        if (!objectId) {
            throw new ElementResolutionError(`No objectId for locator ${locator.raw}`, "permanent");
        }
        return {
            objectId,
            sessionId: match.sessionId,
            ...(match.ownerFrameId || match.frameId
                ? { frameId: match.ownerFrameId || match.frameId }
                : {}),
        };
    }
    const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
    const match = await findUniqueLocatorContext(cdp, contexts, locator, {
        strictGlobal: options.strictGlobal,
        actionability: options.actionability,
    });
    const result = await evaluateInContext(cdp, match, match.actionable
        ? buildLocatorActionableFindJs(locator, options.actionability)
        : buildLocatorFindJs(locator), false, "ego-browser");
    const objectId = result.result?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`Element not found: ${locator.raw}`, "transient");
    }
    return {
        objectId,
        sessionId: match.sessionId,
        ...(match.ownerFrameId || match.frameId
            ? { frameId: match.ownerFrameId || match.frameId }
            : {}),
    };
}
async function findUniqueLocatorContext(cdp, contexts, locator, { strictGlobal = false, actionability = undefined, } = {}) {
    if (actionability) {
        const mainCount = await locatorCount(cdp, contexts[0], locator);
        const mainActionable = mainCount
            ? await locatorActionableCount(cdp, contexts[0], locator, actionability)
            : 0;
        if (mainActionable === 1) {
            return { count: 1, ...contexts[0], actionable: true };
        }
        if (mainActionable > 1) {
            throw await locatorCountError(cdp, [contexts[0]], locator, mainCount);
        }
        const matches = [];
        let totalCount = mainCount;
        let actionableCount = 0;
        for (const context of contexts.slice(1)) {
            const count = await locatorCount(cdp, context, locator);
            totalCount += count;
            if (count === 0)
                continue;
            const actionable = await locatorActionableCount(cdp, context, locator, actionability);
            actionableCount += actionable;
            if (actionable > 0) {
                matches.push({
                    count,
                    actionable,
                    ...context,
                });
            }
        }
        if (totalCount === 0) {
            throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, "transient");
        }
        if (actionableCount === 1) {
            return { ...matches[0], count: 1, actionable: true };
        }
        if (actionableCount === 0) {
            const blocker = await firstActionabilityBlocker(cdp, contexts, buildLocatorElementsJs(locator), actionability);
            throw new ElementResolutionError(`Locator ${locator.raw} matched ${totalCount} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`, "transient");
        }
        throw await locatorCountError(cdp, matches, locator, totalCount);
    }
    const matches = [];
    let count = 0;
    const mainCount = await locatorCount(cdp, contexts[0], locator);
    if (mainCount > 1 && !strictGlobal) {
        throw await locatorCountError(cdp, [contexts[0]], locator, mainCount);
    }
    if (mainCount === 1 && !strictGlobal) {
        return { count: 1, ...contexts[0] };
    }
    count += mainCount;
    if (mainCount > 0) {
        matches.push({ count: mainCount, ...contexts[0] });
    }
    for (const context of contexts.slice(1)) {
        const candidateCount = await locatorCount(cdp, context, locator);
        count += candidateCount;
        if (candidateCount > 0) {
            matches.push({ count: candidateCount, ...context });
        }
    }
    if (count === 0) {
        throw new ElementResolutionError(`Locator ${locator.raw} matched 0 elements`, "transient");
    }
    if (count > 1) {
        throw await locatorCountError(cdp, matches, locator, count);
    }
    return matches[0];
}
async function findUniqueRoleMatch(cdp, contexts, role, name, raw, { nameMode = "exact", strictGlobal = false, actionability = undefined, } = {}) {
    const matchesIn = async (selectedContexts) => {
        const matches = [];
        for (const context of selectedContexts) {
            const result = await send(cdp, "Accessibility.getFullAXTree", context.frameId ? { frameId: context.frameId } : {}, context.sessionId);
            for (const node of result.nodes || []) {
                if (!node.ignored &&
                    normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
                    roleNameMatches(extractAxString(node.name), name, nameMode) &&
                    node.backendDOMNodeId !== undefined &&
                    node.backendDOMNodeId !== null) {
                    matches.push({
                        backendNodeId: node.backendDOMNodeId,
                        frameId: context.frameId,
                        ownerFrameId: context.ownerFrameId,
                        sessionId: context.sessionId,
                    });
                }
            }
        }
        return matches;
    };
    const rawMainMatches = await matchesIn(contexts.slice(0, 1));
    let cachedFrameMatches;
    const matchesWithFrameProvenance = async () => {
        cachedFrameMatches ||= matchesIn(contexts.slice(1));
        const frames = await cachedFrameMatches;
        const framedNodeKeys = new Set(frames
            .filter((match) => match.frameId)
            .map((match) => `${match.sessionId}\u0000${match.backendNodeId}`));
        const main = rawMainMatches.filter((match) => !framedNodeKeys.has(`${match.sessionId}\u0000${match.backendNodeId}`));
        return { main, frames };
    };
    if (strictGlobal) {
        const { main, frames } = await matchesWithFrameProvenance();
        const matches = [...main, ...frames];
        if (matches.length === 0) {
            throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, "transient");
        }
        if (matches.length === 1)
            return matches[0];
        throw ambiguityError(`Locator ${raw} matched ${matches.length} elements`);
    }
    if (!actionability) {
        const matches = rawMainMatches.length > 0
            ? rawMainMatches
            : (await matchesWithFrameProvenance()).frames;
        if (matches.length === 0) {
            throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, "transient");
        }
        if (matches.length === 1)
            return matches[0];
        throw ambiguityError(`Locator ${raw} matched ${matches.length} elements`);
    }
    const classify = async (matches) => {
        const actionable = [];
        let blocker;
        for (const match of matches) {
            const result = await roleMatchActionability(cdp, match, actionability);
            if (result.actionable)
                actionable.push(match);
            else
                blocker ||= result.blocker;
        }
        return { actionable, blocker };
    };
    const provenance = await matchesWithFrameProvenance();
    const mainMatches = provenance.main;
    const main = await classify(mainMatches);
    if (main.actionable.length === 1)
        return main.actionable[0];
    if (main.actionable.length > 1) {
        throw ambiguityError(`Locator ${raw} matched ${mainMatches.length} elements`);
    }
    const frames = provenance.frames;
    const frame = await classify(frames);
    const total = mainMatches.length + frames.length;
    if (total === 0) {
        throw new ElementResolutionError(`Locator ${raw} matched 0 elements`, "transient");
    }
    if (frame.actionable.length === 1)
        return frame.actionable[0];
    if (frame.actionable.length === 0) {
        const blocker = main.blocker || frame.blocker;
        throw new ElementResolutionError(`Locator ${raw} matched ${total} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`, "transient");
    }
    throw ambiguityError(`Locator ${raw} matched ${total} elements`);
}
/** Classify one AX match with the same rules used for DOM selectors. */
async function roleMatchActionability(cdp, match, actionability) {
    let objectId;
    try {
        const resolved = await send(cdp, "DOM.resolveNode", {
            backendNodeId: match.backendNodeId,
            objectGroup: "ego-browser",
        }, match.sessionId);
        objectId = resolved.object?.objectId;
        if (!objectId)
            return { actionable: false };
        const result = await send(cdp, "Runtime.callFunctionOn", {
            functionDeclaration: `function() {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          if (!this.isConnected) {
            return { actionable: false, blocker: "element is detached from the DOM" };
          }
          if (this.closest?.("[hidden], [inert]")) {
            return { actionable: false, blocker: "element is hidden or inert" };
          }
          const view = this.ownerDocument?.defaultView;
          if (!view) {
            return { actionable: false, blocker: "element has no browsing context" };
          }
          const rect = this.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return { actionable: false, blocker: "element has a zero-sized bounding box" };
          }
          const style = view.getComputedStyle(this);
          if (style.display === "none") {
            return { actionable: false, blocker: "element has display: none" };
          }
          if (style.visibility === "hidden") {
            return { actionable: false, blocker: "element has visibility: hidden" };
          }
          if (
            ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
            isActionTargetDisabled(this)
          ) return { actionable: false, blocker: "element is disabled" };
          if (${JSON.stringify(actionabilityRequiresPointer(actionability))}) {
            const point = actionPointForElement(this);
            if (!point) {
              return { actionable: false, blocker: "element has no actionable point" };
            }
            if (!scrollRequestForPoint(this, point)) {
              const interceptor = interceptingElementAtPoint(this, point);
              if (interceptor) {
                return {
                  actionable: false,
                  blocker: describeHitTarget(interceptor) + " intercepts pointer events"
                };
              }
            }
          }
          return { actionable: true };
        }`,
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, match.sessionId);
        const value = result.result?.value;
        if (typeof value === "boolean")
            return { actionable: value };
        return {
            actionable: value?.actionable === true,
            ...(typeof value?.blocker === "string" ? { blocker: value.blocker } : {}),
        };
    }
    catch {
        return { actionable: false };
    }
    finally {
        if (objectId) {
            await send(cdp, "Runtime.releaseObject", { objectId }, match.sessionId).catch(() => { });
        }
    }
}
async function locatorCount(cdp, context, locator) {
    const result = await evaluateInContext(cdp, context, buildLocatorCountJs(locator), true);
    if (result.exceptionDetails) {
        throw new ElementResolutionError(`Invalid selector: ${locator.raw}: ${exceptionText(result)}`, "permanent");
    }
    return Number(result.result?.value || 0);
}
async function locatorActionableCount(cdp, context, locator, actionability) {
    const result = await evaluateInContext(cdp, context, buildLocatorActionableCountJs(locator, actionability), true);
    if (result.exceptionDetails) {
        throw new ElementResolutionError(`Invalid selector: ${locator.raw}: ${exceptionText(result)}`, "permanent");
    }
    return Number(result.result?.value || 0);
}
async function locatorCountError(cdp, contexts, locator, count) {
    if (locator.kind === "role") {
        return ambiguityError(`Locator ${locator.raw} matched ${count} elements`);
    }
    return ambiguityError(`Locator ${locator.raw} matched ${count} elements`, await collectMatchDiagnostics(cdp, contexts, buildLocatorElementsJs(locator)));
}
function matchCount(message) {
    const match = /matched (\d+)/.exec(message);
    return match ? Number(match[1]) : 0;
}
async function collectMatchDiagnostics(cdp, contexts, elementsExpression) {
    const combined = { visible: 0, hidden: 0, candidates: [] };
    try {
        for (const context of contexts) {
            const result = await evaluateInContext(cdp, context, buildMatchDiagnosticsJs(elementsExpression), true);
            const value = result.result?.value;
            if (typeof value?.visible !== "number" ||
                typeof value?.hidden !== "number" ||
                !Array.isArray(value?.candidates)) {
                continue;
            }
            combined.visible += value.visible;
            combined.hidden += value.hidden;
            combined.candidates.push(...value.candidates.slice(0, 3 - combined.candidates.length));
        }
        return combined.visible + combined.hidden > 0 ? combined : undefined;
    }
    catch {
        // Diagnostics must never replace the original strict-selector failure.
        return undefined;
    }
}
function ambiguityError(message, diagnostics = undefined) {
    const visibility = diagnostics
        ? ` (${diagnostics.visible} visible, ${diagnostics.hidden} hidden)`
        : "";
    const candidates = diagnostics?.candidates?.length
        ? ` Candidates: ${diagnostics.candidates
            .map((candidate, index) => `${index + 1}. ${formatCandidate(candidate)}`)
            .join("; ")}.`
        : "";
    return new ElementResolutionError(`${message}${visibility}.${candidates} Use a current snapshot ref or a more specific role, text, or CSS selector.`, "permanent");
}
function formatCandidate(candidate) {
    const tag = candidate?.tag || "element";
    const role = candidate?.role ? ` role=${candidate.role}` : "";
    const name = candidate?.name ? ` ${JSON.stringify(candidate.name)}` : "";
    const states = [candidate?.visible === false ? "hidden" : "visible"];
    if (candidate?.disabled)
        states.push("disabled");
    return `${tag}${role}${name} (${states.join(", ")})`;
}
async function findBackendNodeIdByRoleName(cdp, sessionId, role, name, nth = undefined, frameId = undefined, iframeSessions = new Map()) {
    const [params, effectiveSessionId] = resolveAxSession(frameId, sessionId, iframeSessions);
    const result = await send(cdp, "Accessibility.getFullAXTree", params, effectiveSessionId);
    const matches = (result.nodes || []).filter((node) => !node.ignored &&
        normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
        extractAxString(node.name) === name);
    // This is a recovery path: the ref's backend node is gone, so role and name
    // are the only identity left. They do not distinguish repeated labels, so an
    // ambiguous result must fail loudly instead of silently acting on whichever
    // node happens to come first. A ref that recorded an explicit nth already
    // carries the disambiguator and keeps indexing.
    if (nth === undefined && matches.length > 1) {
        throw new ElementResolutionError(`Stale ref for role=${role} name=${name} matched ${matches.length} elements after its node was replaced; take a new snapshot`, "permanent");
    }
    const node = matches[nth ?? 0];
    if (!node) {
        throw new ElementResolutionError(`Could not locate element with role=${role} name=${name}`, "transient");
    }
    if (node.backendDOMNodeId === undefined || node.backendDOMNodeId === null) {
        throw new ElementResolutionError(`AX node has no backendDOMNodeId for role=${role} name=${name}`, "permanent");
    }
    return node.backendDOMNodeId;
}
function resolveAxSession(frameId, sessionId, iframeSessions) {
    if (!frameId) {
        return [{}, sessionId];
    }
    const iframeSession = iframeSessions instanceof Map
        ? iframeSessions.get(frameId)
        : iframeSessions?.[frameId];
    if (iframeSession && iframeSession !== sessionId) {
        return [{}, iframeSession];
    }
    return [{ frameId }, sessionId];
}
function buildFindElementJs(selector) {
    if (String(selector).startsWith("xpath=")) {
        return `document.evaluate(${JSON.stringify(String(selector).slice(6))}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
    }
    return buildCssFindJs(selector);
}
function parseRawSelector(input) {
    const raw = String(input);
    return raw.startsWith("xpath=")
        ? { kind: "xpath", selector: raw.slice(6), raw }
        : {
            kind: "css",
            selector: raw.startsWith("css=") ? raw.slice(4) : raw,
            raw,
        };
}
function buildRawSelectorCountJs(selector) {
    if (selector.kind === "xpath") {
        return `document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`;
    }
    return buildCssCountJs(selector.selector);
}
function buildRawSelectorElementsJs(selector) {
    if (selector.kind === "xpath") {
        return `(() => {
              const result = document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index));
            })()`;
    }
    return buildCssQueryAllJs(selector.selector);
}
function buildLocatorFindJs(locator) {
    if (locator.kind === "css") {
        return buildCssFindJs(locator.selector);
    }
    if (locator.kind === "text") {
        return `(() => ${textElementsJs(locator)}[0] || null)()`;
    }
    if (locator.kind === "href") {
        return `(() => ${hrefElementsJs(locator.href)}[0] || null)()`;
    }
    return `(() => ${buildLocatorElementsJs(locator)}[0] || null)()`;
}
function buildLocatorActionableFindJs(locator, actionability) {
    return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}[0] || null)()`;
}
function buildLocatorActionableCountJs(locator, actionability) {
    return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}.length)()`;
}
function buildActionableElementsJs(elementsExpression, actionability) {
    return `(() => {
            ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
            const __egoActionableMatches = Array.from(${elementsExpression} || []).filter((element) => {
              if (!element?.isConnected || element.closest?.("[hidden], [inert]")) return false;
              const view = element.ownerDocument?.defaultView;
              if (!view) return false;
              const rect = element.getBoundingClientRect();
              const style = view.getComputedStyle(element);
              const visible = rect.width > 0 && rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden";
              if (!visible) return false;
              if (
                ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
                isActionTargetDisabled(element)
              ) return false;
              if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) return true;
              const point = actionPointForElement(element);
              if (!point) return false;
              return Boolean(scrollRequestForPoint(element, point)) ||
                !interceptingElementAtPoint(element, point);
            });
            return __egoActionableMatches;
          })()`;
}
async function firstActionabilityBlocker(cdp, contexts, elementsExpression, actionability) {
    for (const context of contexts) {
        try {
            const result = await evaluateInContext(cdp, context, `(() => {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          for (const element of Array.from(${elementsExpression} || [])) {
            if (!element?.isConnected) return "element is detached from the DOM";
            if (element.closest?.("[hidden], [inert]")) return "element is hidden or inert";
            const view = element.ownerDocument?.defaultView;
            if (!view) return "element has no browsing context";
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return "element has a zero-sized bounding box";
            }
            const style = view.getComputedStyle(element);
            if (style.display === "none") return "element has display: none";
            if (style.visibility === "hidden") return "element has visibility: hidden";
            if (
              ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
              isActionTargetDisabled(element)
            ) return "element is disabled";
            if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) continue;
            const point = actionPointForElement(element);
            if (!point) return "element has no actionable point";
            if (scrollRequestForPoint(element, point)) continue;
            const interceptor = interceptingElementAtPoint(element, point);
            if (interceptor) {
              return describeHitTarget(interceptor) + " intercepts pointer events";
            }
          }
          return null;
        })()`, true);
            if (typeof result.result?.value === "string")
                return result.result.value;
        }
        catch {
            // Keep the original actionability error when diagnostics fail.
        }
    }
    return undefined;
}
function buildLocatorCountJs(locator) {
    if (locator.kind === "css") {
        return buildCssCountJs(locator.selector);
    }
    if (locator.kind === "text") {
        return `(() => ${textElementsJs(locator)}.length)()`;
    }
    if (locator.kind === "href") {
        return `(() => ${hrefElementsJs(locator.href)}.length)()`;
    }
    return `(() => ${buildLocatorElementsJs(locator)}.length)()`;
}
function buildBatchLocatorCountJs(locators) {
    const queries = locators
        .map((locator) => `() => Array.from(${buildLocatorElementsJs(locator)} || []).length`)
        .join(",\n");
    return `(() => {
            const queries = [${queries}];
            return queries.map((query) => {
              try {
                return query();
              } catch {
                return -1;
              }
            });
          })()`;
}
function buildBatchLocatorObjectsJs(locators) {
    return `(() => [${locators
        .map((locator) => buildLocatorFindJs(locator))
        .join(",\n")}])()`;
}
function buildLocatorElementsJs(locator) {
    if (locator.kind === "css") {
        return buildCssQueryAllJs(locator.selector);
    }
    if (locator.kind === "text") {
        return textElementsJs(locator);
    }
    if (locator.kind === "href") {
        return hrefElementsJs(locator.href);
    }
    if (locator.kind === "cssText") {
        return cssTextElementsJs(locator);
    }
    if (locator.kind === "nth") {
        return nthElementsJs(locator);
    }
    throw new Error(`Unsupported locator kind: ${locator.kind}`);
}
function buildMatchDiagnosticsJs(elementsExpression) {
    return `(() => {
            ${ACTION_TARGET_STATE_HELPERS}
            const __egoDescribeMatches = (values) => {
              const elements = Array.from(values || []).filter(Boolean);
              const normalize = (value) =>
                String(value ?? "").replace(/\\s+/g, " ").trim();
              const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return !element.closest("[hidden], [inert]") &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  rect.width > 0 && rect.height > 0;
              };
              const candidates = elements.slice(0, 3).map((element) => {
                const isVisible = visible(element);
                const name = normalize(
                  element.getAttribute?.("aria-label") ||
                  element.getAttribute?.("alt") ||
                  element.getAttribute?.("title") ||
                  element.value ||
                  element.innerText ||
                  element.textContent
                ).slice(0, 80);
                return {
                  tag: String(element.tagName || "element").toLowerCase(),
                  role: element.getAttribute?.("role") || undefined,
                  name: name || undefined,
                  visible: isVisible,
                  disabled: isActionTargetDisabled(element)
                };
              });
              const visibleCount = elements.filter(visible).length;
              return {
                visible: visibleCount,
                hidden: elements.length - visibleCount,
                candidates
              };
            };
            return __egoDescribeMatches(${elementsExpression});
          })()`;
}
function actionabilityRequiresEnabled(actionability) {
    return actionability === "enabled" || actionability === "pointer-enabled";
}
function actionabilityRequiresPointer(actionability) {
    return actionability === "pointer" || actionability === "pointer-enabled";
}
function buildLocatorCenterJs(locator) {
    return `(() => {
            const count = ${buildLocatorCountJs(locator)};
            if (count !== 1) return { error: ${JSON.stringify(`Locator ${locator.raw} matched`)} + ' ' + count + ' elements' };
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function hrefElementsJs(href) {
    return `${buildCssQueryAllJs("a[href]")}.filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}
function cssTextElementsJs(locator) {
    return `(() => {
            const spec = {
              selector: ${JSON.stringify(locator.selector)},
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "")
                .replace(/[\\u200b\\u00ad]/g, "")
                .replace(/[\\r\\n\\s\\t]+/g, " ")
                .trim();
            const expected = normalize(spec.text);
            const elements = ${buildCssQueryAllJs(locator.selector)};

            function shouldSkip(element) {
              return (
                element.tagName === "SCRIPT" ||
                element.tagName === "NOSCRIPT" ||
                element.tagName === "STYLE" ||
                document.head?.contains(element)
              );
            }

            function elementText(element) {
              if (shouldSkip(element)) {
                return { full: "", normalized: "", immediate: [] };
              }
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                const value = String(element.value || "");
                return { full: value, normalized: normalize(value), immediate: [value] };
              }

              let full = "";
              let currentImmediate = "";
              const immediate = [];
              const flushImmediate = () => {
                if (currentImmediate) immediate.push(currentImmediate);
                currentImmediate = "";
              };
              for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                  full += child.nodeValue || "";
                  currentImmediate += child.nodeValue || "";
                } else if (child.nodeType !== Node.COMMENT_NODE) {
                  flushImmediate();
                  if (child.nodeType === Node.ELEMENT_NODE) {
                    full += elementText(child).full;
                  }
                }
              }
              flushImmediate();
              if (element.shadowRoot) full += elementText(element.shadowRoot).full;
              return { full, normalized: normalize(full), immediate };
            }

            return elements.filter((element) => {
              const text = elementText(element);
              if (spec.mode === "exact") {
                return (
                  (expected === "" && text.immediate.length === 0) ||
                  text.immediate.some((value) => normalize(value) === expected)
                );
              }
              return text.normalized.toLowerCase().includes(expected.toLowerCase());
            });
          })()`;
}
function nthElementsJs(locator) {
    return `(() => {
            const values = Array.from(${buildLocatorElementsJs(locator.locator)} || []);
            const index = ${locator.index} === -1 ? values.length - 1 : ${locator.index};
            return index >= 0 && index < values.length ? [values[index]] : [];
          })()`;
}
function textElementsJs(locator) {
    return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            const spec = {
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "").replace(/\\s+/g, " ").trim();
            const expected = normalize(spec.text);
            const excludedTags = new Set([
              "HEAD",
              "NOSCRIPT",
              "SCRIPT",
              "STYLE",
              "TEMPLATE",
              "TITLE"
            ]);
            const elements = __egoQueryAllOpenShadow("*").filter(
              (element) => !excludedTags.has(element.tagName)
            );

            function fullText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(element.textContent);
            }

            function immediateText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(
                [...element.childNodes]
                  .filter((node) => node.nodeType === Node.TEXT_NODE)
                  .map((node) => node.nodeValue)
                  .join(" ")
              );
            }

            function matches(element) {
              if (spec.mode === "exact") return immediateText(element) === expected;
              return fullText(element)
                .toLowerCase()
                .includes(expected.toLowerCase());
            }

            function isComposedDescendant(ancestor, node) {
              let current = node;
              while (current) {
                if (current === ancestor) return true;
                if (current.parentElement) {
                  current = current.parentElement;
                  continue;
                }
                const root = current.getRootNode?.();
                current = root instanceof ShadowRoot ? root.host : null;
              }
              return false;
            }

            const matchesByText = elements.filter(matches);
            return matchesByText.filter(
              (element) =>
                !matchesByText.some(
                  (other) =>
                    other !== element && isComposedDescendant(element, other)
                )
            );
          })()`;
}
// CSS locators from the native snapshot can point into an open shadow tree.
// Query every reachable tree scope so those locators have the same meaning
// when an action reuses them. XPath deliberately keeps document-only semantics.
const OPEN_SHADOW_QUERY_HELPER = `
  function __egoQueryAllOpenShadow(selector) {
    const matches = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      matches.push(...root.querySelectorAll(selector));
      const elements = root.querySelectorAll('*');
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const shadowRoot = elements[index].shadowRoot;
        if (shadowRoot) roots.push(shadowRoot);
      }
    }
    return matches;
  }
`;
function buildCssQueryAllJs(selector) {
    return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)});
          })()`;
}
function buildCssFindJs(selector) {
    return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)})[0] || null;
          })()`;
}
function buildCssCountJs(selector) {
    return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)}).length;
          })()`;
}
function buildSelectorCenterJs(selector) {
    const findExpr = buildFindElementJs(selector);
    return `(() => {
            const el = ${findExpr};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}
function parseLocator(input) {
    const raw = String(input || "").trim();
    let value = raw;
    if (value.startsWith("loc=")) {
        value = value.slice(4);
    }
    const nth = parseTerminalNth(value);
    if (nth?.valid) {
        const locator = parseLocatorCore(nth.base, raw, true);
        if (!locator || locator.kind === "role" || locator.kind === "nth") {
            return null;
        }
        return { kind: "nth", locator, index: nth.index, raw };
    }
    if (nth)
        return null;
    return parseLocatorCore(value, raw, false);
}
function parseLocatorCore(value, raw, allowRawCss) {
    if (value.startsWith("css:")) {
        const selector = value.slice(4);
        return parseCssLocator(selector, raw);
    }
    if (value.startsWith("css=")) {
        const selector = value.slice(4);
        return parseCssLocator(selector, raw);
    }
    if (value.startsWith("href:")) {
        const href = value.slice(5);
        return href ? { kind: "href", href, raw } : null;
    }
    if (value.startsWith("text=")) {
        const body = value.slice(5).trim();
        if (!body)
            return null;
        const quoted = (body.startsWith('"') && body.endsWith('"')) ||
            (body.startsWith("'") && body.endsWith("'"));
        const text = quoted ? parseLocatorName(body) : body;
        return normalizeText(text)
            ? {
                kind: "text",
                mode: quoted ? "exact" : "substring",
                text,
                raw,
            }
            : null;
    }
    const roleMatch = /^role:([A-Za-z0-9_-]+)\[name(\*=|=)(.+)\]$/.exec(value);
    if (roleMatch) {
        return {
            kind: "role",
            role: normalizeRole(roleMatch[1]),
            nameMode: roleMatch[2] === "*=" ? "substring" : "exact",
            name: parseLocatorName(roleMatch[3]),
            raw,
        };
    }
    if (allowRawCss || hasTerminalCssTextPseudo(value)) {
        return parseCssLocator(value, raw);
    }
    return null;
}
function parseCssLocator(selector, raw) {
    const trimmed = selector.trim();
    if (!trimmed)
        return null;
    const text = parseTerminalCssText(trimmed);
    if (text?.valid) {
        return {
            kind: "cssText",
            selector: text.selector,
            mode: text.mode,
            text: text.text,
            raw,
        };
    }
    if (text)
        return null;
    if (containsUnquotedTextPseudo(trimmed))
        return null;
    return { kind: "css", selector: trimmed, raw };
}
function parseLocatorOrThrow(input) {
    const locator = parseLocator(input);
    if (locator)
        return locator;
    const value = String(input || "").trim();
    if (value.startsWith("loc=") ||
        value.startsWith("role:") ||
        value.startsWith("text=") ||
        value.startsWith("css=") ||
        hasPlaywrightCompatibilitySyntax(value)) {
        throw new ElementResolutionError(`Invalid locator: ${value}. Expected loc=role:<role>[name="<exact name>"], loc=role:<role>[name*="<name part>"], loc=css:<selector>, loc=href:<substring>, text=..., css=..., a terminal :has-text(...) or :text-is(...), or a terminal >> nth=N`, "permanent");
    }
    return null;
}
function parseTerminalNth(value) {
    const separators = topLevelTokenPositions(value, ">>");
    if (separators.length === 0)
        return undefined;
    if (separators.length !== 1)
        return { valid: false };
    const position = separators[0];
    const base = value.slice(0, position).trim();
    const tail = value.slice(position + 2).trim();
    const match = /^nth=(-?\d+)$/.exec(tail);
    if (!base || !match)
        return { valid: false };
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < -1)
        return { valid: false };
    return { valid: true, base, index };
}
function parseTerminalCssText(selector) {
    const pseudos = [
        { token: ":has-text(", mode: "substring" },
        { token: ":text-is(", mode: "exact" },
    ];
    for (let index = 0; index < selector.length; index += 1) {
        if (!isTopLevelPosition(selector, index))
            continue;
        const pseudo = pseudos.find(({ token }) => selector.startsWith(token, index));
        if (!pseudo)
            continue;
        const open = index + pseudo.token.length - 1;
        const close = matchingParenPosition(selector, open);
        if (close === -1 || selector.slice(close + 1).trim()) {
            return { valid: false };
        }
        const base = selector.slice(0, index).trim();
        const argument = selector.slice(open + 1, close).trim();
        const string = parseCssString(argument);
        if (!base ||
            topLevelTokenPositions(base, ",").length > 0 ||
            !string.valid) {
            return { valid: false };
        }
        return {
            valid: true,
            selector: base,
            mode: pseudo.mode,
            text: string.value,
        };
    }
    return undefined;
}
function hasTerminalCssTextPseudo(value) {
    return Boolean(parseTerminalCssText(value));
}
function hasPlaywrightCompatibilitySyntax(value) {
    return (containsUnquotedTextPseudo(value) ||
        topLevelTokenPositions(value, ">>").length > 0);
}
function containsUnquotedTextPseudo(value) {
    const tokens = [":has-text(", ":text-is("];
    let quote;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (tokens.some((token) => value.startsWith(token, index)))
            return true;
    }
    return false;
}
function topLevelTokenPositions(value, token) {
    const positions = [];
    let quote;
    let escaped = false;
    let bracketDepth = 0;
    let parenDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "[")
            bracketDepth += 1;
        else if (character === "]")
            bracketDepth = Math.max(0, bracketDepth - 1);
        else if (character === "(")
            parenDepth += 1;
        else if (character === ")")
            parenDepth = Math.max(0, parenDepth - 1);
        if (bracketDepth === 0 &&
            parenDepth === 0 &&
            value.startsWith(token, index)) {
            positions.push(index);
            index += token.length - 1;
        }
    }
    return positions;
}
function isTopLevelPosition(value, position) {
    let quote;
    let escaped = false;
    let bracketDepth = 0;
    let parenDepth = 0;
    for (let index = 0; index < position; index += 1) {
        const character = value[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        }
        else if (character === "[") {
            bracketDepth += 1;
        }
        else if (character === "]") {
            bracketDepth = Math.max(0, bracketDepth - 1);
        }
        else if (character === "(") {
            parenDepth += 1;
        }
        else if (character === ")") {
            parenDepth = Math.max(0, parenDepth - 1);
        }
    }
    return !quote && bracketDepth === 0 && parenDepth === 0;
}
function matchingParenPosition(value, open) {
    let quote;
    let escaped = false;
    let depth = 0;
    for (let index = open; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === quote)
                quote = undefined;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "(")
            depth += 1;
        if (character === ")" && --depth === 0)
            return index;
    }
    return -1;
}
function parseCssString(value) {
    const quote = value[0];
    if ((quote !== '"' && quote !== "'") || value.length < 2) {
        return { valid: false };
    }
    let decoded = "";
    for (let index = 1; index < value.length; index += 1) {
        const character = value[index];
        if (character === quote) {
            return index === value.length - 1
                ? { valid: true, value: decoded }
                : { valid: false };
        }
        if (character === "\n" || character === "\r" || character === "\f") {
            return { valid: false };
        }
        if (character !== "\\") {
            decoded += character;
            continue;
        }
        index += 1;
        if (index >= value.length)
            return { valid: false };
        if (value[index] === "\r" && value[index + 1] === "\n")
            index += 1;
        if (value[index] === "\n" ||
            value[index] === "\r" ||
            value[index] === "\f") {
            continue;
        }
        const hex = value.slice(index).match(/^[0-9a-fA-F]{1,6}/)?.[0];
        if (!hex) {
            decoded += value[index];
            continue;
        }
        index += hex.length - 1;
        const terminator = value[index + 1];
        if (terminator === "\r") {
            index += value[index + 2] === "\n" ? 2 : 1;
        }
        else if (terminator === "\n" ||
            terminator === "\f" ||
            terminator === "\t" ||
            terminator === " ") {
            index += 1;
        }
        const codePoint = Number.parseInt(hex, 16);
        decoded +=
            codePoint === 0 || codePoint > 0x10ffff
                ? "\uFFFD"
                : String.fromCodePoint(codePoint);
    }
    return { valid: false };
}
function parseLocatorName(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function normalizeText(value) {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
}
function roleNameMatches(actual, expected, mode = "exact") {
    if (mode === "exact")
        return actual === expected;
    return normalizeText(actual)
        .toLowerCase()
        .includes(normalizeText(expected).toLowerCase());
}
function normalizeRole(value) {
    const role = String(value || "").toLowerCase();
    return ({
        listboxoption: "option",
        textfield: "textbox",
    }[role] || role);
}
function boxModelCenter(model = {}) {
    const content = model.content || [];
    if (content.length < 8) {
        // Returning a fake (0,0) here would silently click the viewport corner.
        // Treat a missing/degenerate box model as "element not ready" so callers
        // with retry semantics (waitForElement, ref fallback) can poll.
        throw new ElementResolutionError("Element has no box model (not rendered or zero-sized)", "transient");
    }
    return {
        x: (content[0] + content[2] + content[4] + content[6]) / 4,
        y: (content[1] + content[3] + content[5] + content[7]) / 4,
    };
}
function extractAxString(value) {
    const raw = value?.value;
    if (typeof raw === "string") {
        return raw;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
        return String(raw);
    }
    return "";
}
function send(cdp, method, params = {}, sessionId = undefined) {
    return cdp.sendRaw(method, params, sessionId);
}

/**
 * Remove redundant native snapshot wrappers without changing semantic nodes.
 *
 * Native output uses two-space indentation as its tree encoding. If an older
 * runtime returns another shape, leave it untouched instead of risking a
 * lossy rewrite.
 */
function compactSnapshotContent(content) {
    if (typeof content !== "string" || content.length === 0)
        return content;
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = content.endsWith(newline);
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const rootIndex = lines.findIndex((line) => line.trim() === "root");
    if (rootIndex < 0)
        return content;
    const roots = [];
    const stack = [];
    for (const line of lines.slice(rootIndex)) {
        const indent = line.length - line.trimStart().length;
        if (indent % 2 !== 0)
            return content;
        const node = { text: line.trim(), children: [] };
        while (stack.length && stack.at(-1).indent >= indent)
            stack.pop();
        if (stack.length)
            stack.at(-1).node.children.push(node);
        else
            roots.push(node);
        stack.push({ indent, node });
    }
    const compacted = roots.flatMap(compactSnapshotNode);
    const rendered = [
        ...lines.slice(0, rootIndex),
        ...renderSnapshotTree(compacted),
    ].join(newline);
    return rendered + (trailingNewline ? newline : "");
}
/** Compact textual content and omit native locator status sentinels. */
function compactSnapshotResult(result) {
    if (!result || typeof result !== "object")
        return result;
    if (typeof result.content === "string") {
        result.content = compactSnapshotContent(result.content);
    }
    for (const ref of result.refs || []) {
        if (ref.loc === "unstable" || ref.loc === "ambiguous")
            delete ref.loc;
    }
    return result;
}
function compactSnapshotNode(node) {
    const text = omitUnusableLocatorStatus(node.text);
    const children = node.children.flatMap(compactSnapshotNode);
    if (isEmptySnapshotText(text))
        return [];
    if (text === "container" && children.length === 0)
        return [];
    if (text === "container" && children.length === 1)
        return children;
    return [{ text, children }];
}
function omitUnusableLocatorStatus(text) {
    const metadataIndex = findSnapshotMetadataStart(text);
    if (metadataIndex < 0)
        return text;
    const metadata = text.slice(metadataIndex);
    if (!metadata.endsWith("]"))
        return text;
    const compacted = metadata.replace(/^(\[ref=[^,\]]+),\s*loc=(?:unstable|ambiguous)(?=,|\])/, "$1");
    return compacted === metadata
        ? text
        : `${text.slice(0, metadataIndex)}${compacted}`;
}
/**
 * Read the ref id a snapshot line advertises. Quote-aware, so a `[ref=` that
 * appears inside an accessible name is never mistaken for the line's metadata.
 */
function snapshotLineRefId(line) {
    const metadataIndex = findSnapshotMetadataStart(line);
    if (metadataIndex < 0)
        return undefined;
    const match = line.slice(metadataIndex).match(/^\[ref=([^,\]]+)/);
    return match ? match[1] : undefined;
}
/** Rewrite only ref metadata, never quoted names or locator values. */
function rewriteSnapshotRefIds(content, refIds) {
    return content.replace(/[^\r\n]+/g, (line) => {
        const start = findSnapshotMetadataStart(line);
        if (start < 0)
            return line;
        return (line.slice(0, start) +
            line
                .slice(start)
                .replace(/^\[ref=([^,\]]+)/, (metadata, refId) => refIds.has(refId) ? `[ref=${refIds.get(refId)}` : metadata));
    });
}
function findSnapshotMetadataStart(text) {
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && character === "\\") {
            escaped = true;
            continue;
        }
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted &&
            text.startsWith("[ref=", index) &&
            (index === 0 || /\s/.test(text[index - 1]))) {
            return index;
        }
    }
    return -1;
}
function isEmptySnapshotText(text) {
    if (text === "text")
        return true;
    const match = text.match(/^text\s+("(?:\\.|[^"\\])*")$/);
    if (!match)
        return false;
    try {
        const value = JSON.parse(match[1]);
        return (typeof value === "string" && value.replace(/[\s\p{Cf}]/gu, "") === "");
    }
    catch {
        return false;
    }
}
function renderSnapshotTree(nodes, depth = 0, output = []) {
    for (const node of nodes) {
        output.push(`${"  ".repeat(depth)}${node.text}`);
        renderSnapshotTree(node.children, depth + 1, output);
    }
    return output;
}
/** Omit invalid native stable locators while retaining their short-lived refs. */
async function sanitizeSnapshotLocators(result, validator) {
    if (!Array.isArray(result?.refs))
        return result;
    const invalidLocators = new Map();
    for (const ref of result.refs) {
        const locator = ref?.loc;
        if (typeof locator !== "string" ||
            locator === "unstable" ||
            locator === "ambiguous") {
            continue;
        }
        if (await validator(ref))
            continue;
        delete ref.loc;
        const refId = ref.refId ?? ref.backendNodeId;
        if (refId !== undefined) {
            const refLocators = invalidLocators.get(String(refId)) ?? new Set();
            refLocators.add(locator);
            invalidLocators.set(String(refId), refLocators);
        }
    }
    if (typeof result.content === "string" && invalidLocators.size > 0) {
        result.content = omitSnapshotLocators(result.content, invalidLocators);
    }
    return result;
}
function omitSnapshotLocators(content, invalidLocators) {
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    return content
        .split(/\r?\n/)
        .map((line) => omitSnapshotLineLocator(line, invalidLocators))
        .join(newline);
}
function omitSnapshotLineLocator(text, invalidLocators) {
    const metadataIndex = findSnapshotMetadataStart(text);
    if (metadataIndex < 0)
        return text;
    const metadata = text.slice(metadataIndex);
    if (!metadata.endsWith("]"))
        return text;
    const prefix = metadata.match(/^\[ref=([^,\]]+),\s*loc=/);
    if (!prefix)
        return text;
    const candidates = invalidLocators.get(prefix[1]);
    if (!candidates)
        return text;
    for (const locator of candidates) {
        const locatorEnd = prefix[0].length + locator.length;
        if (metadata.startsWith(locator, prefix[0].length) &&
            (metadata[locatorEnd] === "," || metadata[locatorEnd] === "]")) {
            return `${text.slice(0, metadataIndex)}[ref=${prefix[1]}${metadata.slice(locatorEnd)}`;
        }
    }
    return text;
}
/** Preserve native frame provenance and validate stable locators for the Page API. */
async function preparePageSnapshotResult(services, pageSessionId, iframeSessions, result, rootContext = {}) {
    const adapter = {
        sendRaw: (method, params = {}, sessionId) => services.cdp(method, params, sessionId),
    };
    const refs = result?.refs || [];
    const descendantRefIds = typeof result?.content === "string"
        ? iframeDescendantRefIds(result.content)
        : new Set();
    const validIndexes = await validateLocatorBackendNodes(adapter, pageSessionId, iframeSessions, snapshotLocatorCandidates(refs));
    const validRefs = new Set(refs.filter((_, index) => validIndexes.has(index)));
    await backfillSnapshotFrameIds(adapter, pageSessionId, iframeSessions, result, descendantRefIds);
    for (const ref of refs) {
        const refId = ref.refId ?? ref.backendNodeId;
        if (ref.frameId) {
            ref.frameProvenance = "frame";
        }
        else if (refId !== undefined && descendantRefIds.has(String(refId))) {
            ref.frameProvenance = "unknown";
        }
        else if (rootContext.frameId) {
            ref.frameId = rootContext.frameId;
            ref.frameProvenance = "frame";
        }
        else {
            // A subtree root with frame provenance always carries a frameId, so the
            // remaining cases are a page-owned root or one whose frame is unknown.
            ref.frameProvenance = rootContext.frameProvenance ?? "page";
        }
    }
    return sanitizeSnapshotLocators(result, async (ref) => validRefs.has(ref));
}
async function backfillSnapshotFrameIds(cdp, pageSessionId, iframeSessions, result, descendantRefIds) {
    if (iframeSessions.size === 0 || typeof result.content !== "string")
        return;
    const missing = (result.refs || []).filter((ref) => {
        const refId = ref.refId ?? ref.backendNodeId;
        return (!ref.frameId && refId !== undefined && descendantRefIds.has(String(refId)));
    });
    if (missing.length === 0)
        return;
    const frameIds = [...iframeSessions.keys()];
    // One frame admits no ambiguity to resolve, and the refs that most need a
    // frame here are the ones with no usable locator to validate against.
    if (frameIds.length === 1) {
        for (const ref of missing)
            ref.frameId = frameIds[0];
        return;
    }
    const owners = new Map();
    const candidates = [];
    for (const ref of missing) {
        const base = snapshotLocatorCandidates([ref])[0];
        if (!base)
            continue;
        for (const frameId of frameIds) {
            const index = candidates.length;
            candidates.push({ ...base, index, frameId });
            owners.set(index, { frameId, ref });
        }
    }
    const valid = await validateLocatorBackendNodes(cdp, pageSessionId, iframeSessions, candidates);
    const matches = new Map();
    for (const index of valid) {
        const owner = owners.get(index);
        if (!owner)
            continue;
        const frameMatches = matches.get(owner.ref) ?? new Set();
        frameMatches.add(owner.frameId);
        matches.set(owner.ref, frameMatches);
    }
    for (const [ref, frameMatches] of matches) {
        if (frameMatches.size === 1)
            ref.frameId = [...frameMatches][0];
    }
}
function iframeDescendantRefIds(content) {
    const refs = new Set();
    let iframeIndent;
    let frameRootIndent;
    for (const line of content.split(/\r?\n/)) {
        const text = line.trim();
        if (!text)
            continue;
        const indent = line.length - line.trimStart().length;
        const startsIframe = /^iframe(?:\s|$)/.test(text);
        if (iframeIndent === undefined) {
            if (startsIframe)
                iframeIndent = indent;
            continue;
        }
        if (frameRootIndent === undefined) {
            if (/^root(?:\s|$)/.test(text) && indent >= iframeIndent) {
                frameRootIndent = indent;
            }
            else if (indent <= iframeIndent) {
                iframeIndent = startsIframe ? indent : undefined;
            }
            continue;
        }
        if (indent <= frameRootIndent) {
            iframeIndent = startsIframe ? indent : undefined;
            frameRootIndent = undefined;
            continue;
        }
        const refId = snapshotLineRefId(line);
        if (refId !== undefined)
            refs.add(refId);
    }
    return refs;
}
function snapshotLocatorCandidates(refs) {
    return refs.flatMap((ref, index) => {
        if (!Number.isInteger(ref.backendNodeId) ||
            typeof ref.loc !== "string" ||
            ref.loc.length === 0 ||
            ref.loc === "unstable" ||
            ref.loc === "ambiguous") {
            return [];
        }
        return [
            {
                index,
                locator: ref.loc.startsWith("loc=") ? ref.loc : `loc=${ref.loc}`,
                backendNodeId: ref.backendNodeId,
                ...(ref.frameId ? { frameId: ref.frameId } : {}),
            },
        ];
    });
}

const browserRefMap = new RefMap();
let ensuring = false;
let snapshotImpl = null;
function registerSnapshotForRefRefresh(fn) {
    snapshotImpl = fn;
}
async function ensureRefMapForRef(selectorOrRef) {
    if (ensuring)
        return;
    if (typeof selectorOrRef !== "string")
        return;
    if (!parseRef(selectorOrRef))
        return;
    if (browserRefMap.map.size > 0)
        return;
    if (!snapshotImpl)
        return;
    ensuring = true;
    try {
        await snapshotImpl();
    }
    finally {
        ensuring = false;
    }
}

async function drainEvents() {
    const sessionId = isBrowserRuntime() ? await ensureSession() : undefined;
    return drainBrowserEvents(sessionId);
}
async function snapshot(options = {}) {
    const result = await invokeEgo("snapshot", () => browserEgo().snapshot(options));
    compactSnapshotResult(result);
    browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
    return result;
}
registerSnapshotForRefRefresh(() => snapshot());
const snapshotRaw = snapshot;
/**
 * Return snapshot content with agent-friendly defaults.
 * @param {{scope?: "only_within_viewport"|"full_page"|"subtree", root?: number, includeActionMarks?: boolean, includeStableLocator?: boolean}} [options]
 * @returns {Promise<string>}
 */
async function snapshotText(options = {}) {
    const result = await snapshot({
        scope: options.scope ?? "full_page",
        ...(options.root === undefined ? {} : { root: options.root }),
        includeActionMarks: options.includeActionMarks ?? true,
        includeStableLocator: options.includeStableLocator ?? true,
    });
    return result.content || "";
}
async function elementCenter(selectorOrRef) {
    await ensureRefMapForRef(selectorOrRef);
    return resolveElementCenter({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
}
// Sequence number for default screenshot file names. Combined with the pid it
// keeps concurrent agent processes (parallel task spaces) from overwriting each
// other's shots in the shared tmpdir, and successive shots in one run distinct.
let screenshotSeq = 0;
async function captureScreenshot(path, options = {}) {
    assertScreenshotScale(options.scale);
    const sessionId = isBrowserRuntime() ? await ensureSession() : undefined;
    return captureScreenshotForSession(path, options, sessionId);
}
/**
 * Capture a screenshot through one explicit target session. Page objects use
 * this entry point so another active tab cannot affect evaluation or capture.
 */
async function captureScreenshotForSession(path, options = {}, sessionId) {
    assertScreenshotScale(options.scale);
    const outputPath = path ??
        join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
    const full = options.full ?? false;
    // CSS-pixel sizing is the default and the only declarative scale mode. Keep
    // the legacy raw flag as an internal compatibility escape hatch.
    const scale = options.scale ?? "css";
    const raw = scale === "css" ? false : (options.raw ?? false);
    const params = {
        format: "png",
        captureBeyondViewport: full,
    };
    if (raw) {
        if (options.clip) {
            params.clip = { ...options.clip };
        }
    }
    else {
        if (!pendingDialog(sessionId)) {
            const dprExpression = "window.devicePixelRatio";
            const dpr = Number(runtimeValue(await cdp("Runtime.evaluate", {
                expression: dprExpression,
                returnByValue: true,
            }, sessionId), dprExpression)) || 1;
            const cssScale = 1 / dpr;
            if (options.clip) {
                params.clip = { scale: cssScale, ...options.clip };
            }
            else {
                const infoExpression = "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
                const info = runtimeValue(await cdp("Runtime.evaluate", {
                    expression: infoExpression,
                    returnByValue: true,
                }, sessionId), infoExpression);
                params.clip = {
                    // CDP interprets clip coordinates in the page's document coordinate
                    // space. A viewport screenshot therefore starts at the current scroll
                    // offset, while a full-page screenshot still starts at the document
                    // origin.
                    x: full ? 0 : info.sx,
                    y: full ? 0 : info.sy,
                    width: full ? info.pw : info.w,
                    height: full ? info.ph : info.h,
                    scale: cssScale,
                };
            }
        }
    }
    const result = await cdp("Page.captureScreenshot", params, sessionId);
    await mkdir(dirname(outputPath), { recursive: true });
    await state.writeFile(outputPath, Buffer.from(result.data, "base64"));
    return outputPath;
}
function assertScreenshotScale(scale) {
    if (scale !== undefined && scale !== "css") {
        throw new TypeError("captureScreenshot scale must be css");
    }
}

var observe = /*#__PURE__*/Object.freeze({
    __proto__: null,
    captureScreenshot: captureScreenshot,
    captureScreenshotForSession: captureScreenshotForSession,
    drainEvents: drainEvents,
    elementCenter: elementCenter,
    snapshot: snapshot,
    snapshotRaw: snapshotRaw,
    snapshotText: snapshotText
});

/**
 * Resolve any selector form to a CDP Runtime objectId handle.
 * Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, text=, xpath=, and raw
 * CSS — the same surface as the pointer/observe helpers, via the unified resolver.
 * Refreshes the RefMap on demand when the input is a ref and the map is empty.
 * @param {string} selectorOrRef Selector or ref string.
 * @returns {Promise<{objectId: string, sessionId?: string}>}
 */
async function resolveHandle(selectorOrRef) {
    await ensureRefMapForRef(selectorOrRef);
    return resolveElementObjectId({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
}
/**
 * Release a Runtime objectId handle. Best-effort: swallows "already gone"
 * errors (stale handle, lost session, destroyed context).
 * @param {string} objectId Runtime remote object id to release.
 * @param {string} [sessionId] Session that owns the handle.
 * @returns {Promise<void>}
 */
async function releaseHandle(objectId, sessionId) {
    if (!objectId)
        return;
    try {
        await cdp("Runtime.releaseObject", { objectId }, sessionId);
    }
    catch {
        // Handle/session already invalid; releasing is best-effort.
    }
}
/**
 * Resolve a handle, run fn(handle), then release the handle — even if fn throws.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {(handle: {objectId: string, sessionId?: string}) => Promise<any>} fn Callback bound to the resolved handle.
 * @returns {Promise<any>} Whatever fn returns.
 */
async function withHandle(selectorOrRef, fn) {
    const handle = await resolveHandle(selectorOrRef);
    try {
        return await fn(handle);
    }
    finally {
        await releaseHandle(handle.objectId, handle.sessionId);
    }
}
/**
 * Resolve an element and call a function on it via Runtime.callFunctionOn,
 * with the element bound as `this`. The resolved handle is released afterward;
 * the returned objectId is already freed and must not be reused.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {string} functionDeclaration Function source whose `this` is the element.
 * @param {Array<unknown>} [args=[]] Arguments passed by value.
 * @returns {Promise<{result: any, objectId: string, sessionId?: string}>}
 */
async function resolveAndCall(selectorOrRef, functionDeclaration, args = []) {
    return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
        const result = await cdp("Runtime.callFunctionOn", {
            functionDeclaration,
            objectId,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        return { result, objectId, sessionId };
    });
}

const INPUT_EVENT_DELAY_MS$2 = 25;
const INPUT_DISPATCH_TIMEOUT_MS$1 = 1000;
/**
 * Mouse target accepted by mouse helpers.
 *
 * Forms:
 * - string: CSS selector or @ref, resolves to the element center.
 * - [x, y]: viewport coordinates in CSS pixels.
 * - {x, y}: viewport coordinates in CSS pixels.
 * - {selector}: CSS selector or @ref, resolves to the element center.
 * - {selector, x, y}: element top-left plus x/y offset in CSS pixels.
 *
 * @typedef {string | [number, number] | {x:number,y:number} | {selector:string,x?:number,y?:number}} MouseTarget
 */
/**
 * Click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number, clicks?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function click(target, options = {}) {
    const point = await resolveMouseTarget(target);
    const button = options.button || "left";
    const buttons = pressedButtons$1(button);
    const clickCount = options.clickCount ?? options.clicks ?? 1;
    maybeHighlight(point, options.label);
    const probeId = await installClickProbe(point);
    let dispatchError = null;
    try {
        await dispatchMouse(point, "mouseMoved", {
            button: "none",
            buttons: 0,
        });
        await inputEventDelay$1();
        await dispatchMouse(point, "mousePressed", {
            button,
            buttons,
            clickCount,
        });
        await inputEventDelay$1();
        await dispatchMouse(point, "mouseReleased", {
            button,
            buttons: 0,
            clickCount,
        });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishClickProbe(point, probeId, clickCount);
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Double-click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", label?: string}} [options]
 * @returns {Promise<void>}
 */
async function doubleClick(target, options = {}) {
    await click(target, { ...options, clickCount: 2 });
}
/**
 * Move the mouse over a target without pressing a button.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{label?: string}} [options]
 * @returns {Promise<void>}
 */
async function hover(target, options = {}) {
    const point = await resolveMouseTarget(target);
    maybeHighlight(point, options.label);
    const probeId = await installHoverProbe(point);
    let dispatchError = null;
    try {
        await dispatchMouse(point, "mouseMoved", { buttons: 0 });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishHoverProbe(point, probeId);
    if (dispatchError && !completed)
        throw dispatchError;
}
/**
 * Drag the mouse through a sequence of targets while holding a button.
 * @param {MouseTarget[]} points Ordered drag path. Must contain at least two targets.
 * @param {{button?: "left"|"middle"|"right", delayMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function dragMouse(points, options = {}) {
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error("dragMouse requires at least two points");
    }
    const resolved = [];
    for (const point of points) {
        resolved.push(await resolveMouseTarget(point));
    }
    const button = options.button || "left";
    const buttons = pressedButtons$1(button);
    const first = resolved[0];
    const last = resolved.at(-1);
    maybeHighlight(first, options.label);
    const probeId = await installMouseUpProbe(last);
    let dispatchError = null;
    try {
        await dispatchMouse(first, "mousePressed", {
            button,
            buttons,
            clickCount: 1,
        });
        await inputEventDelay$1();
        for (let i = 1; i < resolved.length; i += 1) {
            const point = resolved[i];
            await dispatchMouse({ ...point, sessionId: point.sessionId ?? first.sessionId }, "mouseMoved", {
                button,
                buttons,
            });
            await inputEventDelay$1(options.delayMs > 0 ? options.delayMs : undefined);
        }
        await dispatchMouse({ ...last, sessionId: last.sessionId ?? first.sessionId }, "mouseReleased", {
            button,
            buttons: 0,
            clickCount: 1,
        });
    }
    catch (error) {
        if (!isInputDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    const completed = await finishDragProbe(resolved, probeId, button);
    if (dispatchError && !completed)
        throw dispatchError;
}
function inputEventDelay$1(ms = INPUT_EVENT_DELAY_MS$2) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function installClickProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `click_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("click", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishClickProbe(point, id, clickCount) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("click", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0, detail: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        if (${JSON.stringify(clickCount)} > 1) {
          target.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
async function installMouseUpProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `drag_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mouseup", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function installHoverProbe(point) {
    if (!canProbeInputFallback$1())
        return null;
    const id = `hover_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mousemove", probe.handler, true);
        document.addEventListener("mouseover", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishHoverProbe(point, id) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mousemove", probe.handler, true);
        document.removeEventListener("mouseover", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
          buttons: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, point.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
async function finishDragProbe(points, id, button) {
    if (!id)
        return false;
    await inputEventDelay$1(50);
    const first = points[0];
    const last = points.at(-1);
    try {
        const result = await cdp("Runtime.evaluate", {
            expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mouseup", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen) return { seen: true, fallback: false };
        const mouseButton = ${JSON.stringify(button === "left" ? 0 : button === "middle" ? 1 : 2)};
        const eventFor = (type, point, buttons) => {
          const target = document.elementFromPoint(point.x, point.y) || document.body;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: mouseButton,
            buttons,
            detail: type === "mousemove" ? 0 : 1,
          }));
        };
        const points = ${JSON.stringify(points.map(({ x, y }) => ({ x, y })))};
        eventFor("mousedown", points[0], 1);
        for (const point of points.slice(1)) eventFor("mousemove", point, 1);
        eventFor("mouseup", points.at(-1), 0);
        return { seen: false, fallback: true };
      })()`,
            returnByValue: true,
            awaitPromise: false,
        }, last.sessionId ?? first.sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
function canProbeInputFallback$1() {
    return Boolean(globalThis.ego?.sendCDPMessage);
}
/**
 * Scroll by dispatching a CDP mouse wheel event.
 * Sign convention follows DOM WheelEvent: positive dy scrolls down, negative dy scrolls up
 * (CDP negates deltas internally when building the Blink wheel event, so the DOM convention
 * applies end to end). Defaults to scrolling down by 300 CSS pixels, matching the downward
 * defaults of scrollBy and scrollToBottomUntil.
 * @param {number|{x?:number,y?:number,dx?:number,dy?:number}} [x=0] Viewport x, or scroll options.
 * @param {number|{dx?: number, dy?: number}} [y=0] Viewport y, or scroll delta options.
 * @param {{dx?: number, dy?: number}} [options] Deltas in CSS pixels; positive dy scrolls down.
 * @returns {Promise<void>}
 */
async function scroll(x = 0, y = 0, options = {}) {
    if (x && typeof x === "object" && !Array.isArray(x)) {
        options = x;
        y = options.y ?? 0;
        x = options.x ?? 0;
    }
    else if (y && typeof y === "object" && !Array.isArray(y)) {
        options = y;
        y = 0;
    }
    const params = {
        type: "mouseWheel",
        x: Number(x) || 0,
        y: Number(y) || 0,
        deltaX: options.dx ?? 0,
        deltaY: options.dy ?? 300,
    };
    try {
        // Chromium may acknowledge wheel input only after the compositor has
        // processed it. Use the normal CDP deadline; retrying a timed-out wheel is
        // unsafe because the original event may still be applied later.
        await browserCdp("Input.dispatchMouseEvent", params);
    }
    catch (error) {
        // Degrade to DOM scrolling only when the target genuinely cannot dispatch
        // wheel events. Everything else (timeouts, "user is controlling", session
        // loss) propagates — window.scrollBy is NOT equivalent to a real wheel
        // event (virtualized lists and inner scroll panes ignore window scrolling),
        // so a silent fallback would hide the failure behind a different behavior.
        if (!isWheelDispatchUnsupported(error)) {
            throw error;
        }
        if (!hasWarnedAboutWheelFallback) {
            hasWarnedAboutWheelFallback = true;
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[ego-browser] scroll(): wheel dispatch unsupported on this target (${message}); ` +
                `falling back to DOM scrollBy(). Wheel-only behaviors (virtualized lists, inner scroll panes) may not trigger.\n`);
        }
        return scrollBy({ dx: params.deltaX, dy: params.deltaY });
    }
}
let hasWarnedAboutWheelFallback = false;
function isWheelDispatchUnsupported(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /not (?:supported|implemented)|wasn't found|isn't found|unknown (?:method|command)|method not found/i.test(message);
}
/**
 * Scroll the window with DOM APIs. Positive dy scrolls down, negative dy scrolls up
 * (same sign convention as scroll()).
 * @param {number|{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [amount=900] Vertical pixels (positive scrolls down), or scroll options.
 * @param {{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [options]
 * @returns {Promise<{x:number,y:number}>} New window scroll position.
 */
async function scrollBy(amount = 900, options = {}) {
    const params = scrollByParams(amount, options);
    return js(`(() => {
    window.scrollBy({
      left: ${JSON.stringify(params.left)},
      top: ${JSON.stringify(params.top)},
      behavior: ${JSON.stringify(params.behavior)}
    });
    return { x: window.scrollX, y: window.scrollY };
  })()`);
}
/**
 * Scroll downward until a condition is met, the page bottom is reached, or scrolling stalls.
 * @param {Function|string|null} [condition] Function receiving scroll state, or browser JS expression string.
 * @param {{step?:number,dy?:number,maxSteps?:number,wait?:number,waitSeconds?:number,stallLimit?:number}} [options]
 * @returns {Promise<{done:boolean,reason:string,steps:number,state:object}>}
 */
async function scrollToBottomUntil(condition = null, options = {}) {
    const step = numberValue(options.step ?? options.dy ?? 900);
    const maxSteps = Math.max(0, Math.floor(numberValue(options.maxSteps ?? 30)));
    const stallLimit = Math.max(1, Math.floor(numberValue(options.stallLimit ?? 2)));
    const waitSeconds = numberValue(options.waitSeconds ?? options.wait ?? 0.5);
    let previousY = -1;
    let stalls = 0;
    let state = await scrollState();
    for (let steps = 0; steps <= maxSteps; steps += 1) {
        if (await conditionMet(condition, state)) {
            return { done: true, reason: "condition", steps, state };
        }
        if (state.atBottom) {
            return { done: false, reason: "bottom", steps, state };
        }
        if (steps === maxSteps) {
            return { done: false, reason: "maxSteps", steps, state };
        }
        await scrollBy(step);
        if (waitSeconds > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
        }
        state = await scrollState();
        stalls = state.y === previousY ? stalls + 1 : 0;
        previousY = state.y;
        if (stalls >= stallLimit) {
            return { done: false, reason: "stalled", steps: steps + 1, state };
        }
    }
    return { done: false, reason: "maxSteps", steps: maxSteps, state };
}
function maybeHighlight(point, label) {
    const ego = globalThis.ego;
    if (!ego)
        return;
    ego.animationHighlightMouseToPosition?.(point.x, point.y);
    if (label) {
        ego.setAgentTaskState?.(label);
    }
}
async function dispatchMouse(point, type, options = {}) {
    await browserCdp("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        ...options,
    }, point.sessionId, INPUT_DISPATCH_TIMEOUT_MS$1);
}
function isInputDispatchTimeout(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /CDP request timed out: Input\.dispatchMouseEvent/.test(message);
}
async function resolveMouseTarget(target) {
    if (typeof target === "string") {
        return elementCenter(target);
    }
    if (Array.isArray(target)) {
        return pointFrom(target);
    }
    if (target && typeof target === "object") {
        if ("selector" in target &&
            typeof target.selector === "string" &&
            target.selector) {
            if (target.x === undefined && target.y === undefined) {
                return elementCenter(target.selector);
            }
            const [topLeft, center] = await Promise.all([
                elementTopLeft(target.selector),
                elementCenter(target.selector),
            ]);
            return {
                x: topLeft.x + numberValue(target.x),
                y: topLeft.y + numberValue(target.y),
                sessionId: center.sessionId,
            };
        }
        if (target.x !== undefined || target.y !== undefined) {
            return pointFrom(target);
        }
    }
    throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
}
async function elementTopLeft(selectorOrRef) {
    const { result } = await resolveAndCall(selectorOrRef, "function(){const rect=this.getBoundingClientRect();return {x:rect.left,y:rect.top};}");
    const value = result.result?.value;
    if (typeof value?.x !== "number" || typeof value?.y !== "number") {
        throw new Error(`element top-left unavailable: ${selectorOrRef}`);
    }
    return { x: value.x, y: value.y };
}
function pointFrom(point) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
        throw new Error(`invalid mouse target: ${JSON.stringify(point)}`);
    }
    return { x: Number(x), y: Number(y), sessionId: undefined };
}
function numberValue(value) {
    const out = value === undefined ? 0 : Number(value);
    if (!Number.isFinite(out)) {
        throw new Error(`invalid mouse offset: ${JSON.stringify(value)}`);
    }
    return out;
}
function scrollByParams(amount, options) {
    const input = amount && typeof amount === "object" && !Array.isArray(amount)
        ? amount
        : options;
    const top = amount && typeof amount === "object" && !Array.isArray(amount)
        ? (input.top ?? input.dy ?? 900)
        : (input.top ?? input.dy ?? amount);
    return {
        left: numberValue(input.left ?? input.dx ?? 0),
        top: numberValue(top),
        behavior: input.behavior === "smooth" ? "smooth" : "instant",
    };
}
async function scrollState() {
    return js(`(() => {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.max(
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      body?.offsetHeight || 0
    );
    const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    return {
      x: window.scrollX || window.pageXOffset || 0,
      y,
      viewportHeight,
      scrollHeight: height,
      atBottom: y + viewportHeight >= height - 2
    };
  })()`);
}
async function conditionMet(condition, state) {
    if (!condition) {
        return false;
    }
    if (typeof condition === "function") {
        return Boolean(await condition(state));
    }
    if (typeof condition === "string") {
        return Boolean(await js(`Boolean(${condition})`));
    }
    throw new TypeError(`scrollToBottomUntil condition must be a function or string, got ${typeof condition}`);
}
function pressedButtons$1(button) {
    if (button === "left") {
        return 1;
    }
    if (button === "right") {
        return 2;
    }
    if (button === "middle") {
        return 4;
    }
    throw new Error(`unsupported mouse button: ${button}`);
}

var pointer = /*#__PURE__*/Object.freeze({
    __proto__: null,
    click: click,
    doubleClick: doubleClick,
    dragMouse: dragMouse,
    hover: hover,
    scroll: scroll,
    scrollBy: scrollBy,
    scrollToBottomUntil: scrollToBottomUntil
});

async function waitForDocumentLoad(options = {}) {
    const timeout = options.timeout ?? 15.0;
    const deadline = state.now() + timeout * 1000;
    while (state.now() < deadline) {
        let committed = true;
        try {
            const tree = await cdp("Page.getFrameTree");
            const url = tree.frameTree?.frame?.url || "";
            committed = url !== "" && url !== ":" && url !== "about:blank";
        }
        catch {
            // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
        }
        if (committed && (await js("document.readyState")) === "complete") {
            return true;
        }
        await state.sleep(300);
    }
    return false;
}

/**
 * Sleep for a fixed number of seconds.
 * @param {number} [seconds=1.0] Seconds to wait.
 * @returns {Promise<void>}
 */
async function wait(seconds = 1.0) {
    await state.sleep(seconds * 1000);
}
/**
 * Wait until document.readyState is complete.
 * @param {{timeout?: number}} [options]
 * @returns {Promise<boolean>} True when loaded before timeout.
 */
async function waitForLoad(options = {}) {
    return waitForDocumentLoad(options);
}
/**
 * Wait until an element exists, optionally requiring visibility.
 * @param {string} selector CSS selector / @ref / loc= / xpath= to poll.
 * @param {{timeout?: number, visible?: boolean}} [options]
 * @returns {Promise<boolean>} True when found before timeout.
 */
async function waitForElement(selector, options = {}) {
    const timeout = options.timeout ?? 10.0;
    const visible = options.visible ?? false;
    const deadline = state.now() + timeout * 1000;
    const visibilityFn = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
    while (state.now() < deadline) {
        let handle;
        try {
            handle = await resolveHandle(selector);
        }
        catch (err) {
            if (err instanceof ElementResolutionError && err.kind === "transient") {
                await state.sleep(300);
                continue; // not found / not ready yet — keep polling.
            }
            throw err; // permanent (bad selector / ambiguous) or unknown error — fail loud.
        }
        try {
            if (!visible)
                return true;
            const response = await cdp("Runtime.callFunctionOn", {
                functionDeclaration: visibilityFn,
                objectId: handle.objectId,
                returnByValue: true,
                awaitPromise: false,
            }, handle.sessionId);
            if (response.result?.value)
                return true;
        }
        catch {
            // visibility check failed (element raced away); treat as not-ready, keep polling.
        }
        finally {
            await releaseHandle(handle.objectId, handle.sessionId);
        }
        await state.sleep(300);
    }
    return false;
}
/**
 * Wait until network events are idle.
 * In the browser runtime this reads the continuous, Page-scoped tracker without
 * consuming public events. Compatibility adapters retain the legacy temporary
 * Network-domain observation and best-effort fallback.
 * @param {{timeout?: number, idleMs?: number}} [options]
 * @returns {Promise<boolean>} True when idle before timeout.
 */
async function waitForNetworkIdle$1(options = {}) {
    const timeout = options.timeout ?? 10.0;
    const idleMs = options.idleMs ?? 500;
    const deadline = state.now() + timeout * 1000;
    if (isBrowserRuntime()) {
        return waitForBrowserNetworkIdle(deadline, idleMs);
    }
    return waitForLegacyNetworkIdle(deadline, idleMs);
}
async function waitForBrowserNetworkIdle(deadline, idleMs) {
    const sessionId = await ensureSession(undefined, Math.max(1, deadline - state.now()));
    let hasTracked = false;
    while (state.now() < deadline) {
        try {
            const sessionIds = await pageNetworkSessions(sessionId, Math.max(1, deadline - state.now()));
            await ensureNetworkTracking(sessionIds, Math.max(1, deadline - state.now()));
            const activity = networkActivity(sessionIds);
            hasTracked ||= activity.tracking;
            if (activity.tracking &&
                activity.inflight === 0 &&
                state.now() - activity.lastActivityAt >= idleMs) {
                return true;
            }
        }
        catch (error) {
            if (!hasTracked && isUnsupportedNetworkTrackingError(error)) {
                return waitForPassiveIdle(deadline, idleMs);
            }
            if (!isRetryableNetworkRefreshError$1(error))
                throw error;
            // A frame can detach while its sessions are refreshed. Once real
            // tracking has started, retry instead of converting uncertainty to idle.
        }
        const remaining = deadline - state.now();
        if (remaining <= 0)
            break;
        await state.sleep(Math.min(100, remaining));
    }
    return false;
}
function isUnsupportedNetworkTrackingError(error) {
    return /Network\.enable.*(?:not found|wasn't found|unsupported|unknown method)/i.test(error instanceof Error ? error.message : String(error));
}
function isRetryableNetworkRefreshError$1(error) {
    if (isCdpRequestTimeoutError(error) || isSessionLostError(error))
        return true;
    return /detached Page session/i.test(error instanceof Error ? error.message : String(error));
}
async function waitForPassiveIdle(deadline, idleMs) {
    const remaining = deadline - state.now();
    if (remaining < idleMs)
        return false;
    await state.sleep(idleMs);
    return true;
}
async function waitForLegacyNetworkIdle(deadline, idleMs) {
    let lastActivity = state.now();
    const inflight = new Set();
    const ownsNetworkDomain = !state.networkDomainEnabled;
    await cdp("Network.enable").catch(() => {
        // Domain may be unsupported by the bridge; fall back to passive observation.
    });
    try {
        while (state.now() < deadline) {
            const events = await drainEvents();
            for (const event of events) {
                const method = event.method || "";
                const params = event.params || {};
                if (method === "Network.requestWillBeSent") {
                    inflight.add(params.requestId);
                    lastActivity = state.now();
                }
                else if (method === "Network.loadingFinished" ||
                    method === "Network.loadingFailed") {
                    inflight.delete(params.requestId);
                    lastActivity = state.now();
                }
                else if (method.startsWith("Network.")) {
                    lastActivity = state.now();
                }
            }
            if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
                return true;
            }
            await state.sleep(100);
        }
        return false;
    }
    finally {
        if (ownsNetworkDomain) {
            await cdp("Network.disable").catch(() => {
                // Best-effort cleanup; keeps the event buffer from accumulating after the wait.
            });
        }
    }
}

var waits = /*#__PURE__*/Object.freeze({
    __proto__: null,
    wait: wait,
    waitForElement: waitForElement,
    waitForLoad: waitForLoad,
    waitForNetworkIdle: waitForNetworkIdle$1
});

const KEYS = {
    Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
    Tab: { vk: 9, key: "Tab", code: "Tab", text: "\t" },
    Backspace: { vk: 8, key: "Backspace", code: "Backspace", text: "" },
    Escape: { vk: 27, key: "Escape", code: "Escape", text: "" },
    Delete: { vk: 46, key: "Delete", code: "Delete", text: "" },
    " ": { vk: 32, key: " ", code: "Space", text: " " },
    ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft", text: "" },
    ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp", text: "" },
    ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight", text: "" },
    ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown", text: "" },
    Home: { vk: 36, key: "Home", code: "Home", text: "" },
    End: { vk: 35, key: "End", code: "End", text: "" },
    PageUp: { vk: 33, key: "PageUp", code: "PageUp", text: "" },
    PageDown: { vk: 34, key: "PageDown", code: "PageDown", text: "" },
};
const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/;
const ALT_MODIFIER = 1;
const CTRL_MODIFIER = 2;
const META_MODIFIER = 4;
const SHIFT_MODIFIER = 8;
const NON_TEXT_MODIFIERS = ALT_MODIFIER | CTRL_MODIFIER | META_MODIFIER;
const INPUT_EVENT_DELAY_MS$1 = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1000;
const MODIFIER_KEYS = [
    {
        bit: ALT_MODIFIER,
        key: "Alt",
        code: "AltLeft",
        windowsVirtualKeyCode: 18,
        location: 1,
    },
    {
        bit: CTRL_MODIFIER,
        key: "Control",
        code: "ControlLeft",
        windowsVirtualKeyCode: 17,
        location: 1,
    },
    {
        bit: META_MODIFIER,
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        location: 1,
    },
    {
        bit: SHIFT_MODIFIER,
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        location: 1,
    },
];
const NATIVE_ONLY_EDITING_COMMANDS = new Set([
    "copy",
    "cut",
    "paste",
    "redo",
    "undo",
]);
const defaultKeyboardServices = {
    async cdp(method, params = {}, sessionId, timeoutMs) {
        // Keep the legacy cdp() override path for calls without a custom timeout.
        // Timed input dispatches use browserCdp() so a stalled native request can
        // still fall back to the synthetic event probe.
        if (timeoutMs === undefined) {
            return cdp(method, params, sessionId);
        }
        const response = await browserCdp(method, params, sessionId, timeoutMs);
        return response?.result || {};
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    get platform() {
        return state.platform;
    },
};
function keyDefinition(key) {
    const special = KEYS[key];
    if (special) {
        return special;
    }
    if (key.length !== 1) {
        return { vk: 0, key, code: key, text: "" };
    }
    const vk = key.toUpperCase().codePointAt(0);
    const code = PRINTABLE_CODE_RE.test(key)
        ? `${/[0-9]/.test(key) ? "Digit" : "Key"}${key.toUpperCase()}`
        : key;
    return { vk, key, code, text: key };
}
function editingCommandsForKey(key, modifiers, platform) {
    const code = keyDefinition(key).code;
    if (modifiers === 0 && key === "Backspace") {
        return ["deleteBackward"];
    }
    if (modifiers === 0 && key === "Delete") {
        return ["deleteForward"];
    }
    // Chromium does not infer macOS editing commands merely from the Meta bit.
    // These command names match Chromium's editor command registry and the
    // corresponding Playwright mappings.
    if (platform === "darwin") {
        if (modifiers === META_MODIFIER) {
            const command = {
                KeyA: "selectAll",
                KeyC: "copy",
                KeyV: "paste",
                KeyX: "cut",
                KeyZ: "undo",
            }[code];
            return command ? [command] : undefined;
        }
        if (modifiers === (SHIFT_MODIFIER | META_MODIFIER) && code === "KeyZ") {
            return ["redo"];
        }
        return undefined;
    }
    // Preserve select-all for the legacy numeric modifier API off macOS.
    if (modifiers === CTRL_MODIFIER && code === "KeyA") {
        return ["selectAll"];
    }
    return undefined;
}
/**
 * Dispatch a key press through CDP.
 * @param {string} key Key name such as Enter, Tab, ArrowLeft, or a single printable character.
 * @param {number} [modifiers=0] CDP modifier bitfield: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
 * @returns {Promise<void>}
 */
async function pressKey(key, modifiers = 0) {
    return pressKeyInPage(defaultKeyboardServices, undefined, key, modifiers);
}
/** Dispatch one key press through an explicit Page session. */
async function pressKeyInPage(services, sessionId, key, modifiers = 0) {
    const { vk, code, text } = keyDefinition(key);
    const platform = services.platform ?? state.platform;
    const commands = editingCommandsForKey(key, modifiers, platform);
    const emittedText = modifiers & NON_TEXT_MODIFIERS ? "" : text;
    const base = {
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
    };
    const probeId = await installKeyProbe(services, sessionId, key, expectedEditingEvent(commands));
    let dispatchError = null;
    let activeModifiers = 0;
    const pressedModifiers = MODIFIER_KEYS.filter((modifier) => Boolean(modifiers & modifier.bit));
    let finalKeyDownAttempted = false;
    try {
        for (const modifier of pressedModifiers) {
            activeModifiers |= modifier.bit;
            await dispatchKeyEvent(services, sessionId, {
                type: "rawKeyDown",
                key: modifier.key,
                code: modifier.code,
                modifiers: activeModifiers,
                windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
                location: modifier.location,
            });
        }
        finalKeyDownAttempted = true;
        await dispatchKeyEvent(services, sessionId, {
            type: emittedText ? "keyDown" : "rawKeyDown",
            ...base,
            ...(emittedText
                ? { text: emittedText, unmodifiedText: emittedText }
                : {}),
            ...(commands ? { commands } : {}),
        });
        await inputEventDelay(services);
        await dispatchKeyEvent(services, sessionId, { type: "keyUp", ...base });
        finalKeyDownAttempted = false;
    }
    catch (error) {
        if (!isKeyDispatchTimeout(error))
            throw error;
        dispatchError = error;
    }
    finally {
        // A timed-out send may still have reached Chromium. Release everything we
        // attempted to press so the page cannot inherit a stuck modifier state.
        if (finalKeyDownAttempted) {
            try {
                await dispatchKeyEvent(services, sessionId, { type: "keyUp", ...base });
            }
            catch (error) {
                dispatchError ||= error;
            }
        }
        for (const modifier of [...pressedModifiers].reverse()) {
            activeModifiers &= ~modifier.bit;
            try {
                await dispatchKeyEvent(services, sessionId, {
                    type: "keyUp",
                    key: modifier.key,
                    code: modifier.code,
                    modifiers: activeModifiers,
                    windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
                    location: modifier.location,
                });
            }
            catch (error) {
                dispatchError ||= error;
            }
        }
    }
    const requiresNativeEditing = Boolean(commands?.some((command) => NATIVE_ONLY_EDITING_COMMANDS.has(command)));
    const completed = await finishKeyProbe(services, sessionId, probeId, {
        key,
        code,
        text: emittedText,
        commands,
        modifiers,
        allowSyntheticFallback: !requiresNativeEditing,
    });
    if (requiresNativeEditing && probeId && !completed) {
        if (dispatchError)
            throw dispatchError;
        throw new Error(`page.keyboard.press could not deliver native editing shortcut ${formatShortcut(key, modifiers)}`);
    }
    if (dispatchError && !completed)
        throw dispatchError;
}
function expectedEditingEvent(commands) {
    if (commands?.includes("paste"))
        return "paste";
    if (commands?.includes("copy"))
        return "copy";
    if (commands?.includes("cut"))
        return "cut";
    return "keydown";
}
function formatShortcut(key, modifiers) {
    const names = MODIFIER_KEYS.filter((modifier) => modifiers & modifier.bit).map((modifier) => modifier.key);
    return [...names, key].join("+");
}
/**
 * Insert text at the focused input using CDP Input.insertText.
 * @param {string} text Text to insert.
 * @returns {Promise<void>}
 */
async function typeText(text) {
    await typeTextInPage(defaultKeyboardServices, undefined, text);
}
/** Insert text through an explicit Page session. */
async function typeTextInPage(services, sessionId, text) {
    if (typeof text !== "string") {
        throw new TypeError("page.keyboard.type text must be a string");
    }
    await services.cdp("Input.insertText", { text }, sessionId);
}
/**
 * Focus an input, optionally clear it, type text, and fire input/change events.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input-like element.
 * @param {string} text Text to write.
 * @param {{clearFirst?: boolean, timeout?: number}} [options]
 * @returns {Promise<void>}
 */
async function fillInput(selector, text, options = {}) {
    const clearFirst = options.clearFirst ?? true;
    const timeout = options.timeout ?? 0;
    if (timeout > 0 && !(await waitForElement(selector, { timeout }))) {
        throw new Error(`fillInput: element not found: ${JSON.stringify(selector)}`);
    }
    await withHandle(selector, async ({ objectId, sessionId }) => {
        const focusSource = clearFirst
            ? "function(){this.focus(); if(typeof this.select==='function') this.select();}"
            : "function(){this.focus();}";
        await cdp("Runtime.callFunctionOn", {
            functionDeclaration: focusSource,
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        if (clearFirst) {
            await cdp("Runtime.callFunctionOn", {
                functionDeclaration: "function(){this.value=''; this.dispatchEvent(new Event('input',{bubbles:true}));}",
                objectId,
                returnByValue: true,
                awaitPromise: false,
            }, sessionId);
        }
        await cdp("Input.insertText", { text }, sessionId);
        await cdp("Runtime.callFunctionOn", {
            functionDeclaration: "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
    });
}
/**
 * Focus an element and dispatch a DOM KeyboardEvent in page JavaScript.
 * Note: dispatched event has isTrusted=false; some frameworks ignore it (see docs/issues/dispatchKey-synthetic-keyboard-event.md).
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the target element.
 * @param {string} [key="Enter"] Event key.
 * @param {"keydown"|"keypress"|"keyup"|string} [event="keypress"] Event type.
 * @returns {Promise<void>}
 */
async function dispatchKey$1(selector, key = "Enter", event = "keypress") {
    const { vk, code } = keyDefinition(key);
    await resolveAndCall(selector, "function(keyCode, key, code, event){this.focus(); this.dispatchEvent(new KeyboardEvent(event,{key,code,keyCode,which:keyCode,bubbles:true}));}", [vk, key, code, event]);
}
function inputEventDelay(services) {
    return services.sleep(INPUT_EVENT_DELAY_MS$1);
}
async function dispatchKeyEvent(services, sessionId, params) {
    await services.cdp("Input.dispatchKeyEvent", params, sessionId, INPUT_DISPATCH_TIMEOUT_MS);
}
async function installKeyProbe(services, sessionId, key, eventType = "keydown") {
    if (!canProbeInputFallback())
        return null;
    const id = `key_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
        const result = await services.cdp("Runtime.evaluate", {
            expression: `(() => {
      window.__egoBrowserInputProbes ||= {};
      const probe = { seen: false, eventType: ${JSON.stringify(eventType)} };
      probe.handler = (event) => {
        if (
          event.isTrusted &&
          (probe.eventType !== "keydown" || event.key === ${JSON.stringify(key)})
        ) probe.seen = true;
      };
      document.addEventListener(probe.eventType, probe.handler, true);
      window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
      return true;
    })()`,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        return result.result?.value ? id : null;
    }
    catch {
        return null;
    }
}
async function finishKeyProbe(services, sessionId, id, definition) {
    if (!id)
        return false;
    await inputEventDelay(services);
    try {
        const result = await services.cdp("Runtime.evaluate", {
            expression: `(() => {
      const probes = window.__egoBrowserInputProbes || {};
      const probe = probes[${JSON.stringify(id)}];
      if (!probe) return { seen: false, fallback: false };
      document.removeEventListener(probe.eventType, probe.handler, true);
      delete probes[${JSON.stringify(id)}];
      if (probe.seen) return { seen: true, fallback: false };

      if (!${JSON.stringify(definition.allowSyntheticFallback)}) {
        return { seen: false, fallback: false };
      }

      const target = document.activeElement || document.body;
      const key = ${JSON.stringify(definition.key)};
      const code = ${JSON.stringify(definition.code)};
      const text = ${JSON.stringify(definition.text)};
      const commands = ${JSON.stringify(definition.commands || [])};
      const modifiers = ${JSON.stringify(definition.modifiers)};
      const keyboardInit = {
        key,
        code,
        altKey: Boolean(modifiers & ${ALT_MODIFIER}),
        ctrlKey: Boolean(modifiers & ${CTRL_MODIFIER}),
        metaKey: Boolean(modifiers & ${META_MODIFIER}),
        shiftKey: Boolean(modifiers & ${SHIFT_MODIFIER}),
        bubbles: true,
        cancelable: true,
        keyCode: ${JSON.stringify(keyDefinition(definition.key).vk)},
        which: ${JSON.stringify(keyDefinition(definition.key).vk)},
      };
      target.dispatchEvent(new KeyboardEvent("keydown", keyboardInit));

      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isEditable) {
        if (commands.includes("selectAll") && typeof target.select === "function") {
          target.select();
        } else if (commands.includes("deleteBackward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const from = start === end ? Math.max(0, start - 1) : start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentBackward",
          }));
          target.value = before.slice(0, from) + before.slice(end);
          target.setSelectionRange(from, from);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }));
        } else if (commands.includes("deleteForward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const to = start === end ? Math.min(target.value.length, end + 1) : end;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentForward",
          }));
          target.value = before.slice(0, start) + before.slice(to);
          target.setSelectionRange(start, start);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentForward",
          }));
        } else if (text) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }));
          target.value = before.slice(0, start) + text + before.slice(end);
          const next = start + text.length;
          target.setSelectionRange(next, next);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }));
        }
      }

      target.dispatchEvent(new KeyboardEvent("keyup", keyboardInit));
      return { seen: false, fallback: true };
    })()`,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        const value = result.result?.value;
        return Boolean(value?.seen || value?.fallback);
    }
    catch {
        return false;
    }
}
function canProbeInputFallback() {
    return Boolean(globalThis.ego?.sendCDPMessage);
}
function isKeyDispatchTimeout(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /CDP request timed out: Input\.dispatchKeyEvent/.test(message);
}

var keyboard = /*#__PURE__*/Object.freeze({
    __proto__: null,
    dispatchKey: dispatchKey$1,
    fillInput: fillInput,
    keyDefinition: keyDefinition,
    pressKey: pressKey,
    pressKeyInPage: pressKeyInPage,
    typeText: typeText,
    typeTextInPage: typeTextInPage
});

const INTERNAL_URL_PREFIXES = [
    "chrome://",
    "chrome-untrusted://",
    "devtools://",
    "chrome-extension://",
    "about:",
];
/**
 * Navigate the current tab to a URL using CDP Page.navigate.
 * @param {string} url Absolute or browser-supported URL to load.
 * @returns {Promise<object>} CDP Page.navigate result.
 */
async function gotoUrl(url) {
    return cdp("Page.navigate", { url });
}
/**
 * Navigate the current tab and wait for load/settle in one call.
 * @param {string} url Absolute or browser-supported URL to load.
 * @param {{timeout?: number, settle?: number, wait?: boolean}} [options]
 * @returns {Promise<{navigation: object, loaded: boolean}>}
 */
async function gotoAndWait(url, options = {}) {
    const navigation = await gotoUrl(url);
    const loaded = options.wait === false
        ? false
        : await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
        await state.sleep(settle * 1000);
    }
    return { navigation, loaded };
}
/**
 * Read basic state for the current page.
 * @returns {Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number}|{dialog:object}>}
 */
async function pageInfo() {
    if (isBrowserRuntime()) {
        const sessionId = await ensureSession();
        const dialog = pendingDialog(sessionId);
        if (dialog) {
            return { dialog };
        }
    }
    const expression = "JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
    return JSON.parse(await js(expression));
}
/**
 * List open page targets known to the browser.
 * @param {{includeChrome?: boolean}} [options]
 * @returns {Promise<Array<{targetId:string,title:string,url:string}>>}
 */
async function listTabs(options = {}) {
    const includeChrome = options.includeChrome ?? true;
    const result = await invokeEgo("listTabs", () => browserEgo().listTabs());
    const tabs = result.tabs || [];
    return tabs
        .filter((tab) => includeChrome ||
        !INTERNAL_URL_PREFIXES.some((prefix) => (tab.url || "").startsWith(prefix)))
        .map((tab) => ({
        targetId: tab.targetId,
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active),
        index: tab.index,
    }));
}
/**
 * Return the currently attached tab.
 * @returns {Promise<{targetId:string,url:string,title:string}>}
 */
async function currentTab() {
    const tabs = await listTabs();
    const active = tabs.find((tab) => tab.active) || tabs[0];
    if (!active) {
        throw new Error("no active browser tab");
    }
    return { targetId: active.targetId, url: active.url, title: active.title };
}
/**
 * Activate an existing tab target.
 * @param {string|{targetId:string}} target Target id or tab-like object.
 * @returns {Promise<string>} Target id.
 */
async function switchTab(target) {
    const targetId = typeof target === "object" ? target.targetId : target;
    await cdp("Target.activateTarget", { targetId });
    setPreferredTarget(targetId);
    return targetId;
}
/**
 * Open a new tab and optionally navigate it.
 * @param {string} [url="about:blank"] URL to open.
 * @returns {Promise<string>} New target id.
 */
async function newTab(url = "about:blank") {
    const result = await invokeEgo("newTab", () => browserEgo().createTab(url));
    if (!result.targetId) {
        throw new Error("newTab returned no targetId");
    }
    // Native createTab activates the new tab. Keep the harness route in sync so
    // the next target-less helper cannot remain attached to the previous Page.
    setPreferredTarget(result.targetId);
    return result.targetId;
}
/**
 * Reuse an existing matching tab or open a new one.
 * @param {string} url URL to find or open.
 * @param {{match?: "exact"|"origin"|"origin+path"|"includes", wait?: boolean, timeout?: number, settle?: number}} [options]
 * @returns {Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean}>}
 */
async function openOrReuseTab(url, options = {}) {
    const tabs = await listTabs({ includeChrome: false });
    const match = options.match || "exact";
    const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
    if (existing) {
        await switchTab(existing.targetId);
        if (options.wait) {
            await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
        }
        const settle = Number(options.settle ?? 0);
        if (settle > 0) {
            await state.sleep(settle * 1000);
        }
        return { ...existing, active: true, reused: true };
    }
    const targetId = await newTab(url);
    if (options.wait !== false) {
        await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
    }
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
        await state.sleep(settle * 1000);
    }
    return { targetId, url, title: "", active: true, reused: false };
}
/**
 * Close a browser tab by target id, tab object, or the current tab when omitted.
 * @param {string|{targetId:string}} [target] Target id or tab-like object. Defaults to the current tab.
 * @returns {Promise<string>} Closed target id.
 */
async function closeTab(target = undefined) {
    const targetId = target === undefined
        ? (await currentTab()).targetId
        : typeof target === "object"
            ? target.targetId
            : target;
    if (!targetId) {
        throw new Error("closeTab requires a targetId");
    }
    await cdp("Target.closeTarget", { targetId });
    invalidateSession(targetId);
    if (state.preferredTargetId === targetId) {
        clearPreferredTarget();
    }
    return targetId;
}
/**
 * Ensure the active harness session points at a real, non-internal page tab.
 * @returns {Promise<{targetId:string,title:string,url:string}|null>}
 */
async function ensureRealTab() {
    const tabs = await listTabs({ includeChrome: false });
    if (tabs.length === 0) {
        return null;
    }
    const current = await currentTab().catch(() => null);
    if (current?.url &&
        !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
        return current;
    }
    await switchTab(tabs[0].targetId);
    return tabs[0];
}
/**
 * Find an iframe target whose URL contains a substring.
 * @param {string} urlSubstring URL substring to match.
 * @returns {Promise<string|null>} Matching iframe target id, if any.
 */
async function iframeTarget(urlSubstring) {
    const targets = (await cdp("Target.getTargets")).targetInfos || [];
    return (targets.find((target) => target.type === "iframe" && (target.url || "").includes(urlSubstring))?.targetId || null);
}
function tabMatchesUrl(tabUrl, wantedUrl, match) {
    if (!tabUrl) {
        return false;
    }
    if (match === "includes") {
        return tabUrl.includes(wantedUrl);
    }
    let tab;
    let wanted;
    try {
        tab = new URL(tabUrl);
        wanted = new URL(wantedUrl);
    }
    catch {
        return tabUrl === wantedUrl;
    }
    if (match === "origin") {
        return tab.origin === wanted.origin;
    }
    if (match === "origin+path") {
        return (tab.origin === wanted.origin &&
            trimSlash(tab.pathname) === trimSlash(wanted.pathname));
    }
    return tab.href === wanted.href;
}
function trimSlash(pathname) {
    return pathname.replace(/\/+$/, "") || "/";
}

var nav = /*#__PURE__*/Object.freeze({
    __proto__: null,
    INTERNAL_URL_PREFIXES: INTERNAL_URL_PREFIXES,
    closeTab: closeTab,
    currentTab: currentTab,
    ensureRealTab: ensureRealTab,
    gotoAndWait: gotoAndWait,
    gotoUrl: gotoUrl,
    iframeTarget: iframeTarget,
    listTabs: listTabs,
    newTab: newTab,
    openOrReuseTab: openOrReuseTab,
    pageInfo: pageInfo,
    switchTab: switchTab
});

/**
 * Set files on a file input.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for an input[type=file].
 * @param {string|string[]} path Absolute file path or paths to upload.
 * @returns {Promise<void>}
 */
async function uploadFile(selector, path) {
    const files = Array.isArray(path) ? path : [path];
    await withHandle(selector, async ({ objectId, sessionId }) => {
        await cdp("DOM.setFileInputFiles", { files, objectId }, sessionId);
    });
}

var files = /*#__PURE__*/Object.freeze({
    __proto__: null,
    uploadFile: uploadFile
});

/**
 * Fetch text from Node with a browser-like User-Agent.
 * @param {string} url URL to fetch.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
async function serverFetch(url, options = {}) {
    const { timeout = 20.0, headers = {}, ...fetchOptions } = options;
    const response = await fetch(url, {
        ...fetchOptions,
        headers: { "User-Agent": "Mozilla/5.0", ...headers },
        signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!response.ok) {
        throw new Error(`${fetchOptions.method || "GET"} ${url} failed: HTTP ${response.status}`);
    }
    return response.text();
}
/**
 * Fetch text in the current browser page context.
 * @param {string} url URL to fetch. Relative URLs resolve against the current page.
 * @param {{headers?: Record<string,string>, timeout?: number, method?: string, body?: any}} [options]
 * @returns {Promise<string>} Response body text.
 */
async function browserFetch(url, options = {}) {
    const { timeout = 20.0, ...fetchOptions } = options;
    const payload = JSON.stringify({ url, options: fetchOptions, timeout });
    return js(`(async () => {
    const { url, options, timeout } = ${payload};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(\`\${options.method || "GET"} \${url} failed: HTTP \${response.status}\`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })()`);
}

class ClipboardRestoreError extends Error {
    code = "EGO_CLIPBOARD_RESTORE_FAILED";
    pasteCompleted = true;
    constructor(cause) {
        super("The paste completed, but ego-browser could not restore the clipboard. Do not retry the paste.", { cause });
        this.name = "ClipboardRestoreError";
    }
}
let transactionQueue = Promise.resolve();
/**
 * Run one action while the macOS clipboard temporarily contains `text`.
 * Transactions are serialized within the process because the pasteboard is a
 * single user resource shared by every Page.
 */
async function withTemporaryClipboardText(text, action, options = {}) {
    const content = validateClipboardInput(text);
    if (typeof action !== "function") {
        throw new TypeError("clipboard action must be a function");
    }
    let releaseQueue;
    const previous = transactionQueue;
    transactionQueue = new Promise((resolve) => {
        releaseQueue = resolve;
    });
    await previous;
    try {
        const beginTransaction = options.beginTransaction ?? beginDarwinClipboardTransaction;
        const transaction = await beginTransaction(content);
        let value;
        let actionError;
        try {
            value = await action();
        }
        catch (error) {
            actionError = error;
        }
        let restoreError;
        try {
            await transaction.finish();
        }
        catch (error) {
            restoreError = error;
        }
        if (actionError !== undefined) {
            if (restoreError !== undefined) {
                throw new AggregateError([actionError, restoreError], "The paste action failed and ego-browser could not restore the clipboard.");
            }
            throw actionError;
        }
        if (restoreError !== undefined) {
            throw new ClipboardRestoreError(restoreError);
        }
        return value;
    }
    finally {
        releaseQueue();
    }
}
/**
 * Keep the original NSPasteboard items inside a short-lived JXA process. The
 * data never crosses stdout or enters the Node heap, and every readable format
 * is restored unless another process changes the clipboard first.
 */
async function beginDarwinClipboardTransaction(input) {
    if (process.platform !== "darwin") {
        throw new Error("page.keyboard.paste currently requires macOS clipboard support");
    }
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", DARWIN_CLIPBOARD_HOST], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const messages = clipboardMessages(child.stdout);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_384)
            stderr += chunk;
    });
    const exit = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(JSON.stringify(input), "utf8");
    const first = await nextHostMessage(messages, exit, () => stderr);
    if (first.state !== "ready") {
        throw new Error(first.message || "could not prepare the macOS clipboard");
    }
    let finished = false;
    return {
        async finish() {
            if (finished)
                throw new Error("clipboard transaction already finished");
            finished = true;
            const signalPipe = child.stdio[3];
            if (!signalPipe) {
                throw new Error("clipboard restore pipe is unavailable");
            }
            signalPipe.end("1");
            const result = await nextHostMessage(messages, exit, () => stderr);
            const completion = await exit;
            if (completion.code !== 0) {
                throw clipboardHostExitError(completion, stderr);
            }
            if (result.state === "restored" || result.state === "changed") {
                return result.state;
            }
            throw new Error(result.message || "could not restore the macOS clipboard");
        },
    };
}
function validateClipboardInput(input) {
    if (typeof input === "string")
        return input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("page.keyboard.paste requires a string or { text, html? }");
    }
    const keys = Object.keys(input);
    const unknown = keys.find((key) => key !== "text" && key !== "html");
    if (unknown) {
        throw new TypeError(`page.keyboard.paste received unknown content field: ${unknown}`);
    }
    if (typeof input.text !== "string") {
        throw new TypeError("page.keyboard.paste content.text must be a string");
    }
    if (input.html !== undefined && typeof input.html !== "string") {
        throw new TypeError("page.keyboard.paste content.html must be a string");
    }
    return input.html === undefined
        ? { text: input.text }
        : { text: input.text, html: input.html };
}
function clipboardMessages(stream) {
    const queued = [];
    const waiters = [];
    let buffer = "";
    let ended = false;
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
        buffer += String(chunk);
        while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0)
                break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch (error) {
                rejectWaiter(new Error(`invalid clipboard host response: ${line}`));
                continue;
            }
            const waiter = waiters.shift();
            if (waiter)
                waiter.resolve(message);
            else
                queued.push(message);
        }
    });
    stream.on("error", rejectWaiter);
    stream.on("end", () => {
        ended = true;
        rejectWaiter(new Error("clipboard host closed without a response"));
    });
    function rejectWaiter(error) {
        const waiter = waiters.shift();
        if (waiter)
            waiter.reject(error);
    }
    return {
        next() {
            const message = queued.shift();
            if (message)
                return Promise.resolve(message);
            if (ended) {
                return Promise.reject(new Error("clipboard host closed without a response"));
            }
            return new Promise((resolve, reject) => {
                waiters.push({ resolve, reject });
            });
        },
    };
}
async function nextHostMessage(messages, exit, stderr) {
    try {
        // Child `exit` may be emitted before its stdout pipe drains. Read the
        // protocol message first so a successful restore cannot race with exit.
        return await messages.next();
    }
    catch (error) {
        const completion = await exit;
        if (completion.code !== 0 || completion.signal) {
            throw clipboardHostExitError(completion, stderr());
        }
        throw error;
    }
}
function clipboardHostExitError(completion, stderr) {
    const detail = stderr.trim();
    return new Error(`clipboard host exited ${completion.signal
        ? `on ${completion.signal}`
        : `with code ${completion.code}`}${detail ? `: ${detail}` : ""}`);
}
const DARWIN_CLIPBOARD_HOST = String.raw `
ObjC.import("AppKit");
ObjC.import("Foundation");

const pasteboard = $.NSPasteboard.generalPasteboard;
const transactionLock = $.NSDistributedLock.alloc.initWithPath(
  $(ObjC.unwrap($.NSTemporaryDirectory()) + "ego-browser-clipboard.lock")
);

function acquireTransactionLock() {
  const deadline = Date.now() + 5000;
  while (!transactionLock.tryLock) {
    const lockDate = transactionLock.lockDate;
    const lockAge = lockDate
      ? Date.now() - Number(lockDate.timeIntervalSince1970) * 1000
      : 0;
    if (lockAge > 30000) {
      transactionLock.breakLock;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another ego-browser process is using the clipboard");
    }
    $.NSThread.sleepForTimeInterval(0.02);
  }
}

function emit(message) {
  const line = $(JSON.stringify(message) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
}

function snapshotPasteboard() {
  const snapshot = [];
  const sourceItems = pasteboard.pasteboardItems;
  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {
    const sourceItem = sourceItems.objectAtIndex(itemIndex);
    const values = [];
    const types = sourceItem.types;
    for (let typeIndex = 0; typeIndex < Number(types.count); typeIndex += 1) {
      const type = types.objectAtIndex(typeIndex);
      const data = sourceItem.dataForType(type);
      if (data) values.push({ type, data });
    }
    snapshot.push(values);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  const restoredItems = [];
  for (const values of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const value of values) item.setDataForType(value.data, value.type);
    restoredItems.push(item);
  }
  if (!pasteboard.writeObjects($(restoredItems))) {
    throw new Error("NSPasteboard rejected the saved clipboard items");
  }
}

const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const serialized = ObjC.unwrap(
  $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)
);
const parsed = JSON.parse(serialized);
const content = typeof parsed === "string" ? { text: parsed } : parsed;
acquireTransactionLock();
const saved = snapshotPasteboard();

try {
  pasteboard.clearContents;
  if (!pasteboard.setStringForType($(content.text), $.NSPasteboardTypeString)) {
    throw new Error("NSPasteboard rejected the temporary text");
  }
  if (
    content.html !== undefined &&
    !pasteboard.setStringForType($(content.html), $.NSPasteboardTypeHTML)
  ) {
    throw new Error("NSPasteboard rejected the temporary HTML");
  }
} catch (error) {
  try { restorePasteboard(saved); } catch (_) {}
  emit({ state: "error", message: String(error.message || error) });
  transactionLock.unlock;
  throw error;
}

const temporaryChangeCount = Number(pasteboard.changeCount);
emit({ state: "ready" });

const restoreSignal = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
restoreSignal.readDataOfLength(1);

try {
  try {
    if (Number(pasteboard.changeCount) !== temporaryChangeCount) {
      emit({ state: "changed" });
    } else {
      restorePasteboard(saved);
      emit({ state: "restored" });
    }
  } catch (error) {
    emit({ state: "error", message: String(error.message || error) });
    throw error;
  }
} finally {
  transactionLock.unlock;
}
`;

const SINGLE_EVENT_DISTANCE = 120;
const PIXELS_PER_STEP = 80;
const MAX_STEPS = 12;
const STEP_INTERVAL_MS = 8;
/**
 * Dispatch one logical wheel action as a short eased browser-input motion.
 * Small deltas stay immediate, while page-sized deltas are spread over enough
 * input frames to remain visually continuous without creating a long gesture.
 */
async function dispatchWheelMotion(services, motion) {
    const distance = Math.max(Math.abs(motion.deltaX), Math.abs(motion.deltaY));
    const steps = distance <= SINGLE_EVENT_DISTANCE
        ? 1
        : Math.min(MAX_STEPS, Math.ceil(distance / PIXELS_PER_STEP));
    let emittedX = 0;
    let emittedY = 0;
    for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const eased = progress * progress * (3 - 2 * progress);
        const cumulativeX = step === steps ? motion.deltaX : motion.deltaX * eased;
        const cumulativeY = step === steps ? motion.deltaY : motion.deltaY * eased;
        const deltaX = cumulativeX - emittedX;
        const deltaY = cumulativeY - emittedY;
        emittedX = cumulativeX;
        emittedY = cumulativeY;
        await services.dispatch({
            type: "mouseWheel",
            x: motion.x,
            y: motion.y,
            modifiers: motion.modifiers ?? 0,
            deltaX,
            deltaY,
        });
        if (step < steps)
            await services.sleep(STEP_INTERVAL_MS);
    }
}

/** Select option values from one visible, enabled select element. */
async function selectOptionInPage(services, sessionId, refMap, selector, choices, iframeSessions = new Map()) {
    assertPageSelector(selector);
    const resolved = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, selector, iframeSessions, { strict: true, actionability: "enabled" });
    const source = `function selectOptionsForAction(choices) {
    ${EDIT_ACTION_TARGET_HELPERS}
    let select = String(this.tagName || "").toUpperCase() === "SELECT"
      ? this
      : null;
    if (!select && this.control?.tagName === "SELECT") select = this.control;
    if (!select) {
      const candidates = composedDescendantMatches(
        this,
        (element) => String(element.tagName || "").toUpperCase() === "SELECT",
        true,
      );
      if (candidates.length > 1) {
        return { error: "element contains multiple select controls" };
      }
      select = candidates[0] || null;
    }
    if (!select) return { error: "element is not a select control" };
    if (!select.isConnected) return { error: "element is not connected" };
    const view = select.ownerDocument.defaultView;
    const rect = select.getBoundingClientRect();
    const style = view?.getComputedStyle(select);
    if (
      !view || rect.width <= 0 || rect.height <= 0 ||
      style?.display === "none" || style?.visibility === "hidden"
    ) return { error: "element is not visible" };
    if (isActionTargetDisabled(select)) return { error: "element is disabled" };
    const options = Array.from(select.options);
    const selected = [];
    const selectedOptions = [];
    let remaining = choices.slice();
    const matches = (choice, candidate, index) =>
      typeof choice === "string"
        ? candidate.value === choice || candidate.label === choice
        : (choice.value === undefined || candidate.value === choice.value) &&
          (choice.label === undefined || candidate.label === choice.label) &&
          (choice.index === undefined || index === choice.index);
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      const matchingChoice = remaining.find((choice) =>
        matches(choice, option, index)
      );
      if (matchingChoice === undefined) continue;
      selectedOptions.push(option);
      if (!select.multiple) {
        remaining = [];
        break;
      }
      remaining = remaining.filter(
        (choice) => !matches(choice, option, index),
      );
    }
    if (remaining.length > 0) {
      const available = options
        .map((candidate, index) =>
          index + ': value=' + JSON.stringify(candidate.value) +
          ', label=' + JSON.stringify(candidate.label),
        )
        .join('; ');
      return {
        error:
          'option ' + JSON.stringify(remaining[0]) +
          ' was not found; available options: ' + (available || '(none)'),
      };
    }
    for (const option of options) option.selected = false;
    for (const option of selectedOptions) option.selected = true;
    for (const option of select.selectedOptions) selected.push(option.value);
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected };
  }`;
    try {
        const response = await services.cdp("Runtime.callFunctionOn", {
            functionDeclaration: source,
            objectId: resolved.objectId,
            arguments: [{ value: choices }],
            returnByValue: true,
            awaitPromise: false,
        }, resolved.sessionId);
        const result = runtimeValue(response, source);
        if (typeof result?.error === "string") {
            const transient = new Set([
                "element is not connected",
                "element is not visible",
                "element is disabled",
            ]);
            throw transient.has(result.error) ||
                result.error.includes(" was not found;")
                ? new ElementResolutionError(`page.selectOption failed: ${result.error}`, "transient")
                : new Error(`page.selectOption failed: ${result.error}`);
        }
        if (!Array.isArray(result?.selected)) {
            throw new Error("page.selectOption received an invalid selection result");
        }
        return result.selected;
    }
    finally {
        await releaseObject$1(services, resolved.sessionId, resolved.objectId);
    }
}
const INPUT_EVENT_DELAY_MS = 25;
const FILL_VERIFICATION_ATTEMPTS = 5;
const FILL_VERIFICATION_INTERVAL_MS = 50;
const AUTO_SCROLL_ATTEMPTS = 6;
/** Click an element through one explicit target session and Page ref map. */
async function clickInPage(services, sessionId, refMap, selector, options = {}, modifiers = 0, iframeSessions = new Map()) {
    assertPageSelector(selector);
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    const target = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, selector, iframeSessions, {
        strict: true,
        actionability: options.force ? "enabled" : "pointer-enabled",
    });
    try {
        let point = await resolveElementPoint(services, target.sessionId, target.objectId, {
            position: options.position,
            frameId: target.frameId,
            actionName: "page.click",
            hitTest: !options.force,
            stability: "recompute",
            pageSessionId: sessionId,
            iframeSessions,
        });
        const cursorPoint = await cursorPointForElement(services, sessionId, target.sessionId, target.frameId, point, point.local, iframeSessions);
        const buttons = pressedButtons(button);
        showAgentActionLabel(services, options.label ?? "Clicking element");
        await dispatchMouseEvent(services, target.sessionId, {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
            modifiers,
        }, cursorPoint);
        if (target.frameId && target.sessionId === sessionId) {
            // Moving into a same-process iframe can adjust the outer document's
            // scroll position. Translate the frame-local point again before the
            // press so native input uses the post-hover viewport coordinates.
            const pagePoint = await pagePointForFrame(services, target.sessionId, target.frameId, point.local, sessionId);
            point = { ...pagePoint, local: point.local };
            await assertElementEnabled(services, target.sessionId, target.objectId, "page.click");
            if (!options.force) {
                await assertElementReceivesPointerEvents(services, target.sessionId, target.objectId, point.local);
            }
            await dispatchMouseEvent(services, target.sessionId, {
                type: "mouseMoved",
                x: point.x,
                y: point.y,
                button: "none",
                buttons: 0,
                modifiers,
            });
        }
        for (let count = 1; count <= clickCount; count += 1) {
            // Moving the pointer or completing an earlier click can change layout.
            // Recheck before every press so hover-created overlays fail closed.
            // A same-process iframe must keep its native move/press sequence
            // contiguous; its state was checked immediately before that gesture's
            // final move.
            if (!target.frameId || count > 1) {
                await assertElementEnabled(services, target.sessionId, target.objectId, "page.click");
            }
            if (!options.force && !target.frameId) {
                await assertElementReceivesPointerEvents(services, target.sessionId, target.objectId, point.local);
            }
            await dispatchMouseEvent(services, target.sessionId, {
                type: "mousePressed",
                x: point.x,
                y: point.y,
                button,
                buttons,
                modifiers,
                clickCount: count,
            });
            if (options.delay)
                await services.sleep(options.delay);
            await dispatchMouseEvent(services, target.sessionId, {
                type: "mouseReleased",
                x: point.x,
                y: point.y,
                button,
                buttons: 0,
                modifiers,
                clickCount: count,
            });
            if (options.delay && count < clickCount) {
                await services.sleep(options.delay);
            }
        }
    }
    finally {
        await services
            .cdp("Runtime.releaseObject", { objectId: target.objectId }, target.sessionId)
            .catch(() => { });
    }
}
/** Focus, replace, and notify an input-like element in one target session. */
async function fillInPage(services, sessionId, refMap, selector, value, options = {}, iframeSessions = new Map()) {
    assertPageSelector(selector);
    if (typeof value !== "string") {
        throw new TypeError("page.fill value must be a string");
    }
    const clearFirst = options.clearFirst ?? true;
    const resolved = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, selector, iframeSessions, { strict: true, actionability: "enabled" });
    let actionObjectId;
    try {
        actionObjectId = await resolveFillActionTarget(services, resolved.sessionId, resolved.objectId);
        await scrollElementIntoView(services, resolved.sessionId, actionObjectId, resolved.frameId, "page.fill", sessionId, iframeSessions);
        const preparationSource = `function fillPreparation(value, clearFirst) {
      ${ACTION_TARGET_STATE_HELPERS}
      if (!this.isConnected) return { error: "element is not connected" };
      const visibleCursorPoint = () => {
        const rect = this.getBoundingClientRect();
        const view = this.ownerDocument.defaultView;
        if (!view || rect.width <= 0 || rect.height <= 0) return null;
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(view.innerWidth, rect.right);
        const bottom = Math.min(view.innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return null;
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      };
      const tag = this.nodeName.toLowerCase();
      const observed = tag === "input" || tag === "textarea"
        ? this.value
        : (this.innerText ?? this.textContent ?? "");
      const view = this.ownerDocument.defaultView;
      const rect = this.getBoundingClientRect();
      const style = view?.getComputedStyle(this);
      if (
        !view || rect.width <= 0 || rect.height <= 0 ||
        style?.visibility === "hidden" || style?.display === "none"
      ) return { error: "element is not visible" };
      if (isActionTargetDisabled(this)) return { error: "element is disabled" };
      if (this.readOnly) return { error: "element is read only" };

      if (tag === "input") {
        const type = this.type.toLowerCase();
        const textTypes = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
        const directTypes = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
        if (!textTypes.has(type) && !directTypes.has(type)) {
          return { error: 'input type "' + type + '" cannot be filled' };
        }
        if (type === "number" && value.trim() !== "" && Number.isNaN(Number(value.trim()))) {
          return { error: "cannot type non-numeric text into input[type=number]" };
        }
        if (directTypes.has(type)) {
          const nextValue = value.trim();
          this.focus({ preventScroll: true });
          if (isActionTargetDisabled(this)) return { error: "element is disabled" };
          this.value = nextValue;
          if (this.value !== nextValue) return { error: "malformed value" };
          this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return { status: "done", kind: "input", cursorPoint: visibleCursorPoint() };
        }
      } else if (tag !== "textarea" && !this.isContentEditable) {
        return { error: "element is not an input, textarea, or contenteditable element" };
      }

      this.focus({ preventScroll: true });
      if (isActionTargetDisabled(this)) return { error: "element is disabled" };
      const cursorPoint = visibleCursorPoint();
      const kind = this.isContentEditable ? "contenteditable" : tag;
      const details = {
        status: "needsinput",
        kind,
        cursorPoint,
        before: String(observed)
      };
      if (!clearFirst) return details;
      if (tag === "input" || tag === "textarea") {
        this.select();
      } else {
        const range = this.ownerDocument.createRange();
        range.selectNodeContents(this);
        const selection = this.ownerDocument.defaultView.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return details;
    }`;
        const prepare = async () => {
            const preparation = await services.cdp("Runtime.callFunctionOn", {
                functionDeclaration: preparationSource,
                objectId: actionObjectId,
                arguments: [{ value }, { value: clearFirst }],
                returnByValue: true,
                awaitPromise: false,
            }, resolved.sessionId);
            return runtimeValue(preparation, preparationSource);
        };
        let result = await prepare();
        if (typeof result?.error === "string") {
            throw fillPreparationError(result.error);
        }
        showAgentCursor(services, await pagePointForFrame(services, resolved.sessionId, resolved.frameId, result?.cursorPoint, sessionId));
        const status = typeof result === "string" ? result : result?.status;
        if (status === "done")
            return;
        if (status !== "needsinput") {
            throw new Error("page.fill received an invalid preparation result");
        }
        await assertElementEnabled(services, resolved.sessionId, actionObjectId, "page.fill");
        await dispatchFillInput(services, resolved.sessionId, value, clearFirst);
        let outcome = await verifyFillOutcome(services, resolved.sessionId, actionObjectId, String(result?.before ?? ""), value, clearFirst);
        if (fillOutcomeAccepted(outcome)) {
            return;
        }
        if (result?.kind === "contenteditable" ||
            result?.kind === "input" ||
            result?.kind === "textarea") {
            // Some controls append because their editing state is not installed
            // until a real pointer activation. Retry only an unchanged or appended
            // result so application formatting is never typed twice.
            await clickResolvedElement(services, resolved.sessionId, actionObjectId, resolved.frameId, sessionId, iframeSessions);
            result = await prepare();
            if (typeof result?.error === "string") {
                throw fillPreparationError(result.error);
            }
            if (result?.status !== "needsinput") {
                throw new Error("page.fill received an invalid preparation result");
            }
            await assertElementEnabled(services, resolved.sessionId, actionObjectId, "page.fill");
            await dispatchFillInput(services, resolved.sessionId, value, clearFirst);
            outcome = await verifyFillOutcome(services, resolved.sessionId, actionObjectId, String(result?.before ?? ""), value, clearFirst);
            if (fillOutcomeAccepted(outcome)) {
                return;
            }
        }
        const target = result?.kind === "contenteditable" ? "editor" : "field";
        throw new Error(`page.fill did not accept the text. Click the ${target} and use page.keyboard, then verify the result.`);
    }
    finally {
        if (actionObjectId && actionObjectId !== resolved.objectId) {
            await releaseObject$1(services, resolved.sessionId, actionObjectId);
        }
        await releaseObject$1(services, resolved.sessionId, resolved.objectId);
    }
}
async function resolveFillActionTarget(services, sessionId, objectId) {
    const source = `function resolveFillTargetForAction() {
    ${EDIT_ACTION_TARGET_HELPERS}
    const tag = String(this.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || isExplicitContentEditable(this)) {
      return this;
    }
    const editingHost = nearestComposedAncestor(this, isExplicitContentEditable);
    if (editingHost) return editingHost;
    const candidates = composedDescendantMatches(
      this,
      isFillableActionTarget,
      true,
    );
    if (candidates.length > 1) {
      throw new TypeError("page.fill selected an element with multiple fillable targets");
    }
    return candidates[0] || this;
  }`;
    const response = await services.cdp("Runtime.callFunctionOn", {
        functionDeclaration: source,
        objectId,
        returnByValue: false,
        awaitPromise: false,
    }, sessionId);
    if (response?.exceptionDetails) {
        throw new ElementResolutionError(exceptionDescription(response), "permanent");
    }
    const targetObjectId = response?.result?.objectId;
    if (!targetObjectId) {
        throw new Error("page.fill could not resolve an editable action target");
    }
    return targetObjectId;
}
/** Focus one strictly resolved element in an explicit Page session. */
async function focusInPage(services, sessionId, refMap, selector, iframeSessions = new Map()) {
    assertPageSelector(selector);
    const resolved = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, selector, iframeSessions, { strict: true, actionability: "enabled" });
    const source = `function focusElementForAction() {
    if (!this.isConnected) return { error: "element is not connected" };
    ${EDIT_ACTION_TARGET_HELPERS}
    const deepActiveElement = () => {
      let active = this.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const containsComposed = (container, element) => {
      let current = element;
      while (current) {
        if (current === container) return true;
        current = composedParent(current);
      }
      return false;
    };
    const details = () => ({
      tagName: this.tagName,
      contentEditable: Boolean(this.isContentEditable),
      tabIndex: this.tabIndex,
      activeTagName: deepActiveElement()?.tagName || null,
    });
    const tryFocus = (candidate, retargeted) => {
      if (typeof candidate.focus !== "function") return null;
      candidate.focus();
      const active = deepActiveElement();
      return active === candidate || containsComposed(candidate, active)
        ? { focused: true, retargeted }
        : null;
    };

    const direct = tryFocus(this, null);
    if (direct) return direct;

    let ancestor = composedParent(this);
    while (ancestor) {
      if (isStrongFocusTarget(ancestor)) {
        const focused = tryFocus(ancestor, "ancestor");
        if (focused) return focused;
      }
      ancestor = composedParent(ancestor);
    }

    const editableCandidates = composedDescendantMatches(
      this,
      isEditableFocusTarget,
      true,
    );
    if (editableCandidates.length === 1) {
      const focused = tryFocus(editableCandidates[0], "descendant");
      if (focused) return focused;
    }
    if (editableCandidates.length > 1) {
      return {
        error: "element contains multiple editable targets",
        details: { ...details(), candidateCount: editableCandidates.length },
      };
    }
    return { error: "element is not focusable", details: details() };
  }`;
    try {
        const response = await services.cdp("Runtime.callFunctionOn", {
            functionDeclaration: source,
            objectId: resolved.objectId,
            returnByValue: true,
            awaitPromise: false,
        }, resolved.sessionId);
        const result = runtimeValue(response, source);
        if (typeof result?.error === "string") {
            const details = result.details;
            const candidateCount = details?.candidateCount
                ? `, candidates=${String(details.candidateCount)}`
                : "";
            const description = details
                ? ` (${String(details.tagName || "element").toLowerCase()}, contenteditable=${Boolean(details.contentEditable)}, tabIndex=${String(details.tabIndex)}, active=${String(details.activeTagName || "none").toLowerCase()}${candidateCount})`
                : "";
            throw new ElementResolutionError(`page.focus failed: ${result.error}${description}`, result.error === "element is not connected" ? "transient" : "permanent");
        }
    }
    finally {
        await releaseObject$1(services, resolved.sessionId, resolved.objectId);
    }
}
async function dispatchFillInput(services, sessionId, value, clearFirst) {
    if (clearFirst && value.length === 0) {
        const keyDown = {
            type: "rawKeyDown",
            key: "Delete",
            code: "Delete",
            modifiers: 0,
            windowsVirtualKeyCode: 46,
        };
        if ((services.platform ?? process.platform) === "darwin") {
            keyDown.commands = ["deleteForward"];
        }
        await services.cdp("Input.dispatchKeyEvent", keyDown, sessionId);
        await services.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Delete",
            code: "Delete",
            modifiers: 0,
            windowsVirtualKeyCode: 46,
        }, sessionId);
        return;
    }
    if (value.length > 0) {
        await services.cdp("Input.insertText", { text: value }, sessionId);
    }
}
async function verifyFillOutcome(services, sessionId, objectId, before, value, clearFirst) {
    const source = `function readFilledValue() {
    if (!this.isConnected) return { error: "element is not connected" };
    const tag = this.nodeName.toLowerCase();
    const observed = tag === "input" || tag === "textarea"
      ? this.value
      : (this.innerText ?? this.textContent ?? "");
    return {
      actual: String(observed),
      type: tag === "input" ? this.type.toLowerCase() : ""
    };
  }`;
    let prior;
    let consecutiveReads = 0;
    let lastOutcome = "unchanged";
    for (let attempt = 0; attempt < FILL_VERIFICATION_ATTEMPTS; attempt += 1) {
        const response = await services.cdp("Runtime.callFunctionOn", {
            functionDeclaration: source,
            objectId,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId);
        const result = runtimeValue(response, source);
        if (typeof result?.error === "string") {
            // Input has already been dispatched, so retrying the whole operation
            // could duplicate text on a replacement element.
            throw new Error(`page.fill could not verify the result: ${result.error}`);
        }
        const outcome = classifyFillOutcome(before, value, String(result?.actual ?? ""), clearFirst, String(result?.type ?? ""));
        lastOutcome = outcome;
        const reading = `${outcome}\u0000${String(result?.actual ?? "")}`;
        if (reading === prior) {
            consecutiveReads += 1;
            if (consecutiveReads === 2)
                return outcome;
        }
        else {
            prior = reading;
            consecutiveReads = 1;
        }
        if (attempt + 1 < FILL_VERIFICATION_ATTEMPTS) {
            await services.sleep(FILL_VERIFICATION_INTERVAL_MS);
        }
    }
    return lastOutcome;
}
function fillOutcomeAccepted(outcome) {
    return (outcome === "exact" || outcome === "equivalent" || outcome === "transformed");
}
function classifyFillOutcome(beforeValue, expectedValue, actualValue, clearFirst, inputType) {
    const normalize = (text) => String(text)
        .replace(/\r\n?/g, "\n")
        .replace(/\u200b/g, "");
    const before = normalize(beforeValue);
    const expected = normalize(expectedValue);
    const actual = normalize(actualValue);
    if (clearFirst ? actual === expected : actual.includes(expected)) {
        return "exact";
    }
    if (inputType === "number" &&
        expected.trim() !== "" &&
        actual.trim() !== "" &&
        Number(actual) === Number(expected)) {
        return "equivalent";
    }
    const integerExpected = expected.normalize("NFKC").trim();
    if (/^\d+$/.test(integerExpected)) {
        const actualDigits = actual.normalize("NFKC").replace(/\D/g, "");
        if (actualDigits === integerExpected)
            return "equivalent";
        const beforeDigits = before.normalize("NFKC").replace(/\D/g, "");
        if (clearFirst &&
            beforeDigits.length > 0 &&
            actualDigits === beforeDigits + integerExpected) {
            return "appended";
        }
    }
    if (clearFirst && actual === before + expected && before.length > 0) {
        return "appended";
    }
    return actual === before ? "unchanged" : "transformed";
}
async function clickResolvedElement(services, sessionId, objectId, frameId, pageSessionId = sessionId, iframeSessions = new Map()) {
    const point = await resolveElementPoint(services, sessionId, objectId, {
        frameId,
        actionName: "page.fill",
        hitTest: true,
        stability: "recompute",
        pageSessionId,
        iframeSessions,
    });
    await assertElementReceivesPointerEvents(services, sessionId, objectId, point.local);
    await assertSafeFillActivationTarget(services, sessionId, objectId, point.local);
    await dispatchMouseEvent(services, sessionId, {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
        modifiers: 0,
    });
    await assertElementEnabled(services, sessionId, objectId, "page.fill");
    if (frameId) {
        await dispatchMouseEvent(services, sessionId, {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
            modifiers: 0,
        });
    }
    await dispatchMouseEvent(services, sessionId, {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        modifiers: 0,
        clickCount: 1,
    });
    await dispatchMouseEvent(services, sessionId, {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        modifiers: 0,
        clickCount: 1,
    });
}
async function assertSafeFillActivationTarget(services, sessionId, objectId, point) {
    const expression = `function safeFillActivationTarget(point) {
    ${HIT_TARGET_HELPERS}
    if (!this.isConnected) return { error: "the editor is not connected" };
    const hit = hitElementAtPoint(this, point);
    let current = hit;
    while (current && current !== this) {
      if (isExplicitInteractiveElement(current)) {
        return { error: describeHitTarget(current) };
      }
      current = composedParent(current);
    }
    return { safe: true };
  }`;
    const response = await services.cdp("Runtime.callFunctionOn", {
        functionDeclaration: expression,
        objectId,
        arguments: [{ value: point }],
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    const result = runtimeValue(response, expression);
    if (typeof result?.error === "string") {
        throw new ElementResolutionError(`page.fill cannot safely activate the editor because ${result.error} would receive the click`, "permanent");
    }
}
/** Move the native mouse over one element in an explicit Page session. */
async function hoverInPage(services, sessionId, refMap, selector, options = {}, modifiers = 0, iframeSessions = new Map()) {
    assertPageSelector(selector);
    const resolved = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, selector, iframeSessions, {
        strict: true,
        actionability: options.force ? "visible" : "pointer",
    });
    try {
        const point = await resolveElementPoint(services, resolved.sessionId, resolved.objectId, {
            position: options.position,
            frameId: resolved.frameId,
            actionName: "page.hover",
            hitTest: !options.force,
            stability: "strict",
            pageSessionId: sessionId,
            iframeSessions,
        });
        showAgentActionLabel(services, options.label);
        await dispatchMouseEvent(services, resolved.sessionId, {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
            modifiers,
        });
    }
    finally {
        await releaseObject$1(services, resolved.sessionId, resolved.objectId);
    }
}
/** Drag between two elements through the same explicit Page session. */
async function dragAndDropInPage(services, sessionId, refMap, sourceSelector, targetSelector, options = {}, modifiers = 0, iframeSessions = new Map()) {
    assertPageSelector(sourceSelector);
    assertPageSelector(targetSelector);
    const source = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, sourceSelector, iframeSessions, {
        strict: true,
        actionability: options.force ? "visible" : "pointer",
    });
    let target;
    try {
        target = await resolveElementObjectId(cdpAdapter$2(services), sessionId, refMap, targetSelector, iframeSessions, {
            strict: true,
            actionability: options.force ? "visible" : "pointer",
        });
        const sourcePoint = await resolveElementPoint(services, source.sessionId, source.objectId, {
            position: options.sourcePosition,
            frameId: source.frameId,
            actionName: "page.dragAndDrop",
            hitTest: !options.force,
            stability: "strict",
            pageSessionId: sessionId,
            iframeSessions,
        });
        const targetPoint = await resolveElementPoint(services, target.sessionId, target.objectId, {
            position: options.targetPosition,
            frameId: target.frameId,
            actionName: "page.dragAndDrop",
            hitTest: !options.force,
            stability: "strict",
            pageSessionId: sessionId,
            iframeSessions,
        });
        const button = options.button ?? "left";
        const buttons = pressedButtons(button);
        showAgentActionLabel(services, options.label);
        await dispatchMouseEvent(services, source.sessionId, {
            type: "mouseMoved",
            x: sourcePoint.x,
            y: sourcePoint.y,
            button: "none",
            buttons: 0,
            modifiers,
        });
        await services.sleep(INPUT_EVENT_DELAY_MS);
        await dispatchMouseEvent(services, source.sessionId, {
            type: "mousePressed",
            x: sourcePoint.x,
            y: sourcePoint.y,
            button,
            buttons,
            modifiers,
            clickCount: 1,
        });
        await services.sleep(INPUT_EVENT_DELAY_MS);
        await dispatchMouseEvent(services, source.sessionId, {
            type: "mouseMoved",
            x: targetPoint.x,
            y: targetPoint.y,
            button,
            buttons,
            modifiers,
        });
        await services.sleep(INPUT_EVENT_DELAY_MS);
        await dispatchMouseEvent(services, source.sessionId, {
            type: "mouseReleased",
            x: targetPoint.x,
            y: targetPoint.y,
            button,
            buttons: 0,
            modifiers,
            clickCount: 1,
        });
    }
    finally {
        if (target) {
            await releaseObject$1(services, target.sessionId, target.objectId);
        }
        await releaseObject$1(services, source.sessionId, source.objectId);
    }
}
/** Dispatch a complete native click at viewport coordinates. */
async function clickPointInPage(services, sessionId, x, y, options = {}, modifiers = 0, baseButtons = 0) {
    assertPoint(x, y, "page.mouse.click");
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    const buttons = pressedButtons(button);
    showAgentActionLabel(services, options.label);
    await dispatchMouseEvent(services, sessionId, {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: baseButtons,
        modifiers,
    });
    for (let count = 1; count <= clickCount; count += 1) {
        await dispatchMouseEvent(services, sessionId, {
            type: "mousePressed",
            x,
            y,
            button,
            buttons: baseButtons | buttons,
            modifiers,
            clickCount: count,
        });
        if (options.delay)
            await services.sleep(options.delay);
        await dispatchMouseEvent(services, sessionId, {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: baseButtons,
            modifiers,
            clickCount: count,
        });
        if (options.delay && count < clickCount) {
            await services.sleep(options.delay);
        }
    }
}
async function moveMouseInPage(services, sessionId, fromX, fromY, x, y, options) {
    assertPoint(x, y, "page.mouse.move");
    const steps = options.steps ?? 1;
    showAgentActionLabel(services, options.label);
    for (let step = 1; step <= steps; step += 1) {
        await dispatchMouseEvent(services, sessionId, {
            type: "mouseMoved",
            x: fromX + (x - fromX) * (step / steps),
            y: fromY + (y - fromY) * (step / steps),
            button: options.button,
            buttons: options.buttons,
            modifiers: options.modifiers,
        });
    }
}
async function mouseButtonInPage(services, sessionId, type, x, y, buttons, options = {}, modifiers = 0) {
    assertPoint(x, y, `page.mouse.${type === "mousePressed" ? "down" : "up"}`);
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    await dispatchMouseEvent(services, sessionId, {
        type,
        x,
        y,
        button,
        buttons,
        modifiers,
        clickCount,
    });
    return button;
}
async function wheelInPage(services, sessionId, x, y, deltaX, deltaY, modifiers = 0, options = {}) {
    assertPoint(x, y, "page.mouse.wheel");
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new TypeError("page.mouse.wheel requires finite deltaX and deltaY");
    }
    showAgentActionLabel(services, options.label);
    await dispatchWheelMotion({
        dispatch: (params) => dispatchMouseEvent(services, sessionId, params),
        sleep: services.sleep,
    }, {
        x,
        y,
        modifiers,
        deltaX,
        deltaY,
    });
}
async function scrollElementIntoView(services, sessionId, objectId, frameId, actionName, pageSessionId, iframeSessions) {
    await resolveElementPoint(services, sessionId, objectId, {
        frameId,
        actionName,
        hitTest: false,
        stability: "none",
        pageSessionId,
        iframeSessions,
    });
}
async function resolveElementPoint(services, sessionId, objectId, options = {}) {
    const { position, frameId, actionName = "page.click", hitTest = true, stability = "strict", pageSessionId = sessionId, iframeSessions = new Map(), } = options;
    if (position !== undefined &&
        (!position ||
            typeof position !== "object" ||
            !Number.isFinite(position.x) ||
            !Number.isFinite(position.y))) {
        throw new TypeError(`${actionName} position requires finite x and y offsets`);
    }
    const pointExpression = position
        ? "({x:rect.x+position.x,y:rect.y+position.y})"
        : "actionPointForElement(this)";
    const settleExpression = stability === "none"
        ? ""
        : `await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
    rect = this.getBoundingClientRect();`;
    const strictStabilityExpression = stability === "strict"
        ? `const firstRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    ${settleExpression}
    if (
      Math.abs(rect.x - firstRect.x) > 0.25 ||
      Math.abs(rect.y - firstRect.y) > 0.25 ||
      Math.abs(rect.width - firstRect.width) > 0.25 ||
      Math.abs(rect.height - firstRect.height) > 0.25
    ) {
      return { error: "element is not stable" };
    }`
        : settleExpression;
    const expression = `async function(${position ? "position" : ""}) {
    ${hitTest ? HIT_TARGET_HELPERS : SCROLL_TARGET_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    let rect = this.getBoundingClientRect();
    let point = ${pointExpression};
    if (rect.width <= 0 || rect.height <= 0 || !point) {
      return { error: "element is not visible" };
    }
    const scroll = scrollRequestForPoint(this, point);
    if (scroll) return { scroll };
    ${strictStabilityExpression}
    point = ${pointExpression};
    if (${hitTest ? "true" : "false"}) {
      const interceptor = interceptingElementAtPoint(this, point);
      if (interceptor) {
        return { error: describeHitTarget(interceptor) + " intercepts pointer events" };
      }
    }
    return point;
  }`;
    if (frameId) {
        await ensureFrameOwnerInView(services, pageSessionId, frameId, actionName, iframeSessions);
    }
    for (let attempt = 0; attempt <= AUTO_SCROLL_ATTEMPTS; attempt += 1) {
        const response = await services.cdp("Runtime.callFunctionOn", {
            functionDeclaration: expression,
            objectId,
            arguments: position ? [{ value: position }] : [],
            returnByValue: true,
            awaitPromise: true,
        }, sessionId);
        const point = runtimeValue(response, expression);
        if (typeof point?.error === "string") {
            throw new ElementResolutionError(`${actionName} failed: ${point.error}`, "transient");
        }
        const scroll = point?.scroll;
        if (scroll) {
            if (attempt === AUTO_SCROLL_ATTEMPTS ||
                !Number.isFinite(scroll.x) ||
                !Number.isFinite(scroll.y) ||
                !Number.isFinite(scroll.deltaX) ||
                !Number.isFinite(scroll.deltaY)) {
                throw new ElementResolutionError(`${actionName} failed: element is not visible in the viewport`, "transient");
            }
            const pageScrollPoint = await pagePointForFrame(services, sessionId, frameId, scroll, pageSessionId);
            await dispatchWheelMotion({
                dispatch: (params) => dispatchMouseEvent(services, sessionId, params),
                sleep: services.sleep,
            }, {
                x: pageScrollPoint.x,
                y: pageScrollPoint.y,
                deltaX: scroll.deltaX,
                deltaY: scroll.deltaY,
            });
            continue;
        }
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
            throw new Error(`${actionName} could not resolve the element position`);
        }
        const pagePoint = await pagePointForFrame(services, sessionId, frameId, point, pageSessionId);
        return { ...pagePoint, local: point };
    }
    throw new ElementResolutionError(`${actionName} failed: element is not visible in the viewport`, "transient");
}
async function ensureFrameOwnerInView(services, pageSessionId, frameId, actionName, iframeSessions, visited = new Set()) {
    if (visited.has(frameId))
        return;
    visited.add(frameId);
    const parentFrameIds = iframeSessions.parentFrameIds;
    const parentFrameId = parentFrameIds?.get(frameId);
    if (parentFrameId && iframeSessions.has(parentFrameId)) {
        await ensureFrameOwnerInView(services, pageSessionId, parentFrameId, actionName, iframeSessions, visited);
    }
    const ownerSessionId = parentFrameId
        ? iframeSessions.get(parentFrameId) || pageSessionId
        : pageSessionId;
    const owner = await services.cdp("DOM.getFrameOwner", { frameId }, ownerSessionId);
    const backendNodeId = owner?.backendNodeId;
    if (backendNodeId === undefined || backendNodeId === null) {
        throw new ElementResolutionError(`${actionName} failed: iframe is not available`, "transient");
    }
    const resolved = await services.cdp("DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, ownerSessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
        throw new ElementResolutionError(`${actionName} failed: iframe is not available`, "transient");
    }
    const source = `function() {
    ${SCROLL_TARGET_HELPERS}
    if (!this.isConnected) return { error: "iframe is not connected" };
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { error: "iframe is not visible" };
    }
    const point = actionPointForElement(this);
    if (!point) return { error: "iframe is not visible" };
    return { scroll: scrollRequestForPoint(this, point) };
  }`;
    try {
        for (let attempt = 0; attempt <= AUTO_SCROLL_ATTEMPTS; attempt += 1) {
            const response = await services.cdp("Runtime.callFunctionOn", {
                functionDeclaration: source,
                objectId,
                returnByValue: true,
                awaitPromise: false,
            }, ownerSessionId);
            const result = runtimeValue(response, source);
            if (typeof result?.error === "string") {
                throw new ElementResolutionError(`${actionName} failed: ${result.error}`, "transient");
            }
            const scroll = result?.scroll;
            if (!scroll)
                return;
            if (attempt === AUTO_SCROLL_ATTEMPTS ||
                !Number.isFinite(scroll.x) ||
                !Number.isFinite(scroll.y) ||
                !Number.isFinite(scroll.deltaX) ||
                !Number.isFinite(scroll.deltaY)) {
                throw new ElementResolutionError(`${actionName} failed: iframe is not visible in the viewport`, "transient");
            }
            await dispatchWheelMotion({
                dispatch: (params) => dispatchMouseEvent(services, ownerSessionId, params),
                sleep: services.sleep,
            }, scroll);
        }
    }
    finally {
        await releaseObject$1(services, ownerSessionId, objectId);
    }
}
async function pagePointForFrame(services, sessionId, frameId, point, pageSessionId = sessionId) {
    if (!point ||
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y) ||
        !frameId ||
        sessionId !== pageSessionId) {
        return point;
    }
    const owner = await services.cdp("DOM.getFrameOwner", { frameId }, pageSessionId);
    const backendNodeId = owner?.backendNodeId;
    if (backendNodeId === undefined || backendNodeId === null) {
        throw new Error(`page action could not resolve iframe ${frameId}`);
    }
    const box = await services.cdp("DOM.getBoxModel", { backendNodeId }, pageSessionId);
    const content = box?.model?.content;
    if (!Array.isArray(content) || content.length < 2) {
        throw new Error(`page action could not resolve iframe ${frameId} position`);
    }
    return { x: point.x + content[0], y: point.y + content[1] };
}
async function cursorPointForElement(services, pageSessionId, targetSessionId, frameId, inputPoint, localPoint, iframeSessions) {
    if (!frameId || targetSessionId === pageSessionId)
        return inputPoint;
    const parents = new Map(iframeSessions.parentFrameIds);
    try {
        const response = await services.cdp("Page.getFrameTree", {}, pageSessionId);
        const collect = (tree, parentId) => {
            const currentFrameId = tree?.frame?.id;
            if (typeof currentFrameId !== "string")
                return;
            parents.set(currentFrameId, tree.frame.parentId ?? parentId);
            for (const child of tree.childFrames || []) {
                collect(child, currentFrameId);
            }
        };
        collect(response?.frameTree, undefined);
    }
    catch {
        // OOPIF ancestry from Target.getTargets remains usable when FrameTree is
        // unavailable or omits cross-process descendants.
    }
    try {
        let point = localPoint;
        let currentFrameId = frameId;
        let currentSessionId = targetSessionId;
        const visited = new Set();
        while (currentFrameId &&
            parents.get(currentFrameId) &&
            !visited.has(currentFrameId)) {
            visited.add(currentFrameId);
            let boundaryFrameId = currentFrameId;
            let parentFrameId = parents.get(boundaryFrameId);
            while (parentFrameId &&
                parents.get(parentFrameId) &&
                (iframeSessions.get(parentFrameId) || pageSessionId) ===
                    currentSessionId) {
                boundaryFrameId = parentFrameId;
                parentFrameId = parents.get(boundaryFrameId);
            }
            const parentSessionId = parentFrameId
                ? iframeSessions.get(parentFrameId) || pageSessionId
                : pageSessionId;
            point = (await pagePointForFrame(services, parentSessionId, boundaryFrameId, point));
            currentFrameId = parentFrameId;
            currentSessionId = parentSessionId;
        }
        return point;
    }
    catch {
        return inputPoint;
    }
}
async function assertElementReceivesPointerEvents(services, sessionId, objectId, point) {
    const expression = `function(point) {
    ${HIT_TARGET_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    const interceptor = interceptingElementAtPoint(this, point);
    return interceptor
      ? { error: describeHitTarget(interceptor) + " intercepts pointer events" }
      : { ok: true };
  }`;
    const response = await services.cdp("Runtime.callFunctionOn", {
        functionDeclaration: expression,
        objectId,
        arguments: [{ value: point }],
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    const result = runtimeValue(response, expression);
    if (typeof result?.error === "string") {
        throw new ElementResolutionError(`page.click failed: ${result.error}`, "transient");
    }
}
async function assertElementEnabled(services, sessionId, objectId, actionName) {
    const expression = `function() {
    ${ACTION_TARGET_STATE_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    return isActionTargetDisabled(this)
      ? { error: "element is disabled" }
      : { ok: true };
  }`;
    const response = await services.cdp("Runtime.callFunctionOn", {
        functionDeclaration: expression,
        objectId,
        returnByValue: true,
        awaitPromise: false,
    }, sessionId);
    const result = runtimeValue(response, expression);
    if (typeof result?.error === "string") {
        throw new ElementResolutionError(`${actionName} failed: ${result.error}`, "transient");
    }
}
function fillPreparationError(message) {
    const transient = new Set([
        "element is not connected",
        "element is not visible",
        "element is disabled",
        "element is read only",
    ]);
    return transient.has(message)
        ? new ElementResolutionError(`page.fill failed: ${message}`, "transient")
        : new Error(`page.fill failed: ${message}`);
}
function exceptionDescription(response) {
    return (response?.exceptionDetails?.exception?.description ||
        response?.exceptionDetails?.text ||
        "page action evaluation failed");
}
function assertPageSelector(selector) {
    if (typeof selector !== "string" || selector.trim().length === 0) {
        throw new TypeError("Page actions require a non-empty selector string");
    }
}
function cdpAdapter$2(services) {
    return {
        sendRaw(method, params, sessionId) {
            return services.cdp(method, params, sessionId);
        },
    };
}
async function dispatchMouseEvent(services, sessionId, params, cursorPoint) {
    await services.cdp("Input.dispatchMouseEvent", params, sessionId);
    if (params.type !== "mouseMoved" ||
        typeof params.x !== "number" ||
        typeof params.y !== "number") {
        return;
    }
    showAgentCursor(services, cursorPoint || { x: params.x, y: params.y });
}
function showAgentCursor(services, point) {
    const x = point?.x;
    const y = point?.y;
    if (typeof x !== "number" ||
        !Number.isFinite(x) ||
        typeof y !== "number" ||
        !Number.isFinite(y)) {
        return;
    }
    try {
        // The native cursor is a display-only hint. Start it while the Page gate
        // still owns the correct task space, but never let rendering latency or an
        // unavailable overlay affect a completed website action.
        void services.showAgentMousePosition(x, y).catch(() => { });
    }
    catch {
        // Also tolerate an invalid adapter that throws before returning a Promise.
    }
}
function showAgentActionLabel(services, label) {
    if (!label)
        return;
    try {
        // Labels are display-only, like the native cursor. Start the update before
        // the pointer event but never let a rendering problem block the action.
        void services.showAgentTaskState(label).catch(() => { });
    }
    catch {
        // Also tolerate an invalid adapter that throws before returning a Promise.
    }
}
async function releaseObject$1(services, sessionId, objectId) {
    await services
        .cdp("Runtime.releaseObject", { objectId }, sessionId)
        .catch(() => { });
}
function assertPoint(x, y, operation) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new TypeError(`${operation} requires finite x and y coordinates`);
    }
}
function mouseButtonMask(button) {
    return pressedButtons(button);
}
function pressedButtons(button) {
    if (button === "left")
        return 1;
    if (button === "right")
        return 2;
    return 4;
}

const RESOLVE_FILE_INPUT_SOURCE = `function resolveFileInputForUpload() {
  ${COMPOSED_TREE_HELPERS}
  const isFileInput = (element) =>
    String(element?.tagName || "").toUpperCase() === "INPUT" &&
    String(element.type || "").toLowerCase() === "file";
  if (isFileInput(this)) return this;
  const isFileLabel = (element) =>
    String(element?.tagName || "").toUpperCase() === "LABEL" &&
    isFileInput(element.control);
  if (isFileLabel(this)) {
    return this.control;
  }
  const label = nearestComposedAncestor(this, isFileLabel);
  if (label) return label.control;
  const descendants = composedDescendantMatches(this, isFileInput, true);
  if (descendants.length === 1) return descendants[0];
  if (descendants.length > 1) {
    throw new TypeError(
      "page.setInputFiles selected a container with multiple file inputs",
    );
  }
  throw new TypeError(
    "page.setInputFiles requires a file input, its label, or a container with a file input",
  );
}`;
/** Set one or more local files on an input in one explicit Page session. */
async function setInputFilesInPage(services, sessionId, refMap, selector, path, iframeSessions = new Map()) {
    const files = normalizeFilePaths(path, "page.setInputFiles");
    const resolved = await resolveElementObjectId(cdpAdapter$1(services), sessionId, refMap, selector, iframeSessions, { strict: true });
    let inputObjectId;
    try {
        const input = await services.cdp("Runtime.callFunctionOn", {
            functionDeclaration: RESOLVE_FILE_INPUT_SOURCE,
            objectId: resolved.objectId,
            returnByValue: false,
            awaitPromise: false,
        }, resolved.sessionId);
        if (input?.exceptionDetails) {
            throw new TypeError(input.exceptionDetails.exception?.description ||
                input.exceptionDetails.text ||
                "page.setInputFiles could not resolve a file input");
        }
        inputObjectId = input?.result?.objectId;
        if (!inputObjectId) {
            throw new TypeError("page.setInputFiles could not resolve a file input");
        }
        await setFilesOnBackendNode(services, resolved.sessionId, files, undefined, inputObjectId);
    }
    finally {
        if (inputObjectId && inputObjectId !== resolved.objectId) {
            await releaseObject(services, resolved.sessionId, inputObjectId);
        }
        await releaseObject(services, resolved.sessionId, resolved.objectId);
    }
}
/** Validate local file paths without touching the operating-system chooser. */
function normalizeFilePaths(path, methodName) {
    const files = Array.isArray(path) ? path : [path];
    if (files.some((file) => typeof file !== "string" || file.length === 0 || !isAbsolute(file))) {
        throw new TypeError(`${methodName} requires absolute file paths`);
    }
    return files;
}
/** Set files using the file input identity supplied by a chooser event. */
async function setFilesOnBackendNode(services, sessionId, files, backendNodeId, objectId) {
    await services.cdp("DOM.setFileInputFiles", {
        files,
        ...(backendNodeId === undefined ? {} : { backendNodeId }),
        ...(objectId === undefined ? {} : { objectId }),
    }, sessionId);
}
function cdpAdapter$1(services) {
    return {
        sendRaw(method, params, sessionId) {
            return services.cdp(method, params, sessionId);
        },
    };
}
async function releaseObject(services, sessionId, objectId) {
    await services
        .cdp("Runtime.releaseObject", { objectId }, sessionId)
        .catch(() => { });
}

const artifactDirectories = new Set();
const activeInterceptions = new Set();
const activeDownloadTargets = new Set();
/**
 * Arm one Page session for its next download without changing the shared
 * Chromium BrowserContext download behavior.
 */
function preparePageDownload(services, targetId, { timeoutMs }) {
    if (activeDownloadTargets.has(targetId)) {
        throw new Error(`${targetId} is already waiting for a download`);
    }
    activeDownloadTargets.add(targetId);
    const directory = mkdtempSync(join(tmpdir(), "ego-browser-download-"));
    artifactDirectories.add(directory);
    const directoryPromise = Promise.resolve(directory);
    const configuredSessions = new Set();
    let guid;
    let disposed = false;
    let settled = false;
    let filePollTimer;
    let resolveEvent;
    let rejectEvent;
    let resolveCompletion;
    const event = new Promise((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
    });
    void event.catch(() => { });
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });
    const resetBehavior = async () => {
        const sessions = [...configuredSessions];
        configuredSessions.clear();
        await Promise.all(sessions.map((sessionId) => services
            .cdp("Page.setDownloadBehavior", { behavior: "default" }, sessionId, 1_000)
            .catch(() => { })));
    };
    const finish = async (result) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        if (filePollTimer)
            clearTimeout(filePollTimer);
        unsubscribe();
        activeInterceptions.delete(disposeSynchronously);
        await resetBehavior();
        activeDownloadTargets.delete(targetId);
        resolveCompletion(result);
    };
    const checkForDownloadedFile = async () => {
        filePollTimer = undefined;
        if (disposed || settled || !guid)
            return;
        try {
            const path = await directoryPromise.then(findDownloadedFile);
            if (path) {
                await finish({ path, failure: null });
                return;
            }
        }
        catch (error) {
            await finish({ failure: asError$1(error).message });
            return;
        }
        scheduleFileCheck();
    };
    const scheduleFileCheck = () => {
        if (disposed || settled || filePollTimer)
            return;
        filePollTimer = setTimeout(() => void checkForDownloadedFile(), 50);
    };
    const onEvent = (message) => {
        const params = message?.params;
        if (message?.method === "Page.downloadWillBegin" && !guid) {
            if (typeof params?.guid !== "string" ||
                typeof params?.url !== "string" ||
                typeof params?.suggestedFilename !== "string") {
                return;
            }
            guid = params.guid;
            clearTimeout(timer);
            resolveEvent(new PageDownloadArtifact(services, targetId, params.guid, params.url, params.suggestedFilename, directoryPromise, completion));
            scheduleFileCheck();
            return;
        }
        if (message?.method !== "Page.downloadProgress" || params?.guid !== guid) {
            return;
        }
        if (params.state === "completed") {
            if (filePollTimer)
                clearTimeout(filePollTimer);
            filePollTimer = undefined;
            void checkForDownloadedFile();
        }
        else if (params.state === "canceled") {
            void finish({ failure: "canceled" });
        }
    };
    const unsubscribe = services.subscribePageEvents(targetId, onEvent);
    const disposeSynchronously = () => {
        if (disposed || settled)
            return;
        disposed = true;
        clearTimeout(timer);
        if (filePollTimer)
            clearTimeout(filePollTimer);
        unsubscribe();
        activeDownloadTargets.delete(targetId);
        void resetBehavior();
        rejectEvent(new Error("download waiter was disposed"));
        resolveCompletion({ failure: "download waiter was disposed" });
    };
    activeInterceptions.add(disposeSynchronously);
    const timer = setTimeout(() => {
        if (guid || disposed || settled)
            return;
        disposed = true;
        unsubscribe();
        activeInterceptions.delete(disposeSynchronously);
        void (async () => {
            await resetBehavior();
            activeDownloadTargets.delete(targetId);
            rejectEvent(new Error(`page.waitForEvent("download") timed out after ${timeoutMs}ms`));
            resolveCompletion({ failure: "download did not start" });
            await directoryPromise.then(removeArtifactDirectory);
        })();
    }, timeoutMs);
    return {
        async ready(sessionId) {
            if (disposed || settled) {
                throw new Error("download waiter is no longer active");
            }
            const downloadPath = await directoryPromise;
            await services.cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath }, sessionId);
            configuredSessions.add(sessionId);
        },
        event,
        async dispose(reason = new Error("download waiter was disposed")) {
            if (disposed || settled)
                return;
            disposed = true;
            clearTimeout(timer);
            if (filePollTimer)
                clearTimeout(filePollTimer);
            unsubscribe();
            activeInterceptions.delete(disposeSynchronously);
            await resetBehavior();
            activeDownloadTargets.delete(targetId);
            rejectEvent(reason);
            resolveCompletion({ failure: reason.message });
            await directoryPromise.then(removeArtifactDirectory);
        },
    };
}
class PageDownloadArtifact {
    url;
    suggestedFilename;
    finished;
    #services;
    #targetId;
    #guid;
    #directory;
    #completion;
    #completionResult;
    constructor(services, targetId, guid, url, suggestedFilename, directory, completion) {
        this.#services = services;
        this.#targetId = targetId;
        this.#guid = guid;
        this.url = url;
        this.suggestedFilename = suggestedFilename;
        this.#directory = directory;
        this.#completion = completion;
        this.finished = completion.then((result) => {
            this.#completionResult = result;
        });
    }
    async saveAs(path) {
        assertAbsolutePath(path, "download.saveAs");
        const sourcePath = await this.path();
        await mkdir(dirname(path), { recursive: true });
        await copyFile(sourcePath, path);
    }
    async path() {
        const result = await this.#completion;
        if (!("path" in result)) {
            throw new Error(`download failed: ${result.failure}`);
        }
        return result.path;
    }
    async failure() {
        return (await this.#completion).failure;
    }
    async cancel() {
        if (this.#completionResult)
            return;
        try {
            const targetInfo = await this.#services.cdp("Target.getTargetInfo", {
                targetId: this.#targetId,
            });
            const browserContextId = targetInfo?.targetInfo?.browserContextId;
            await this.#services.cdp("Browser.cancelDownload", {
                guid: this.#guid,
                ...(typeof browserContextId === "string" ? { browserContextId } : {}),
            });
        }
        catch (error) {
            if (this.#completionResult)
                return;
            throw error;
        }
    }
    async delete() {
        await this.#completion;
        await removeArtifactDirectory(await this.#directory);
    }
}
async function findDownloadedFile(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".crdownload"));
    if (files.length > 1) {
        throw new Error(`download completed with ${files.length} files in its temporary directory`);
    }
    return files.length === 1 ? join(directory, files[0].name) : undefined;
}
async function removeArtifactDirectory(directory) {
    artifactDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
}
function assertAbsolutePath(path, method) {
    if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
        throw new TypeError(`${method} requires an absolute file path`);
    }
}
function asError$1(error) {
    return error instanceof Error ? error : new Error(String(error));
}
/** Remove round-local files and stop pending waits during SDK disposal. */
function disposeDownloadArtifacts() {
    for (const dispose of [...activeInterceptions])
        dispose();
    activeInterceptions.clear();
    activeDownloadTargets.clear();
    for (const directory of artifactDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
    artifactDirectories.clear();
}

const KEYPAD_LOCATION = 3;
const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift"];
const MODIFIER_ALIASES = new Map([
    ["alt", "Alt"],
    ["control", "Control"],
    ["meta", "Meta"],
    ["shift", "Shift"],
    ["controlormeta", "ControlOrMeta"],
]);
const MODIFIER_MASKS = {
    Alt: 1,
    Control: 2,
    Meta: 4,
    Shift: 8,
};
/**
 * Page keyboard state follows Playwright's model: physical keys and modifiers
 * remain pressed until `up`, mouse input can read the same modifier state, and
 * `type` uses real key events for characters present on a US keyboard.
 */
class PageKeyboardController {
    #services;
    #run;
    #runObserved;
    #pressedCodes = new Set();
    #pressedModifiers = new Set();
    constructor(services, run, runObserved = run) {
        this.#services = services;
        this.#run = run;
        this.#runObserved = runObserved;
    }
    modifierMask() {
        return modifierMask(this.#pressedModifiers);
    }
    async down(key) {
        return this.#run((sessionId) => this.#down(sessionId, key));
    }
    async up(key) {
        return this.#run((sessionId) => this.#up(sessionId, key));
    }
    async press(chord, options = {}) {
        return this.#runObserved((sessionId) => this.pressInSession(sessionId, chord, options));
    }
    /** Press a chord inside an existing Page action boundary. */
    async pressInSession(sessionId, chord, options = {}) {
        const tokens = splitChord(chord);
        const pressed = [];
        let actionError;
        try {
            for (const token of tokens) {
                pressed.push(token);
                await this.#down(sessionId, token);
            }
            if (options.delay)
                await this.#services.sleep(options.delay);
        }
        catch (error) {
            actionError = error;
        }
        let releaseError;
        // Releasing in reverse order prevents a failed shortcut from leaving a
        // modifier held for every later mouse or keyboard action on this Page.
        for (const token of pressed.reverse()) {
            try {
                await this.#up(sessionId, token);
            }
            catch (error) {
                releaseError ??= error;
            }
        }
        if (actionError)
            throw actionError;
        if (releaseError)
            throw releaseError;
    }
    async paste(content) {
        assertClipboardContent(content);
        return this.#runObserved((sessionId) => this.#services.withTemporaryClipboardText(content, () => this.pressInSession(sessionId, "ControlOrMeta+V")));
    }
    async insertText(text) {
        assertText(text, "page.keyboard.insertText");
        return this.#run((sessionId) => this.#insertText(sessionId, text));
    }
    async type(text, options = {}) {
        assertText(text, "page.keyboard.type");
        return this.#run(async (sessionId) => {
            for (const character of text) {
                if (keyboardLayout.has(character)) {
                    await this.#down(sessionId, character);
                    if (options.delay)
                        await this.#services.sleep(options.delay);
                    await this.#up(sessionId, character);
                }
                else {
                    if (options.delay)
                        await this.#services.sleep(options.delay);
                    await this.#insertText(sessionId, character);
                }
            }
        });
    }
    async #down(sessionId, input) {
        const keyName = resolveSmartModifier(input, this.#services.platform);
        const definition = keyDefinitionForString(keyName, this.#pressedModifiers.has("Shift"));
        const autoRepeat = this.#pressedCodes.has(definition.code);
        this.#pressedCodes.add(definition.code);
        if (isModifier(definition.key)) {
            this.#pressedModifiers.add(definition.key);
        }
        const text = keyText(definition, this.#pressedModifiers);
        const commands = editingCommands(definition.code, this.#pressedModifiers, this.#services.platform);
        await dispatchKey(this.#services, sessionId, {
            type: text ? "keyDown" : "rawKeyDown",
            modifiers: this.modifierMask(),
            windowsVirtualKeyCode: definition.keyCodeWithoutLocation,
            code: definition.code,
            commands,
            key: definition.key,
            text,
            unmodifiedText: text,
            autoRepeat,
            location: definition.location,
            isKeypad: definition.location === KEYPAD_LOCATION,
        });
    }
    async #up(sessionId, input) {
        const keyName = resolveSmartModifier(input, this.#services.platform);
        const definition = keyDefinitionForString(keyName, this.#pressedModifiers.has("Shift"));
        if (isModifier(definition.key)) {
            this.#pressedModifiers.delete(definition.key);
        }
        this.#pressedCodes.delete(definition.code);
        await dispatchKey(this.#services, sessionId, {
            type: "keyUp",
            modifiers: this.modifierMask(),
            key: definition.key,
            windowsVirtualKeyCode: definition.keyCodeWithoutLocation,
            code: definition.code,
            location: definition.location,
        });
    }
    async #insertText(sessionId, text) {
        await this.#services.cdp("Input.insertText", { text }, sessionId);
    }
}
function assertClipboardContent(content) {
    if (typeof content === "string")
        return;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
        throw new TypeError("page.keyboard.paste requires a string or { text, html? }");
    }
    const value = content;
    const unknown = Object.keys(value).find((key) => key !== "text" && key !== "html");
    if (unknown) {
        throw new TypeError(`page.keyboard.paste received unknown content field: ${unknown}`);
    }
    if (typeof value.text !== "string") {
        throw new TypeError("page.keyboard.paste content.text must be a string");
    }
    if (value.html !== undefined && typeof value.html !== "string") {
        throw new TypeError("page.keyboard.paste content.html must be a string");
    }
}
/** Split a chord without losing a literal `+` key, matching Playwright. */
function splitChord(chord) {
    if (typeof chord !== "string" || chord.length === 0) {
        throw new TypeError("page.keyboard.press requires a non-empty key");
    }
    const tokens = [];
    let building = "";
    for (const character of chord) {
        if (character === "+" && building) {
            tokens.push(building);
            building = "";
        }
        else {
            building += character;
        }
    }
    tokens.push(building);
    if (tokens.some((token) => token.length === 0)) {
        throw new TypeError(`page.keyboard.press received invalid chord: ${chord}`);
    }
    return tokens;
}
function resolveSmartModifier(key, platform = process.platform) {
    const lower = key.toLowerCase();
    const normalized = MODIFIER_ALIASES.get(lower) ?? NAMED_KEY_NAMES.get(lower) ?? key;
    if (normalized === "ControlOrMeta") {
        return platform === "darwin" ? "Meta" : "Control";
    }
    return normalized;
}
function keyDefinitionForString(input, shift) {
    const definition = keyboardLayout.get(input);
    if (!definition) {
        const arrow = new Map([
            ["Left", "ArrowLeft"],
            ["Right", "ArrowRight"],
            ["Up", "ArrowUp"],
            ["Down", "ArrowDown"],
        ]).get(input);
        const hint = arrow ? `. Use ${JSON.stringify(arrow)}` : "";
        throw new Error(`Unknown key: ${JSON.stringify(input)}${hint}`);
    }
    return shift && definition.shifted ? definition.shifted : definition;
}
function keyText(definition, modifiers) {
    if (modifiers.size > 1)
        return "";
    if (modifiers.size === 1 && !modifiers.has("Shift"))
        return "";
    return definition.text;
}
function isModifier(key) {
    return MODIFIER_NAMES.includes(key);
}
function modifierMask(modifiers) {
    let mask = 0;
    for (const modifier of MODIFIER_NAMES) {
        if (modifiers.has(modifier))
            mask |= MODIFIER_MASKS[modifier];
    }
    return mask;
}
async function dispatchKey(services, sessionId, params) {
    await services.cdp("Input.dispatchKeyEvent", params, sessionId);
}
function assertText(value, operation) {
    if (typeof value !== "string") {
        throw new TypeError(`${operation} text must be a string`);
    }
}
function buildKeyboardLayout() {
    const entries = {
        Escape: { keyCode: 27, key: "Escape" },
        Backquote: { keyCode: 192, key: "`", shiftKey: "~" },
        Minus: { keyCode: 189, key: "-", shiftKey: "_" },
        Equal: { keyCode: 187, key: "=", shiftKey: "+" },
        Backslash: { keyCode: 220, key: "\\", shiftKey: "|" },
        Backspace: { keyCode: 8, key: "Backspace" },
        Tab: { keyCode: 9, key: "Tab" },
        BracketLeft: { keyCode: 219, key: "[", shiftKey: "{" },
        BracketRight: { keyCode: 221, key: "]", shiftKey: "}" },
        CapsLock: { keyCode: 20, key: "CapsLock" },
        Semicolon: { keyCode: 186, key: ";", shiftKey: ":" },
        Quote: { keyCode: 222, key: "'", shiftKey: '"' },
        Enter: { keyCode: 13, key: "Enter", text: "\r" },
        ShiftLeft: {
            keyCode: 160,
            keyCodeWithoutLocation: 16,
            key: "Shift",
            location: 1,
        },
        ShiftRight: {
            keyCode: 161,
            keyCodeWithoutLocation: 16,
            key: "Shift",
            location: 2,
        },
        Comma: { keyCode: 188, key: ",", shiftKey: "<" },
        Period: { keyCode: 190, key: ".", shiftKey: ">" },
        Slash: { keyCode: 191, key: "/", shiftKey: "?" },
        ControlLeft: {
            keyCode: 162,
            keyCodeWithoutLocation: 17,
            key: "Control",
            location: 1,
        },
        MetaLeft: { keyCode: 91, key: "Meta", location: 1 },
        AltLeft: {
            keyCode: 164,
            keyCodeWithoutLocation: 18,
            key: "Alt",
            location: 1,
        },
        Space: { keyCode: 32, key: " " },
        AltRight: {
            keyCode: 165,
            keyCodeWithoutLocation: 18,
            key: "Alt",
            location: 2,
        },
        AltGraph: { keyCode: 225, key: "AltGraph" },
        MetaRight: { keyCode: 92, key: "Meta", location: 2 },
        ContextMenu: { keyCode: 93, key: "ContextMenu" },
        ControlRight: {
            keyCode: 163,
            keyCodeWithoutLocation: 17,
            key: "Control",
            location: 2,
        },
        PrintScreen: { keyCode: 44, key: "PrintScreen" },
        ScrollLock: { keyCode: 145, key: "ScrollLock" },
        Pause: { keyCode: 19, key: "Pause" },
        PageUp: { keyCode: 33, key: "PageUp" },
        PageDown: { keyCode: 34, key: "PageDown" },
        Insert: { keyCode: 45, key: "Insert" },
        Delete: { keyCode: 46, key: "Delete" },
        Home: { keyCode: 36, key: "Home" },
        End: { keyCode: 35, key: "End" },
        ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
        ArrowUp: { keyCode: 38, key: "ArrowUp" },
        ArrowRight: { keyCode: 39, key: "ArrowRight" },
        ArrowDown: { keyCode: 40, key: "ArrowDown" },
        NumLock: { keyCode: 144, key: "NumLock" },
        NumpadDivide: { keyCode: 111, key: "/", location: 3 },
        NumpadMultiply: { keyCode: 106, key: "*", location: 3 },
        NumpadSubtract: { keyCode: 109, key: "-", location: 3 },
        NumpadAdd: { keyCode: 107, key: "+", location: 3 },
        NumpadDecimal: {
            keyCode: 46,
            shiftKeyCode: 110,
            key: "\0",
            shiftKey: ".",
            location: 3,
        },
        NumpadEnter: { keyCode: 13, key: "Enter", text: "\r", location: 3 },
    };
    for (let number = 0; number <= 9; number += 1) {
        const shifted = ")!@#$%^&*("[number];
        entries[`Digit${number}`] = {
            keyCode: 48 + number,
            key: String(number),
            shiftKey: shifted,
        };
    }
    for (let index = 0; index < 26; index += 1) {
        const upper = String.fromCharCode(65 + index);
        entries[`Key${upper}`] = {
            keyCode: 65 + index,
            key: upper.toLowerCase(),
            shiftKey: upper,
        };
    }
    for (let number = 1; number <= 12; number += 1) {
        entries[`F${number}`] = { keyCode: 111 + number, key: `F${number}` };
    }
    const numpad = [
        ["Numpad7", 36, 103, "Home", "7"],
        ["Numpad8", 38, 104, "ArrowUp", "8"],
        ["Numpad9", 33, 105, "PageUp", "9"],
        ["Numpad4", 37, 100, "ArrowLeft", "4"],
        ["Numpad5", 12, 101, "Clear", "5"],
        ["Numpad6", 39, 102, "ArrowRight", "6"],
        ["Numpad1", 35, 97, "End", "1"],
        ["Numpad2", 40, 98, "ArrowDown", "2"],
        ["Numpad3", 34, 99, "PageDown", "3"],
        ["Numpad0", 45, 96, "Insert", "0"],
    ];
    for (const [code, keyCode, shiftKeyCode, key, shiftKey] of numpad) {
        entries[code] = {
            keyCode,
            shiftKeyCode,
            key,
            shiftKey,
            location: 3,
        };
    }
    const layout = new Map();
    for (const [code, entry] of Object.entries(entries)) {
        const definition = {
            code,
            key: entry.key,
            keyCode: entry.keyCode,
            keyCodeWithoutLocation: entry.keyCodeWithoutLocation ?? entry.keyCode,
            location: entry.location ?? 0,
            text: entry.text ?? (entry.key.length === 1 ? entry.key : ""),
        };
        if (entry.shiftKey) {
            definition.shifted = {
                ...definition,
                key: entry.shiftKey,
                keyCode: entry.shiftKeyCode ?? definition.keyCode,
                keyCodeWithoutLocation: definition.keyCodeWithoutLocation,
                text: entry.shiftKey,
            };
        }
        layout.set(code, definition);
        // Character input should resolve to the main keyboard, never to the numpad.
        // Numpad shifted keys expose digits, so indexing them would overwrite Digit0-9.
        if (definition.location !== 0)
            continue;
        if (definition.key.length === 1) {
            layout.set(definition.key, definition);
        }
        if (definition.shifted) {
            layout.set(definition.shifted.key, {
                ...definition.shifted,
                shifted: undefined,
            });
        }
    }
    const aliases = {
        Alt: "AltLeft",
        Control: "ControlLeft",
        Meta: "MetaLeft",
        Shift: "ShiftLeft",
        " ": "Space",
        "\n": "Enter",
        "\r": "Enter",
    };
    for (const [alias, code] of Object.entries(aliases)) {
        layout.set(alias, layout.get(code));
    }
    return layout;
}
const keyboardLayout = buildKeyboardLayout();
const NAMED_KEY_NAMES = new Map([...keyboardLayout.keys()]
    .filter((key) => key.length > 1)
    .map((key) => [key.toLowerCase(), key]));
function editingCommands(code, modifiers, platform = process.platform) {
    if (platform !== "darwin")
        return [];
    const parts = [];
    for (const modifier of ["Shift", "Control", "Alt", "Meta"]) {
        if (modifiers.has(modifier))
            parts.push(modifier);
    }
    parts.push(code);
    const value = MAC_EDITING_COMMANDS[parts.join("+")];
    const commands = value === undefined ? [] : Array.isArray(value) ? value : [value];
    return commands
        .filter((command) => !command.startsWith("insert"))
        .map((command) => command.slice(0, -1));
}
// Chromium requires macOS editing commands explicitly on raw key events.
// This is the same platform command set used by Playwright's Chromium driver.
const MAC_EDITING_COMMANDS = {
    Backspace: "deleteBackward:",
    Enter: "insertNewline:",
    NumpadEnter: "insertNewline:",
    Escape: "cancelOperation:",
    ArrowUp: "moveUp:",
    ArrowDown: "moveDown:",
    ArrowLeft: "moveLeft:",
    ArrowRight: "moveRight:",
    F5: "complete:",
    Delete: "deleteForward:",
    Home: "scrollToBeginningOfDocument:",
    End: "scrollToEndOfDocument:",
    PageUp: "scrollPageUp:",
    PageDown: "scrollPageDown:",
    "Shift+Backspace": "deleteBackward:",
    "Shift+Enter": "insertNewline:",
    "Shift+NumpadEnter": "insertNewline:",
    "Shift+Escape": "cancelOperation:",
    "Shift+ArrowUp": "moveUpAndModifySelection:",
    "Shift+ArrowDown": "moveDownAndModifySelection:",
    "Shift+ArrowLeft": "moveLeftAndModifySelection:",
    "Shift+ArrowRight": "moveRightAndModifySelection:",
    "Shift+F5": "complete:",
    "Shift+Delete": "deleteForward:",
    "Shift+Home": "moveToBeginningOfDocumentAndModifySelection:",
    "Shift+End": "moveToEndOfDocumentAndModifySelection:",
    "Shift+PageUp": "pageUpAndModifySelection:",
    "Shift+PageDown": "pageDownAndModifySelection:",
    "Shift+Numpad5": "delete:",
    "Control+Tab": "selectNextKeyView:",
    "Control+Enter": "insertLineBreak:",
    "Control+NumpadEnter": "insertLineBreak:",
    "Control+Quote": "insertSingleQuoteIgnoringSubstitution:",
    "Control+KeyA": "moveToBeginningOfParagraph:",
    "Control+KeyB": "moveBackward:",
    "Control+KeyD": "deleteForward:",
    "Control+KeyE": "moveToEndOfParagraph:",
    "Control+KeyF": "moveForward:",
    "Control+KeyH": "deleteBackward:",
    "Control+KeyK": "deleteToEndOfParagraph:",
    "Control+KeyL": "centerSelectionInVisibleArea:",
    "Control+KeyN": "moveDown:",
    "Control+KeyO": ["insertNewlineIgnoringFieldEditor:", "moveBackward:"],
    "Control+KeyP": "moveUp:",
    "Control+KeyT": "transpose:",
    "Control+KeyV": "pageDown:",
    "Control+KeyY": "yank:",
    "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
    "Control+ArrowUp": "scrollPageUp:",
    "Control+ArrowDown": "scrollPageDown:",
    "Control+ArrowLeft": "moveToLeftEndOfLine:",
    "Control+ArrowRight": "moveToRightEndOfLine:",
    "Shift+Control+Enter": "insertLineBreak:",
    "Shift+Control+NumpadEnter": "insertLineBreak:",
    "Shift+Control+Tab": "selectPreviousKeyView:",
    "Shift+Control+Quote": "insertDoubleQuoteIgnoringSubstitution:",
    "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection:",
    "Shift+Control+KeyB": "moveBackwardAndModifySelection:",
    "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection:",
    "Shift+Control+KeyF": "moveForwardAndModifySelection:",
    "Shift+Control+KeyN": "moveDownAndModifySelection:",
    "Shift+Control+KeyP": "moveUpAndModifySelection:",
    "Shift+Control+KeyV": "pageDownAndModifySelection:",
    "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
    "Shift+Control+ArrowUp": "scrollPageUp:",
    "Shift+Control+ArrowDown": "scrollPageDown:",
    "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
    "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
    "Alt+Backspace": "deleteWordBackward:",
    "Alt+Enter": "insertNewlineIgnoringFieldEditor:",
    "Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
    "Alt+Escape": "complete:",
    "Alt+ArrowUp": ["moveBackward:", "moveToBeginningOfParagraph:"],
    "Alt+ArrowDown": ["moveForward:", "moveToEndOfParagraph:"],
    "Alt+ArrowLeft": "moveWordLeft:",
    "Alt+ArrowRight": "moveWordRight:",
    "Alt+Delete": "deleteWordForward:",
    "Alt+PageUp": "pageUp:",
    "Alt+PageDown": "pageDown:",
    "Shift+Alt+Backspace": "deleteWordBackward:",
    "Shift+Alt+Enter": "insertNewlineIgnoringFieldEditor:",
    "Shift+Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
    "Shift+Alt+Escape": "complete:",
    "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection:",
    "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection:",
    "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection:",
    "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection:",
    "Shift+Alt+Delete": "deleteWordForward:",
    "Shift+Alt+PageUp": "pageUp:",
    "Shift+Alt+PageDown": "pageDown:",
    "Control+Alt+KeyB": "moveWordBackward:",
    "Control+Alt+KeyF": "moveWordForward:",
    "Control+Alt+Backspace": "deleteWordBackward:",
    "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection:",
    "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection:",
    "Shift+Control+Alt+Backspace": "deleteWordBackward:",
    "Meta+NumpadSubtract": "cancel:",
    "Meta+Backspace": "deleteToBeginningOfLine:",
    "Meta+ArrowUp": "moveToBeginningOfDocument:",
    "Meta+ArrowDown": "moveToEndOfDocument:",
    "Meta+ArrowLeft": "moveToLeftEndOfLine:",
    "Meta+ArrowRight": "moveToRightEndOfLine:",
    "Shift+Meta+NumpadSubtract": "cancel:",
    "Shift+Meta+Backspace": "deleteToBeginningOfLine:",
    "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection:",
    "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection:",
    "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
    "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
    "Meta+KeyA": "selectAll:",
    "Meta+KeyC": "copy:",
    "Meta+KeyX": "cut:",
    "Meta+KeyV": "paste:",
    "Meta+KeyZ": "undo:",
    "Shift+Meta+KeyZ": "redo:",
};

const SELECTOR_POLL_INTERVAL_MS = 100;
/** How often a polling wait re-enumerates iframe sessions to catch late frames. */
const FRAME_DISCOVERY_REFRESH_INTERVAL_MS = 500;
/**
 * An element failure worth another resolution attempt: the resolver reported a
 * transient state, or a frame vanished mid-resolution. Session loss is not
 * included; callers decide whether the lost session was the Page itself.
 */
function isTransientElementError(error) {
    return (isFrameLifecycleError(error) ||
        (error instanceof ElementResolutionError && error.kind === "transient"));
}
class PageNavigationTimeoutError extends Error {
    code = "EGO_NAVIGATION_TIMEOUT";
    committed;
    url;
    readyState;
    waitUntil;
    timeoutMs;
    constructor(message, details) {
        super(message);
        this.name = "PageNavigationTimeoutError";
        this.committed = details.committed;
        this.url = details.url;
        this.readyState = details.readyState;
        this.waitUntil = details.waitUntil;
        this.timeoutMs = details.timeoutMs;
    }
}
const VISIBILITY_FUNCTION = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);const r=this.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0;}";
/** Wait for a selector inside one explicit Page session. */
async function waitForSelectorInPage(services, sessionId, refMap, selector, options = {}, getIframeSessions) {
    if (typeof selector !== "string" || selector.length === 0) {
        throw new TypeError("page.waitForSelector selector must be a non-empty string");
    }
    const timeoutMs = options.timeout ?? 10_000;
    const state = options.state ?? "visible";
    const deadline = services.now() + timeoutMs;
    let iframeSessions;
    let refreshFrames = false;
    let nextDiscoveryAt = 0;
    while (true) {
        let resolved;
        try {
            if (!iframeSessions ||
                (refreshFrames && services.now() >= nextDiscoveryAt)) {
                iframeSessions = await getIframeSessions(Math.max(1, deadline - services.now()));
                nextDiscoveryAt = services.now() + FRAME_DISCOVERY_REFRESH_INTERVAL_MS;
                refreshFrames = false;
            }
            resolved = await resolveElementObjectId(cdpAdapter(services), sessionId, refMap, selector, iframeSessions);
            if (state === "attached")
                return true;
            if (state !== "detached") {
                const response = await services.cdp("Runtime.callFunctionOn", {
                    functionDeclaration: VISIBILITY_FUNCTION,
                    objectId: resolved.objectId,
                    returnByValue: true,
                    awaitPromise: false,
                }, resolved.sessionId);
                const visible = response?.result?.value === true;
                if (state === "visible" ? visible : !visible)
                    return true;
            }
        }
        catch (error) {
            // Frame discovery is bounded by the remaining budget; a transport timeout
            // at the deadline is this wait's own timeout, not a distinct failure.
            if (isCdpRequestTimeoutError(error) && deadline - services.now() <= 0) {
                break;
            }
            if (!isRetryableSelectorWaitError(error, sessionId)) {
                throw error;
            }
            if (error instanceof ElementResolutionError) {
                if (state === "detached" || state === "hidden")
                    return true;
                // The element may live in an iframe that appears later; re-enumerate
                // frames at a throttled cadence while polling.
                refreshFrames = true;
            }
            else {
                // A frame or its session vanished: rediscover before the next attempt.
                refreshFrames = true;
                nextDiscoveryAt = 0;
            }
        }
        finally {
            if (resolved?.objectId) {
                await services
                    .cdp("Runtime.releaseObject", { objectId: resolved.objectId }, resolved.sessionId)
                    .catch(() => { });
            }
        }
        const remaining = deadline - services.now();
        if (remaining <= 0)
            break;
        await services.sleep(Math.min(SELECTOR_POLL_INTERVAL_MS, remaining));
    }
    throw new Error(`page.waitForSelector timed out after ${timeoutMs}ms: ${selector}`);
}
function isRetryableSelectorWaitError(error, pageSessionId) {
    if (isTransientElementError(error) ||
        isTransientNavigationContextError(error))
        return true;
    // A lost iframe session is recovered by rediscovery. A lost Page session is
    // terminal: never report a closed page as "hidden" or keep polling it.
    return (isSessionLostError(error) &&
        typeof error.sessionId === "string" &&
        error.sessionId !== pageSessionId);
}
/** Wait until one Page URL matches an exact string, glob, RegExp, or predicate. */
async function waitForURLInPage(services, sessionId, expected, options = {}, hooks = {}) {
    const matcher = compilePageURLMatcher(expected);
    const timeoutMs = options.timeout ?? 10_000;
    const deadline = services.now() + timeoutMs;
    let lastUrl = "";
    while (services.now() <= deadline) {
        const remaining = Math.max(1, deadline - services.now());
        let response;
        try {
            response = await services.cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId, Math.min(1_000, remaining));
        }
        catch (error) {
            if (isRuntimeEvaluateTimeout(error)) {
                if (services.now() >= deadline)
                    break;
            }
            else if (!isTransientNavigationContextError(error)) {
                throw error;
            }
        }
        if (typeof response?.result?.value === "string") {
            lastUrl = response.result.value;
            if (matcher.matches(lastUrl))
                return;
        }
        const interruption = hooks.interrupt?.(lastUrl, matcher.matches);
        if (interruption)
            throw interruption;
        const waitMs = deadline - services.now();
        if (waitMs <= 0)
            break;
        await services.sleep(Math.min(100, waitMs));
    }
    throw new Error(`page.waitForURL timed out after ${timeoutMs}ms: expected ${matcher.description}; last URL was ${JSON.stringify(lastUrl)}`);
}
function compilePageURLMatcher(expected) {
    if (typeof expected === "string") {
        if (expected.length === 0) {
            throw invalidPageURLMatcherError();
        }
        const pattern = urlGlobToRegExp(expected);
        return {
            matches: (url) => pattern.test(url),
            description: JSON.stringify(expected),
        };
    }
    if (expected instanceof RegExp) {
        const pattern = new RegExp(expected.source, expected.flags);
        return {
            matches(url) {
                pattern.lastIndex = 0;
                return pattern.test(url);
            },
            description: pattern.toString(),
        };
    }
    if (typeof expected === "function") {
        return {
            matches(url) {
                let parsed;
                try {
                    parsed = new URL(url);
                }
                catch {
                    return false;
                }
                const result = expected(parsed);
                if (typeof result !== "boolean") {
                    throw new TypeError("page.waitForURL predicate must return a boolean synchronously");
                }
                return result;
            },
            description: "a URL predicate",
        };
    }
    throw invalidPageURLMatcherError();
}
function invalidPageURLMatcherError() {
    return new TypeError("page.waitForURL expected URL must be a non-empty string, RegExp, or function");
}
const URL_REGEX_SPECIAL_CHARS = new Set([
    "$",
    "^",
    "+",
    ".",
    "*",
    "(",
    ")",
    "|",
    "\\",
    "?",
    "{",
    "}",
    "[",
    "]",
]);
/** Compile the URL-glob subset used by Playwright string matchers. */
function urlGlobToRegExp(glob) {
    const tokens = ["^"];
    let inGroup = false;
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === "\\" && index + 1 < glob.length) {
            const escaped = glob[(index += 1)];
            tokens.push(URL_REGEX_SPECIAL_CHARS.has(escaped) ? `\\${escaped}` : escaped);
            continue;
        }
        if (char === "*") {
            const charBefore = glob[index - 1];
            let starCount = 1;
            while (glob[index + 1] === "*") {
                starCount += 1;
                index += 1;
            }
            if (starCount === 1) {
                tokens.push("[^/]*");
                continue;
            }
            const charAfter = glob[index + 1];
            if (charAfter === "/") {
                tokens.push(charBefore === "/" ? "(?:(?:.+)/)?" : "(?:.*/)");
                index += 1;
            }
            else {
                tokens.push(".*");
            }
            continue;
        }
        if (char === "{") {
            if (inGroup) {
                throw invalidURLGlobError(glob, "nested '{' is not supported");
            }
            inGroup = true;
            tokens.push("(");
            continue;
        }
        if (char === "}") {
            if (!inGroup)
                throw invalidURLGlobError(glob, "unmatched '}'");
            inGroup = false;
            tokens.push(")");
            continue;
        }
        if (char === "," && inGroup) {
            tokens.push("|");
            continue;
        }
        tokens.push(URL_REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char);
    }
    if (inGroup)
        throw invalidURLGlobError(glob, "unmatched '{'");
    tokens.push("$");
    return new RegExp(tokens.join(""));
}
function invalidURLGlobError(glob, reason) {
    return new TypeError(`Invalid URL glob ${JSON.stringify(glob)}: ${reason}`);
}
/** Navigate one Page and wait for the selected state of this navigation. */
async function navigateInPage(services, sessionId, url, options) {
    const { timeoutMs, waitUntil, referer } = options;
    const deadline = services.now() + timeoutMs;
    let committed = false;
    let navigation = {};
    try {
        // Network tracking must start before Page.navigate or the initial document
        // requests can be missed by a network-idle wait.
        if (waitUntil === "networkidle") {
            await services.ensureNetworkTracking([sessionId], navigationTimeRemaining(services, deadline, timeoutMs, waitUntil));
        }
        const response = await services.cdp("Page.navigate", {
            url,
            ...(referer === undefined ? {} : { referrer: referer }),
        }, sessionId, navigationTimeRemaining(services, deadline, timeoutMs, waitUntil));
        navigation = response?.result || response || {};
        if (navigation.errorText) {
            throw new Error(`page.goto failed: ${navigation.errorText}`);
        }
        if (navigation.isDownload === true) {
            throw new Error("page.goto failed: navigation started a download");
        }
        await waitForNavigationCommit(services, sessionId, navigation, deadline, timeoutMs, waitUntil);
        committed = true;
        if (waitUntil === "commit")
            return;
        await waitForLoadStateInPage(services, sessionId, waitUntil, {
            timeout: navigationTimeRemaining(services, deadline, timeoutMs, waitUntil),
        });
    }
    catch (error) {
        if (services.now() >= deadline || isLoadStateTimeout(error)) {
            if (!committed && navigation.loaderId) {
                committed = await navigationMatchesCurrentFrame(services, sessionId, navigation, 250);
            }
            const state = committed
                ? await currentDocumentState(services, sessionId)
                : {};
            throw navigationTimeout(timeoutMs, waitUntil, {
                committed,
                ...state,
            });
        }
        throw error;
    }
}
/** Reload one Page and wait for the selected state of the new document. */
async function reloadInPage(services, sessionId, options) {
    const { timeoutMs, waitUntil } = options;
    const deadline = services.now() + timeoutMs;
    try {
        const previousFrame = await mainFrame(services, sessionId, reloadTimeRemaining(services, deadline, timeoutMs, waitUntil));
        if (waitUntil === "networkidle") {
            await services.ensureNetworkTracking([sessionId], reloadTimeRemaining(services, deadline, timeoutMs, waitUntil));
        }
        await services.cdp("Page.reload", previousFrame.loaderId === undefined
            ? {}
            : { loaderId: previousFrame.loaderId }, sessionId, reloadTimeRemaining(services, deadline, timeoutMs, waitUntil));
        await waitForReloadCommit(services, sessionId, previousFrame, deadline, timeoutMs, waitUntil);
        if (waitUntil === "commit")
            return;
        await waitForLoadStateInPage(services, sessionId, waitUntil, {
            timeout: reloadTimeRemaining(services, deadline, timeoutMs, waitUntil),
        });
    }
    catch (error) {
        if (services.now() >= deadline || isLoadStateTimeout(error)) {
            throw reloadTimeout(timeoutMs, waitUntil);
        }
        throw error;
    }
}
async function mainFrame(services, sessionId, timeoutMs) {
    const response = await services.cdp("Page.getFrameTree", {}, sessionId, timeoutMs);
    return response?.result?.frameTree?.frame || response?.frameTree?.frame || {};
}
async function waitForReloadCommit(services, sessionId, previousFrame, deadline, timeoutMs, waitUntil) {
    while (services.now() <= deadline) {
        const remaining = reloadTimeRemaining(services, deadline, timeoutMs, waitUntil);
        try {
            const frame = await mainFrame(services, sessionId, Math.min(1_000, remaining));
            if (frame.loaderId &&
                (frame.loaderId !== previousFrame.loaderId ||
                    (previousFrame.id && frame.id !== previousFrame.id))) {
                return;
            }
        }
        catch (error) {
            if (!isCdpTimeout(error, "Page.getFrameTree"))
                throw error;
        }
        const waitMs = deadline - services.now();
        if (waitMs <= 0)
            break;
        await services.sleep(Math.min(50, waitMs));
    }
    throw reloadTimeout(timeoutMs, waitUntil);
}
function reloadTimeRemaining(services, deadline, timeoutMs, waitUntil) {
    const remaining = deadline - services.now();
    if (remaining <= 0)
        throw reloadTimeout(timeoutMs, waitUntil);
    return remaining;
}
function reloadTimeout(timeoutMs, waitUntil) {
    return new Error(`page.reload timed out after ${timeoutMs}ms waiting for ${waitUntil}`);
}
async function waitForNavigationCommit(services, sessionId, navigation, deadline, timeoutMs, waitUntil) {
    // CDP omits loaderId for a same-document navigation. Page.navigate has
    // already committed that URL change, and the existing document has already
    // passed its DOMContentLoaded and load boundaries.
    if (!navigation.loaderId)
        return;
    while (services.now() <= deadline) {
        const remaining = navigationTimeRemaining(services, deadline, timeoutMs, waitUntil);
        try {
            const response = await services.cdp("Page.getFrameTree", {}, sessionId, Math.min(1_000, remaining));
            const frame = response?.result?.frameTree?.frame || response?.frameTree?.frame;
            if (frame?.loaderId === navigation.loaderId &&
                (!navigation.frameId || frame?.id === navigation.frameId)) {
                return;
            }
        }
        catch (error) {
            if (!isCdpTimeout(error, "Page.getFrameTree"))
                throw error;
        }
        const waitMs = deadline - services.now();
        if (waitMs <= 0)
            break;
        await services.sleep(Math.min(50, waitMs));
    }
    throw navigationTimeout(timeoutMs, waitUntil);
}
async function navigationMatchesCurrentFrame(services, sessionId, navigation, timeoutMs) {
    try {
        const response = await services.cdp("Page.getFrameTree", {}, sessionId, timeoutMs);
        const frame = response?.result?.frameTree?.frame || response?.frameTree?.frame;
        return (Boolean(navigation.loaderId) &&
            frame?.loaderId === navigation.loaderId &&
            (!navigation.frameId || frame?.id === navigation.frameId));
    }
    catch {
        // This is a best-effort timeout diagnostic, not a second navigation path.
        return false;
    }
}
function navigationTimeRemaining(services, deadline, timeoutMs, waitUntil) {
    const remaining = deadline - services.now();
    if (remaining <= 0)
        throw navigationTimeout(timeoutMs, waitUntil);
    return remaining;
}
function navigationTimeout(timeoutMs, waitUntil, details = {}) {
    const committed = details.committed === true;
    const nextStep = navigationTimeoutNextStep(waitUntil);
    const state = committed
        ? `; navigation committed${details.url ? ` at ${JSON.stringify(details.url)}` : ""}${details.readyState ? ` with document.readyState=${JSON.stringify(details.readyState)}` : ""}. ${nextStep}`
        : "";
    return new PageNavigationTimeoutError(`page.goto timed out after ${timeoutMs}ms waiting for ${waitUntil}${state}`, {
        committed,
        url: details.url,
        readyState: details.readyState,
        waitUntil,
        timeoutMs,
    });
}
function navigationTimeoutNextStep(waitUntil) {
    if (waitUntil === "commit") {
        return "Continue on this Page; the requested document has committed.";
    }
    if (waitUntil === "networkidle") {
        return 'Continue when the needed DOM state is observable, or call page.waitForLoadState("networkidle") if network quiescence is required.';
    }
    return `Continue on this Page; call page.waitForLoadState(${JSON.stringify(waitUntil)}) if that lifecycle state is still required.`;
}
async function currentDocumentState(services, sessionId) {
    try {
        const response = await services.cdp("Runtime.evaluate", {
            expression: "({ __egoNavigationState: true, url: location.href, readyState: document.readyState })",
            returnByValue: true,
            timeout: 200,
        }, sessionId, 250);
        const value = response?.result?.value;
        if (!value || typeof value !== "object")
            return {};
        return {
            ...(typeof value.url === "string" ? { url: value.url } : {}),
            ...(typeof value.readyState === "string"
                ? { readyState: value.readyState }
                : {}),
        };
    }
    catch {
        // Diagnostics must not replace the navigation timeout.
        return {};
    }
}
function isLoadStateTimeout(error) {
    return (error instanceof Error &&
        error.message.startsWith("page.waitForLoadState(") &&
        error.message.includes(" timed out"));
}
/** Wait for document load or network idle inside one Page session. */
async function waitForLoadStateInPage(services, sessionId, state, options = {}) {
    if (state !== "domcontentloaded" &&
        state !== "load" &&
        state !== "networkidle") {
        throw new TypeError('page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"');
    }
    const timeoutMs = options.timeout ?? 10_000;
    if (state !== "networkidle") {
        await waitForDocumentReadyState(services, sessionId, state, timeoutMs);
        return;
    }
    const idleMs = options.idleMs ?? 500;
    await waitForNetworkIdle(services, sessionId, timeoutMs, idleMs);
}
async function waitForDocumentReadyState(services, sessionId, state, timeoutMs) {
    const expression = state === "domcontentloaded"
        ? `(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          const modernEnd = Number(navigation?.domContentLoadedEventEnd || 0);
          const legacyEnd = Number(performance.timing?.domContentLoadedEventEnd || 0);
          return {
            readyState: document.readyState,
            domContentLoaded:
              document.readyState === "complete" || modernEnd > 0 || legacyEnd > 0,
          };
        })()`
        : "document.readyState";
    const deadline = services.now() + timeoutMs;
    while (services.now() < deadline) {
        const remaining = Math.max(1, deadline - services.now());
        let response;
        try {
            response = await services.cdp("Runtime.evaluate", { expression, returnByValue: true }, sessionId, Math.min(1_000, remaining));
        }
        catch (error) {
            // A document swap can briefly invalidate the execution context. Retry
            // those transitions and individual probe timeouts within the Page-level
            // wait budget instead of leaking a CDP implementation detail.
            if (!isRuntimeEvaluateTimeout(error) &&
                !isTransientNavigationContextError(error)) {
                throw error;
            }
            if (services.now() >= deadline)
                break;
        }
        const value = response?.result?.value;
        if (state === "load" && value === "complete")
            return;
        if (state === "domcontentloaded" && value?.domContentLoaded === true)
            return;
        const waitMs = deadline - services.now();
        if (waitMs <= 0)
            break;
        await services.sleep(Math.min(100, waitMs));
    }
    throw new Error(`page.waitForLoadState(${state}) timed out after ${timeoutMs}ms`);
}
function isRuntimeEvaluateTimeout(error) {
    return (error instanceof Error &&
        error.message.includes("CDP request timed out: Runtime.evaluate"));
}
function isCdpTimeout(error, method) {
    return (error instanceof Error &&
        error.message.includes(`CDP request timed out: ${method}`));
}
function isTransientNavigationContextError(error) {
    if (!(error instanceof Error))
        return false;
    return (error.message.includes("Execution context was destroyed") ||
        error.message.includes("Cannot find context with specified id") ||
        error.message.includes("Inspected target navigated"));
}
async function waitForNetworkIdle(services, sessionId, timeoutMs, idleMs) {
    const deadline = services.now() + timeoutMs;
    let sessionIds = [];
    while (services.now() <= deadline) {
        try {
            // OOPIFs can appear while the Page is loading. Refreshing before every
            // observation ensures a new child starts its own continuous tracker before
            // the top-level Page can be declared idle.
            const discoveryBudget = Math.max(1, deadline - services.now());
            sessionIds = await services.pageNetworkSessions(sessionId, discoveryBudget);
            const trackingBudget = deadline - services.now();
            if (trackingBudget <= 0)
                break;
            await services.ensureNetworkTracking(sessionIds, trackingBudget);
            const activity = services.networkActivity(sessionIds);
            if (activity.tracking &&
                activity.inflight === 0 &&
                services.now() - activity.lastActivityAt >= idleMs) {
                return;
            }
        }
        catch (error) {
            if (!isRetryableNetworkRefreshError(error))
                throw error;
            if (services.now() >= deadline)
                break;
        }
        const waitMs = deadline - services.now();
        if (waitMs <= 0)
            break;
        await services.sleep(Math.min(50, waitMs));
    }
    throw new Error(`page.waitForLoadState(networkidle) timed out after ${timeoutMs}ms`);
}
function isRetryableNetworkRefreshError(error) {
    if (isCdpRequestTimeoutError(error) || isSessionLostError(error))
        return true;
    return /CDP request timed out:|detached Page session/i.test(error instanceof Error ? error.message : String(error));
}
function cdpAdapter(services) {
    return {
        sendRaw(method, params, sessionId) {
            return services.cdp(method, params, sessionId);
        },
    };
}

/**
 * Serializes native operations that rely on Ego Lite's process-wide selected
 * task space. The queue covers the entire async operation, so another caller
 * cannot change the selected space while a request is still in flight.
 */
class NativeOperationGate {
    #services;
    #ownership = new AsyncLocalStorage();
    #tail = Promise.resolve();
    constructor(services) {
        if (!services || typeof services.selectSpace !== "function") {
            throw new TypeError("NativeOperationGate requires selectSpace");
        }
        if (typeof services.ensureSession !== "function") {
            throw new TypeError("NativeOperationGate requires ensureSession");
        }
        this.#services = services;
    }
    withSpace(spaceId, operation) {
        assertSpaceId$1(spaceId);
        if (typeof operation !== "function") {
            throw new TypeError("withSpace requires an operation function");
        }
        const ownership = this.#ownership.getStore();
        if (ownership?.active) {
            if (ownership.spaceId !== spaceId) {
                return Promise.reject(new Error(`cannot select space ${spaceId} while space ${ownership.spaceId} is active`));
            }
            // Re-entry deliberately bypasses the FIFO because the outer operation
            // owns the lease. Nested callers must await same-space work in order;
            // Promise.all here would issue concurrent native requests by design.
            return Promise.resolve().then(() => operation({ spaceId }));
        }
        const run = async () => {
            await this.#services.selectSpace(spaceId);
            const acquired = { spaceId, active: true };
            return this.#ownership.run(acquired, async () => {
                try {
                    return await operation({ spaceId });
                }
                finally {
                    // AsyncLocalStorage also flows into detached child tasks. Mark this
                    // lease inactive when its awaited operation ends so late work queues
                    // normally instead of bypassing a released gate.
                    acquired.active = false;
                }
            });
        };
        const result = this.#tail.then(run);
        // The queue is intentionally unbounded and covers long waits: changing the
        // selected space during any in-flight native operation would misroute it.
        // A failure rejects its caller without poisoning later FIFO entries.
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
    withPage(page, operation) {
        if (!page || typeof page !== "object") {
            throw new TypeError("withPage requires a page target");
        }
        assertSpaceId$1(page.spaceId);
        if (typeof page.targetId !== "string" || page.targetId.length === 0) {
            throw new TypeError("withPage requires a non-empty targetId");
        }
        if (typeof operation !== "function") {
            throw new TypeError("withPage requires an operation function");
        }
        return this.withSpace(page.spaceId, async () => {
            const sessionId = await this.#services.ensureSession(page.targetId);
            return operation({
                spaceId: page.spaceId,
                targetId: page.targetId,
                sessionId,
            });
        });
    }
}
function assertSpaceId$1(spaceId) {
    if (!Number.isInteger(spaceId) || spaceId < 0) {
        throw new TypeError("spaceId must be a non-negative integer");
    }
}
const defaultGate$1 = new NativeOperationGate({
    async selectSpace(spaceId) {
        const ego = browserEgo();
        if (typeof ego.useTaskSpace !== "function") {
            throw new Error("withSpace requires ego.useTaskSpace");
        }
        await invokeEgo("withSpace", () => ego.useTaskSpace(spaceId));
    },
    ensureSession,
});
function withSpace(spaceId, operation) {
    return defaultGate$1.withSpace(spaceId, operation);
}
function withPage(page, operation) {
    return defaultGate$1.withPage(page, operation);
}

const MAX_INVALIDATED_REFS_PER_TARGET = 10_000;
/** Public Page refs retain node identity even when native snapshot ids restart. */
class PageRefRegistry {
    #targets = new Map();
    #states = new Map();
    forTarget(targetId) {
        assertTargetId$1(targetId);
        let refs = this.#targets.get(targetId);
        if (!refs) {
            refs = new RefMap({ allowFallback: false });
            this.#targets.set(targetId, refs);
        }
        return refs;
    }
    replace(targetId, snapshotRefs = []) {
        return this.#register(targetId, snapshotRefs, true);
    }
    merge(targetId, snapshotRefs = []) {
        return this.#register(targetId, snapshotRefs, false);
    }
    exportState(targetId) {
        return structuredClone(this.#states.get(targetId));
    }
    restore(targetId, state) {
        this.clear(targetId);
        if (state)
            this.#states.set(targetId, validatePageRefState(state));
        this.#rebuild(targetId);
    }
    invalidateChangedDocuments(targetId, documents) {
        const state = this.#states.get(targetId);
        if (!state)
            return;
        for (const ref of state.refs) {
            if (!ref.documentId ||
                ref.documentId !== pageRefDocumentId(ref, documents)) {
                ref.active = false;
            }
        }
        this.#rebuild(targetId);
    }
    #register(targetId, snapshotRefs, replace) {
        assertTargetId$1(targetId);
        const state = this.#states.get(targetId) || { nextRef: 1, refs: [] };
        const byIdentity = new Map(state.refs
            .filter((ref) => ref.frameProvenance !== "unknown")
            .map((ref) => [nodeIdentity(ref), ref]));
        const byId = new Map(state.refs.map((ref) => [ref.refId, ref]));
        const firstUnused = state.nextRef;
        if (replace)
            for (const ref of state.refs)
                ref.active = false;
        for (const ref of snapshotRefs) {
            if (!ref ||
                !Number.isSafeInteger(ref.backendNodeId) ||
                ref.backendNodeId <= 0)
                continue;
            // Unknown frame provenance cannot establish identity across snapshots.
            const previous = ref.frameProvenance === "unknown"
                ? undefined
                : byIdentity.get(nodeIdentity(ref));
            let refId = previous?.refId;
            if (!refId) {
                const nativeId = Number(ref.refId ?? ref.backendNodeId);
                const candidate = Number.isSafeInteger(nativeId) &&
                    nativeId >= firstUnused &&
                    !byId.has(String(nativeId))
                    ? nativeId
                    : state.nextRef;
                refId = String(candidate);
                state.nextRef = Math.max(state.nextRef, candidate + 1);
                if (!Number.isSafeInteger(state.nextRef))
                    throw new Error("Page ref ids exhausted");
            }
            ref.refId = Number(refId);
            const stored = {
                refId,
                backendNodeId: ref.backendNodeId,
                role: ref.role,
                name: ref.name,
                frameId: ref.frameId,
                frameProvenance: ref.frameProvenance,
                documentId: ref.documentId,
                active: true,
            };
            byId.set(refId, stored);
            byIdentity.set(nodeIdentity(stored), stored);
        }
        state.refs = [...byId.values()];
        this.#states.set(targetId, state);
        return this.#rebuild(targetId);
    }
    invalidate(targetId) {
        assertTargetId$1(targetId);
        const state = this.#states.get(targetId);
        if (state)
            for (const ref of state.refs)
                ref.active = false;
        this.#rebuild(targetId);
    }
    isInvalidated(targetId, refId) {
        assertTargetId$1(targetId);
        return (this.#states
            .get(targetId)
            ?.refs.some((ref) => ref.refId === refId && !ref.active) ?? false);
    }
    clear(targetId) {
        assertTargetId$1(targetId);
        this.#targets.delete(targetId);
        this.#states.delete(targetId);
    }
    #rebuild(targetId) {
        const refs = new RefMap({ allowFallback: false });
        const state = this.#states.get(targetId);
        if (state) {
            let inactive = state.refs.filter((ref) => !ref.active).length;
            state.refs = state.refs.filter((ref) => {
                if (!ref.active && inactive > MAX_INVALIDATED_REFS_PER_TARGET) {
                    inactive--;
                    return false;
                }
                if (ref.active)
                    refs.addWithFrame(ref.refId, ref.backendNodeId, ref.role, ref.name, undefined, ref.frameId, ref.frameProvenance);
                return true;
            });
        }
        this.#targets.set(targetId, refs);
        return refs;
    }
}
/** Reject corrupt persisted mappings instead of reconstructing native ids. */
function validatePageRefState(value) {
    const state = value;
    const ids = new Set();
    if (!state ||
        !Number.isSafeInteger(state.nextRef) ||
        state.nextRef < 1 ||
        !Array.isArray(state.refs) ||
        state.refs.some((ref) => {
            if (!ref ||
                typeof ref.refId !== "string" ||
                !/^[1-9]\d*$/.test(ref.refId) ||
                ids.has(ref.refId) ||
                Number(ref.refId) >= state.nextRef ||
                !Number.isSafeInteger(ref.backendNodeId) ||
                ref.backendNodeId <= 0 ||
                typeof ref.active !== "boolean" ||
                ![undefined, "page", "frame", "unknown"].includes(ref.frameProvenance) ||
                [ref.frameId, ref.documentId, ref.role, ref.name].some((value) => value !== undefined && typeof value !== "string"))
                return true;
            ids.add(ref.refId);
            return false;
        }))
        throw new Error("Invalid persisted Page refs; take a new snapshot");
    return structuredClone(state);
}
function nodeIdentity(ref) {
    return JSON.stringify([
        ref.frameId ?? null,
        ref.backendNodeId,
        ref.documentId ?? null,
    ]);
}
function pageRefDocumentId(ref, documents) {
    return ref.frameProvenance === "unknown"
        ? JSON.stringify([...documents].sort(([a], [b]) => a.localeCompare(b)))
        : documents.get(ref.frameId || "");
}
function assertTargetId$1(targetId) {
    if (typeof targetId !== "string" || targetId.length === 0) {
        throw new TypeError("PageRefRegistry requires a non-empty targetId");
    }
}

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Stable across Agent rounds and Node-service restarts in one Ego Lite run. */
function runtimeInstanceId(parentPid = process.ppid) {
    return `browser-host:${parentPid}`;
}
/**
 * Stores durable page labels in one JSON document per task space. Each update
 * replaces the complete document with an atomic rename so readers never see a
 * partially written ledger.
 */
class PageLedgerStore {
    rootDir;
    #writeToken = randomUUID();
    #browserInstanceId;
    #staleAfterMs;
    #now;
    #temporarySequence = 0;
    #resolvedBrowserInstanceId;
    #cleanup;
    constructor(options = {}) {
        this.rootDir =
            options.rootDir ||
                process.env.EGO_BROWSER_STATE_DIR ||
                join(homedir(), ".ego-browser", "state");
        this.#browserInstanceId = options.browserInstanceId;
        this.#staleAfterMs =
            options.staleAfterMs === undefined
                ? DEFAULT_STALE_AFTER_MS
                : options.staleAfterMs;
        this.#now = options.now || Date.now;
        if (!Number.isFinite(this.#staleAfterMs) || this.#staleAfterMs < 0) {
            throw new TypeError("staleAfterMs must be a non-negative number");
        }
    }
    async read(spaceId) {
        assertSpaceId(spaceId);
        const ledger = await this.#readCurrent(spaceId);
        return cloneLedger(ledger);
    }
    /** Replace any stale state for a newly created space with its Agent-owned p1. */
    async initializeCreatedSpace(spaceId, targetId) {
        assertSpaceId(spaceId);
        assertTargetId(targetId);
        const browserInstanceId = await this.#currentBrowserInstanceId();
        await this.#cleanupExpiredLedgers(browserInstanceId);
        const ledger = emptyLedger(spaceId, browserInstanceId);
        const label = nextAutomaticLabel(ledger, new Set());
        const entry = { targetId, openedBy: "agent" };
        ledger.initialized = true;
        ledger.usedLabels.push(label);
        ledger.pages[label] = entry;
        await this.#writeAtomic(spaceId, ledger);
        return { label, ...entry };
    }
    /** Remove all Page-model state after its task space is finished or closed. */
    async discard(spaceId) {
        assertSpaceId(spaceId);
        await rm(this.#path(spaceId), { force: true });
    }
    async getPage(spaceId, label) {
        assertLabel(label);
        const ledger = await this.read(spaceId);
        const entry = ledger.pages[label];
        if (entry)
            return { label, ...entry };
        if (ledger.releasedLabels.includes(label)) {
            throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
            throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
    }
    async addPage(spaceId, targetId, options = {}) {
        assertTargetId(targetId);
        if (options.as !== undefined)
            assertLabel(options.as);
        let added;
        await this.#update(spaceId, (ledger) => {
            const existing = Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId);
            if (existing) {
                throw new Error(`target ${targetId} is already page ${existing[0]}`);
            }
            const used = new Set(ledger.usedLabels);
            const label = options.as || nextAutomaticLabel(ledger, used);
            if (used.has(label)) {
                throw new Error(`page label already used: ${label}`);
            }
            const entry = {
                targetId,
                openedBy: options.openedBy || "agent",
            };
            ledger.initialized = true;
            delete ledger.unmanagedTargets[targetId];
            ledger.usedLabels.push(label);
            ledger.pages[label] = entry;
            added = { label, ...entry };
        });
        return added;
    }
    async setPageRefs(spaceId, label, refs) {
        assertLabel(label);
        await this.#update(spaceId, (ledger) => {
            const page = ledger.pages[label];
            if (!page)
                throw new Error(`page label not found: ${label}`);
            page.refs = validatePageRefState(refs);
        });
    }
    async closePage(spaceId, label) {
        assertLabel(label);
        let removed;
        await this.#update(spaceId, (ledger) => {
            const entry = ledger.pages[label];
            if (!entry) {
                if (ledger.releasedLabels.includes(label)) {
                    throw new Error(`page ${label} was released`);
                }
                if (ledger.usedLabels.includes(label)) {
                    throw new Error(`page ${label} was closed`);
                }
                throw new Error(`page label not found: ${label}`);
            }
            removed = { label, ...entry };
            delete ledger.pages[label];
        });
        return removed;
    }
    async releasePage(spaceId, label) {
        assertLabel(label);
        let removed;
        await this.#update(spaceId, (ledger) => {
            const entry = ledger.pages[label];
            if (!entry) {
                if (ledger.releasedLabels.includes(label)) {
                    throw new Error(`page ${label} was released`);
                }
                if (ledger.usedLabels.includes(label)) {
                    throw new Error(`page ${label} was closed`);
                }
                throw new Error(`page label not found: ${label}`);
            }
            removed = { label, ...entry };
            delete ledger.pages[label];
            ledger.releasedLabels.push(label);
            ledger.unmanagedTargets[entry.targetId] = entry.openedBy;
        });
        return removed;
    }
    async keepUnmanaged(spaceId, targetId, openedBy = "unknown") {
        assertTargetId(targetId);
        if (!["agent", "unknown"].includes(openedBy)) {
            throw new TypeError(`invalid unmanaged page origin: ${openedBy}`);
        }
        await this.#update(spaceId, (ledger) => {
            const existing = Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId);
            if (existing) {
                throw new Error(`target ${targetId} is already page ${existing[0]}`);
            }
            ledger.initialized = true;
            ledger.unmanagedTargets[targetId] = openedBy;
        });
    }
    /** Mark the next reconciliation as crossing a user-control boundary. */
    async beginUserControl(spaceId) {
        await this.#update(spaceId, (ledger) => {
            ledger.userControlPending = true;
        });
    }
    /** Roll back a boundary marker when the native handoff itself fails. */
    async cancelUserControl(spaceId) {
        await this.#update(spaceId, (ledger) => {
            ledger.userControlPending = false;
        });
    }
    async reconcile(spaceId, liveTargetIds, options = {}) {
        const live = new Set(liveTargetIds);
        const current = await this.read(spaceId);
        const hasMissingPage = Object.values(current.pages).some((page) => !live.has(page.targetId));
        const hasMissingUnmanaged = Object.keys(current.unmanagedTargets).some((targetId) => !live.has(targetId));
        const knownTargets = new Set([
            ...Object.values(current.pages).map((page) => page.targetId),
            ...Object.keys(current.unmanagedTargets),
        ]);
        const newTargets = [...live].filter((targetId) => !knownTargets.has(targetId));
        const needsInitialization = !current.initialized;
        const protectsUserTabs = options.afterUserControl || current.userControlPending;
        const shouldAdopt = current.initialized &&
            options.autoAdoptNew &&
            !protectsUserTabs &&
            newTargets.length > 0;
        if (!hasMissingPage &&
            !hasMissingUnmanaged &&
            !needsInitialization &&
            !protectsUserTabs &&
            !shouldAdopt) {
            return current;
        }
        return this.#update(spaceId, (ledger) => {
            for (const [label, page] of Object.entries(ledger.pages)) {
                if (!live.has(page.targetId))
                    delete ledger.pages[label];
            }
            for (const targetId of Object.keys(ledger.unmanagedTargets)) {
                if (!live.has(targetId))
                    delete ledger.unmanagedTargets[targetId];
            }
            const managedTargets = new Set(Object.values(ledger.pages).map((page) => page.targetId));
            const untracked = [...live].filter((targetId) => !managedTargets.has(targetId) &&
                !Object.hasOwn(ledger.unmanagedTargets, targetId));
            if (!ledger.initialized) {
                // The first observable tab set is the control boundary. It may contain
                // user pages from before claim/takeover, so preserve it rather than
                // guessing that those tabs were opened by the current agent.
                for (const targetId of untracked) {
                    ledger.unmanagedTargets[targetId] = "unknown";
                }
                ledger.initialized = true;
                ledger.userControlPending = false;
                return;
            }
            if (protectsUserTabs) {
                for (const targetId of untracked) {
                    ledger.unmanagedTargets[targetId] = "unknown";
                }
                ledger.userControlPending = false;
                return;
            }
            if (!options.autoAdoptNew)
                return;
            const used = new Set(ledger.usedLabels);
            for (const targetId of untracked) {
                const label = nextAutomaticLabel(ledger, used);
                used.add(label);
                ledger.usedLabels.push(label);
                ledger.pages[label] = {
                    targetId,
                    openedBy: "agent",
                };
            }
        });
    }
    async #update(spaceId, mutate) {
        assertSpaceId(spaceId);
        const next = await this.#readCurrent(spaceId);
        mutate(next);
        await this.#writeAtomic(spaceId, next);
        return cloneLedger(next);
    }
    async #readCurrent(spaceId) {
        const browserInstanceId = await this.#currentBrowserInstanceId();
        await this.#cleanupExpiredLedgers(browserInstanceId);
        const path = this.#path(spaceId);
        let raw;
        try {
            raw = await readFile(path, "utf8");
        }
        catch (error) {
            if (error?.code === "ENOENT") {
                return emptyLedger(spaceId, browserInstanceId);
            }
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`invalid page ledger ${path}: ${error.message}`);
        }
        const storedBrowserInstanceId = ledgerBrowserInstanceId(parsed);
        if (browserInstanceId !== undefined &&
            storedBrowserInstanceId !== undefined &&
            storedBrowserInstanceId !== browserInstanceId) {
            return emptyLedger(spaceId, browserInstanceId);
        }
        const ledger = validateLedger(parsed, spaceId, path);
        if (browserInstanceId !== undefined &&
            storedBrowserInstanceId === undefined) {
            // Preserve ledgers created before instance ids existed. This one-time
            // backfill avoids discarding live Page labels during an SDK upgrade.
            ledger.browserInstanceId = browserInstanceId;
            await this.#writeAtomic(spaceId, ledger);
        }
        return ledger;
    }
    async #currentBrowserInstanceId() {
        this.#resolvedBrowserInstanceId ||= Promise.resolve(typeof this.#browserInstanceId === "function"
            ? this.#browserInstanceId()
            : this.#browserInstanceId).then((value) => {
            if (value === undefined)
                return undefined;
            if (typeof value !== "string" || value.length === 0) {
                throw new TypeError("browserInstanceId must be a non-empty string");
            }
            return value;
        });
        return this.#resolvedBrowserInstanceId;
    }
    async #cleanupExpiredLedgers(browserInstanceId) {
        if (browserInstanceId === undefined)
            return;
        this.#cleanup ||= this.#removeExpiredLedgers(browserInstanceId);
        await this.#cleanup;
    }
    async #removeExpiredLedgers(browserInstanceId) {
        let names;
        try {
            names = await readdir(this.rootDir);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return;
            throw error;
        }
        await Promise.all(names
            .filter((name) => /^space-\d+\.json$/.test(name))
            .map(async (name) => {
            const path = join(this.rootDir, name);
            const metadata = await stat(path).catch(() => undefined);
            if (!metadata ||
                this.#now() - metadata.mtimeMs < this.#staleAfterMs) {
                return;
            }
            let storedInstanceId;
            try {
                storedInstanceId = ledgerBrowserInstanceId(JSON.parse(await readFile(path, "utf8")));
            }
            catch {
                // An expired unreadable ledger cannot belong to the active browser.
            }
            if (storedInstanceId !== browserInstanceId) {
                await rm(path, { force: true });
            }
        }));
    }
    async #writeAtomic(spaceId, ledger) {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        const path = this.#path(spaceId);
        const temporary = `${path}.${process.pid}.${this.#writeToken}.${++this.#temporarySequence}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
            });
            await rename(temporary, path);
        }
        finally {
            await rm(temporary, { force: true }).catch(() => { });
        }
    }
    #path(spaceId) {
        return join(this.rootDir, `space-${spaceId}.json`);
    }
}
function emptyLedger(spaceId, browserInstanceId) {
    return {
        ...(browserInstanceId ? { browserInstanceId } : {}),
        spaceId,
        nextLabel: 1,
        usedLabels: [],
        releasedLabels: [],
        initialized: false,
        userControlPending: false,
        unmanagedTargets: {},
        pages: {},
    };
}
function ledgerBrowserInstanceId(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const browserInstanceId = value
        .browserInstanceId;
    return typeof browserInstanceId === "string" && browserInstanceId.length > 0
        ? browserInstanceId
        : undefined;
}
function nextAutomaticLabel(ledger, used) {
    let sequence = ledger.nextLabel;
    let label = `p${sequence}`;
    while (used.has(label)) {
        sequence += 1;
        label = `p${sequence}`;
    }
    ledger.nextLabel = sequence + 1;
    return label;
}
function validateLedger(value, expectedSpaceId, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid page ledger ${path}: expected an object`);
    }
    const stored = value;
    // Defaults keep ledgers written by earlier runtimes readable. They start
    // uninitialized so the first new runtime observes a safe control baseline
    // instead of silently adopting pre-existing user tabs.
    const releasedLabels = stored.releasedLabels ?? [];
    const initialized = stored.initialized ?? false;
    const legacyHandoffBaseline = stored.handoffBaseline;
    const userControlPending = stored.userControlPending ??
        (legacyHandoffBaseline !== undefined && legacyHandoffBaseline !== null);
    const unmanagedTargets = stored.unmanagedTargets ?? {};
    if ((stored.browserInstanceId !== undefined &&
        (typeof stored.browserInstanceId !== "string" ||
            stored.browserInstanceId.length === 0)) ||
        stored.spaceId !== expectedSpaceId ||
        !Number.isInteger(stored.nextLabel) ||
        stored.nextLabel < 1 ||
        !Array.isArray(stored.usedLabels) ||
        stored.usedLabels.some((label) => typeof label !== "string") ||
        !Array.isArray(releasedLabels) ||
        releasedLabels.some((label) => typeof label !== "string" ||
            !stored.usedLabels.includes(label) ||
            Object.hasOwn(stored.pages || {}, label)) ||
        typeof initialized !== "boolean" ||
        typeof userControlPending !== "boolean" ||
        (legacyHandoffBaseline !== undefined &&
            legacyHandoffBaseline !== null &&
            (!Array.isArray(legacyHandoffBaseline) ||
                legacyHandoffBaseline.some((targetId) => typeof targetId !== "string" || targetId.length === 0))) ||
        !unmanagedTargets ||
        typeof unmanagedTargets !== "object" ||
        Array.isArray(unmanagedTargets) ||
        Object.entries(unmanagedTargets).some(([targetId, openedBy]) => targetId.length === 0 ||
            !["agent", "user", "unknown"].includes(openedBy)) ||
        !stored.pages ||
        typeof stored.pages !== "object" ||
        Array.isArray(stored.pages)) {
        throw new Error(`invalid page ledger ${path}: schema mismatch`);
    }
    const pages = {};
    for (const [label, page] of Object.entries(stored.pages)) {
        if (!stored.usedLabels.includes(label) ||
            !page ||
            typeof page.targetId !== "string" ||
            !["agent", "user", "unknown"].includes(page.openedBy)) {
            throw new Error(`invalid page ledger ${path}: invalid page ${label}`);
        }
        if (Object.hasOwn(unmanagedTargets, page.targetId)) {
            throw new Error(`invalid page ledger ${path}: target ${page.targetId} is both managed and unmanaged`);
        }
        pages[label] = {
            targetId: page.targetId,
            openedBy: normalizePageOrigin(page.openedBy),
            ...(page.refs === undefined
                ? {}
                : { refs: validatePageRefState(page.refs) }),
        };
    }
    const normalizedUnmanagedTargets = Object.fromEntries(Object.entries(unmanagedTargets).map(([targetId, openedBy]) => [
        targetId,
        normalizePageOrigin(openedBy),
    ]));
    return {
        ...(stored.browserInstanceId
            ? { browserInstanceId: stored.browserInstanceId }
            : {}),
        spaceId: stored.spaceId,
        nextLabel: stored.nextLabel,
        usedLabels: [...stored.usedLabels],
        releasedLabels: [...releasedLabels],
        initialized,
        userControlPending,
        unmanagedTargets: normalizedUnmanagedTargets,
        pages,
    };
}
function normalizePageOrigin(value) {
    return value === "agent" ? "agent" : "unknown";
}
function cloneLedger(ledger) {
    return structuredClone(ledger);
}
function assertSpaceId(spaceId) {
    if (!Number.isInteger(spaceId) || spaceId < 0) {
        throw new TypeError("spaceId must be a non-negative integer");
    }
}
function assertTargetId(targetId) {
    if (typeof targetId !== "string" || targetId.length === 0) {
        throw new TypeError("targetId must be a non-empty string");
    }
}
function assertLabel(label) {
    if (typeof label !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)) {
        throw new TypeError("page label must start with a letter and contain only letters, numbers, _ or -");
    }
}

/**
 * An action failed on element state after resolution (hidden, moving, covered)
 * and may simply be attempted again. Transport and session errors are not
 * included: input may already have reached the page.
 */
function isRetryableElementStateError(error) {
    return (error instanceof ElementResolutionError &&
        error.kind === "transient" &&
        !error.message.startsWith("Unknown ref:"));
}
/**
 * Resolution or frame discovery failed before any input was dispatched. On top
 * of the element-state cases above, a frame that vanished or an iframe session
 * that was lost is recovered by rediscovering frames; losing the Page's own
 * session is terminal.
 */
function isRetryableResolutionError(error, pageSessionId) {
    if (isTransientElementError(error)) {
        return !error.message.startsWith("Unknown ref:");
    }
    return (isSessionLostError(error) &&
        typeof error.sessionId === "string" &&
        error.sessionId !== pageSessionId);
}
class PageEvaluationTimeoutError extends Error {
    code = "EGO_PAGE_EVALUATION_TIMED_OUT";
    timeoutMs;
    executionStopped;
    mayHaveLateEffects;
    pageResponsive;
    constructor(message, { timeoutMs, executionStopped, mayHaveLateEffects, pageResponsive, }) {
        super(message);
        this.name = "PageEvaluationTimeoutError";
        this.timeoutMs = timeoutMs;
        this.executionStopped = executionStopped;
        this.mayHaveLateEffects = mayHaveLateEffects;
        this.pageResponsive = pageResponsive;
    }
}
const PAGE_CLOSE_CONFIRM_TIMEOUT_MS = 2_000;
const PAGE_CLOSE_CONFIRM_INTERVAL_MS = 50;
const CREATED_SPACE_TAB_TIMEOUT_MS = 2_000;
const CREATED_SPACE_TAB_POLL_INTERVAL_MS = 50;
const DEFAULT_PAGE_ACTION_TIMEOUT_MS = 3_000;
const PAGE_ACTION_RESOLUTION_RETRY_MS = 500;
const CONTROL_POLL_INTERVAL_MS = 20_000;
const PAGE_EVALUATE_EXECUTION_TIMEOUT_MS = 14_000;
const PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS = 15_000;
const PAGE_EVALUATE_HEALTH_TIMEOUT_MS = 250;
const PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS = 200;
const PAGE_EVALUATE_TERMINATE_TIMEOUT_MS = 1_000;
const WAIT_FOR_FUNCTION_TRANSPORT_GRACE_MS = 250;
const CONTROL_WAIT_TIMEOUT_MS = 600_000;
/** Page-scoped mouse state and CDP Input primitives. */
class PageMouse {
    #run;
    #runObserved;
    #modifierMask;
    #x = 0;
    #y = 0;
    #buttons = 0;
    #lastButton = "none";
    constructor(run, runObserved, modifierMask) {
        this.#run = run;
        this.#runObserved = runObserved;
        this.#modifierMask = modifierMask;
    }
    async click(x, y, options = {}) {
        validatePublicApiOptions("Page.mouse.click", options);
        const receipt = await this.#runObserved((services, sessionId) => clickPointInPage(services, sessionId, x, y, options, this.#modifierMask(), this.#buttons));
        this.#x = x;
        this.#y = y;
        this.#lastButton = "none";
        return receipt;
    }
    async move(x, y, options = {}) {
        validatePublicApiOptions("Page.mouse.move", options);
        await this.#run((services, sessionId) => moveMouseInPage(services, sessionId, this.#x, this.#y, x, y, {
            ...options,
            button: this.#lastButton,
            buttons: this.#buttons,
            modifiers: this.#modifierMask(),
        }));
        this.#x = x;
        this.#y = y;
    }
    async down(options = {}) {
        validatePublicApiOptions("Page.mouse.down", options);
        const button = options.button ?? "left";
        const nextButtons = this.#buttons | mouseButtonMask(button);
        await this.#run((services, sessionId) => mouseButtonInPage(services, sessionId, "mousePressed", this.#x, this.#y, nextButtons, options, this.#modifierMask()).then(() => undefined));
        this.#buttons = nextButtons;
        this.#lastButton = button;
    }
    async up(options = {}) {
        validatePublicApiOptions("Page.mouse.up", options);
        const button = options.button ?? "left";
        const nextButtons = this.#buttons & ~mouseButtonMask(button);
        await this.#run((services, sessionId) => mouseButtonInPage(services, sessionId, "mouseReleased", this.#x, this.#y, nextButtons, options, this.#modifierMask()).then(() => undefined));
        this.#buttons = nextButtons;
        this.#lastButton = "none";
    }
    async wheel(deltaX, deltaY, options = {}) {
        validatePublicApiOptions("Page.mouse.wheel", options);
        return this.#run((services, sessionId) => wheelInPage(services, sessionId, this.#x, this.#y, deltaX, deltaY, this.#modifierMask(), options));
    }
}
/** Page-scoped keyboard input with Playwright-style key state. */
class PageKeyboard {
    #controller;
    constructor(services, run, runObserved) {
        this.#controller = new PageKeyboardController(services, (operation) => run((_services, sessionId) => operation(sessionId)), (operation) => runObserved((_services, sessionId) => operation(sessionId)));
    }
    modifierMask() {
        return this.#controller.modifierMask();
    }
    async down(key) {
        await this.#controller.down(key);
    }
    async up(key) {
        await this.#controller.up(key);
    }
    async press(chord, options = {}) {
        validatePublicApiOptions("Page.keyboard.press", options);
        return (await this.#controller.press(chord, options));
    }
    async pressInSession(sessionId, chord, options = {}) {
        validatePublicApiOptions("Page.keyboard.press", options);
        await this.#controller.pressInSession(sessionId, chord, options);
    }
    async paste(content) {
        return (await this.#controller.paste(content));
    }
    async insertText(text) {
        await this.#controller.insertText(text);
    }
    async type(text, options = {}) {
        validatePublicApiOptions("Page.keyboard.type", options);
        await this.#controller.type(text, options);
    }
}
class PageBudgetError extends Error {
    code = "EGO_PAGE_BUDGET_REACHED";
    spaceId;
    limit;
    constructor(spaceId, limit, message) {
        super(message);
        this.name = "PageBudgetError";
        this.spaceId = spaceId;
        this.limit = limit;
    }
}
let defaultLedger;
const defaultPageRefs = new PageRefRegistry();
const unmanagedPageConstructorToken = Symbol("UnmanagedPage");
const captureUserBoundaryToken = Symbol("captureUserBoundary");
const initializeTaskSpaceToken = Symbol("initializeTaskSpace");
const initializeCreatedSpaceToken = Symbol("initializeCreatedSpace");
const rollbackCreatedTaskSpaceToken = Symbol("rollbackCreatedTaskSpace");
const defaultGate = {
    withSpace: withSpace,
    withPage: withPage,
};
const baseDefaultServices = {
    gate: defaultGate,
    pageRefs: defaultPageRefs,
    async createTab(url) {
        const result = await invokeEgo("task.newPage", () => browserEgo().createTab(url));
        const targetId = result?.targetId || result?.result?.targetId;
        if (typeof targetId !== "string" || targetId.length === 0) {
            throw new Error("task.newPage returned no targetId");
        }
        return targetId;
    },
    async listTabs() {
        const result = await invokeEgo("task.listTabs", () => browserEgo().listTabs());
        return result?.tabs || result?.targetInfos || [];
    },
    async probeAgentControl() {
        // Do not route this through invokeEgo: observing user control is the
        // expected waiting state, not a hard-stop signal.
        return probeAgentControl(() => browserEgo().snapshot({ maxResultLength: 1 }));
    },
    async handOffTaskSpace() {
        const ego = browserEgo();
        if (typeof ego.handOffTaskSpace !== "function") {
            throw new Error("task.handOff requires ego.handOffTaskSpace");
        }
        await invokeEgo("task.handOff", () => ego.handOffTaskSpace());
    },
    async completeTaskSpace() {
        const ego = browserEgo();
        if (typeof ego.completeTaskSpace !== "function") {
            throw new Error("task.finish requires ego.completeTaskSpace");
        }
        await invokeEgo("task.finish", () => ego.completeTaskSpace());
    },
    async closeTaskSpace() {
        const ego = browserEgo();
        if (typeof ego.closeTaskSpace !== "function") {
            throw new Error("task.close requires ego.closeTaskSpace");
        }
        await invokeEgo("task.close", () => ego.closeTaskSpace());
    },
    async cdp(method, params = {}, sessionId, timeoutMs) {
        const response = await browserCdp(method, params, sessionId, timeoutMs);
        return response?.result || {};
    },
    async showAgentMousePosition(x, y) {
        const ego = browserEgo();
        if (typeof ego.animationHighlightMouseToPosition !== "function")
            return;
        await invokeEgo("page.mouse.move", () => ego.animationHighlightMouseToPosition(x, y));
    },
    async showAgentTaskState(state) {
        const ego = browserEgo();
        if (typeof ego.setAgentTaskState !== "function")
            return;
        await invokeEgo("page.mouse.label", () => ego.setAgentTaskState(state));
    },
    withTemporaryClipboardText,
    snapshot: snapshotRaw,
    screenshot: captureScreenshotForSession,
    pendingDialog,
    prepareFileChooser,
    drainEvents: drainPageEvents,
    ensureNetworkTracking,
    pageNetworkSessions,
    networkActivity,
    ensureSession,
    ensureFrameSessions,
    invalidateSession,
    setPreferredTarget,
    supportsBackgroundPageDiscovery: isBrowserRuntime,
    subscribeBrowserEvents,
    subscribePageEvents,
    prepareDownload(targetId, options) {
        return preparePageDownload({
            cdp: baseDefaultServices.cdp,
            subscribePageEvents,
        }, targetId, options);
    },
    now: () => state.now(),
    async sleep(ms) {
        await state.sleep(ms);
    },
    get platform() {
        return state.platform;
    },
};
/**
 * Create a TaskSpace object around a resolved native task-space descriptor.
 * The helper layer owns name/id resolution; this layer owns page identity and
 * routes every browser operation through the native operation gate.
 */
function createTaskSpaceHandle(descriptor, overrides = {}) {
    if (!descriptor || !Number.isInteger(descriptor.id)) {
        throw new TypeError("TaskSpace requires a numeric id");
    }
    // Ego Lite imports the SDK before it evaluates the submitted script. Resolve
    // environment-backed settings lazily so SDK callers can configure a round
    // before their first taskSpace() call.
    defaultLedger ||= new PageLedgerStore({
        browserInstanceId: runtimeInstanceId,
    });
    const services = {
        ...baseDefaultServices,
        ledger: defaultLedger,
        pageBudget: configuredPageBudget(),
        ...overrides,
    };
    if (!Number.isInteger(services.pageBudget) || services.pageBudget < 1) {
        throw new TypeError("pageBudget must be a positive integer");
    }
    return new TaskSpace(descriptor, services);
}
/**
 * Capture the active tab at a claim/takeover boundary before Agent actions can
 * change it. This is called by the helper layer and is not injected directly.
 */
async function captureTaskSpaceUserBoundary(task) {
    await task.captureUserBoundary(captureUserBoundaryToken);
}
/** Initialize Page state and round-local discovery before exposing a TaskSpace. */
async function initializeTaskSpaceHandle(task, options = {}) {
    if (options.created) {
        await task.initializeCreatedSpace(initializeCreatedSpaceToken);
    }
    await task.initializeBackgroundPageDiscovery(initializeTaskSpaceToken);
}
/** Close a newly created space whose Page-model initialization did not commit. */
async function rollbackCreatedTaskSpace(task) {
    await task[rollbackCreatedTaskSpaceToken]();
}
class TaskSpace {
    taskId;
    id;
    name;
    createdBy;
    ownership;
    recentTabTitles;
    #services;
    #userPage;
    #stopBrowserEvents;
    #backgroundDiscoveryInitialized = false;
    constructor(descriptor, services) {
        this.taskId = descriptor.taskId;
        this.id = descriptor.id;
        this.name = descriptor.name;
        this.createdBy = descriptor.createdBy;
        this.ownership = descriptor.ownership;
        this.recentTabTitles = descriptor.recentTabTitles;
        this.#services = services;
    }
    /** Stable task-space identifier. `id` remains as a compatibility alias. */
    get spaceId() {
        return this.id;
    }
    page(label) {
        return new Page(this, label, this.#services);
    }
    /** The tab active at the most recent claim/takeover boundary, if any. */
    userPage() {
        return this.#userPage;
    }
    async initializeCreatedSpace(token) {
        if (token !== initializeCreatedSpaceToken) {
            throw new TypeError("created-space initialization is internal");
        }
        if (this.ownership !== "agent") {
            throw new Error("only a newly created Agent TaskSpace can initialize p1");
        }
        await this.#services.gate.withSpace(this.id, async () => {
            const targetId = await this.#waitForCreatedSpaceTab();
            const page = await this.#services.ledger.initializeCreatedSpace(this.id, targetId);
            this.#services.setPreferredTarget(page.targetId);
        });
    }
    async #waitForCreatedSpaceTab() {
        const deadline = this.#services.now() + CREATED_SPACE_TAB_TIMEOUT_MS;
        while (true) {
            const tabs = await this.#services.listTabs();
            if (tabs.length > 1) {
                throw new Error(`new task space expected one default tab, found ${tabs.length}`);
            }
            if (tabs.length === 1) {
                const targetId = tabs[0]?.targetId;
                if (typeof targetId !== "string" || targetId.length === 0) {
                    throw new Error("new task space default tab returned no targetId");
                }
                return targetId;
            }
            const remainingMs = deadline - this.#services.now();
            if (remainingMs <= 0) {
                throw new Error(`new task space did not expose its default tab within ${CREATED_SPACE_TAB_TIMEOUT_MS}ms`);
            }
            await this.#services.sleep(Math.min(CREATED_SPACE_TAB_POLL_INTERVAL_MS, remainingMs));
        }
    }
    async initializeBackgroundPageDiscovery(token) {
        if (token !== initializeTaskSpaceToken) {
            throw new TypeError("background page discovery is initialized internally");
        }
        if (this.#backgroundDiscoveryInitialized ||
            this.ownership !== "agent" ||
            !this.#services.supportsBackgroundPageDiscovery()) {
            return;
        }
        this.#backgroundDiscoveryInitialized = true;
        this.#stopBrowserEvents = this.#services.subscribeBrowserEvents((event) => {
            this.#handleBrowserEvent(event);
        });
        // Subscribe before enabling discovery so a target created during setup
        // cannot fall into the gap between the initial inventory and the callback.
        try {
            await this.#services.gate.withSpace(this.id, async () => {
                await this.#services.cdp("Target.setDiscoverTargets", {
                    discover: true,
                });
                await this.#recoverExistingChildPages();
            });
        }
        catch {
            // Background discovery is an observation aid. Existing action receipts
            // and task.tabs() reconciliation remain the correctness fallback.
        }
    }
    async captureUserBoundary(token) {
        if (token !== captureUserBoundaryToken) {
            throw new TypeError("the user-page boundary is captured automatically by claim/takeover");
        }
        await this.#services.gate.withSpace(this.id, async () => {
            const tabs = await this.#services.listTabs();
            if (tabs.length === 0) {
                this.#userPage = undefined;
                return;
            }
            const ledger = await this.#services.ledger.reconcile(this.id, tabs.map((tab) => tab.targetId), { autoAdoptNew: false, afterUserControl: true });
            const active = tabs.find((tab) => tab.active);
            this.#userPage = active
                ? tabInventory(this, this.#services, ledger, tabs).find((item) => item.targetId === active.targetId)?.page
                : undefined;
        });
    }
    /** Return managed Page handles after reconciling the browser tab list. */
    async pages() {
        const tabs = await this.tabs();
        return tabs
            .filter((item) => item.page instanceof Page)
            .map((item) => item.page);
    }
    /** Return managed and unmanaged tabs after reconciling browser state. */
    async tabs() {
        return this.#services.gate.withSpace(this.id, async () => {
            const { ledger, tabs } = await this.#reconcilePages();
            return tabInventory(this, this.#services, ledger, tabs);
        });
    }
    /** Wait until this space is controllable without taking control from the user. */
    async waitForControl(options = {}) {
        validatePublicApiOptions("TaskSpace.waitForControl", options);
        const intervalMs = options.interval ?? CONTROL_POLL_INTERVAL_MS;
        const timeoutMs = options.timeout ?? CONTROL_WAIT_TIMEOUT_MS;
        const deadline = this.#services.now() + timeoutMs;
        while (true) {
            const available = await this.#services.gate.withSpace(this.id, () => this.#services.probeAgentControl());
            if (available)
                return;
            const remainingMs = deadline - this.#services.now();
            if (remainingMs <= 0) {
                throw new Error(`task.waitForControl timed out after ${timeoutMs}ms`);
            }
            await this.#services.sleep(Math.min(intervalMs, remainingMs));
        }
    }
    /** Give control of this task space to the user while keeping Page state. */
    async handOff() {
        await this.#services.gate.withSpace(this.spaceId, async () => {
            await this.#reconcilePages();
            await this.#services.ledger.beginUserControl(this.spaceId);
            try {
                await this.#services.handOffTaskSpace();
                this.#stopBackgroundPageDiscovery();
            }
            catch (error) {
                await this.#services.ledger.cancelUserControl(this.spaceId);
                throw error;
            }
        });
    }
    /** Finish the task with an explicit managed-Page retention policy. */
    async finish(options) {
        validatePublicApiOptions("TaskSpace.finish", options);
        if (!Object.hasOwn(options, "keep") || options.keep === undefined) {
            throw new TypeError("task.finish requires the keep option. Expected: await task.finish({ keep })");
        }
        return this.#services.gate.withSpace(this.spaceId, async () => {
            const { ledger, tabs } = await this.#reconcilePages();
            const keepLabels = options.keep === "all"
                ? new Set(Object.keys(ledger.pages))
                : new Set(options.keep);
            for (const label of keepLabels) {
                if (!ledger.pages[label]) {
                    // Reuse the ledger's permanent-label diagnostics and validate every
                    // requested label before closing any Page.
                    await this.#services.ledger.getPage(this.spaceId, label);
                }
            }
            const managedByTarget = new Map(Object.values(ledger.pages).map((page) => [page.targetId, page]));
            const labelsToClose = Object.entries(ledger.pages)
                .filter(([label, page]) => page.openedBy === "agent" && !keepLabels.has(label))
                .map(([label]) => label);
            const closedManagedLabelSet = new Set(labelsToClose);
            const keptManagedLabels = Object.keys(ledger.pages).filter((label) => !closedManagedLabelSet.has(label));
            const preservedUnmanagedCount = tabs.filter((tab) => !managedByTarget.has(tab.targetId)).length;
            const hasProtectedTabs = tabs.some((tab) => {
                const managed = managedByTarget.get(tab.targetId);
                return !managed || managed.openedBy === "unknown";
            });
            if (options.keep !== "all" &&
                options.keep.length === 0 &&
                !hasProtectedTabs) {
                await this.#services.closeTaskSpace();
                await this.#discardTerminalState();
                return {
                    spaceId: this.spaceId,
                    closedSpace: true,
                    keptManagedLabels: [],
                    closedManagedLabels: labelsToClose,
                    preservedUnmanagedCount,
                };
            }
            for (const label of labelsToClose) {
                await this.page(label).close();
            }
            await this.#services.completeTaskSpace();
            await this.#discardTerminalState();
            return {
                spaceId: this.spaceId,
                closedSpace: false,
                keptManagedLabels,
                closedManagedLabels: labelsToClose,
                preservedUnmanagedCount,
            };
        });
    }
    async [rollbackCreatedTaskSpaceToken]() {
        await this.#services.gate.withSpace(this.spaceId, async () => {
            await this.#services.closeTaskSpace();
            await this.#discardTerminalState();
        });
    }
    async #discardTerminalState() {
        await this.#services.ledger.discard(this.spaceId);
        this.#stopBackgroundPageDiscovery();
        clearSpacePageNotices(this.spaceId);
    }
    /** Send a Target or Browser domain command within this selected space. */
    async cdp(method, params = {}, options = {}) {
        assertCdpCall("TaskSpace.cdp", method, params, options);
        if (!method.startsWith("Target.") && !method.startsWith("Browser.")) {
            throw new TypeError("task.cdp only supports Target. and Browser. commands");
        }
        return this.#services.gate.withSpace(this.id, () => this.#services.cdp(method, params, undefined, options.timeout));
    }
    /**
     * Bring an untracked browser tab under the durable Page lifecycle.
     * Untracked handles intentionally cannot operate on the tab before adoption.
     */
    async adopt(page, options = {}) {
        validatePublicApiOptions("TaskSpace.adopt", options);
        assertUnmanagedPage(page);
        if (page.spaceId !== this.id) {
            throw new Error(`untracked page ${page.targetId} belongs to space ${page.spaceId}, not space ${this.id}`);
        }
        return this.#services.gate.withSpace(this.id, async () => {
            const { ledger, tabs } = await this.#reconcilePages();
            const live = tabs.some((tab) => tab.targetId === page.targetId);
            if (!live) {
                throw new Error(`untracked page ${page.targetId} is no longer open`);
            }
            const existing = Object.entries(ledger.pages).find(([, entry]) => entry.targetId === page.targetId);
            if (existing) {
                throw new Error(`target ${page.targetId} is already page ${existing[0]}`);
            }
            if (Object.keys(ledger.pages).length >= this.#services.pageBudget) {
                throw pageBudgetError(this, this.#services.pageBudget, ledger, tabs);
            }
            const entry = await this.#services.ledger.addPage(this.id, page.targetId, {
                as: options.as,
                openedBy: page.openedBy,
            });
            return new Page(this, entry.label, this.#services, entry);
        });
    }
    /**
     * Stop managing an unknown-origin page without closing its browser tab.
     * Agent-created pages must be closed so they cannot become untracked orphans.
     */
    async release(label) {
        return this.#services.gate.withSpace(this.id, async () => {
            await this.#reconcilePages();
            const entry = await this.#services.ledger.getPage(this.id, label);
            if (entry.openedBy === "agent") {
                throw new Error(`page ${label} was created by the agent; close it instead of releasing it`);
            }
            const released = await this.#services.ledger.releasePage(this.id, label);
            return new UnmanagedPage(this, released.targetId, released.openedBy, unmanagedPageConstructorToken);
        });
    }
    async newPage(...args) {
        if (args.length > 0) {
            throw new TypeError("task.newPage does not accept arguments");
        }
        return this.#services.gate.withSpace(this.id, async () => {
            const { ledger, tabs } = await this.#reconcilePages();
            const managedCount = Object.keys(ledger.pages).length;
            if (managedCount >= this.#services.pageBudget) {
                throw pageBudgetError(this, this.#services.pageBudget, ledger, tabs);
            }
            const targetId = await this.#services.createTab("about:blank");
            this.#services.setPreferredTarget(targetId);
            const existingManaged = Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId);
            if (existingManaged) {
                throw new Error(`task.newPage did not create a distinct tab; target ${targetId} is already page ${existingManaged[0]}`);
            }
            const existedBeforeCreate = tabs.some((tab) => tab.targetId === targetId);
            let entry;
            try {
                entry = await this.#services.ledger.addPage(this.id, targetId, {
                    openedBy: "agent",
                });
            }
            catch (error) {
                // A tab without a committed label cannot be returned safely. Close it
                // only when createTab produced a new target. Ego Lite may reuse a blank
                // anchor tab; closing a pre-existing target on a ledger error could
                // destroy a page the runtime does not own.
                if (!existedBeforeCreate) {
                    await this.#services
                        .cdp("Target.closeTarget", { targetId })
                        .catch(() => { });
                    this.#services.invalidateSession(targetId);
                }
                throw error;
            }
            await this.#services.ensureSession(targetId);
            return new Page(this, entry.label, this.#services, entry);
        });
    }
    async #reconcilePages() {
        // Some embedders provide a minimal ledger port. Adoption still works
        // without the optional before-image; only the round notice is skipped.
        const before = typeof this.#services.ledger.read === "function"
            ? await this.#services.ledger.read(this.id)
            : undefined;
        const tabs = await this.#services.listTabs();
        const ledger = await this.#services.ledger.reconcile(this.id, tabs.map((tab) => tab.targetId), { autoAdoptNew: this.ownership === "agent" });
        if (before) {
            const knownTargets = new Set(Object.values(before.pages).map((page) => page.targetId));
            for (const [label, page] of Object.entries(ledger.pages)) {
                if (knownTargets.has(page.targetId))
                    continue;
                const tab = tabs.find((candidate) => candidate.targetId === page.targetId);
                recordDiscoveredPage(this.id, { label, ...page }, labelForTarget(ledger, tab?.openerId), tab?.url);
            }
        }
        return { ledger, tabs };
    }
    async #adoptDiscoveredChildPage(ledger, tab) {
        const openerLabel = labelForTarget(ledger, tab.openerId);
        if (!openerLabel ||
            labelForTarget(ledger, tab.targetId) ||
            Object.hasOwn(ledger.unmanagedTargets, tab.targetId)) {
            return undefined;
        }
        try {
            const page = await this.#services.ledger.addPage(this.id, tab.targetId, {
                openedBy: "agent",
            });
            // Keep the current inventory usable while adopting a chain of child
            // pages from one listTabs() result.
            ledger.pages[page.label] = {
                targetId: page.targetId,
                openedBy: page.openedBy,
            };
            recordDiscoveredPage(this.id, page, openerLabel, tab.url);
            return page;
        }
        catch {
            // Another discovery path may have adopted the same target first.
            return undefined;
        }
    }
    #handleBrowserEvent(event) {
        if (event?.method === "Target.targetDestroyed") {
            const targetId = event.params?.targetId;
            if (typeof targetId === "string") {
                forgetPageNotice(this.id, targetId);
            }
            return;
        }
        if (event?.method === "Target.targetInfoChanged") {
            const info = event.params?.targetInfo;
            if (info?.type === "page" &&
                typeof info.targetId === "string" &&
                typeof info.url === "string") {
                refreshUnhandledPageNotice(this.id, info.targetId, info.url);
            }
            return;
        }
        const info = event?.params?.targetInfo;
        if (event?.method !== "Target.targetCreated" ||
            info?.type !== "page" ||
            typeof info.targetId !== "string" ||
            typeof info.openerId !== "string") {
            return;
        }
        void this.#services.gate
            .withSpace(this.id, async () => {
            const before = await this.#services.ledger.read(this.id);
            const tabs = await this.#services.listTabs();
            const tab = tabs.find((candidate) => candidate.targetId === info.targetId);
            if (!tab)
                return;
            await this.#adoptDiscoveredChildPage(before, {
                ...tab,
                openerId: info.openerId,
                url: tab.url || info.url,
            });
        })
            .catch(() => {
            // The next task.tabs() reconciliation remains the fallback.
        });
    }
    async #recoverExistingChildPages() {
        const ledger = await this.#services.ledger.read(this.id);
        const tabs = await this.#services.listTabs();
        for (const tab of tabs) {
            await this.#adoptDiscoveredChildPage(ledger, tab);
        }
    }
    #stopBackgroundPageDiscovery() {
        this.#stopBrowserEvents?.();
        this.#stopBrowserEvents = undefined;
    }
}
function labelForTarget(ledger, targetId) {
    if (typeof targetId !== "string")
        return undefined;
    return Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId)?.[0];
}
function recordDiscoveredPage(spaceId, page, openerLabel, url) {
    recordUnhandledPage({
        spaceId,
        targetId: page.targetId,
        label: page.label,
        openerLabel,
        url,
    });
}
/**
 * A read-only identity for a live tab that is not managed by the Page model.
 * Obtain one from TaskSpace.tabs(), then call TaskSpace.adopt() before
 * navigating, observing, or closing the tab.
 */
class UnmanagedPage {
    spaceId;
    targetId;
    openedBy;
    constructor(task, targetId, openedBy, token) {
        if (token !== unmanagedPageConstructorToken) {
            throw new TypeError("UnmanagedPage handles can only be obtained from task.tabs()");
        }
        this.spaceId = task.id;
        this.targetId = targetId;
        this.openedBy = openedBy;
        Object.freeze(this);
    }
}
/** A file chooser intercepted before Chromium can open a native dialog. */
class FileChooser {
    #services;
    #page;
    #event;
    #interception;
    #handled = false;
    constructor(services, armed, event) {
        this.#services = services;
        this.#page = armed.page;
        this.#interception = armed.interception;
        this.#event = event;
    }
    isMultiple() {
        return this.#event.mode === "selectMultiple";
    }
    async setFiles(path) {
        if (this.#handled)
            throw new Error("this file chooser was already handled");
        const files = normalizeFilePaths(path, "fileChooser.setFiles");
        this.#handled = true;
        try {
            await this.#services.gate.withPage(this.#page, async ({ sessionId }) => {
                await setFilesOnBackendNode(this.#services, sessionId, files, this.#event.backendNodeId);
            });
            return {};
        }
        catch (error) {
            if (isPageDialogOpenedError(error)) {
                return { dialog: error.dialog };
            }
            throw error;
        }
        finally {
            await this.#interception.dispose();
        }
    }
}
/** A Page download backed by a round-local artifact. */
class Download {
    #pageHandle;
    #artifact;
    constructor(page, artifact) {
        this.#pageHandle = page;
        this.#artifact = artifact;
    }
    page() {
        return this.#pageHandle;
    }
    url() {
        return this.#artifact.url;
    }
    suggestedFilename() {
        return this.#artifact.suggestedFilename;
    }
    saveAs(path) {
        return this.#artifact.saveAs(path);
    }
    path() {
        return this.#artifact.path();
    }
    failure() {
        return this.#artifact.failure();
    }
    cancel() {
        return this.#artifact.cancel();
    }
    delete() {
        return this.#artifact.delete();
    }
}
class Page {
    label;
    spaceId;
    mouse;
    keyboard;
    #task;
    #services;
    #spaceName;
    #targetId;
    #openedBy;
    #pendingFileChooser;
    #pendingDownload;
    #activeDownload;
    constructor(task, label, services, entry) {
        this.label = label;
        this.spaceId = task.id;
        this.#task = task;
        this.#spaceName = task.name;
        this.#services = services;
        this.#targetId = entry?.targetId;
        this.#openedBy = entry?.openedBy;
        this.keyboard = new PageKeyboard(this.#services, (operation) => this.#runRawAction((sessionId) => operation(this.#services, sessionId)), (operation) => this.#runObservedAction((sessionId) => operation(this.#services, sessionId)));
        this.mouse = new PageMouse((operation) => this.#runRawAction((sessionId) => operation(this.#services, sessionId)), (operation) => this.#runObservedAction((sessionId) => operation(this.#services, sessionId)), () => this.keyboard.modifierMask());
    }
    get targetId() {
        return this.#targetId;
    }
    get openedBy() {
        return this.#openedBy;
    }
    async goto(url, options = {}) {
        assertUrl(url);
        validatePublicApiOptions("Page.goto", options);
        const timeoutMs = options.timeout ?? 15_000;
        const waitUntil = options.waitUntil ?? "load";
        const page = await this.#resolve();
        const { receipt } = await this.#runActionBoundary(page, async (sessionId) => {
            await navigateInPage(this.#services, sessionId, url, {
                referer: options.referer,
                timeoutMs,
                waitUntil,
            });
        });
        return receipt;
    }
    async reload(options = {}) {
        validatePublicApiOptions("Page.reload", options);
        const timeoutMs = options.timeout ?? 15_000;
        const waitUntil = options.waitUntil ?? "load";
        const page = await this.#resolve();
        const { receipt } = await this.#runActionBoundary(page, async (sessionId) => {
            await reloadInPage(this.#services, sessionId, {
                timeoutMs,
                waitUntil,
            });
        });
        return receipt;
    }
    async snapshot(options = {}) {
        validatePublicApiOptions("Page.snapshot", options);
        const rootRefId = options.scope === "subtree" && options.root !== undefined
            ? parseRef(options.root)
            : undefined;
        if (options.scope === "subtree" && options.root === undefined) {
            throw pageSnapshotOptionsError("page.snapshot subtree scope requires root to be a snapshot ref such as @21");
        }
        if (options.scope !== "subtree" && options.root !== undefined) {
            throw pageSnapshotOptionsError("page.snapshot root is only supported when scope is subtree");
        }
        if (options.root !== undefined && !rootRefId) {
            throw pageSnapshotOptionsError("page.snapshot root must be a snapshot ref such as @21");
        }
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            let root;
            let rootContext;
            if (rootRefId) {
                const refs = await this.#refMapForAction(page, sessionId, options.root);
                const entry = refs.get(rootRefId);
                if (!entry) {
                    throw new ElementResolutionError(`Unknown ref: ${options.root}`, "permanent");
                }
                root = entry.backendNodeId;
                rootContext = {
                    ...(entry.frameId ? { frameId: entry.frameId } : {}),
                    ...(entry.frameProvenance
                        ? { frameProvenance: entry.frameProvenance }
                        : {}),
                };
            }
            const { root: _root, ...snapshotOptions } = options;
            const snapshotScope = options.scope ?? "only_within_viewport";
            const beforeDocuments = await this.#pageDocuments(page, sessionId);
            const result = await this.#services.snapshot({
                ...snapshotOptions,
                ...(root === undefined ? {} : { root }),
                scope: snapshotScope,
                includeActionMarks: options.includeActionMarks ?? true,
                includeStableLocator: options.includeStableLocator ?? true,
            });
            const iframeSessions = Array.isArray(result?.refs) && result.refs.length > 0
                ? await this.#services.ensureFrameSessions(page.targetId)
                : new Map();
            await preparePageSnapshotResult(this.#services, sessionId, iframeSessions, result, rootContext);
            const documents = await this.#pageDocuments(page, sessionId);
            for (const ref of result?.refs || []) {
                const documentId = pageRefDocumentId(ref, documents);
                if (!documentId ||
                    documentId !== pageRefDocumentId(ref, beforeDocuments)) {
                    throw new ElementResolutionError("Page changed during snapshot; take a new snapshot", "transient");
                }
                ref.documentId = documentId;
            }
            await this.#loadRefs(page);
            this.#services.pageRefs.invalidateChangedDocuments(page.targetId, documents);
            await this.#registerSnapshotRefs(page, result, snapshotScope === "full_page");
            const content = result?.content || "";
            const header = await this.#snapshotHeader(page);
            return `${header}\n${content}`;
        });
    }
    async url() {
        return this.#evaluate("location.href", false);
    }
    async waitForURL(expected, options = {}) {
        validatePublicApiOptions("Page.waitForURL", options);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, ({ sessionId }) => waitForURLInPage(this.#services, sessionId, expected, options, {
            interrupt: (lastUrl, matches) => matchingPopupWaitError(this.spaceId, this.label, lastUrl, matches),
        }));
    }
    /** Wait for the next popup or download started by this Page. */
    waitForEvent(event, options = {}) {
        if (event !== "popup" && event !== "download") {
            throw new TypeError("page.waitForEvent only supports the popup and download events");
        }
        validatePublicApiOptions("Page.waitForEvent", options);
        const timeoutMs = options.timeout ?? 10_000;
        if (event === "download")
            return this.#waitForDownload(timeoutMs);
        // Subscribe synchronously so the common `const pending = waitForEvent();
        // await click()` pattern cannot miss a popup created by the click.
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (operation) => {
                if (settled)
                    return;
                settled = true;
                unsubscribe();
                if (timer)
                    clearTimeout(timer);
                operation();
            };
            const onNotice = (notice) => {
                if (notice.spaceId !== this.spaceId ||
                    notice.openerLabel !== this.label) {
                    return;
                }
                finish(() => {
                    markPageObserved(notice.spaceId, notice.targetId);
                    resolve(this.#task.page(notice.label));
                });
            };
            const unsubscribe = subscribeUnhandledPageNotices(onNotice);
            timer = setTimeout(() => {
                finish(() => reject(new Error(`page.waitForEvent("popup") timed out after ${timeoutMs}ms`)));
            }, timeoutMs);
            // Playwright-style event waits observe only future events. Replaying a
            // pending notice here can return a popup from an earlier action.
            // Resolve the source after arming the listener. A stale Page should fail
            // the waiter, but no popup may be lost while that validation is pending.
            if (!settled) {
                void this.#resolve().catch((error) => finish(() => reject(error)));
            }
        });
    }
    #waitForDownload(timeoutMs) {
        if (this.#pendingDownload || this.#activeDownload) {
            throw new Error("this Page already has an active download wait");
        }
        const pending = {
            arm: (async () => {
                const page = await this.#resolve();
                return this.#services.gate.withPage(page, async ({ sessionId }) => {
                    const interception = this.#services.prepareDownload(page.targetId, {
                        timeoutMs,
                    });
                    try {
                        await interception.ready(sessionId);
                        return { page, interception };
                    }
                    catch (error) {
                        await interception.dispose(asError(error));
                        throw error;
                    }
                });
            })(),
        };
        this.#pendingDownload = pending;
        return (async () => {
            let armed;
            try {
                armed = await pending.arm;
                const artifact = await armed.interception.event;
                const active = artifact.finished.finally(() => {
                    if (this.#activeDownload === active) {
                        this.#activeDownload = undefined;
                    }
                });
                this.#activeDownload = active;
                void active.catch(() => { });
                return new Download(this, artifact);
            }
            catch (error) {
                if (armed)
                    await armed.interception.dispose(asError(error));
                throw error;
            }
            finally {
                if (this.#pendingDownload === pending) {
                    this.#pendingDownload = undefined;
                }
            }
        })();
    }
    /** Wait without activating this Page or occupying the native operation gate. */
    async waitForTimeout(timeout) {
        if (typeof timeout !== "number" ||
            !Number.isFinite(timeout) ||
            timeout < 0) {
            throw new TypeError("page.waitForTimeout requires a non-negative number of milliseconds");
        }
        await this.#resolve();
        await this.#services.sleep(timeout);
    }
    async title() {
        return this.#evaluate("document.title", false);
    }
    async info() {
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            const dialog = this.#services.pendingDialog(sessionId);
            if (dialog)
                return { dialog };
            return evaluateInSession(this.#services, sessionId, "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})", false);
        });
    }
    /** Accept the JavaScript dialog currently blocking this Page, if any. */
    async acceptDialog(promptText) {
        if (promptText !== undefined && typeof promptText !== "string") {
            throw new TypeError("page.acceptDialog promptText must be a string");
        }
        return this.#handleJavaScriptDialog(true, promptText);
    }
    /** Dismiss the JavaScript dialog currently blocking this Page, if any. */
    async dismissDialog() {
        return this.#handleJavaScriptDialog(false);
    }
    async evaluate(expression, argument) {
        const hasArgument = arguments.length >= 2;
        return this.#evaluate(expression, hasArgument, argument, true);
    }
    /** Wait until a Page expression returns a truthy value. */
    async waitForFunction(expression, argument, options = {}) {
        if (arguments.length === 2 &&
            typeof expression === "function" &&
            expression.length === 0 &&
            looksLikeWaitForFunctionOptions(argument)) {
            const signature = publicApiEntry("Page.waitForFunction")?.signature;
            throw new TypeError(`page.waitForFunction options are the third argument; pass undefined when omitting the callback argument. Expected: ${signature}`);
        }
        validatePublicApiOptions("Page.waitForFunction", options);
        // Passing `undefined` is how callers omit the optional argument while
        // supplying the third options parameter, matching Playwright's shape.
        const hasArgument = arguments.length >= 2 && argument !== undefined;
        const serializedArgument = validateEvaluateInput("page.waitForFunction", expression, hasArgument, argument);
        const timeoutMs = options.timeout ?? 10_000;
        const pollingMs = options.polling ?? 100;
        const source = waitForFunctionExpression(expression, hasArgument, serializedArgument);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            const deadline = this.#services.now() + timeoutMs;
            let lastUrl = "";
            let lastTitle = "";
            try {
                while (this.#services.now() <= deadline) {
                    const remaining = Math.max(1, deadline - this.#services.now());
                    const executionTimeoutMs = remaining;
                    const transportTimeoutMs = remaining + WAIT_FOR_FUNCTION_TRANSPORT_GRACE_MS;
                    const evaluationStartedAt = this.#services.now();
                    try {
                        let response;
                        try {
                            response = await this.#services.cdp("Runtime.evaluate", {
                                expression: source,
                                returnByValue: true,
                                awaitPromise: true,
                                timeout: executionTimeoutMs,
                            }, sessionId, transportTimeoutMs);
                        }
                        catch (error) {
                            throw normalizeProtocolExecutionTimeout(error, this.#services.now() - evaluationStartedAt, executionTimeoutMs);
                        }
                        const state = runtimeValue(response, source);
                        if (isWaitForFunctionState(state)) {
                            lastUrl = state.url;
                            lastTitle = state.title;
                            if (state.matched)
                                return true;
                        }
                    }
                    catch (error) {
                        if (isEvaluationExecutionDeadlineError(error)) {
                            break;
                        }
                        if (isRuntimeEvaluateTransportTimeout(error)) {
                            throw await recoverPageEvaluationTimeout(this.#services, sessionId, "page.waitForFunction", timeoutMs);
                        }
                        if (!isRetryablePageEvaluationError(error)) {
                            throw enrichPageCallbackReferenceError(error, "page.waitForFunction");
                        }
                        if (this.#services.now() >= deadline)
                            break;
                    }
                    const waitMs = deadline - this.#services.now();
                    if (waitMs <= 0)
                        break;
                    await this.#services.sleep(Math.min(pollingMs, waitMs));
                }
            }
            finally {
                // The predicate may mutate the DOM, so snapshot refs are no longer
                // guaranteed to identify the same elements.
                await this.#invalidateRefs(page);
            }
            throw waitForFunctionTimeoutError(this.spaceId, this.label, timeoutMs, lastUrl, lastTitle);
        });
    }
    /**
     * Run window.fetch inside this Page and return a CDP-serializable response.
     * Relative URLs, cookies, and service workers use the addressed document's
     * browser context. Browser CORS still applies.
     */
    async fetch(url, options = {}) {
        assertUrl(url);
        const { payload, saveAs } = pageFetchPayload(url, options);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            const response = await evaluateInSession(this.#services, sessionId, fetchInPage, true, payload, payload.timeoutMs + 1_000);
            if ("fetchError" in response) {
                throw new Error(response.fetchError);
            }
            if (!saveAs)
                return response;
            if (typeof response.bodyBase64 !== "string") {
                throw new Error("page.fetch received no binary response body");
            }
            await mkdir(dirname(saveAs), { recursive: true });
            await writeFile(saveAs, Buffer.from(response.bodyBase64, "base64"));
            const { bodyBase64: _bodyBase64, ...metadata } = response;
            return { ...metadata, savedPath: saveAs };
        });
    }
    /** Send one CDP command through this Page's target session. */
    async cdp(method, params = {}, options = {}) {
        assertCdpCall("Page.cdp", method, params, options);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            // A modal dialog already belongs to the active Page. Re-activating it
            // can hand browser control to the user before CDP gets a chance to close
            // the dialog, so send this one command directly to its existing session.
            if (method !== "Page.handleJavaScriptDialog") {
                await this.#activate(page.targetId);
            }
            try {
                return await this.#services.cdp(method, params, sessionId, options.timeout);
            }
            finally {
                // Raw CDP can navigate or mutate the document, so existing refs are no
                // longer safe even when the command looked observational.
                await this.#invalidateRefs(page);
            }
        });
    }
    async waitForSelector(selector, options = {}) {
        validatePublicApiOptions("Page.waitForSelector", options);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            const refMap = await this.#refMapForAction(page, sessionId, selector);
            return waitForSelectorInPage(this.#services, sessionId, refMap, selector, options, (timeoutMs) => this.#services.ensureFrameSessions(page.targetId, timeoutMs));
        });
    }
    async waitForLoadState(state = "load", options = {}) {
        validatePublicApiOptions("Page.waitForLoadState", options);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            try {
                await waitForLoadStateInPage(this.#services, sessionId, state, options);
            }
            finally {
                await this.#invalidateRefs(page);
            }
        });
    }
    /** Drain only CDP events routed to this Page session. */
    async events() {
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, ({ sessionId }) => this.#services.drainEvents(sessionId));
    }
    async screenshot(options = {}) {
        validatePublicApiOptions("Page.screenshot", options);
        const { path, fullPage, ...captureOptions } = options;
        if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
            throw new TypeError("page.screenshot path must be a non-empty string");
        }
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            return this.#services.screenshot(path, fullPage === undefined
                ? captureOptions
                : { ...captureOptions, full: fullPage }, sessionId);
        });
    }
    async click(selector, options = {}) {
        validatePublicApiOptions("Page.click", options);
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => clickInPage(services, sessionId, refMap, selector, options, this.keyboard.modifierMask(), iframeSessions), {
            actionName: "page.click",
            guardFileChooser: true,
            timeout: options.timeout,
        });
    }
    async dblclick(selector, options = {}) {
        validatePublicApiOptions("Page.dblclick", options);
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => clickInPage(services, sessionId, refMap, selector, { ...options, clickCount: 2 }, this.keyboard.modifierMask(), iframeSessions), {
            actionName: "page.dblclick",
            guardFileChooser: true,
            timeout: options.timeout,
        });
    }
    async hover(selector, options = {}) {
        validatePublicApiOptions("Page.hover", options);
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => hoverInPage(services, sessionId, refMap, selector, options, this.keyboard.modifierMask(), iframeSessions), { actionName: "page.hover", timeout: options.timeout });
    }
    async dragAndDrop(sourceSelector, targetSelector, options = {}) {
        validatePublicApiOptions("Page.dragAndDrop", options);
        return this.#runAction([sourceSelector, targetSelector], (sessionId, refMap, iframeSessions, services) => dragAndDropInPage(services, sessionId, refMap, sourceSelector, targetSelector, options, this.keyboard.modifierMask(), iframeSessions), { actionName: "page.dragAndDrop", timeout: options.timeout });
    }
    async fill(selector, value, options = {}) {
        validatePublicApiOptions("Page.fill", options);
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => fillInPage(services, sessionId, refMap, selector, value, options, iframeSessions), { actionName: "page.fill", timeout: options.timeout });
    }
    async selectOption(selector, valueOrValues, options = {}) {
        validatePublicApiOptions("Page.selectOption", options);
        const choices = valueOrValues === null
            ? []
            : Array.isArray(valueOrValues)
                ? valueOrValues
                : [valueOrValues];
        choices.forEach(validateSelectOptionChoice);
        const timeoutMs = options.timeout ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
        const page = await this.#resolve();
        return this.#runInputBoundary(page, (sessionId) => this.#retryElementAction("page.selectOption", timeoutMs, sessionId, (remainingMs) => this.#resolveActionTargets(page, sessionId, remainingMs, selector), ({ refMap, iframeSessions }, services) => selectOptionInPage(services, sessionId, refMap, selector, choices, iframeSessions)));
    }
    async focus(selector, options = {}) {
        validatePublicApiOptions("Page.focus", options);
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => focusInPage(services, sessionId, refMap, selector, iframeSessions), { actionName: "page.focus", timeout: options.timeout });
    }
    async press(selector, chord, options = {}) {
        validatePublicApiOptions("Page.press", options);
        const { timeout, ...pressOptions } = options;
        return this.#runAction(selector, async (sessionId, refMap, iframeSessions, services) => {
            await focusInPage(services, sessionId, refMap, selector, iframeSessions);
            await this.keyboard.pressInSession(sessionId, chord, pressOptions);
        }, {
            actionName: "page.press",
            guardFileChooser: true,
            timeout,
        });
    }
    async setInputFiles(selector, path) {
        return this.#runAction(selector, (sessionId, refMap, iframeSessions, services) => setInputFilesInPage(services, sessionId, refMap, selector, path, iframeSessions), { actionName: "page.setInputFiles" });
    }
    waitForFileChooser(options = {}) {
        validatePublicApiOptions("Page.waitForFileChooser", options);
        const timeoutMs = options.timeout ?? 10_000;
        if (this.#pendingFileChooser) {
            throw new Error("this Page is already waiting for a file chooser");
        }
        const pending = {
            arm: (async () => {
                const page = await this.#resolve();
                return this.#services.gate.withPage(page, async ({ sessionId }) => {
                    await this.#activate(page.targetId);
                    const interception = this.#services.prepareFileChooser(sessionId, {
                        timeoutMs,
                        cancel: false,
                    });
                    await interception.ready;
                    return { page, interception };
                });
            })(),
        };
        this.#pendingFileChooser = pending;
        return (async () => {
            let armed;
            try {
                armed = await pending.arm;
                const event = await armed.interception.event;
                return new FileChooser(this.#services, armed, event);
            }
            catch (error) {
                if (armed)
                    await armed.interception.dispose(asError(error));
                throw error;
            }
            finally {
                if (this.#pendingFileChooser === pending) {
                    this.#pendingFileChooser = undefined;
                }
            }
        })();
    }
    async close() {
        const page = await this.#resolve();
        await this.#services.gate.withSpace(this.spaceId, async () => {
            const tabs = await this.#services.listTabs();
            const live = tabs.some((tab) => tab.targetId === page.targetId);
            if (!live) {
                await this.#services.ledger.closePage(this.spaceId, this.label);
                this.#services.pageRefs.clear(page.targetId);
                throw new Error(`page ${this.label} was closed`);
            }
            if (tabs.length <= 1) {
                const anchorTargetId = await this.#services.createTab("about:blank");
                try {
                    await this.#services.ledger.keepUnmanaged(this.spaceId, anchorTargetId, "unknown");
                }
                catch (error) {
                    // The original page is still live, so a failed anchor bookkeeping
                    // write can safely roll the new anchor back before aborting close.
                    await this.#services
                        .cdp("Target.closeTarget", { targetId: anchorTargetId })
                        .catch(() => { });
                    throw error;
                }
            }
            const result = await this.#services.cdp("Target.closeTarget", {
                targetId: page.targetId,
            });
            if (result?.success !== true) {
                throw new Error(`failed to close page ${this.label}`);
            }
            const disappeared = await waitForTargetToDisappear(this.#services, page.targetId, PAGE_CLOSE_CONFIRM_TIMEOUT_MS);
            if (!disappeared) {
                // Keep the durable label while the native tab still exists. The caller
                // can retry close safely instead of leaving an unmanaged orphan.
                throw new Error(`page ${this.label} did not close within ${PAGE_CLOSE_CONFIRM_TIMEOUT_MS}ms`);
            }
            this.#services.invalidateSession(page.targetId);
            this.#services.pageRefs.clear(page.targetId);
            await this.#services.ledger.closePage(this.spaceId, this.label);
        });
    }
    async #resolve() {
        const entry = await this.#services.ledger.getPage(this.spaceId, this.label);
        this.#targetId = entry.targetId;
        this.#openedBy = entry.openedBy;
        markPageObserved(this.spaceId, entry.targetId);
        return { spaceId: this.spaceId, targetId: entry.targetId };
    }
    async #evaluate(expression, hasArgument, argument, activate = false) {
        const serializedArgument = validateEvaluateInput("page.evaluate", expression, hasArgument, argument);
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            if (activate)
                await this.#activate(page.targetId);
            try {
                return await evaluateInSession(this.#services, sessionId, expression, hasArgument, serializedArgument, PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS, PAGE_EVALUATE_EXECUTION_TIMEOUT_MS);
            }
            catch (error) {
                if (isEvaluationExecutionDeadlineError(error)) {
                    throw evaluationExecutionDeadlineError("page.evaluate", PAGE_EVALUATE_EXECUTION_TIMEOUT_MS);
                }
                if (isRuntimeEvaluateTransportTimeout(error)) {
                    throw await recoverPageEvaluationTimeout(this.#services, sessionId, "page.evaluate", PAGE_EVALUATE_TRANSPORT_TIMEOUT_MS);
                }
                if (typeof expression === "function") {
                    throw enrichPageCallbackReferenceError(error, "page.evaluate");
                }
                throw error;
            }
        });
    }
    async #runAction(selector, operation, options = {}) {
        const page = await this.#resolve();
        const selectors = Array.isArray(selector) ? selector : [selector];
        const timeoutMs = options.timeout ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
        const actionName = options.actionName ?? "page action";
        const { receipt } = await this.#runActionBoundary(page, (sessionId) => this.#retryElementAction(actionName, timeoutMs, sessionId, (remainingMs) => this.#resolveActionTargets(page, sessionId, remainingMs, ...selectors), ({ refMap, iframeSessions }, services) => operation(sessionId, refMap, iframeSessions, services)), options.guardFileChooser);
        return receipt;
    }
    async #resolveActionTargets(page, sessionId, remainingMs, ...selectors) {
        const refMap = await this.#refMapForAction(page, sessionId, ...selectors);
        const iframeSessions = await this.#services.ensureFrameSessions(page.targetId, Math.max(1, remainingMs));
        return { refMap, iframeSessions };
    }
    /** Services whose CDP transport reports the first `Input.*` command. */
    #inputTrackingServices(onInput) {
        const services = this.#services;
        return {
            ...services,
            cdp(method, params, sessionId, timeoutMs) {
                if (method.startsWith("Input."))
                    onInput();
                return services.cdp(method, params, sessionId, timeoutMs);
            },
        };
    }
    /**
     * Retry an element action until its deadline. Until the first `Input.*`
     * command reaches the page, failures may include a vanished frame or a lost
     * iframe session and are retried after rediscovering frames. Once input was
     * dispatched only element-state transients are retried, so a gesture that
     * already reached the page is never dispatched twice.
     */
    async #retryElementAction(actionName, timeoutMs, pageSessionId, prepare, perform) {
        const deadline = this.#services.now() + timeoutMs;
        let lastBlocker;
        while (true) {
            let inputDispatched = false;
            const services = this.#inputTrackingServices(() => {
                inputDispatched = true;
            });
            try {
                const prepared = await prepare(deadline - this.#services.now());
                return await perform(prepared, services);
            }
            catch (error) {
                const remainingMs = deadline - this.#services.now();
                // Frame discovery runs on the remaining budget; a transport timeout at
                // the deadline is this action's timeout, reported with the last real
                // blocker rather than as a CDP failure.
                const exhausted = !inputDispatched &&
                    isCdpRequestTimeoutError(error) &&
                    remainingMs <= 0;
                const retryable = inputDispatched
                    ? isRetryableElementStateError(error)
                    : isRetryableResolutionError(error, pageSessionId);
                if (!retryable && !exhausted)
                    throw error;
                if (remainingMs <= 0) {
                    const blocker = exhausted && lastBlocker ? lastBlocker : error;
                    throw new ElementResolutionError(`${actionName} timed out after ${timeoutMs}ms: ${blocker.message}`, "transient");
                }
                lastBlocker = error;
                await this.#services.sleep(Math.min(PAGE_ACTION_RESOLUTION_RETRY_MS, remainingMs));
            }
        }
    }
    async #runRawAction(operation) {
        const page = await this.#resolve();
        try {
            await this.#runInputBoundary(page, operation);
        }
        catch (error) {
            // A modal dialog is now the page's observable result. The interrupted
            // driver stack has already unwound, so no later click/key steps resume
            // unexpectedly after the caller handles the dialog.
            if (isPageDialogOpenedError(error))
                return;
            throw error;
        }
    }
    async #runObservedAction(operation) {
        const page = await this.#resolve();
        const { receipt } = await this.#runActionBoundary(page, operation, true);
        return receipt;
    }
    async #handleJavaScriptDialog(accept, promptText) {
        const page = await this.#resolve();
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            try {
                await this.#services.cdp("Page.handleJavaScriptDialog", {
                    accept,
                    ...(promptText === undefined ? {} : { promptText }),
                }, sessionId);
                // A handled dialog resumes its callback and may mutate the DOM. A
                // no-dialog response leaves the page untouched, so its refs stay valid.
                await this.#invalidateRefs(page);
                return true;
            }
            catch (error) {
                if (isNoJavaScriptDialogError(error))
                    return false;
                throw error;
            }
        });
    }
    async #runInputBoundary(page, operation) {
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            return operation(sessionId);
        });
    }
    async #runActionBoundary(page, operation, guardFileChooser = false) {
        const explicitDownload = this.#pendingDownload;
        const armedDownload = explicitDownload
            ? await explicitDownload.arm
            : undefined;
        if (armedDownload && armedDownload.page.targetId !== page.targetId) {
            throw new Error("download waiter belongs to a different Page");
        }
        const explicitFileChooser = guardFileChooser
            ? this.#pendingFileChooser
            : undefined;
        if (explicitFileChooser) {
            const armed = await explicitFileChooser.arm;
            if (armed.page.targetId !== page.targetId) {
                throw new Error("file chooser waiter belongs to a different Page");
            }
        }
        return this.#services.gate.withPage(page, async ({ sessionId }) => {
            await this.#activate(page.targetId);
            await armedDownload?.interception.ready(sessionId);
            const fileChooserGuard = guardFileChooser && !explicitFileChooser
                ? this.#services.prepareFileChooser(sessionId, {
                    timeoutMs: 1_000,
                    cancel: true,
                })
                : undefined;
            try {
                await fileChooserGuard?.ready;
                const before = new Set((await this.#services.listTabs()).map((tab) => tab.targetId));
                let actionError;
                let value;
                try {
                    value = await operation(sessionId);
                }
                catch (error) {
                    actionError = error;
                }
                if (isPageDialogOpenedError(actionError)) {
                    const dialog = this.#services.pendingDialog(sessionId) || actionError.dialog;
                    return {
                        value: undefined,
                        receipt: { dialog },
                    };
                }
                // A popup is normally created synchronously by the input event. A short
                // settle covers native tab-list propagation without turning this into a
                // navigation wait or silently changing the page's active state.
                await this.#services.sleep(50);
                let popupError;
                const popups = [];
                try {
                    const after = await this.#services.listTabs();
                    for (const tab of after) {
                        if (before.has(tab.targetId))
                            continue;
                        const managed = await this.#services.ledger.addPage(this.spaceId, tab.targetId, { openedBy: "agent" });
                        recordDiscoveredPage(this.spaceId, managed, this.label, tab.url);
                        popups.push({ label: managed.label, targetId: managed.targetId });
                    }
                }
                catch (error) {
                    popupError = error;
                }
                if (fileChooserGuard?.peek()) {
                    throw unhandledFileChooserError();
                }
                if (actionError)
                    throw actionError;
                if (popupError)
                    throw popupError;
                return {
                    value: value,
                    receipt: popups.length > 0 ? { popups } : {},
                };
            }
            finally {
                await fileChooserGuard?.dispose();
            }
        });
    }
    async #refMapForAction(page, sessionId, ...selectors) {
        if (!selectors.some((selector) => parseRef(selector))) {
            return this.#services.pageRefs.forTarget(page.targetId);
        }
        await this.#loadRefs(page);
        const registry = this.#services.pageRefs;
        registry.invalidateChangedDocuments(page.targetId, await this.#pageDocuments(page, sessionId));
        await this.#saveRefs(page);
        const refs = registry.forTarget(page.targetId);
        for (const selector of selectors) {
            const refId = parseRef(selector);
            if (!refId)
                continue;
            if (registry.isInvalidated(page.targetId, refId)) {
                throw new ElementResolutionError(`Stale ref: @${refId}; take a new snapshot`, "permanent");
            }
            if (!refs.get(refId)) {
                throw new ElementResolutionError(`Unknown ref: ${refId}; take a new snapshot`, "permanent");
            }
        }
        return refs;
    }
    async #pageDocuments(page, sessionId) {
        const iframeSessions = await this.#services.ensureFrameSessions(page.targetId);
        const readTree = async (session) => {
            const response = await this.#services.cdp("Page.getFrameTree", {}, session);
            return (response.result || response).frameTree;
        };
        const tree = await readTree(sessionId);
        const documents = new Map();
        const visit = (node) => {
            if (typeof node?.frame?.id !== "string" ||
                typeof node.frame.loaderId !== "string")
                return;
            documents.set(node.frame.id, JSON.stringify([
                tree.frame.id,
                tree.frame.loaderId,
                node.frame.id,
                node.frame.loaderId,
            ]));
            for (const child of node.childFrames || [])
                visit(child);
        };
        visit(tree);
        const root = documents.get(tree?.frame?.id);
        if (!root)
            throw new ElementResolutionError("Cannot verify Page document; take a new snapshot", "transient");
        // The Page tree excludes out-of-process frames. A failed session read must
        // reach the retry boundary, not persistently expire refs in a live frame.
        const frames = await Promise.all([...new Set(iframeSessions.values())]
            .filter((session) => session !== sessionId)
            .map(readTree));
        for (const frame of frames)
            visit(frame);
        documents.set("", root);
        return documents;
    }
    async #loadRefs(page) {
        const stored = await this.#services.ledger.getPage(page.spaceId, this.label);
        this.#services.pageRefs.restore(page.targetId, stored.refs);
    }
    async #saveRefs(page) {
        const refs = this.#services.pageRefs.exportState(page.targetId);
        if (refs)
            await this.#services.ledger.setPageRefs(page.spaceId, this.label, refs);
    }
    async #invalidateRefs(page) {
        await this.#loadRefs(page);
        this.#services.pageRefs.invalidate(page.targetId);
        await this.#saveRefs(page);
    }
    async #registerSnapshotRefs(page, result, replace) {
        const nativeRefs = result?.refs || [];
        const originalIds = nativeRefs.map((ref) => String(ref.refId ?? ref.backendNodeId));
        const registry = this.#services.pageRefs;
        const refs = replace
            ? registry.replace(page.targetId, nativeRefs)
            : registry.merge(page.targetId, nativeRefs);
        if (typeof result?.content === "string") {
            result.content = rewriteSnapshotRefIds(result.content, new Map(nativeRefs.map((ref, index) => [
                originalIds[index],
                String(ref.refId),
            ])));
        }
        await this.#saveRefs(page);
        return refs;
    }
    async #snapshotHeader(page) {
        try {
            const [tabs, ledger] = await Promise.all([
                this.#services.listTabs(),
                this.#services.ledger.read(this.spaceId),
            ]);
            return snapshotSourceHeader({
                currentLabel: this.label,
                currentTargetId: page.targetId,
                ledger,
                pageBudget: this.#services.pageBudget,
                spaceId: this.spaceId,
                spaceName: this.#spaceName,
                tabs,
            });
        }
        catch {
            return `[${this.label} | space ${JSON.stringify(this.#spaceName)}(${this.spaceId})]`;
        }
    }
    async #activate(targetId) {
        await this.#services.cdp("Target.activateTarget", { targetId });
        this.#services.setPreferredTarget(targetId);
    }
}
function pageSnapshotOptionsError(message) {
    const signature = publicApiEntry("Page.snapshot")?.signature;
    return new TypeError(`${message}. Expected: ${signature}`);
}
function snapshotSourceHeader(input) {
    const tabsByTarget = new Map(input.tabs.map((tab) => [tab.targetId, tab]));
    const managedTargets = new Set(Object.values(input.ledger.pages).map((page) => page.targetId));
    const current = tabsByTarget.get(input.currentTargetId);
    const currentTitle = compactPageTitle(current?.title || current?.url || "untitled");
    const pages = Object.entries(input.ledger.pages).map(([label, page]) => {
        const tab = tabsByTarget.get(page.targetId);
        const title = compactPageTitle(tab?.title || tab?.url || "untitled");
        return `${label}${page.targetId === input.currentTargetId ? "*" : ""} ${JSON.stringify(title)}`;
    });
    const untracked = input.tabs.filter((tab) => !managedTargets.has(tab.targetId)).length;
    const managed = pages.length;
    const budget = managed >= input.pageBudget - 1
        ? ` | budget ${managed}/${input.pageBudget}`
        : "";
    const inventory = pages.length > 0 ? ` — ${pages.join(", ")}` : "";
    return `[${input.currentLabel} ${JSON.stringify(currentTitle)} | space ${JSON.stringify(input.spaceName)}(${input.spaceId}): ${managed} managed, ${untracked} untracked${inventory}${budget}]`;
}
async function evaluateInSession(services, sessionId, expression, hasArgument, serializedArgument, timeoutMs, executionTimeoutMs) {
    const startedAt = services.now();
    if (typeof expression === "string") {
        let response;
        try {
            response = await services.cdp("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise: true,
                ...(executionTimeoutMs === undefined
                    ? {}
                    : { timeout: executionTimeoutMs }),
            }, sessionId, timeoutMs);
        }
        catch (error) {
            throw normalizeProtocolExecutionTimeout(error, services.now() - startedAt, executionTimeoutMs);
        }
        return runtimeValue(response, expression);
    }
    const source = expression.toString();
    let response;
    try {
        response = await services.cdp("Runtime.evaluate", {
            expression: `(async function __egoPageEvaluate() {
        return await ${pageFunctionCallExpression(source, hasArgument, serializedArgument)};
      })()`,
            returnByValue: true,
            awaitPromise: true,
            ...(executionTimeoutMs === undefined
                ? {}
                : { timeout: executionTimeoutMs }),
        }, sessionId, timeoutMs);
    }
    catch (error) {
        throw normalizeProtocolExecutionTimeout(error, services.now() - startedAt, executionTimeoutMs);
    }
    return runtimeValue(response, source);
}
function validateEvaluateInput(apiName, expression, hasArgument, argument) {
    if (typeof expression !== "string" && typeof expression !== "function") {
        throw new TypeError(`${apiName} expects a function or string expression`);
    }
    if (typeof expression === "string") {
        if (expression.length === 0) {
            throw new TypeError(`${apiName} expression must not be empty`);
        }
        if (hasArgument) {
            throw new TypeError(`${apiName} string expression does not accept an argument`);
        }
        return undefined;
    }
    return hasArgument ? serializeEvaluateArgument(apiName, argument) : undefined;
}
function serializeEvaluateArgument(apiName, argument) {
    return serializeJsonValue(argument, `${apiName} argument must be JSON-serializable`);
}
function waitForFunctionExpression(expression, hasArgument, serializedArgument) {
    if (typeof expression === "string") {
        return `(async function __egoWaitForFunction() { return { matched: Boolean(await (${expression})), url: location.href, title: document.title }; })()`;
    }
    const source = expression.toString();
    return `(async function __egoWaitForFunction() { return { matched: Boolean(await ${pageFunctionCallExpression(source, hasArgument, serializedArgument)}), url: location.href, title: document.title }; })()`;
}
function pageFunctionCallExpression(source, hasArgument, serializedArgument) {
    if (!hasArgument)
        return `(${source})()`;
    const json = JSON.stringify(serializedArgument);
    return `(${source})(JSON.parse(${JSON.stringify(json)}))`;
}
function isWaitForFunctionState(value) {
    if (!value || typeof value !== "object")
        return false;
    const state = value;
    return (typeof state.matched === "boolean" &&
        typeof state.url === "string" &&
        typeof state.title === "string");
}
function waitForFunctionTimeoutError(spaceId, pageLabel, timeoutMs, lastUrl, lastTitle) {
    const title = lastTitle
        ? `; last title was ${JSON.stringify(lastTitle)}`
        : "";
    const popup = peekUnhandledPageNotices().find((notice) => notice.spaceId === spaceId && notice.openerLabel === pageLabel);
    const popupHint = popup
        ? ` Popup ${popup.label} opened from ${pageLabel} at ${JSON.stringify(popup.url)}; inspect task.page(${JSON.stringify(popup.label)}) before retrying the preceding action.`
        : "";
    return new Error(`page.waitForFunction timed out after ${timeoutMs}ms on page ${pageLabel}; last URL was ${JSON.stringify(lastUrl)}${title}.${popupHint}`);
}
function isRetryablePageEvaluationError(error) {
    if (!(error instanceof Error))
        return false;
    return (error.message.includes("Execution context was destroyed") ||
        error.message.includes("Cannot find context with specified id") ||
        error.message.includes("Inspected target navigated"));
}
function isRuntimeEvaluateTransportTimeout(error) {
    return ((isCdpRequestTimeoutError(error) && error.method === "Runtime.evaluate") ||
        (error instanceof Error &&
            error.message.includes("CDP request timed out: Runtime.evaluate")));
}
function isEvaluationExecutionDeadlineError(error) {
    return (error instanceof Error &&
        error.code === "EGO_PAGE_EXECUTION_DEADLINE");
}
function isProtocolExecutionTimeout(error, elapsedMs, timeoutMs) {
    return (error instanceof Error &&
        (/Execution was terminated|Script execution timed out/i.test(error.message) ||
            (error.message === "Internal error" &&
                timeoutMs !== undefined &&
                elapsedMs !== undefined &&
                elapsedMs >= timeoutMs - 100)));
}
function normalizeProtocolExecutionTimeout(error, elapsedMs, timeoutMs) {
    if (!isProtocolExecutionTimeout(error, elapsedMs, timeoutMs))
        return error;
    if (error instanceof Error) {
        error.code = "EGO_PAGE_EXECUTION_DEADLINE";
    }
    return error;
}
function evaluationExecutionDeadlineError(apiName, timeoutMs) {
    return new PageEvaluationTimeoutError(`${apiName} exceeded its ${timeoutMs}ms page-execution safety limit. The current JavaScript execution was stopped and the Page is ready for another command, but work scheduled earlier may still produce late side effects.`, {
        timeoutMs,
        executionStopped: true,
        mayHaveLateEffects: true,
        pageResponsive: true,
    });
}
async function recoverPageEvaluationTimeout(services, sessionId, apiName, timeoutMs) {
    if (await pageEvaluationHealthProbe(services, sessionId)) {
        return new PageEvaluationTimeoutError(`${apiName} timed out after ${timeoutMs}ms while waiting for page JavaScript. The Page is responsive, but the evaluation is still pending and may produce late side effects. Reload or close the Page when that would be unsafe.`, {
            timeoutMs,
            executionStopped: false,
            mayHaveLateEffects: true,
            pageResponsive: true,
        });
    }
    let terminationSent = false;
    try {
        await services.cdp("Runtime.terminateExecution", {}, sessionId, PAGE_EVALUATE_TERMINATE_TIMEOUT_MS);
        terminationSent = true;
    }
    catch (error) {
        if (!isCdpRequestTimeoutError(error))
            throw error;
    }
    if (terminationSent &&
        (await pageEvaluationHealthProbe(services, sessionId))) {
        return new PageEvaluationTimeoutError(`${apiName} timed out after ${timeoutMs}ms and the renderer stopped responding. The current execution was stopped and the Page recovered, but work scheduled earlier may still produce late side effects.`, {
            timeoutMs,
            executionStopped: true,
            mayHaveLateEffects: true,
            pageResponsive: true,
        });
    }
    return new PageEvaluationTimeoutError(`${apiName} timed out after ${timeoutMs}ms and the Page is still unresponsive. Execution could not be confirmed stopped; reload or close the Page before continuing.`, {
        timeoutMs,
        executionStopped: false,
        mayHaveLateEffects: true,
        pageResponsive: false,
    });
}
async function pageEvaluationHealthProbe(services, sessionId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const startedAt = services.now();
        try {
            const response = await services.cdp("Runtime.evaluate", {
                expression: "1",
                returnByValue: true,
                awaitPromise: false,
                timeout: PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS,
            }, sessionId, PAGE_EVALUATE_HEALTH_TIMEOUT_MS);
            return response?.result?.value === 1;
        }
        catch (error) {
            if (isRuntimeEvaluateTransportTimeout(error))
                return false;
            if (attempt === 0 &&
                isProtocolExecutionTimeout(error, services.now() - startedAt, PAGE_EVALUATE_HEALTH_EXECUTION_TIMEOUT_MS)) {
                // Runtime.terminateExecution may consume the next evaluation rather
                // than the original one. Probe once more before declaring the Page bad.
                continue;
            }
            throw error;
        }
    }
    return false;
}
function enrichPageCallbackReferenceError(error, apiName) {
    if (!(error instanceof Error) ||
        !/\bReferenceError: .* is not defined/.test(error.message) ||
        error.message.includes("cannot access variables from the Node.js script")) {
        return error;
    }
    error.message +=
        `\n${apiName}() callbacks run inside the Page and cannot access variables ` +
            "from the Node.js script. Define the value inside the callback or pass " +
            "JSON data as the second argument.";
    return error;
}
function serializeJsonValue(value, message) {
    try {
        const json = JSON.stringify(value, (_key, item) => {
            if (typeof item === "bigint" ||
                (typeof item === "number" && !Number.isFinite(item))) {
                throw new TypeError("unsupported value");
            }
            return item;
        });
        if (json === undefined)
            throw new TypeError("unsupported value");
        return JSON.parse(json);
    }
    catch (error) {
        throw new TypeError(message, { cause: error });
    }
}
function pageFetchPayload(url, options) {
    validatePublicApiOptions("Page.fetch", options);
    const { timeout = 20_000, saveAs, ...requestOptions } = options;
    return {
        payload: {
            url,
            options: serializeJsonValue(requestOptions, "page.fetch options must be JSON-serializable"),
            timeoutMs: timeout,
            responseType: saveAs ? "base64" : "text",
        },
        ...(saveAs ? { saveAs } : {}),
    };
}
async function fetchInPage({ url, options, timeoutMs, responseType, }) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await window.fetch(url, {
            ...options,
            signal: controller.signal,
        });
        const headers = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        const metadata = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers,
        };
        if (responseType === "text") {
            return { ...metadata, body: await response.text() };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { ...metadata, bodyBase64: btoa(binary) };
    }
    catch (error) {
        if (controller.signal.aborted) {
            return { fetchError: `page.fetch timed out after ${timeoutMs}ms` };
        }
        let requestUrl = url;
        try {
            requestUrl = new URL(url, window.location.href).href;
        }
        catch {
            // Keep the caller's URL when it cannot be resolved in the Page.
        }
        const detail = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        return {
            fetchError: `page.fetch uses window.fetch and obeys browser CORS. ` +
                `Request ${JSON.stringify(requestUrl)} from ${JSON.stringify(window.location.origin)} failed: ${detail}`,
        };
    }
    finally {
        window.clearTimeout(timer);
    }
}
function looksLikeWaitForFunctionOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const keys = Object.keys(value);
    return (keys.length > 0 &&
        keys.every((key) => key === "timeout" || key === "polling"));
}
function isNoJavaScriptDialogError(error) {
    if (!(error instanceof Error))
        return false;
    return /no (?:javascript )?dialog (?:is showing|is open|to handle)/i.test(error.message);
}
function validateSelectOptionChoice(choice, index) {
    const path = `page.selectOption valueOrValues[${index}]`;
    if (typeof choice === "string")
        return;
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        throw new TypeError(`${path} must be a string or an object with value, label, or index`);
    }
    const keys = Object.keys(choice);
    const unknown = keys.find((key) => key !== "value" && key !== "label" && key !== "index");
    if (unknown) {
        throw new TypeError(`${path} has unknown field ${JSON.stringify(unknown)}`);
    }
    if (choice.value === undefined &&
        choice.label === undefined &&
        choice.index === undefined) {
        throw new TypeError(`${path} must specify value, label, or index`);
    }
    if (choice.value !== undefined && typeof choice.value !== "string") {
        throw new TypeError(`${path}.value must be a string`);
    }
    if (choice.label !== undefined && typeof choice.label !== "string") {
        throw new TypeError(`${path}.label must be a string`);
    }
    if (choice.index !== undefined &&
        (!Number.isInteger(choice.index) || choice.index < 0)) {
        throw new TypeError(`${path}.index must be a non-negative integer`);
    }
}
function assertUrl(url) {
    if (typeof url !== "string" || url.length === 0) {
        throw new TypeError("page URL must be a non-empty string");
    }
}
function asError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
function unhandledFileChooserError() {
    const error = new Error("This action opened a file chooser, which was cancelled before the system dialog appeared. " +
        "Use page.setInputFiles() for an existing file input, or call " +
        "page.waitForFileChooser() before the action when the input is created dynamically.");
    error.code = "EGO_FILE_CHOOSER_OPENED";
    return error;
}
function matchingPopupWaitError(spaceId, openerLabel, lastUrl, matches) {
    const popup = peekUnhandledPageNotices().find((notice) => notice.spaceId === spaceId &&
        notice.openerLabel === openerLabel &&
        typeof notice.url === "string" &&
        matches(notice.url));
    if (!popup)
        return undefined;
    const error = new Error(`page ${openerLabel} did not navigate from ${JSON.stringify(lastUrl)}, ` +
        `but popup ${popup.label} opened from it at ${JSON.stringify(popup.url)}. ` +
        `The triggering action already succeeded; do not repeat it. Continue with ` +
        `task.page(${JSON.stringify(popup.label)}).`);
    error.code = "EGO_URL_OPENED_IN_POPUP";
    return error;
}
function assertCdpCall(apiName, method, params, options) {
    if (typeof method !== "string" || method.length === 0) {
        throw new TypeError("cdp method must be a non-empty string");
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new TypeError("cdp params must be an object");
    }
    validatePublicApiOptions(apiName, options);
}
async function waitForTargetToDisappear(services, targetId, timeoutMs) {
    const deadline = services.now() + timeoutMs;
    while (true) {
        const tabs = await services.listTabs();
        if (!tabs.some((tab) => tab.targetId === targetId))
            return true;
        const remaining = deadline - services.now();
        if (remaining <= 0)
            return false;
        await services.sleep(Math.min(PAGE_CLOSE_CONFIRM_INTERVAL_MS, remaining));
    }
}
function tabInventory(task, services, ledger, tabs) {
    const managedByTarget = new Map(Object.entries(ledger.pages).map(([label, entry]) => [
        entry.targetId,
        { label, entry },
    ]));
    return tabs.map((tab) => {
        const managed = managedByTarget.get(tab.targetId);
        if (!managed) {
            const openedBy = ledger.unmanagedTargets[tab.targetId] || "unknown";
            return {
                targetId: tab.targetId,
                page: new UnmanagedPage(task, tab.targetId, openedBy, unmanagedPageConstructorToken),
                title: tab.title || "",
                url: tab.url || "",
                active: Boolean(tab.active),
                openedBy,
            };
        }
        const entry = { label: managed.label, ...managed.entry };
        return {
            targetId: tab.targetId,
            label: managed.label,
            page: new Page(task, managed.label, services, entry),
            title: tab.title || "",
            url: tab.url || "",
            active: Boolean(tab.active),
            openedBy: entry.openedBy,
        };
    });
}
function assertUnmanagedPage(page) {
    if (!(page instanceof UnmanagedPage)) {
        throw new TypeError("task.adopt requires an untracked page returned by task.tabs()");
    }
}
function pageBudgetError(task, limit, ledger, tabs) {
    const tabsByTarget = new Map(tabs.map((tab) => [tab.targetId, tab]));
    const entries = Object.entries(ledger.pages);
    const lines = entries.map(([label, page]) => {
        const tab = tabsByTarget.get(page.targetId);
        const title = compactPageTitle(tab?.title || tab?.url || "untitled");
        return `  ${label.padEnd(6)} ${JSON.stringify(title)}${tab?.active ? " active" : ""}`;
    });
    const suggestion = entries[0]?.[0] || "p1";
    return new PageBudgetError(task.id, limit, [
        `Page budget reached (${entries.length}/${limit}) in space ${JSON.stringify(task.name)}.`,
        "",
        ...lines,
        "",
        `Close: await task.page('${suggestion}').close()`,
        `Reuse: await task.page('${suggestion}').goto(url)`,
    ].join("\n"));
}
function compactPageTitle(value) {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
function configuredPageBudget() {
    const configured = Number(process.env.EGO_BROWSER_PAGE_BUDGET || 8);
    return Number.isInteger(configured) && configured > 0 ? configured : 8;
}

function learningsRoot(workspace = agentWorkspace()) {
    return join(workspace, "learnings");
}
const siteSkillsRoot = learningsRoot;
async function siteSkillsForUrl$1(url, options = {}) {
    const hostname = urlHostname(url);
    if (!hostname) {
        return [];
    }
    const root = options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
    const matches = [];
    for (const siteDir of await iterLearningDirs(root)) {
        let manifest;
        try {
            manifest = await loadLearningManifest(siteDir);
        }
        catch {
            continue;
        }
        const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
        if (domains.some((domain) => typeof domain === "string" && domainMatches(hostname, domain))) {
            matches.push(learningEntry(siteDir, manifest));
        }
    }
    return matches;
}
async function iterLearningDirs(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
        .map((entry) => join(root, entry.name))
        .sort();
}
async function loadLearningManifest(siteDir) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(siteDir, "manifest.json"), "utf8"));
    }
    catch (error) {
        throw new Error(`site skill ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`site skill ${JSON.stringify(siteDir)} manifest must be an object`);
    }
    return parsed;
}
function learningEntry(siteDir, manifest) {
    const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
    return {
        id: manifest.id || siteDir.split(/[\\/]/).at(-1),
        name: manifest.name || manifest.id || siteDir.split(/[\\/]/).at(-1),
        path: siteDir,
        domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
        notes: notes.map((note) => join(siteDir, note)),
        nodeTools: toolSchemasNode(manifest),
        browserTools: toolSchemasBrowser(manifest),
    };
}
function urlHostname(url) {
    try {
        const parsed = String(url).includes("://")
            ? new URL(String(url))
            : new URL(`https://${url}`);
        return (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
    }
    catch {
        return "";
    }
}
function domainMatches(hostname, pattern) {
    const normalized = String(pattern || "")
        .toLowerCase()
        .replace(/\.$/, "");
    if (normalized.startsWith("*.")) {
        const suffix = normalized.slice(2);
        return hostname.endsWith(`.${suffix}`);
    }
    return hostname === normalized;
}
function toolSchemasNode(manifest) {
    const value = manifest.nodeTools;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return { ...value };
}
function toolSchemasBrowser(manifest) {
    const value = manifest.browserTools;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return { ...value };
}

/**
 * Load learned context for a given URL.
 * Returns site knowledge (notes content, available tools, selector hints).
 */
async function loadLearnedContext(url, options = {}) {
    const matches = await siteSkillsForUrl$1(url, options);
    if (matches.length === 0) {
        return {
            exists: false,
            siteId: null,
            siteName: null,
            domain: urlHostname(url),
            knowledge: [],
            tools: [],
        };
    }
    const toolSignatures = [];
    const knowledgeNotes = [];
    for (const entry of matches) {
        const siteId = entry.id;
        for (const notePath of entry.notes) {
            if (!isLearningNotePath(entry.path, notePath)) {
                continue;
            }
            let content;
            try {
                content = await readFile(notePath, "utf8");
            }
            catch {
                continue;
            }
            const fileName = notePath.split(/[\\/]/).pop() || "";
            knowledgeNotes.push({ siteId, fileName, content });
        }
        // Build tool signatures with usage examples
        const nodeTools = entry.nodeTools || {};
        for (const [toolName, schema] of Object.entries(nodeTools)) {
            toolSignatures.push({
                siteId,
                toolName,
                toolType: "node",
                description: schema.description || "",
                args: schema.args || {},
                example: `await runSiteTool("${siteId}", "${toolName}", { ... })`,
            });
        }
        const browserTools = entry.browserTools || {};
        for (const [toolName, schema] of Object.entries(browserTools)) {
            toolSignatures.push({
                siteId,
                toolName,
                toolType: "browser",
                description: schema.description || "",
                args: schema.args || {},
                example: `await runSiteBrowserTool("${siteId}", "${toolName}", { ... })`,
            });
        }
    }
    return {
        exists: true,
        siteId: matches[0].id,
        siteName: matches[0].name,
        domain: urlHostname(url),
        knowledge: knowledgeNotes,
        tools: toolSignatures,
    };
}
function isLearningNotePath(siteDir, notePath) {
    const relativePath = relative(resolve(siteDir), resolve(notePath));
    const parts = relativePath.split(/[\\/]/);
    return (parts.length === 2 &&
        parts[0] === "notes" &&
        parts[1].endsWith(".md") &&
        parts.every((part) => part && part !== "." && part !== ".."));
}
async function findSiteSkill(siteId, options = {}) {
    const root = options.root || siteSkillsRoot(options.agentWorkspace);
    for (const siteDir of await iterLearningDirs(root)) {
        const manifest = await loadLearningManifest(siteDir);
        if (manifest.id === siteId) {
            return { siteDir, manifest };
        }
    }
    throw siteSkillNotFoundError(siteId, root);
}
async function runNodeSiteTool(siteId, toolName, args = {}, ctx, options = {}) {
    const { siteDir, manifest } = await findSiteSkill(siteId, options);
    const schema = toolSchemas(manifest, "nodeTools")[toolName];
    if (!schema || typeof schema !== "object") {
        throw new Error(`Node tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`);
    }
    const toolPath = relativeSitePath(siteDir, schema.path, "Node tool");
    const module = await import(`${pathToFileURL(toolPath).href}?t=${Date.now()}`);
    const callableName = schema.callable;
    if (typeof callableName !== "string" || !callableName.trim()) {
        throw new Error(`Node tool ${JSON.stringify(toolName)} must declare a callable`);
    }
    const tool = module[callableName];
    if (typeof tool !== "function") {
        throw new Error(`site skill ${JSON.stringify(siteId)} is missing Node callable ${JSON.stringify(callableName)}`);
    }
    return tool(ctx, args || {});
}
async function loadBrowserToolSource(siteId, toolName, options = {}) {
    const { siteDir, manifest } = await findSiteSkill(siteId, options);
    const schema = toolSchemas(manifest, "browserTools")[toolName];
    if (!schema || typeof schema !== "object") {
        throw new Error(`browser tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`);
    }
    const toolPath = relativeSitePath(siteDir, schema.path, "browser tool");
    return readFile(toolPath, "utf8");
}
function wrapBrowserTool(source, args = {}) {
    return `(async () => { const __egoBrowserTool = ${source}; return await __egoBrowserTool(${JSON.stringify(args || {})}); })()`;
}
function siteSkillNotFoundError(siteId, searchedRoot) {
    const workspace = process.env.EGO_BROWSER_AGENT_WORKSPACE || "unset";
    const lines = [
        `site skill not found: ${JSON.stringify(siteId)}`,
        `  searched: ${searchedRoot}`,
        `  EGO_BROWSER_AGENT_WORKSPACE: ${workspace}`,
        `  hint: ensure your write path begins with the searched root above`,
    ];
    return new Error(lines.join("\n"));
}
function toolSchemas(manifest, key) {
    const value = manifest[key] || {};
    return value && typeof value === "object" && !Array.isArray(value)
        ? { ...value }
        : {};
}
function relativeSitePath(siteDir, manifestPath, label) {
    if (typeof manifestPath !== "string" || !manifestPath.trim()) {
        throw new Error(`${label} path must be a non-empty relative path`);
    }
    if (manifestPath.includes("\\") ||
        isAbsolute(manifestPath) ||
        manifestPath.split("/").includes("..")) {
        throw new Error(`${label} path must be relative to the site skill directory`);
    }
    const resolved = resolve(siteDir, manifestPath);
    const siteRoot = resolve(siteDir);
    // Windows: path.resolve returns backslash paths, so a "/" boundary check
    // rejects every relative tool path. Use the platform separator instead.
    const boundary = siteRoot.endsWith(sep) ? siteRoot : siteRoot + sep;
    if (resolved !== siteRoot && !resolved.startsWith(boundary)) {
        throw new Error(`${label} path must stay inside the site skill directory`);
    }
    return resolved;
}

/**
 * List Agent-owned and user-owned spaces exposed by Ego Lite.
 * Use the numeric id as the stable locator; display names may be duplicated.
 * @returns {Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,profileId?:string,profileName?:string,recentTabTitles?:string[]}>>}
 */
async function listTaskSpaces() {
    const ego = globalThis.ego;
    if (!ego || typeof ego.listTaskSpaces !== "function") {
        throw new Error("listTaskSpaces requires ego.listTaskSpaces");
    }
    return normalizeTaskSpaces(await invokeEgo("listTaskSpaces", () => ego.listTaskSpaces()));
}
/**
 * List browser profiles that may be selected when creating a task space.
 * Profile ids are stable locators; display names are not guaranteed unique.
 * @returns {Promise<Array<{id:string,name:string,isDefault:boolean}>>}
 */
async function profiles() {
    const ego = globalThis.ego;
    if (!ego || typeof ego.listProfiles !== "function") {
        throw new Error("profiles requires ego.listProfiles");
    }
    const result = await invokeEgo("profiles", () => ego.listProfiles());
    if (!Array.isArray(result?.profiles) ||
        !result.profiles.every((profile) => profile &&
            typeof profile.id === "string" &&
            profile.id.length > 0 &&
            typeof profile.name === "string" &&
            typeof profile.isDefault === "boolean")) {
        throw new Error("profiles expected entries with id, name, and isDefault");
    }
    return result.profiles;
}
/*
 * Task space ownership policy (`ownership`: "agent" | "agentDelegatedToUser" | "user").
 * "agent" and "agentDelegatedToUser" are both agent-owned (see isAgentOwned) — the
 * latter is the agent's own space with control temporarily handed to the user
 * (handoff or GUI takeover). The user-control boundary is enforced at the native
 * bridge when real commands run, not here. The rows below describe what each helper
 * does when the target space is user-owned:
 *
 *   switchTaskSpace                     -> throws (agent-owned only)
 *   claimTaskSpace                      -> claims it (ownership transfers to the agent), then selects it
 *   handOffTaskSpace                    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: true }    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: false }   -> claims it, then closes it
 *   takeOverTaskSpace / waitForAgentControl -> no ownership check (operates as-is)
 *
 * Keep this table in sync with the one in skills/ego-browser/SKILL.md.
 */
/**
 * Whether the agent owns the space. "agentDelegatedToUser" is still agent-owned —
 * the agent created it but control is temporarily with the user (handoff / GUI
 * takeover). Selecting such a space is fine; the user-control boundary is enforced
 * separately at the native bridge when real commands run.
 * @param {string|undefined} ownership
 * @returns {boolean}
 */
function isAgentOwned(ownership) {
    return ownership === "agent" || ownership === "agentDelegatedToUser";
}
/**
 * Select an existing task space by id/name for the current Node invocation.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function switchTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.useTaskSpace !== "function") {
        throw new Error("switchTaskSpace requires ego.useTaskSpace");
    }
    const space = await findTaskSpace(nameOrId);
    if (!isAgentOwned(space.ownership)) {
        throw new Error(`switchTaskSpace requires an agent-owned task space, got ownership ${JSON.stringify(space.ownership)}`);
    }
    return selectTaskSpace(ego, space, "switchTaskSpace");
}
/**
 * Create an agent-owned task space and select it for the current Node invocation.
 * @param {string} name Task space name.
 * @param {string} [profileId] Profile id returned by profiles().
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function newTaskSpace(name, profileId) {
    return (await createTaskSpaceResolution(name, profileId)).descriptor;
}
async function createTaskSpaceResolution(name, profileId, options = {}) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.createTaskSpace !== "function") {
        throw new Error("newTaskSpace requires ego.createTaskSpace");
    }
    // Do not pass an explicit undefined: older native bindings reject extra
    // arguments, while newer builds accept profileId as the second argument.
    const created = normalizeTaskSpace(await invokeEgo("newTaskSpace", () => profileId === undefined
        ? ego.createTaskSpace(name)
        : ego.createTaskSpace(name, profileId)));
    if (!created) {
        throw new Error("newTaskSpace returned an invalid task space");
    }
    taskSpaceNumericId(created, "newTaskSpace");
    // The native create response currently omits ownership on some Ego Lite
    // builds. Creation through this Agent API is itself authoritative.
    const createdByAgent = {
        ...created,
        ownership: created.ownership || "agent",
    };
    const descriptor = options.select === false
        ? createdByAgent
        : await selectTaskSpace(ego, createdByAgent, "newTaskSpace");
    return {
        descriptor,
        created: true,
    };
}
/**
 * Use an existing agent-owned task space, or create it when missing. User-owned
 * spaces are selected but not claimed (the EGO_TASK_SPACE_USER_IN_CONTROL error
 * surfaces) — call claimTaskSpace(nameOrId) to take ownership.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
async function useOrCreateTaskSpace(nameOrId) {
    return (await resolveTaskSpace(nameOrId)).descriptor;
}
async function resolveTaskSpace(nameOrId, options = {}) {
    const spaces = await listTaskSpaces();
    const existing = findMatchingTaskSpace(spaces, nameOrId);
    if (!existing) {
        if (typeof nameOrId === "number") {
            throw new Error(`task space not found: ${nameOrId}`);
        }
        return createTaskSpaceResolution(nameOrId, undefined, {
            select: options.select,
        });
    }
    if (isAgentOwned(existing.ownership)) {
        return {
            descriptor: options.select === false
                ? existing
                : await selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace"),
            created: false,
        };
    }
    if (existing.ownership === "user") {
        // Don't claim user-owned spaces here. Select it as-is; the user stays in
        // control, so EGO_TASK_SPACE_USER_IN_CONTROL surfaces (as ego-browser's owned
        // guidance, not the raw native text). Call claimTaskSpace(nameOrId) to take
        // ownership.
        return {
            descriptor: options.select === false
                ? existing
                : await selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace"),
            created: false,
        };
    }
    throw new Error(`useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`);
}
/**
 * Return the v2 object handle for an existing task space, or create the space
 * when a string name does not exist.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @param {{profileId?:string}} [options] Creation options for a new named space.
 * @returns {Promise<import('./page-model.js').TaskSpace>}
 */
async function taskSpace(nameOrId, options = {}) {
    validatePublicApiOptions("taskSpace", options);
    const { profileId } = options;
    if (profileId === undefined) {
        return initializeResolvedTaskSpace(await resolveTaskSpace(nameOrId, { select: false }));
    }
    if (typeof nameOrId !== "string") {
        throw new TypeError("taskSpace profileId can only be used with a new task-space name");
    }
    const existing = findMatchingTaskSpace(await listTaskSpaces(), nameOrId);
    if (existing) {
        throw new Error(`taskSpace profileId only applies when creating a new task space; ${JSON.stringify(nameOrId)} already exists`);
    }
    return initializeResolvedTaskSpace(await createTaskSpaceResolution(nameOrId, profileId, { select: false }));
}
async function initializeResolvedTaskSpace(resolution) {
    const task = createTaskSpaceHandle(resolution.descriptor);
    if (!resolution.created) {
        await initializeTaskSpaceHandle(task);
        return task;
    }
    try {
        await initializeTaskSpaceHandle(task, { created: true });
        return task;
    }
    catch (error) {
        // A fresh space must not survive without its canonical p1 ledger entry.
        // Preserve the initialization error if native rollback is unavailable.
        await rollbackCreatedTaskSpace(task).catch(() => { });
        throw error;
    }
}
/**
 * Claim a user-owned task space (ownership transfers to the agent) and select it
 * for the current Node invocation. Resolves the space by id/name, claims it via
 * ego.claimTaskSpace, then selects it.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<import('./page-model.js').TaskSpace>}
 */
async function claimTaskSpace(nameOrId) {
    const space = await findTaskSpace(nameOrId);
    const claimed = await claimResolvedTaskSpace(space, "claimTaskSpace");
    const task = createTaskSpaceHandle({ ...claimed, ownership: "agent" });
    await captureTaskSpaceUserBoundary(task);
    await initializeTaskSpaceHandle(task);
    return task;
}
async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
    const ego = globalThis.ego;
    if (!ego || typeof ego.claimTaskSpace !== "function") {
        throw new Error(`${op} requires ego.claimTaskSpace`);
    }
    const id = taskSpaceNumericId(space, op);
    const claimed = normalizeTaskSpace(await invokeEgo(op, () => ego.claimTaskSpace(id, space.name)));
    if (!claimed) {
        throw new Error(`${op} returned an invalid task space`);
    }
    taskSpaceNumericId(claimed, op);
    return selectTaskSpace(ego, claimed, op);
}
async function selectTaskSpace(ego, space, op) {
    if (!ego || typeof ego.useTaskSpace !== "function") {
        throw new Error(`${op} requires ego.useTaskSpace`);
    }
    await invokeEgo(op, () => ego.useTaskSpace(taskSpaceNumericId(space, op)));
    return space;
}
async function selectTaskSpaceIfProvided(ego, nameOrId, op = "taskSpace") {
    if (nameOrId === undefined)
        return;
    const match = await findTaskSpace(nameOrId);
    await selectTaskSpace(ego, match, op);
}
/**
 * Finish working on a task space. With `{ keep: true }` the page stays open
 * with the agent overlay dismissed so the user can review the result; with
 * `{ keep: false }` the task space is closed entirely.
 * User-owned spaces: `keep:true` is skipped (the user already has the page) and
 * resolves `{ done: false, skipped: "user-owned" }`; `keep:false` claims the
 * space first, then closes it.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ keep: boolean }} options Required. `keep:true` hands the page to the user; `keep:false` closes the space.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when the space was completed or closed; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
async function completeTaskSpace(nameOrId, options) {
    if ((typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
        nameOrId === "") {
        throw new Error("completeTaskSpace requires a task space name or id");
    }
    if (!options || typeof options.keep !== "boolean") {
        throw new Error("completeTaskSpace requires { keep: boolean }");
    }
    const ego = globalThis.ego;
    if (!ego) {
        throw new Error("completeTaskSpace requires ego runtime");
    }
    const spaces = await listTaskSpaces();
    const match = findMatchingTaskSpace(spaces, nameOrId);
    if (!match) {
        throw new Error(`task space not found: ${nameOrId}`);
    }
    if (options.keep) {
        if (match.ownership === "user") {
            return { done: false, skipped: "user-owned" };
        }
        await selectTaskSpace(ego, match, "completeTaskSpace");
        if (typeof ego.completeTaskSpace !== "function") {
            throw new Error("completeTaskSpace requires ego.completeTaskSpace");
        }
        await invokeEgo("completeTaskSpace", () => ego.completeTaskSpace());
    }
    else {
        if (match.ownership === "user") {
            await claimResolvedTaskSpace(match, "completeTaskSpace");
        }
        else {
            await selectTaskSpace(ego, match, "completeTaskSpace");
        }
        if (typeof ego.closeTaskSpace !== "function") {
            throw new Error("completeTaskSpace requires ego.closeTaskSpace");
        }
        await invokeEgo("completeTaskSpace", () => ego.closeTaskSpace());
    }
    return { done: true };
}
/**
 * Hand off a task space back to the user, hiding the agent overlay.
 * User-owned spaces are skipped (the user already controls them) and resolve
 * `{ done: false, skipped: "user-owned" }`.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when control was handed off; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
async function handOffTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.handOffTaskSpace !== "function") {
        throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
    }
    if (nameOrId !== undefined) {
        const match = await findTaskSpace(nameOrId);
        if (match.ownership === "user") {
            return { done: false, skipped: "user-owned" };
        }
        await selectTaskSpace(ego, match, "handOffTaskSpace");
    }
    await invokeEgo("handOffTaskSpace", () => ego.handOffTaskSpace());
    return { done: true };
}
/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<import('./page-model.js').TaskSpace|void>} A TaskSpace when a name or id is provided; otherwise preserves the selected-space form's void result.
 */
async function takeOverTaskSpace(nameOrId) {
    const ego = globalThis.ego;
    if (!ego || typeof ego.takeOverTaskSpace !== "function") {
        throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
    }
    let descriptor;
    if (nameOrId !== undefined) {
        descriptor = await findTaskSpace(nameOrId);
        await selectTaskSpace(ego, descriptor, "takeOverTaskSpace");
    }
    await invokeEgo("takeOverTaskSpace", () => ego.takeOverTaskSpace());
    if (descriptor) {
        const task = createTaskSpaceHandle({ ...descriptor, ownership: "agent" });
        // Repeatedly ensuring control over an already agent-controlled space is a
        // no-op, not a user interaction boundary. Only delegated spaces can have
        // gained tabs through user activity since the Agent last controlled them.
        if (descriptor.ownership === "agentDelegatedToUser") {
            await captureTaskSpaceUserBoundary(task);
        }
        await initializeTaskSpaceHandle(task);
        return task;
    }
}
/**
 * Probe whether the agent currently holds control of the active task space.
 * Module-private; used by waitForAgentControl. Uses ego.snapshot, which
 * rejects under user-control (per ego-bindings spec) — a reliable
 * synchronous-error signal that raw CDP sends can't provide. Other rejections
 * (task not found, internal errors) propagate so the caller fails fast instead
 * of busy-looping until timeout.
 */
async function probeCurrentAgentControl() {
    const ego = globalThis.ego;
    if (!ego || typeof ego.snapshot !== "function")
        return false;
    return probeAgentControl(() => ego.snapshot({ maxResultLength: 1 }));
}
/**
 * Block until the agent regains control of the named task space.
 * Polls a harmless probe until it succeeds, or throws when the timeout
 * elapses. Read-only — does not call takeOverTaskSpace.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ interval?: number, timeout?: number }} [options] interval & timeout in seconds (default 20s / 600s).
 * @returns {Promise<void>}
 */
async function waitForAgentControl(nameOrId, options = {}) {
    if ((typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
        nameOrId === "") {
        throw new Error("waitForAgentControl requires a task space name or id");
    }
    const ego = globalThis.ego;
    if (!ego) {
        throw new Error("waitForAgentControl requires ego runtime");
    }
    await selectTaskSpaceIfProvided(ego, nameOrId, "waitForAgentControl");
    const interval = typeof options.interval === "number" ? options.interval : 20;
    const timeout = typeof options.timeout === "number" ? options.timeout : 600;
    const deadline = Date.now() + timeout * 1000;
    while (true) {
        if (await probeCurrentAgentControl())
            return;
        if (Date.now() >= deadline) {
            throw new Error(`waitForAgentControl timed out after ${timeout}s`);
        }
        await wait(interval);
    }
}
function normalizeTaskSpaces(raw) {
    if (Array.isArray(raw?.taskSpaces)) {
        return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
    }
    throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
}
function normalizeTaskSpace(space) {
    const taskId = space?.taskId ?? space?.name ?? space?.id;
    if (taskId === undefined || taskId === null || taskId === "") {
        return null;
    }
    return {
        ...space,
        taskId,
        id: space?.id ?? taskId,
        name: space?.name ?? taskId,
    };
}
function taskSpaceNumericId(space, op) {
    if (typeof space?.id !== "number" || !Number.isFinite(space.id)) {
        throw new Error(`${op} requires a numeric task space id, got ${JSON.stringify(space?.id)}`);
    }
    return space.id;
}
async function findTaskSpace(nameOrId) {
    const spaces = await listTaskSpaces();
    const match = findMatchingTaskSpace(spaces, nameOrId);
    if (!match)
        throw new Error(`task space not found: ${nameOrId}`);
    return match;
}
function findMatchingTaskSpace(spaces, nameOrId) {
    if (typeof nameOrId === "number") {
        return spaces.find((space) => space.id === nameOrId);
    }
    const byName = spaces.find((space) => space.name === nameOrId || space.taskId === nameOrId);
    if (byName)
        return byName;
    if (/^\d+$/.test(nameOrId)) {
        const id = Number(nameOrId);
        if (Number.isFinite(id)) {
            return spaces.find((space) => space.id === id);
        }
    }
    return undefined;
}
async function siteSkillsForUrl(url) {
    return siteSkillsForUrl$1(url, {
        agentWorkspace: state.agentWorkspace(),
    });
}
/**
 * Return site skills matching a URL, or the current page URL when omitted.
 * @param {string} [url] URL to inspect for site skills.
 * @returns {Promise<Array<object|string>>}
 */
async function siteSkills(url = undefined) {
    const targetUrl = url ?? (await pageInfo()).url ?? "";
    return siteSkillsForUrl(targetUrl);
}
/**
 * Run a learned Node site tool with the helper context.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Tool result.
 */
async function runSiteTool(siteId, toolName, args = {}) {
    return runNodeSiteTool(siteId, toolName, args, helperContext(), {
        agentWorkspace: state.agentWorkspace(),
    });
}
/**
 * Run a learned browser-side site tool in the current page.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Browser tool result.
 */
async function runSiteBrowserTool(siteId, toolName, args = {}) {
    const source = await loadBrowserToolSource(siteId, toolName, {
        agentWorkspace: state.agentWorkspace(),
    });
    return js(wrapBrowserTool(source, args));
}
/**
 * Load learned context for the current page or a given URL.
 * Returns accumulated site knowledge: notes content, available tools, usage examples.
 * @param {string} [url] URL to inspect. Defaults to current page.
 * @returns {Promise<object>} Learned context with knowledge and tool signatures.
 */
async function learnContext(url = undefined) {
    const targetUrl = url ?? (await pageInfo()).url ?? "";
    return loadLearnedContext(targetUrl, {
        agentWorkspace: state.agentWorkspace(),
    });
}
function helperContext(extra = {}) {
    const { newTab: _newTab, ...publicNav } = nav;
    const all = {
        ...pointer,
        ...keyboard,
        ...publicNav,
        ...observe,
        ...waits,
        ...files,
        cdp,
        js,
        serverFetch,
        browserFetch,
        siteSkills,
        siteSkillsForUrl,
        runSiteTool,
        runSiteBrowserTool,
        learnContext,
        profiles,
        listTaskSpaces,
        switchTaskSpace,
        newTaskSpace,
        taskSpace,
        useOrCreateTaskSpace,
        claimTaskSpace,
        completeTaskSpace,
        handOffTaskSpace,
        takeOverTaskSpace,
        waitForAgentControl,
        ...extra,
    };
    return {
        ...all,
        // The formal 1.3 Skill starts through egoBrowser.*. Keep a narrow guard so
        // stale conversations get a recovery instruction instead of a ReferenceError.
        egoBrowser: createStaleEgoBrowserGuard(),
        help: (...names) => {
            const result = help(all, ...names);
            if (typeof result === "string")
                return result;
            if (Array.isArray(result))
                return result.map(formatHelp).join("\n\n");
            return formatHelp(result);
        },
    };
}
async function loadAgentHelpers() {
    const path = join(state.agentWorkspace(), "agent_helpers.js");
    if (!existsSync(path)) {
        return {};
    }
    const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
    const out = {};
    for (const [name, value] of Object.entries(module)) {
        if (!name.startsWith("_")) {
            out[name] = value;
        }
    }
    return out;
}
const __testing = { setOverrides, decodeUnserializableJsValue };

const PAGE_ONLY_GLOBALS = [
    "document",
    "innerHeight",
    "innerWidth",
    "localStorage",
    "location",
    "scrollX",
    "scrollY",
    "sessionStorage",
    "window",
];
const PAGE_ONLY_GLOBAL_NAMES = new Set(PAGE_ONLY_GLOBALS);
function pageContextHint(globalName) {
    return (`The heredoc runs in Node.js, not in the Page. ${globalName} is a Page global. ` +
        "Put browser-side code inside page.evaluate(), for example page.evaluate(() => ...); " +
        "keep Node.js work outside it.");
}
/** Add one actionable hint to the common Node-versus-Page context mistake. */
function addPageContextHint(error) {
    if (!(error instanceof ReferenceError))
        return error;
    const match = /^([A-Za-z_$][\w$]*) is not defined\.?$/i.exec(error.message.trim());
    if (!match || !PAGE_ONLY_GLOBAL_NAMES.has(match[1]))
        return error;
    if (error.message.includes("page.evaluate()"))
        return error;
    const originalMessage = error.message;
    error.message = `${originalMessage}. ${pageContextHint(match[1])}`;
    if (typeof error.stack === "string") {
        const lines = error.stack.split("\n");
        lines[0] = `${error.name}: ${error.message}`;
        error.stack = lines.join("\n");
    }
    return error;
}
/**
 * Install an SDK-only guard so the embedding host can print the same hint even
 * though it, rather than ego-browser's CLI wrapper, executes the heredoc.
 */
function installPageContextGuard(target) {
    for (const globalName of PAGE_ONLY_GLOBALS) {
        // Defining `window` would change normal Node.js checks such as
        // `typeof window`, so only the CLI wrapper enriches that error.
        if (globalName === "window")
            continue;
        if (Object.getOwnPropertyDescriptor(target, globalName))
            continue;
        Object.defineProperty(target, globalName, {
            configurable: true,
            enumerable: false,
            get() {
                throw new ReferenceError(`${globalName} is not defined. ${pageContextHint(globalName)}`);
            },
        });
    }
}

const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.
`;
const USAGE = `Usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS
`;
async function runMain(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const stdout$1 = options.stdout || stdout;
    const stderr$1 = options.stderr || stderr;
    if (argv[0] === "-h" || argv[0] === "--help") {
        write(stdout$1, HELP);
        return 0;
    }
    if (argv.length > 0) {
        write(stderr$1, USAGE);
        return 2;
    }
    const code = options.stdinText !== undefined
        ? options.stdinText
        : await readAll(options.stdin || stdin);
    if (!code.trim()) {
        write(stderr$1, USAGE);
        return 2;
    }
    await execute(code, stdout$1);
    return 0;
}
async function execute(code, stdout) {
    resetSink();
    const context = await executionContext();
    // Helpers remain globally visible for loaded agent modules, but console is a
    // lexical round parameter so the CLI never replaces Node's process console.
    const globalHelpers = { ...context };
    delete globalHelpers.console;
    Object.assign(globalThis, globalHelpers);
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const names = Object.keys(context);
    const values = Object.values(context);
    let fn;
    try {
        fn = new AsyncFunction(...names, `"use strict";\n${code}`);
    }
    catch (error) {
        flushSink(stdout, true);
        throw userScriptSyntaxError(code, error);
    }
    try {
        await fn(...values);
    }
    catch (error) {
        // The thrown Error surfaces the hard-stop message on its own, so flush as a thrown
        // completion (drop the buffer, stay silent) and let it propagate.
        flushSink(stdout, true);
        throw addPageContextHint(error);
    }
    flushSink(stdout, false);
}
function userScriptSyntaxError(code, original) {
    const originalMessage = original instanceof Error ? original.message : String(original);
    try {
        // V8 omits source locations for Function-constructor syntax errors. Acorn
        // only runs after compilation fails and recovers the location in the
        // user's script; wrapping preserves top-level await support.
        parse(`async function __egoBrowserUserScript__() {\n${code}\n}`, {
            ecmaVersion: "latest",
            sourceType: "script",
        });
    }
    catch (parseError) {
        const location = parseError
            .loc;
        if (location && location.line >= 2) {
            const userLineNumber = location.line - 1;
            const sourceLine = code.split(/\r?\n/)[userLineNumber - 1] ?? "";
            const columnNumber = location.column + 1;
            const error = new SyntaxError(`Browser script syntax error at line ${userLineNumber}, column ${columnNumber}: ${originalMessage}\n` +
                `${userLineNumber} | ${sourceLine}\n` +
                `${" ".repeat(String(userLineNumber).length + 3 + location.column)}^`);
            error.cause = original;
            return error;
        }
    }
    return original instanceof SyntaxError
        ? original
        : new SyntaxError(originalMessage);
}
async function executionContext() {
    const agentHelpers = await loadAgentHelpers();
    // Single source of truth for the agent-facing surface: the same helperContext()
    // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
    // cannot drift apart (and `help` exists in both).
    const context = helperContext(agentHelpers);
    context.cliLog = (...args) => {
        // Buffer rather than write through; execute() flushes (or discards on hard stop)
        // once the script settles. Keeps the CLI path identical to the SDK path.
        bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
    };
    // A lexical parameter shadows Node's global console without mutating it.
    context.console = createRoundConsole();
    return context;
}
function readAll(stream) {
    return new Promise((resolve, reject) => {
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            data += chunk;
        });
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
    });
}
function write(stream, text) {
    stream.write(text);
}

const PROBE_TIMEOUT_MS = 500;
/** Emit a best-effort update hint without making it part of task success. */
async function emitUpdateNotice(runtime, emit) {
    if (typeof runtime?.getBrowserVersion !== "function")
        return;
    try {
        const result = await Promise.race([
            runtime.getBrowserVersion(),
            setTimeout$1(PROBE_TIMEOUT_MS, null, { ref: false }),
        ]);
        if (!result || typeof result !== "object")
            return;
        const info = result;
        if (info.updateAvailable !== true ||
            typeof info.currentVersion !== "string" ||
            info.currentVersion.trim().length === 0) {
            return;
        }
        emit(`[ego-browser:notice] Ego Lite update is available ` +
            `(current ${info.currentVersion.trim()}). Finish the current browser task, ` +
            "then ask the user before running `ego-browser upgrade`; re-read the " +
            "ego-browser Skill afterward.");
    }
    catch {
        // An optional update hint must never fail the browser task.
    }
}

/** Release native callbacks before the host discards an embedded Node context. */
async function disposeEgoSdk(target = globalThis) {
    disposeDownloadArtifacts();
    disposeBrowserRuntime(target.ego);
}
const SYNC_HELPERS = new Set(["help"]);
// Marks an ego runtime whose mutating methods have already been wrapped, so a
// second installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for("egoBrowser.sdkWrapped");
function installEgoSdk(target = globalThis, options = {}) {
    if (!target || typeof target !== "object") {
        return target;
    }
    if (target === globalThis)
        installPageContextGuard(target);
    const context = options.context || helperContext();
    const readySignal = Promise.resolve(options.ready);
    // The host may reject readiness before a helper is called. Mark the promise
    // as observed while preserving the same rejection for every helper await.
    void readySignal.catch(() => { });
    const installed = {};
    for (const [name, value] of Object.entries(context)) {
        if (typeof value !== "function") {
            continue;
        }
        const exposed = SYNC_HELPERS.has(name)
            ? value
            : async (...args) => {
                await readySignal;
                return value(...args);
            };
        Object.defineProperty(target, name, {
            value: exposed,
            writable: true,
            configurable: true,
            enumerable: false,
        });
        installed[name] = exposed;
    }
    // Non-function values are intentionally absent from the normal helper loop.
    // Install the 1.3 migration guard explicitly so embedded SDK execution and
    // the direct CLI produce the same actionable error.
    installStaleEgoBrowserGuard(target);
    const usingDefaultCliLog = !options.cliLog;
    const cliLogFn = options.cliLog || createCliLog();
    Object.defineProperty(target, "cliLog", {
        value: cliLogFn,
        writable: true,
        configurable: true,
        enumerable: false,
    });
    installed.cliLog = cliLogFn;
    Object.defineProperty(target, "console", {
        value: createRoundConsole(usingDefaultCliLog
            ? undefined
            : (line) => cliLogFn(line.endsWith("\n") ? line.slice(0, -1) : line)),
        writable: true,
        configurable: true,
        enumerable: false,
    });
    if (usingDefaultCliLog) {
        // SDK path: the host runs each heredoc in a fresh short-lived process and never
        // calls execute(), so reset the per-run sink and flush it on process teardown.
        resetSink();
        installLifecycleFlush(process.stdout);
    }
    if (target.ego && typeof target.ego === "object") {
        void emitUpdateNotice(target.ego, (line) => {
            if (usingDefaultCliLog)
                bufferOutput(`${line}\n`);
            else
                cliLogFn(line);
        });
        target.ego.helpers = installed;
        target.ego.learnings = {};
        if (!target.ego[EGO_WRAPPED]) {
            const taskSelection = {};
            wrapCreateTab(target.ego);
            wrapUseTaskSpace(target.ego, taskSelection);
            wrapInvalidating(target.ego, ["closeTaskSpace", "createTaskSpace", "claimTaskSpace"], () => {
                taskSelection.spaceId = undefined;
            });
            Object.defineProperty(target.ego, EGO_WRAPPED, {
                value: true,
                enumerable: false,
            });
        }
        exposeEgoMethods(target, target.ego);
    }
    return target;
}
if (isDirectCli()) {
    try {
        process.exitCode = await runMain();
    }
    catch (error) {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    }
    finally {
        disposeDownloadArtifacts();
    }
}
else {
    installEgoSdk();
}
function createCliLog() {
    return (...args) => {
        // Buffer instead of writing through: a hard stop later in the run must be able to
        // discard everything logged so far. The buffer is flushed on process teardown.
        bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
    };
}
function isDirectCli() {
    return (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
}
function wrapInvalidating(ego, methodNames, resetSelection = () => { }) {
    for (const name of methodNames) {
        const original = ego[name];
        if (typeof original !== "function")
            continue;
        const after = () => {
            resetSelection();
            invalidateSession();
            clearPreferredTarget();
        };
        ego[name] = function (...args) {
            const result = original.apply(this, args);
            if (result && typeof result.then === "function") {
                return result.then((value) => {
                    after();
                    return value;
                });
            }
            after();
            return result;
        };
    }
}
function wrapUseTaskSpace(ego, selection) {
    // File chooser waits and other event subscriptions span multiple Page calls.
    // Re-selecting the same space must preserve their CDP session; changing the
    // space still invalidates every session because native routing is global.
    const original = ego.useTaskSpace;
    if (typeof original !== "function")
        return;
    const after = (spaceId, value) => {
        if (value && typeof value === "object" && Object.hasOwn(value, "error")) {
            return value;
        }
        if (selection.spaceId !== spaceId) {
            invalidateSession();
            clearPreferredTarget();
            selection.spaceId = spaceId;
        }
        return value;
    };
    ego.useTaskSpace = function (...args) {
        const result = original.apply(this, args);
        if (result && typeof result.then === "function") {
            return result.then((value) => after(args[0], value));
        }
        return after(args[0], result);
    };
}
function wrapCreateTab(ego) {
    const original = ego.createTab;
    if (typeof original !== "function")
        return;
    ego.createTab = function (...args) {
        const result = original.apply(this, args);
        if (result && typeof result.then === "function") {
            return result.then((value) => {
                const id = value?.targetId || value?.result?.targetId;
                if (id)
                    setPreferredTarget(id);
                return value;
            });
        }
        return result;
    };
}
function exposeEgoMethods(target, ego) {
    const skip = new Set([
        "helpers",
        "learnings",
        "useTaskSpace",
        "createTaskSpace",
        "claimTaskSpace",
        "closeTaskSpace",
    ]);
    for (const key of Object.keys(ego)) {
        if (skip.has(key))
            continue;
        if (key in target)
            continue;
        const value = ego[key];
        if (typeof value !== "function")
            continue;
        const bound = value.bind(ego);
        Object.defineProperty(target, key, {
            value: bound,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }
}

export { INTERNAL_URL_PREFIXES, NAME, __testing, browserFetch, captureScreenshot, cdp, claimTaskSpace, click, closeTab, completeTaskSpace, currentTab, dispatchKey$1 as dispatchKey, disposeEgoSdk, doubleClick, dragMouse, drainEvents, elementCenter, ensureRealTab, fillInput, gotoAndWait, gotoUrl, handOffTaskSpace, helperContext, hover, iframeTarget, installEgoSdk, js, learnContext, listTabs, listTaskSpaces, loadAgentHelpers, newTaskSpace, openOrReuseTab, pageInfo, pressKey, profiles, runMain, runSiteBrowserTool, runSiteTool, scroll, scrollBy, scrollToBottomUntil, serverFetch, siteSkills, siteSkillsForUrl, snapshot, snapshotRaw, snapshotText, switchTab, switchTaskSpace, takeOverTaskSpace, taskSpace, typeText, uploadFile, useOrCreateTaskSpace, wait, waitForAgentControl, waitForElement, waitForLoad, waitForNetworkIdle$1 as waitForNetworkIdle };
