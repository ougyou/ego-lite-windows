import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearPrefs,
  loadPrefs,
  normalizePrefs,
  profileMatches,
  savePrefs,
} from "../src/personal-prefs.mjs";

test("normalizePrefs: 合法输入补全默认并正斜杠化", () => {
  const p = normalizePrefs({
    binary: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: "C:\\Users\\q\\workspace\\chrome_workspace",
    debugPort: 9222,
    flags: ["--disable-web-security"],
  });
  assert.ok(p);
  assert.ok(p.binary.startsWith("C:/"));
  assert.ok(p.userDataDir.startsWith("C:/"));
  assert.equal(p.debugPort, 9222);
  assert.deepEqual(p.flags, ["--disable-web-security"]);
  assert.equal(p.source, "user-confirmed");
  assert.ok(p.confirmedAt);
});

test("normalizePrefs: 缺 binary/userDataDir 返回 null；缺 debugPort 用 9222", () => {
  assert.equal(normalizePrefs({ userDataDir: "C:/x" }), null);
  assert.equal(normalizePrefs({ binary: "C:/x" }), null);
  assert.equal(normalizePrefs(null), null);
  const p = normalizePrefs({ binary: "C:/x", userDataDir: "C:/y" });
  assert.equal(p.debugPort, 9222);
});

test("profileMatches: 命中/未命中/带引号/无 flag", () => {
  const ud = "C:/Users/q/workspace/chrome_workspace";
  assert.ok(
    profileMatches(
      `chrome.exe --user-data-dir=${ud} --remote-debugging-port=9222`,
      ud,
    ),
  );
  assert.ok(
    !profileMatches(
      `chrome.exe --user-data-dir=${ud} --remote-debugging-port=9222`,
      "C:/Users/q/other",
    ),
  );
  assert.ok(!profileMatches("chrome.exe --remote-debugging-port=9222", ud));
  assert.ok(
    profileMatches(
      `chrome.exe "--user-data-dir=${ud}" --type=renderer`,
      ud,
    ),
  );
});

test("save/load/clear roundtrip", async () => {
  await clearPrefs();
  assert.equal(await loadPrefs(), null);
  const prefs = normalizePrefs({
    binary: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    userDataDir: "C:/Users/q/workspace/chrome_workspace",
  });
  await savePrefs(prefs);
  const back = await loadPrefs();
  assert.equal(back.binary, prefs.binary);
  assert.equal(back.userDataDir, prefs.userDataDir);
  assert.equal(back.debugPort, 9222);
  await clearPrefs();
  assert.equal(await loadPrefs(), null);
});
