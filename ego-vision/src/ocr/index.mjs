import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerEngine, getEngine } from "./registry.mjs";
import { recognize as tesseractRecognize } from "./engines/tesseract.mjs";
import { readImageSize, decodeImage, encodePng, cropRgba, upscaleRgba } from "./image.mjs";

registerEngine("tesseract", tesseractRecognize);

// index.mjs sits at ego-vision/src/ocr/, so ../../data resolves to ego-vision/data/
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../data", import.meta.url));

export async function recognize(opts = {}) {
  const langs = opts.langs || process.env.EGO_VISION_LANGS || "eng+jpn+chi_sim";
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
  // Cheap header read gives original dims (the line coordinate space) without decoding.
  const size = readImageSize(image);
  let origWidth = size ? size.width : undefined;
  let origHeight = size ? size.height : undefined;

  // Decode ONCE; crop/upscale chain on the same RGBA buffer; encode once for the engine.
  let engineImage = image;
  let offsetX = 0, offsetY = 0;
  if (region || scale > 1) {
    const src = decodeImage(image);
    origWidth = src.width;
    origHeight = src.height;
    let cur = src;
    if (region) {
      cur = cropRgba(cur, region);
      offsetX = region.x;
      offsetY = region.y;
    }
    if (scale > 1) cur = upscaleRgba(cur, scale);
    engineImage = encodePng(cur);
  }

  const engine = getEngine(engineName);
  const result = await engine({ image: engineImage, langs, dataDir });

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
    width: origWidth,
    height: origHeight,
    text: lines.map((line) => line.text).join("\n"),
    lines,
  };
  if (opts.find) {
    const needle = String(opts.find).toLowerCase();
    out.found = lines.find((line) => line.text.toLowerCase().includes(needle)) || null;
  }
  return out;
}
