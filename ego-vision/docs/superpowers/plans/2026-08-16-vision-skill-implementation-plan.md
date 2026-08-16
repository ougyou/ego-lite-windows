# 独立视觉理解 skill（vision）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, fully-offline vision capability inside a workspace subfolder `vision/` (v1 = local OCR via `ego-vision ocr <image>` → JSON text + coordinates), decoupled from ego-lite internals, plus a `vision/skill/` Copilot skill package, a light optional declaration in the ego-browser skill, and a single install flow that installs both skills + the capability.

**Architecture:** All vision content lives under `ego-lite-windows/vision/` (self-contained, NOT mixed into the ego-lite runtime/skill). A small engine layer (`vision/src/ocr/`) has a pluggable engine registry + Tesseract.js adapter (default, vendored) + pngjs crop/upscale. A thin CLI (`vision/cli/ego-vision.mjs` + `vision/bin/ego-vision.cmd`) reads an image, crops/upscales, runs the engine, prints JSON (image-pixel coordinates). The Copilot skill package lives at `vision/skill/`. The ego-browser skill gets a light **optional** pointer note. `scripts/install-copilot-skill.ps1` + `install.md` install both skills and the capability together.

**Tech Stack:** Node ≥ 22 (ESM), `tesseract.js@5.1.1` (Apache-2.0) + `tesseract.js-core`, `pngjs@7.0.0` (MIT), standard tessdata `eng.traineddata` + `chi_sim.traineddata` (Apache-2.0), PowerShell `System.Drawing` for test fixtures (Windows), `node:util` `parseArgs`.

## Global Constraints

