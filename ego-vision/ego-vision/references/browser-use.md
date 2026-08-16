# Using vision with a browser (consumer pattern)

The `ego-vision` skill is independent of any browser. Browser automation (e.g. the `ego-browser` skill) consumes it by saving a screenshot, then calling OCR:

```js
// inside an ego-browser heredoc — 每次用唯一临时路径，避免复用旧截图
const shot = require('path').join(require('os').tmpdir(), `ego-vision-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
await page.screenshot({ path: shot })
// then:  ego-vision ocr ${shot} --find "确认"
// 用后清理本次截图，保持区域干净：
// require('fs').unlinkSync(shot)
```

Coordinate mapping to the page's CSS viewport:
`cssX = ocrX * (viewportCssWidth / imageWidth)`, `cssY = ocrY * (viewportCssHeight / imageHeight)`.

In v1 there is no `page.ocr` harness helper; this screenshot-then-OCR flow is the supported path. A native helper may come in v2.
