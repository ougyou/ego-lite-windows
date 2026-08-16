import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

if (!existsSync("testdata/en.png")) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/make-fixture.ps1", "-OutDir", "testdata"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

const cli = fileURLToPath(new URL("../cli/ego-vision.mjs", import.meta.url));

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
  return JSON.parse(r.stdout);
}

const en = run(["ocr", "testdata/en.png"]);
assert.ok(en.lines.some((l) => /hello/i.test(l.text)), "en: hello");
assert.ok(en.lines.every((l) => l.center.x >= 0 && l.center.y >= 0), "en: non-negative coords");

const found = run(["ocr", "testdata/en.png", "--find", "12345"]);
assert.ok(found.found && /12345/.test(found.found.text), "find");

const zh = run(["ocr", "testdata/zh.png", "--min-confidence", "0.2"]);
// tesseract emits one CJK "word" per character; strip spaces before matching.
const zhPlain = zh.lines.map((l) => l.text.replace(/\s+/g, "")).join("");
assert.ok(/你好/.test(zhPlain), `zh: 你好, got: ${JSON.stringify(zh.lines)}`);

const region = run(["ocr", "testdata/en.png", "--region", "0,0,640,200", "--scale", "2"]);
assert.ok(region.lines.length >= 1, "region+scale");

console.log("verify-ocr: PASS");
