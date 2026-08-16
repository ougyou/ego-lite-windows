# ego-vision CLI reference

`ego-vision ocr <image> [options]`

| Option | Default | Meaning |
|---|---|---|
| `--langs` | `eng+jpn+chi_sim` | Tesseract language string (e.g. `--langs jpn` for Japanese-only, faster/more accurate) |
| `--engine` | `EGO_VISION_ENGINE` \|\| `tesseract` | Engine name (pluggable registry) |
| `--min-confidence` | `0.5` | Drop lines below this confidence (0–1) |
| `--region` | — | Crop `x,y,w,h` in image pixels before OCR (faster, focused) |
| `--scale` | `1` | Integer upscale factor for small text (then coords are mapped back) |
| `--find` | — | Return `found` with the first line containing this substring |
| `--text` | off | Compact output `{ engine, width, height, text, found? }` — omit per-line boxes; cheap token-light text reasoning |
| `-h, --help` | — | Print usage |

Output JSON: `{ engine, width, height, text, lines[], found? }`.
All coordinates are image-pixel space of the ORIGINAL input image.

Env vars (independent namespace, do NOT use ego-lite's): `EGO_VISION_LANGS`, `EGO_VISION_ENGINE`, `EGO_VISION_DATA_DIR`.
