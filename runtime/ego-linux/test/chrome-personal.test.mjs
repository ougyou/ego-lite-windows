import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWinCimChrome } from "../src/chrome.mjs";

const WS = "C:/Users/q/workspace/chrome_workspace";

test("parseWinCimChrome: 只认端口+主进程，可按 profile 过滤", () => {
  const list = [
    { ProcessId: 1, CommandLine: `C:/chrome.exe --user-data-dir=${WS} --remote-debugging-port=9222` },
    { ProcessId: 2, CommandLine: "C:/chrome.exe --user-data-dir=C:/Users/q/other --remote-debugging-port=9222" },
    { ProcessId: 3, CommandLine: `C:/chrome.exe --user-data-dir=${WS} --remote-debugging-port=9222 --type=renderer` },
    { ProcessId: 4, CommandLine: `C:/chrome.exe --user-data-dir=${WS} --remote-debugging-port=9333` },
  ];
  const hit = parseWinCimChrome(list, { port: 9222 });
  assert.deepEqual(hit.map((x) => x.pid).sort(), [1, 2]);
  const mine = parseWinCimChrome(list, { port: 9222, userDataDir: WS });
  assert.deepEqual(mine.map((x) => x.pid), [1]);
});

test("parseWinCimChrome: 容忍反斜杠路径与空输入", () => {
  const win = "C:\\Users\\q\\workspace\\chrome_workspace";
  const list = [
    { ProcessId: 9, CommandLine: `C:\\chrome.exe --user-data-dir="${win}" --remote-debugging-port=9222` },
  ];
  const mine = parseWinCimChrome(list, { port: 9222, userDataDir: "C:/Users/q/workspace/chrome_workspace" });
  assert.deepEqual(mine.map((x) => x.pid), [9]);
  assert.deepEqual(parseWinCimChrome(null, { port: 9222 }), []);
  assert.deepEqual(parseWinCimChrome([], { port: 9222 }), []);
});
