# Third-Party Notices

`ego-lite-windows` packages the following third-party software.

## ego-lite (MIT)

- Source: https://github.com/CitroLabs/ego-lite
- License: MIT (see `LICENSE` — copied from the upstream repo)

We vendored the **community Linux port** of ego-lite (ego-lite PR
[#234](https://github.com/citrolabs/ego-lite/pull/234)), which replaces the
macOS app's native bindings with a CDP shim over a stock Chromium/Edge. This is
what makes the runtime run on Windows and Linux.

Vendored pieces:

- `runtime/ego-linux/` — the CDP shim + CLI launcher (`bin/ego-browser.mjs`,
  `src/*.mjs`)
- `runtime/ego-browser/dist/out/index.js` — the compiled agent harness (helper
  injection, facades, drivers, learning subsystem)
- `skills/ego-browser/` — the agent skill package (docs, learnings for
  `google`, `x-com`, assets, agent references)

Local modifications relative to the vendored baseline are recorded in
`runtime/PATCHES.md` (e.g. the cursor watermark renamed `Claude` → `DeepSeek`
in `runtime/ego-linux/src/cursor.mjs`).

## Provenance of this packaging

The vendored runtime was originally bundled inside the
`@dsh-external/ego-browser` DSH plugin
(https://github.com/Fisfzy/ego-browser), where it powered 32 `ego_*` harness
tools and a realtime observation window. This repo extracts the **runtime and
skill** into a standalone, DSH-free package and adds a Windows launcher +
Copilot skill. The DSH plugin's `lib/` (tool layer, cast server, watch panel)
is intentionally **not** included.

## Licenses

- Upstream ego-lite: MIT (see `LICENSE`)
- This packaging: MIT