- **No git repo** — the user said do not commit to git. Omit all `git add`/`git commit` steps; the "Done when" for each task is a test/command that passes.
- Workspace root = `C:\Users\quincy\workspace\mywork\fontwebProjects\ego-lite-windows\`. All vision content lives under its **`vision/` subfolder** (self-contained; do NOT touch `runtime/`, `runtime/ego-browser/dist/out/index.js`, or `skills/ego-browser/` internals except the one allowed note in Task 5).
- **Fully offline at runtime**: `tesseract.js` + `tesseract.js-core` + `pngjs` (in `vision/node_modules/`) and both `.traineddata` files (in `vision/data/`) are committed/vendored. No runtime network, no API keys.
- **One-time setup network actions require explicit user consent** (per the user's operating preferences): Task 1's `npm install` and traineddata download must be confirmed with the user before running.
- **Env namespace**: vision uses ONLY `EGO_VISION_LANGS` / `EGO_VISION_ENGINE` / `EGO_VISION_DATA_DIR` — never the ego-lite `EGO_LINUX_*` / `EGO_BROWSER_*` vars.
- Coordinates returned by the CLI are **image-pixel space** of the input image (never CSS/viewport).
- Engine is pluggable: `EGO_VISION_ENGINE` / `--engine`; v1 ships only `tesseract`.
- Security boundary: OCR may read text the page/display shows, but must NOT be used to bypass security CAPTCHAs (sliders, wappass, reCAPTCHA) — those stay human-handled.
- Windows-first (fixture generation via PowerShell `System.Drawing`); the CLI itself is cross-platform Node.
- Language pack: **standard tessdata** (eng ≈ 10MB + chi_sim ≈ 12MB ≈ 22MB).
- The ego-browser skill note (Task 5) is **optional-by-design**: it must not make the browser skill depend on vision.

---

### Task 1: Scaffold `vision/` + vendored deps & data

**Files:**
- Create: `vision/package.json`
- Create: `vision/.gitignore`
- Create: `vision/THIRD_PARTY_NOTICES.md`
- Create (via setup): `vision/node_modules/` (vendored `tesseract.js`, `tesseract.js-core`, `pngjs`), `vision/package-lock.json`, `vision/data/eng.traineddata`, `vision/data/chi_sim.traineddata`

**Interfaces:**
- Produces: `package.json` scripts `verify`, `test:engine`, `test:cli`, `fixture`; vendored deps resolvable via `import "tesseract.js"` / `import "pngjs"`; `data/` with both `.traineddata` files (absolute path consumed by Task 2 as `dataDir`).

- [ ] **Step 1: Create `vision/package.json`**

```json
{
  "name": "vision",
  "version": "0.1.0",
  "description": "Standalone vision-understanding capability: local offline OCR (tesseract.js) + a Copilot skill. Run `ego-vision ocr <image>`.",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "ego-vision": "bin/ego-vision.cmd" },
  "scripts": {
    "verify": "node scripts/verify-ocr.mjs",
    "test:engine": "node scripts/test-ocr-engine.mjs",
    "test:cli": "node scripts/test-cli.mjs",
    "fixture": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-fixture.ps1"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create `vision/.gitignore`** (deliberately does NOT ignore `node_modules/` — vendored deps must be committed)

```
# Logs
*.log
npm-debug.log*

# OS / editor
.DS_Store
Thumbs.db

# NOTE: node_modules/ is intentionally NOT ignored here.
# tesseract.js + pngjs are vendored and committed so the skill is fully offline.
```

- [ ] **Step 3: Create `vision/THIRD_PARTY_NOTICES.md`**

```markdown
# Third-Party Notices

`vision/` vendors the following third-party software (all committed for fully-offline operation):

- tesseract.js (Apache-2.0) — https://github.com/naptha/tesseract.js
- tesseract.js-core (Apache-2.0) — https://github.com/naptha/tesseract.js-core
- pngjs (MIT) — https://github.com/lukeapage/pngjs
- tessdata language packs (Apache-2.0) — https://github.com/tesseract-ocr/tessdata
  (eng.traineddata, chi_sim.traineddata)
```

- [ ] **Step 4: Install vendored JS deps (ONCE; needs network + user consent)**

Run (from `vision/`):

```powershell
npm install --save-exact tesseract.js@5.1.1 pngjs@7.0.0
```

Expected: `node_modules/` created with `tesseract.js`, `tesseract.js-core`, `pngjs`; `package-lock.json` written; `package.json` gets a `"dependencies"` block with exact versions.

> **Consent gate:** this step hits the network. Ask the user before running (their operating preference requires explicit consent for installs/network).

- [ ] **Step 5: Download language packs (ONCE; needs network + user consent)**

```powershell
New-Item -ItemType Directory -Force -Path data | Out-Null
curl.exe -L -o data\eng.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata
curl.exe -L -o data\chi_sim.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/chi_sim.traineddata
```

Expected: `data/eng.traineddata` (≈10MB) and `data/chi_sim.traineddata` (≈12MB) exist and are non-empty.

> **Consent gate:** network. Confirm with the user first.

- [ ] **Step 6: Verify offline resolvability**

Run: `node -e "import('tesseract.js').then(m => console.log(typeof m.createWorker)); import('pngjs').then(m => console.log(typeof m.PNG))"`
Expected: prints `function` and `function`, no network attempted.

**Done when:** Steps 4–6 succeed; `data/` has both `.traineddata`; `node_modules/` present.

---

### Task 2: Engine layer + fixture generator + engine unit test

**Files:**
- Create: `vision/scripts/make-fixture.ps1`
- Create: `vision/src/ocr/engines/tesseract.mjs`
- Create: `vision/src/ocr/registry.mjs`
- Create: `vision/src/ocr/image.mjs`
- Create: `vision/src/ocr/index.mjs`
- Create: `vision/scripts/test-ocr-engine.mjs`

**Interfaces:**
- Consumes: vendored `tesseract.js` + `pngjs` (Task 1); `dataDir` = absolute path to `vision/data`.
- Produces:
  - `recognize(opts)` from `vision/src/ocr/index.mjs`:
    `recognize({ image: string|Buffer, langs?: string, engine?: string, dataDir?: string, minConfidence?: number, region?: {x,y,w,h}, scale?: number, find?: string })`
    → `Promise<{ engine, width, height, text, lines: Array<{text, confidence, bbox:{x,y,w,h}, center:{x,y}}>, found?: {...} }>`
    All bbox/center are in the **original input image pixel space** (crop/upscale undone).
  - `make-fixture.ps1 -OutDir <dir>` → writes `<dir>/en.png` ("Hello World 12345", Arial 28) and `<dir>/zh.png` ("哔哩哔哩 你好世界", Microsoft YaHei 28).

- [ ] **Step 1: Create the fixture generator `vision/scripts/make-fixture.ps1`**

```powershell
param([string]$OutDir = "testdata")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-Fixture([string]$Text, [string]$Path, [string]$FontName, [int]$Size) {
  $bmp = New-Object System.Drawing.Bitmap 640, 200
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font($FontName, $Size, [System.Drawing.FontStyle]::Regular)
  $g.DrawString($Text, $font, [System.Drawing.Brushes]::Black, 20, 40)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Fixture "Hello World 12345" (Join-Path $OutDir "en.png") "Arial" 28
New-Fixture "哔哩哔哩 你好世界" (Join-Path $OutDir "zh.png") "Microsoft YaHei" 28
Write-Output "fixtures written to $OutDir"
```

- [ ] **Step 2: Run it and verify the fixtures exist**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-fixture.ps1 -OutDir testdata`
Expected: prints `fixtures written to testdata`; `testdata/en.png` + `testdata/zh.png` exist (under `vision/`).

- [ ] **Step 3: Create the image helper `vision/src/ocr/image.mjs`**

```js
import { PNG } from "pngjs";

export function cropPng(buffer, { x, y, w, h }) {
  const src = PNG.sync.read(buffer);
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(src.width, Math.round(x + w));
  const y1 = Math.min(src.height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) throw new Error("vision: empty crop region");
  const out = new PNG({ width: x1 - x0, height: y1 - y0 });
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const si = (row * src.width + col) * 4;
      const di = ((row - y0) * out.width + (col - x0)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(out);
}

export function upscalePng(buffer, factor) {
  if (!(factor > 1)) return buffer;
  const src = PNG.sync.read(buffer);
  const out = new PNG({ width: src.width * factor, height: src.height * factor });
  for (let row = 0; row < out.height; row++) {
    const sr = Math.floor(row / factor);
    for (let col = 0; col < out.width; col++) {
      const sc = Math.floor(col / factor);
      const si = (sr * src.width + sc) * 4;
      const di = (row * out.width + col) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(out);
}
```

- [ ] **Step 4: Create the engine registry `vision/src/ocr/registry.mjs`**

```js
const ENGINES = new Map();

export function registerEngine(name, adapter) {
  ENGINES.set(name, adapter);
}

export function getEngine(name) {
  const engine = ENGINES.get(name);
  if (!engine) {
    const available = [...ENGINES.keys()].join(", ") || "(none)";
    throw new Error(`vision: unknown OCR engine "${name}". Available: ${available}`);
  }
  return engine;
}
```

- [ ] **Step 5: Create the Tesseract adapter `vision/src/ocr/engines/tesseract.mjs`**

```js
import { createWorker } from "tesseract.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plain OCR of a PNG/JPEG buffer. Returns lines in THIS buffer's pixel space.
 * Crop/upscale (and their coordinate correction) happen in src/ocr/index.mjs.
 */
export async function recognize({ image, langs, dataDir }) {
  const worker = await createWorker(langs, 1, {
    langPath: dataDir,
    gzip: false,
    cachePath: join(tmpdir(), "ego-vision-tessdata-cache"),
  });
  try {
    const { data } = await worker.recognize(image);
    const lines = (data.lines || [])
      .map((line) => {
        const words = line.words || [];
        if (words.length === 0) return null;
        let confidence = words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const w of words) {
          if (!w.bbox) continue;
          x0 = Math.min(x0, w.bbox.x0); y0 = Math.min(y0, w.bbox.y0);
          x1 = Math.max(x1, w.bbox.x1); y1 = Math.max(y1, w.bbox.y1);
        }
        if (!Number.isFinite(x0)) return null;
        return {
          text: String(line.text || ""),
          confidence: Math.round(confidence * 100) / 100,
          bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
          center: { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) },
        };
      })
      .filter(Boolean);
    return { width: data.width, height: data.height, lines };
  } finally {
    await worker.terminate();
  }
}
```

> **Contingency:** if your tesseract.js version fails to load `langPath` as a plain absolute path (error mentions fetching/URL), change `langPath: dataDir` to `langPath: pathToFileURL(dataDir).href` and add `import { pathToFileURL } from "node:url";`. Everything else stays the same.

- [ ] **Step 6: Create the public API `vision/src/ocr/index.mjs`**

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerEngine, getEngine } from "./registry.mjs";
import { recognize as tesseractRecognize } from "./engines/tesseract.mjs";
import { cropPng, upscalePng } from "./image.mjs";

registerEngine("tesseract", tesseractRecognize);

const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

export async function recognize(opts = {}) {
  const langs = opts.langs || process.env.EGO_VISION_LANGS || "eng+chi_sim";
  const engineName = opts.engine || process.env.EGO_VISION_ENGINE || "tesseract";
  const dataDir = opts.dataDir || process.env.EGO_VISION_DATA_DIR || DEFAULT_DATA_DIR;
  const minConfidence = opts.minConfidence ?? 0.5;
  const region = opts.region;
  const scale = Math.max(1, Math.floor(opts.scale ?? 1));

  let image = opts.image;
  if (typeof image === "string") image = await readFile(image);
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error("vision: image must be a file path or a non-empty Buffer");
  }
  if (region) image = cropPng(image, region);
  if (scale > 1) image = upscalePng(image, scale);

  const engine = getEngine(engineName);
  const result = await engine({ image, langs, dataDir });

  const offsetX = region ? region.x : 0;
  const offsetY = region ? region.y : 0;
  const lines = result.lines
    .filter((line) => line.confidence >= minConfidence)
    .map((line) => ({
      ...line,
      bbox: {
        x: line.bbox.x / scale + offsetX,
        y: line.bbox.y / scale + offsetY,
        w: line.bbox.w / scale,
        h: line.bbox.h / scale,
      },
      center: {
        x: line.center.x / scale + offsetX,
        y: line.center.y / scale + offsetY,
      },
    }));

  const out = {
    engine: engineName,
    width: result.width,
    height: result.height,
    text: lines.map((line) => line.text).join("\n"),
    lines,
  };
  if (opts.find) {
    const needle = String(opts.find).toLowerCase();
    out.found = lines.find((line) => line.text.toLowerCase().includes(needle)) || null;
  }
  return out;
}
```

> Note: `src/ocr/index.mjs` sits at `vision/src/ocr/`, so `../data` resolves to `vision/data/` — the vendored language pack dir.

- [ ] **Step 7: Write the engine unit test `vision/scripts/test-ocr-engine.mjs`**

```js
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
assert.ok(zh.lines.some((l) => /你好/.test(l.text)), `zh should contain 你好, got: ${JSON.stringify(zh.lines)}`);

// region + scale map back to ORIGINAL image pixel space
const region = await recognize({ image: "testdata/en.png", langs: "eng", minConfidence: 0.5, region: { x: 0, y: 0, w: 640, h: 200 }, scale: 2 });
assert.ok(region.lines.some((l) => /hello/i.test(l.text)), "region+scale should still find hello");

console.log("test-ocr-engine: PASS");
```

- [ ] **Step 8: Run the test, expect PASS**

Run (from `vision/`): `node scripts/test-ocr-engine.mjs`
Expected: prints `test-ocr-engine: PASS` (first run generates fixtures via PowerShell).

**Done when:** Step 8 prints PASS.

---

### Task 3: CLI (`ego-vision ocr`) + CLI contract test

**Files:**
- Create: `vision/cli/ego-vision.mjs`
- Create: `vision/bin/ego-vision.cmd`
- Create: `vision/scripts/test-cli.mjs`

**Interfaces:**
- Consumes: `recognize(opts)` from `src/ocr/index.mjs` (Task 2) with `opts.image` = file path.
- Produces: CLI contract — stdout JSON `{ engine, width, height, text, lines:[{text,confidence,bbox,center}], found? }`; exit 0 on success, exit 1 on engine error, exit 2 on usage error; `bin/ego-vision.cmd` wrapper for PATH use.

- [ ] **Step 1: Write the CLI `vision/cli/ego-vision.mjs`**

```js
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { recognize } from "../src/ocr/index.mjs";

const { values, positionals } = parseArgs({
  options: {
    langs: { type: "string" },
    engine: { type: "string" },
    "min-confidence": { type: "string" },
    region: { type: "string" },
    scale: { type: "string" },
    find: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage:
  ego-vision ocr <image> [--langs eng+chi_sim] [--engine tesseract]
                    [--min-confidence 0.5] [--region x,y,w,h] [--scale 2] [--find <substring>]
Coordinates in output are image-pixel space of the input image.`);
  process.exit(0);
}

