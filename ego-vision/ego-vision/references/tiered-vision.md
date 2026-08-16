# Tiered vision policy

1. **Default — local OCR** (`ego-vision ocr`, engine `tesseract`): cheap, offline, high call volume. Use for reading text and locating/clicking.
2. **Escalation — vision model**: only when you need high-precision reading, layout/semantic understanding, or OCR confidence is too low. This tier is online and costly; invoke deliberately, and only after OCR returns poor results.
3. **Human — security CAPTCHA**: sliders/wappass/reCAPTCHA are handed to the user, never auto-solved. Reading text the page merely displays is allowed.

Engine interface is pluggable (`EGO_VISION_ENGINE`); v1 ships `tesseract` only.
