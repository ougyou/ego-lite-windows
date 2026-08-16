---
name: ego-vision
description: 'Standalone vision-understanding skill with local OFFLINE OCR. Use for extracting text + coordinates from any local image (screenshots, photos, scans, game frames, canvas renders) when you do NOT have a vision model, or want to avoid its cost. Triggers: "OCR this image", "read the text in this screenshot", "find where on the image X appears", "extract text from image". Run `ego-vision ocr <image>`; output is JSON with text, per-line bounding boxes and centers (image-pixel space). Escalate to a vision model only for high-precision reading, layout/semantic understanding, or when OCR confidence is low.'
metadata:
  version: "1.0.0"
  date: "2026-08-16"
---

# ego-vision — local offline OCR for any image

Run `ego-vision ocr <image>` on any local image file. It returns JSON:

- `text` — lines joined by newlines (read this for content).
- `lines[]` — each `{ text, confidence, bbox:{x,y,w,h}, center:{x,y} }`.
- `found` — present when `--find <substring>` matches; includes a clickable `center`.
- Coordinates are **image-pixel space** of the input image.

## Invocation

```powershell
ego-vision ocr C:\path\shot.png
ego-vision ocr C:\path\shot.png --langs jpn --scale 2      # 日文（单语言更准；小字用 --scale 放大）
ego-vision ocr C:\path\shot.png --region 10,20,300,80
ego-vision ocr C:\path\shot.png --text                     # 紧凑输出（只要 text，省 token 文本推理）
ego-vision ocr C:\path\shot.png --text --find "確認"        # 读文本 + 需要定位时再取 center
```

Default `--langs` is `eng+jpn+chi_sim` (covers EN/JP/CN out of the box). For
cleaner single-script results pass `--langs jpn` / `--langs chi_sim` / `--langs eng`.

## 性能提示

- 只读内容时用 `--text`（返回 `text`，无逐行 bbox/confidence，token 更省、更快）。
- 明确语言用 `--langs <单语言>`：单语言比默认 3 语言快约 1.5x（默认加载 eng+jpn+chi_sim）。
- 输出是 UTF-8 JSON；终端乱码多为控制台代码页问题（`bin/ego-vision.cmd` 已加 `chcp 65001`）。

If `ego-vision` is not on PATH, run `node <repo>\vision\cli\ego-vision.mjs ocr ...`.

## Rules

- **Read text** with OCR when the model has no vision (or to save cost). Use the returned `center` to click/press at that location.
- **Escalate to a vision model** ONLY when: high-precision reading, layout/semantic understanding, or OCR `confidence` is low. That tier is on-demand and costs tokens.
- **Never use OCR to bypass security CAPTCHAs** (sliders, wappass, reCAPTCHA). Reading text the page merely *displays* (e.g. a code shown on screen) is fine.
- Fully offline; no API keys; no runtime network.

Full reference: [references/cli.md](references/cli.md) · [references/tiered-vision.md](references/tiered-vision.md) · [references/browser-use.md](references/browser-use.md).
