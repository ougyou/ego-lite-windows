# Using vision with a browser (consumer pattern)

The `ego-vision` skill is independent of any browser. Browser automation (e.g. the `ego-browser` skill) consumes it by saving a screenshot, then calling OCR:

```js
// inside an ego-browser heredoc
await page.screenshot({ path: 'C:/tmp/shot.png' })
// then:  ego-vision ocr C:/tmp/shot.png --find "确认"
```

Coordinate mapping to the page's CSS viewport:
`cssX = ocrX * (viewportCssWidth / imageWidth)`, `cssY = ocrY * (viewportCssHeight / imageHeight)`.

In v1 there is no `page.ocr` harness helper; this screenshot-then-OCR flow is the supported path. A native helper may come in v2.
