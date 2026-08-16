import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { recognize } from "../src/ocr/index.mjs";

if (!existsSync("testdata/en.png")) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/make-fixture.ps1", "-OutDir", "testdata"], { stdio: "inherit" });
  if (r.status !== 0) { console.error("fixture generation failed"); process.exit(1); }
}

const en = await recognize({ image: "testdata/en.png", langs: "eng", minConfidence: 0.5 });
assert.ok(en.lines.some((l) => /hello/i.test(l.text)), `en should contain hello, got: ${JSON.stringify(en.lines)}`);
assert.ok(en.lines.some((l) => /12345/.test(l.text)), "en should contain 12345");
assert.ok(en.lines.every((l) => Number.isFinite(l.center.x) && Number.isFinite(l.center.y)), "en centers finite");

const zh = await recognize({ image: "testdata/zh.png", langs: "chi_sim", minConfidence: 0.2 });
// tesseract emits one CJK "word" per character, so strip spaces before matching.
const zhPlain = zh.lines.map((l) => l.text.replace(/\s+/g, "")).join("");
assert.ok(/你好/.test(zhPlain), `zh should contain 你好, got: ${JSON.stringify(zh.lines)}`);

// region + scale map back to ORIGINAL image pixel space
const region = await recognize({ image: "testdata/en.png", langs: "eng", minConfidence: 0.5, region: { x: 0, y: 0, w: 640, h: 200 }, scale: 2 });
assert.ok(region.lines.some((l) => /hello/i.test(l.text)), "region+scale should still find hello");

// width/height must be the ORIGINAL image dims (line coordinate space), even when
// region/scale transform the buffer internally.
const scaled = await recognize({ image: "testdata/en.png", langs: "eng", scale: 2 });
assert.equal(scaled.width, 640, `width should be original 640, got ${scaled.width}`);
assert.equal(scaled.height, 200, `height should be original 200, got ${scaled.height}`);
const cropped = await recognize({ image: "testdata/en.png", langs: "eng", region: { x: 0, y: 0, w: 300, h: 100 } });
assert.equal(cropped.width, 640, `cropped width should still be original 640, got ${cropped.width}`);
assert.equal(cropped.height, 200, `cropped height should still be original 200, got ${cropped.height}`);

console.log("test-ocr-engine: PASS");
