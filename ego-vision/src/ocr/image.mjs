import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";

function isPng(buffer) {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4e && buffer[3] === 0x47
  );
}

/**
 * Cheaply read an image's dimensions from its header only (no full decode).
 * PNG: IHDR width/height at fixed offsets. JPEG: scan markers for SOF segments.
 * @returns {{width:number,height:number}|null}
 */
export function readImageSize(buffer) {
  if (isPng(buffer) && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 8 < buffer.length) {
      if (buffer[i] !== 0xff) { i++; continue; }
      const marker = buffer[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda) break; // SOS: no more header segments
      const len = buffer.readUInt16BE(i + 2);
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && i + 9 < buffer.length) {
        return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Decode a PNG or JPEG buffer to RGBA pixels: { width, height, data(Buffer) }. */
export function decodeImage(buffer) {
  if (isPng(buffer)) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  const jpeg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true });
  return {
    width: jpeg.width,
    height: jpeg.height,
    data: Buffer.from(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.byteLength),
  };
}

/** Encode RGBA pixels to a PNG buffer (what the OCR engine consumes). */
export function encodePng(rgba) {
  const png = new PNG({ width: rgba.width, height: rgba.height });
  png.data.set(rgba.data);
  return PNG.sync.write(png);
}

/** Crop RGBA pixels to a region; returns a new RGBA object (no re-decode/encode). */
export function cropRgba(src, { x, y, w, h }) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(src.width, Math.round(x + w));
  const y1 = Math.min(src.height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) throw new Error("vision: empty crop region");
  const cw = x1 - x0, ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const si = (row * src.width + col) * 4;
      const di = ((row - y0) * cw + (col - x0)) * 4;
      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = src.data[si + 3];
    }
  }
  return { width: cw, height: ch, data: out };
}

/** Nearest-neighbour upscale RGBA pixels by an integer factor; returns a new RGBA object. */
export function upscaleRgba(src, factor) {
  if (!(factor > 1)) return src;
  const w = src.width * factor, h = src.height * factor;
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const sr = Math.floor(row / factor);
    for (let col = 0; col < w; col++) {
      const sc = Math.floor(col / factor);
      const si = (sr * src.width + sc) * 4;
      const di = (row * w + col) * 4;
      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = src.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}
