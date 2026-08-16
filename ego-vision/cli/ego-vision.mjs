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
    text: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage:
  ego-vision ocr <image> [--langs eng+jpn+chi_sim] [--engine tesseract]
                    [--min-confidence 0.5] [--region x,y,w,h] [--scale 2]
                    [--find <substring>] [--text]
Coordinates in output are image-pixel space of the input image.
--text: compact output { text, width, height, found? } - omit per-line boxes for cheap text reasoning.`);
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
  // --text: compact, token-light output for pure text reasoning (agent reads text,
  // calls back with --find only when it needs a clickable location).
  const payload = values.text
    ? {
        engine: result.engine,
        width: result.width,
        height: result.height,
        text: result.text,
        ...(result.found !== undefined ? { found: result.found } : {}),
      }
    : result;
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
} catch (err) {
  console.error(`ego-vision: ${err.message}`);
  process.exit(1);
}