const [sub, imagePath] = positionals;
if (sub !== "ocr") {
  console.error(`ego-vision: unknown command "${sub}" (v1 supports only "ocr")`);
  process.exit(2);
}
if (!imagePath) {
  console.error("ego-vision: missing image path");
  process.exit(2);
}

function parseRegion(s) {
  if (!s) return undefined;
  const [x, y, w, h] = s.split(",").map((v) => Number(v));
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error(`ego-vision: invalid --region "${s}" (expected x,y,w,h)`);
  }
  return { x, y, w, h };
}

try {
  const result = await recognize({
    image: imagePath,
    langs: values.langs,
    engine: values.engine,
    minConfidence: values["min-confidence"] !== undefined ? Number(values["min-confidence"]) : undefined,
    region: parseRegion(values.region),
    scale: values.scale !== undefined ? Number(values.scale) : undefined,
    find: values.find,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (err) {
  console.error(`ego-vision: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Write the PATH wrapper `vision/bin/ego-vision.cmd`**

```bat
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%..\cli\ego-vision.mjs" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 3: Write the CLI contract test `vision/scripts/test-cli.mjs`**

```js
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

console.log("test-cli: PASS");
```

- [ ] **Step 4: Run the test, expect PASS**

Run (from `vision/`): `node scripts/test-cli.mjs`
Expected: prints `test-cli: PASS`.

- [ ] **Step 5: Manual CLI check through the .cmd wrapper**

Run: `bin\ego-vision.cmd ocr testdata\en.png --find hello`
Expected: JSON with a `found` object whose `text` contains `hello` and finite `center`.

**Done when:** Steps 4–5 pass.

---

### Task 4: vision skill package (`vision/skill/`)

**Files:**
- Create: `vision/skill/SKILL.md`
- Create: `vision/skill/references/cli.md`
- Create: `vision/skill/references/tiered-vision.md`
- Create: `vision/skill/references/browser-use.md`

**Interfaces:**
- Consumes: stable CLI from Task 3 (`ego-vision ocr <image> ...`).
- Produces: a skill package that the main installer (Task 6) copies to `~/.copilot/skills/vision/`.

- [ ] **Step 1: Write `vision/skill/SKILL.md`**

```markdown
---
name: vision
description: 'Standalone vision-understanding skill with local OFFLINE OCR. Use for extracting text + coordinates from any local image (screenshots, photos, scans, game frames, canvas renders) when you do NOT have a vision model, or want to avoid its cost. Triggers: "OCR this image", "read the text in this screenshot", "find where on the image X appears", "extract text from image". Run `ego-vision ocr <image>`; output is JSON with text, per-line bounding boxes and centers (image-pixel space). Escalate to a vision model only for high-precision reading, layout/semantic understanding, or when OCR confidence is low.'
metadata:
  version: "1.0.0"
  date: "2026-08-16"
---

# vision — local offline OCR for any image

Run `ego-vision ocr <image>` on any local image file. It returns JSON:

- `text` — lines joined by newlines (read this for content).
- `lines[]` — each `{ text, confidence, bbox:{x,y,w,h}, center:{x,y} }`.
- `found` — present when `--find <substring>` matches; includes a clickable `center`.
- Coordinates are **image-pixel space** of the input image.

## Invocation

```powershell
ego-vision ocr C:\path\shot.png
ego-vision ocr C:\path\shot.png --langs eng+chi_sim --min-confidence 0.5
ego-vision ocr C:\path\shot.png --region 10,20,300,80 --scale 2
ego-vision ocr C:\path\shot.png --find "确认"
```

If `ego-vision` is not on PATH, run `node <repo>\vision\cli\ego-vision.mjs ocr ...`.

## Rules

- **Read text** with OCR when the model has no vision (or to save cost). Use the returned `center` to click/press at that location.
- **Escalate to a vision model** ONLY when: high-precision reading, layout/semantic understanding, or OCR `confidence` is low. That tier is on-demand and costs tokens.
- **Never use OCR to bypass security CAPTCHAs** (sliders, wappass, reCAPTCHA). Reading text the page merely *displays* (e.g. a code shown on screen) is fine.
- Fully offline; no API keys; no runtime network.

Full reference: [references/cli.md](references/cli.md) · [references/tiered-vision.md](references/tiered-vision.md) · [references/browser-use.md](references/browser-use.md).
```

- [ ] **Step 2: Write `vision/skill/references/cli.md`**

```markdown
# ego-vision CLI reference

`ego-vision ocr <image> [options]`

| Option | Default | Meaning |
|---|---|---|
| `--langs` | `eng+chi_sim` | Tesseract language string |
| `--engine` | `EGO_VISION_ENGINE` \|\| `tesseract` | Engine name (pluggable registry) |
| `--min-confidence` | `0.5` | Drop lines below this confidence (0–1) |
| `--region` | — | Crop `x,y,w,h` in image pixels before OCR (faster, focused) |
| `--scale` | `1` | Integer upscale factor for small text (then coords are mapped back) |
| `--find` | — | Return `found` with the first line containing this substring |
| `-h, --help` | — | Print usage |

Output JSON: `{ engine, width, height, text, lines[], found? }`.
All coordinates are image-pixel space of the ORIGINAL input image.

Env vars (independent namespace, do NOT use ego-lite's): `EGO_VISION_LANGS`, `EGO_VISION_ENGINE`, `EGO_VISION_DATA_DIR`.
```

- [ ] **Step 3: Write `vision/skill/references/tiered-vision.md`**

```markdown
# Tiered vision policy

1. **Default — local OCR** (`ego-vision ocr`, engine `tesseract`): cheap, offline, high call volume. Use for reading text and locating/clicking.
2. **Escalation — vision model**: only when you need high-precision reading, layout/semantic understanding, or OCR confidence is too low. This tier is online and costly; invoke deliberately, and only after OCR returns poor results.
3. **Human — security CAPTCHA**: sliders/wappass/reCAPTCHA are handed to the user, never auto-solved. Reading text the page merely displays is allowed.

Engine interface is pluggable (`EGO_VISION_ENGINE`); v1 ships `tesseract` only.
```

- [ ] **Step 4: Write `vision/skill/references/browser-use.md`**

```markdown
# Using vision with a browser (consumer pattern)

The vision skill is independent of any browser. Browser automation (e.g. the `ego-browser` skill) consumes it by saving a screenshot, then calling OCR:

```js
// inside an ego-browser heredoc
await page.screenshot({ path: 'C:/tmp/shot.png' })
// then:  ego-vision ocr C:/tmp/shot.png --find "确认"
```

Coordinate mapping to the page's CSS viewport:
`cssX = ocrX * (viewportCssWidth / imageWidth)`, `cssY = ocrY * (viewportCssHeight / imageHeight)`.

In v1 there is no `page.ocr` harness helper; this screenshot-then-OCR flow is the supported path. A native helper may come in v2.
```

**Done when:** Steps 1–4 complete; `vision/skill/` tree is complete and self-consistent.

---

### Task 5: ego-browser skill — optional vision declaration (user requirement 2)

**Files:**
- Modify: `skills/ego-browser/SKILL.md` (add a short **optional** note; do not make the browser skill depend on vision)

**Interfaces:**
- Consumes: `ego-vision` command name from Task 3.
- Produces: a light, non-mandatory pointer in the ego-browser skill.

- [ ] **Step 1: Add the optional note to `skills/ego-browser/SKILL.md`**

Insert this section right after the `## Core patterns` section (keep it short and clearly optional):

    ## 可选：本地 OCR / 视觉能力（vision skill）

    本仓库自带独立的 `vision` skill（`ego-vision ocr <图片>`，本地离线 OCR，输出文本+坐标）。
    **纯可选、不强制**——默认仍用 `page.snapshot()` 语义树；仅当需要读取截图/图片内嵌文字
    （canvas、视频画面、无 DOM 文本）或模型无视觉时才用：

    ```js
    await page.screenshot({ path: 'C:/tmp/shot.png' })
    // 然后（终端/另一脚本）：ego-vision ocr C:/tmp/shot.png --find "确认"
    ```

    详见 `~/.copilot/skills/vision/`（或仓库 `vision/skill/`）。

- [ ] **Step 2: Verify the note does not create a hard dependency**

Run: `grep -n "vision" skills\ego-browser\SKILL.md`
Expected: the new section appears; the rest of SKILL.md (invocation, facade, core patterns) is unchanged; nothing in the skill *requires* `ego-vision`.

**Done when:** Step 2 shows the note present and the skill still self-contained.

---

### Task 6: Install integration — both skills + capability (user requirement 3)

**Files:**
- Modify: `scripts/install-copilot-skill.ps1` (install ego-browser skill + vision skill + add `bin\` and `vision\bin\` to PATH + verify vendored capability)
- Modify: `install.md` (document the combined install)

**Interfaces:**
- Consumes: `skills/ego-browser/` (existing), `vision/skill/` (Task 4), `vision/bin/ego-vision.cmd` (Task 3), `vision/data/` + `vision/node_modules/` (Task 1).
- Produces: one install command that makes both `ego-browser` and `ego-vision` available.

- [ ] **Step 1: Rewrite `scripts/install-copilot-skill.ps1`** (full new content)

```powershell
# Install the ego-browser + vision skills for GitHub Copilot (VS Code).
# Copies skills/ego-browser -> ~/.copilot/skills/ego-browser and
# vision/skill -> ~/.copilot/skills/vision, and adds bin\ + vision\bin\ to the
# user PATH so 'ego-browser' and 'ego-vision' work anywhere.
# Restart / reload VS Code afterwards. -SkipPath skips the PATH step.
param([switch]$SkipPath)
$ErrorActionPreference = "Stop"

function Add-DirToUserPath {
  param([string]$BinDir)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $entries = @($userPath.Split(";") | Where-Object { $_ -ne "" })
  if ($entries -contains $BinDir) {
    Write-Host "[ok] already on user PATH: $BinDir"
    return
  }
  $newPath = ($userPath.TrimEnd(";") + ";" + $BinDir)
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "[ok] added to user PATH: $BinDir"
  Write-Host "     New terminals will pick it up."
}

$Repo = Split-Path -Parent $PSScriptRoot

# --- skill 1: ego-browser ---
$Src1 = Join-Path $Repo "skills\ego-browser"
$Dest1 = Join-Path $HOME ".copilot\skills\ego-browser"
if (-not (Test-Path $Src1)) { Write-Error "Skill source not found: $Src1" }
New-Item -ItemType Directory -Force -Path $Dest1 | Out-Null
Copy-Item "$Src1\*" $Dest1 -Recurse -Force
Write-Host "[ok] Copilot skill installed to: $Dest1"

# --- skill 2: vision ---
$Src2 = Join-Path $Repo "vision\skill"
$Dest2 = Join-Path $HOME ".copilot\skills\vision"
if (Test-Path $Src2) {
  New-Item -ItemType Directory -Force -Path $Dest2 | Out-Null
  Copy-Item "$Src2\*" $Dest2 -Recurse -Force
  Write-Host "[ok] vision skill installed to: $Dest2"
} else {
  Write-Warning "vision skill source not found: $Src2 (skipped)"
}

# --- capability check: vendored deps + language packs (offline, must be present) ---
$visionTess = Join-Path $Repo "vision\node_modules\tesseract.js"
$visionEng = Join-Path $Repo "vision\data\eng.traineddata"
$visionZh  = Join-Path $Repo "vision\data\chi_sim.traineddata"
if ((Test-Path $visionTess) -and (Test-Path $visionEng) -and (Test-Path $visionZh)) {
  Write-Host "[ok] vision capability vendored deps + language packs present (offline OK)"
} else {
  Write-Warning "vision vendored deps/data incomplete - run setup (npm install + language pack download) under vision/ first"
}

Write-Host "     Next: in VS Code run 'Developer: Reload Window' (or restart)."

# --- PATH: bin\ (ego-browser) + vision\bin\ (ego-vision) ---
if (-not $SkipPath) {
  $bins = @((Join-Path $Repo "bin"), (Join-Path $Repo "vision\bin"))
  foreach ($b in $bins) {
    if (Test-Path $b) { Add-DirToUserPath -BinDir $b }
  }
} else {
  Write-Host "[skip] user PATH not modified (-SkipPath)."
}
```

- [ ] **Step 2: Update `install.md` section 2 (接入 Copilot)**

Replace the current section 2 body with:

```markdown
## 2. 接入 GitHub Copilot（一次性安装两个 skill + 能力）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-copilot-skill.ps1
```

一次完成：

- 把 `skills/ego-browser/` 复制到 `~\.copilot\skills\ego-browser\`（浏览器自动化 skill）
- 把 `vision/skill/` 复制到 `~\.copilot\skills\vision\`（本地离线 OCR / 视觉理解 skill）
- 把 `bin\` 与 `vision\bin\` 加入用户 PATH → `ego-browser`、`ego-vision` 全局可用
- 校验 vision 的 vendored 依赖/语言包齐全（离线可跑，安装无需网络）

在 VS Code 执行 `Developer: Reload Window`（或重启）。

> vision 能力**彻底离线**：语言包与依赖已随仓库 vendored，无需 npm install / 下载。
```

- [ ] **Step 3: Update `install.md` (可选视觉能力) + 移植章节**

Add a short "vision 能力" note after section 3:

```markdown
## 3.5（可选）使用 vision（本地 OCR）

```powershell
ego-vision ocr 某截图.png --find "确认"
# 返回 JSON：text / lines[].bbox / lines[].center（图像像素坐标）
```

读取 canvas、视频画面、图片内嵌文字，或模型无视觉时的兜底。详见 `~\.copilot\skills\vision\`。
```

And in the 移植到新电脑（Porting）章节, replace step 1 with "拷贝整个仓库文件夹（含 runtime/、skills/、vision/、scripts/、bin/）", and note step 5 installs **both** skills.

- [ ] **Step 4: Dry-run the installer without modifying PATH**

Run:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-copilot-skill.ps1 -SkipPath
```
Expected: prints `[ok] Copilot skill installed to: ...ego-browser`, `[ok] vision skill installed to: ...vision`, and `[ok] vision capability vendored deps + language packs present (offline OK)` (or a warning if setup was skipped).

**Done when:** Steps 4 dry-run passes; `install.md` documents the combined install.

---

### Task 7: End-to-end smoke test (`vision/scripts/verify-ocr.mjs`)

**Files:**
- Create: `vision/scripts/verify-ocr.mjs`

**Interfaces:**
- Consumes: `scripts/make-fixture.ps1` (Task 2), `cli/ego-vision.mjs` (Task 3).
- Produces: the `vision/` repo's `npm run verify`; prints `verify-ocr: PASS`.

- [ ] **Step 1: Write `vision/scripts/verify-ocr.mjs`**

```js
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
assert.ok(zh.lines.some((l) => /你好/.test(l.text)), "zh: 你好");

const region = run(["ocr", "testdata/en.png", "--region", "0,0,640,200", "--scale", "2"]);
assert.ok(region.lines.length >= 1, "region+scale");

console.log("verify-ocr: PASS");
```

- [ ] **Step 2: Run it, expect PASS**

Run (from `vision/`): `node scripts/verify-ocr.mjs`
Expected: prints `verify-ocr: PASS`.

- [ ] **Step 3: Run the repo alias too**

Run (from `vision/`): `npm run verify`
Expected: same `verify-ocr: PASS`.

**Done when:** Steps 2–3 pass.

---

## Self-Review

**Spec coverage (design doc §5–§10):**
- v1 OCR 文本+坐标 → Task 2 + Task 3. ✅
- 彻底离线（模型+依赖 vendored）→ Task 1. ✅
- 引擎可插拔（registry + `--engine`/`EGO_VISION_ENGINE`）→ Task 2/3. ✅
- 工作区子目录 `vision/`、`EGO_VISION_*` 独立命名空间 → Global Constraints + all Task paths. ✅
- vision skill 包在 `vision/skill/` → Task 4. ✅
- ego-browser 可选声明（不强制）→ Task 5. ✅
- 安装一并（两 skill + 能力 + PATH）→ Task 6. ✅
- `--region`/`--find`/`--min-confidence`/`--scale` → Task 2/3. ✅
- standard tessdata → Task 1. ✅
- 冒烟 `verify-ocr.mjs` → Task 7. ✅
- 坐标图像像素空间、浏览器按 scale 换算 → Task 2/3/4. ✅

**Placeholder scan:** no TBD/TODO/"similar to Task N"; every code step is concrete. ✅

**Type consistency:** `recognize()` signature identical in index.mjs (Task 2), CLI (Task 3), and both tests; output shape `{ engine, width, height, text, lines[], found? }` consistent across Task 3 tests and Task 7 smoke. `center`/`bbox` always in original-image pixel space. Installer function renamed `Add-EgoBrowserToPath` → `Add-DirToUserPath` consistently (Task 6). ✅
