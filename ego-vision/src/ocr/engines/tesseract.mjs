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
