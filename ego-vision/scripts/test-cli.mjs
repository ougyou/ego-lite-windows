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

const out = run(["ocr", "testdata/en.png"]);
assert.equal(typeof out.text, "string");
assert.ok(Array.isArray(out.lines) && out.lines.length >= 1);
for (const line of out.lines) {
  assert.ok(Number.isFinite(line.confidence));
  assert.ok(Number.isFinite(line.bbox.x) && Number.isFinite(line.bbox.w));
  assert.ok(Number.isFinite(line.center.x) && Number.isFinite(line.center.y));
}

const found = run(["ocr", "testdata/en.png", "--find", "12345"]);
assert.ok(found.found && /12345/.test(found.found.text), "find should return matched line");

const region = run(["ocr", "testdata/en.png", "--region", "0,0,640,200"]);
assert.ok(region.lines.length >= 1, "region returns lines");

// --text compact mode: text + dims + (found), NO lines
const compact = run(["ocr", "testdata/en.png", "--text"]);
assert.equal(typeof compact.text, "string");
assert.ok(compact.lines === undefined, "--text should omit lines");
assert.equal(compact.width, 640, "--text keeps original width");
assert.equal(compact.height, 200, "--text keeps original height");
const compactFind = run(["ocr", "testdata/en.png", "--text", "--find", "12345"]);
assert.ok(compactFind.found && /12345/.test(compactFind.found.text), "--text + --find returns found");

console.log("test-cli: PASS");
