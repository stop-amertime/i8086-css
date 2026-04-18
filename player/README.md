# player

Static HTML shell that runs a cabinet in Chrome. No build step.

## Four variants

| File | Description |
|---|---|
| `play.html` | Pure CSS — zero `<script>` tags. The clock advances via a CSS animation. Proves the source-of-truth claim: the CSS is the machine. |
| `turbo.html` | `play.html` + `turbo.js`. Overrides `--clock` via `requestAnimationFrame` so ticks run as fast as Chrome can evaluate them. Much faster than the CSS animation rate. |
| `meter.html` | `play.html` + `meter.js`. Adds a small badge (top-right) showing effective 8086 Hz sampled once per second from `--__1cycleCount`. |
| `turbo-meter.html` | `play.html` + both scripts. Fast execution with the Hz meter. |

## Usage

The dev server (or Vercel) serves cabinets at `/cabinet.css`. Open whichever
variant you want:

```
/play.html
/turbo.html
/meter.html
/turbo-meter.html
```

For local file use, point a static server at the project root and load the
cabinet via the server's `/cabinet.css` route.

## Assets

| File | Description |
|---|---|
| `assets/player.css` | Keyboard grid + beveled button styling. |
| `assets/turbo.js` | Clock accelerator (~20 lines). |
| `assets/meter.js` | Hz meter badge (~20 lines). |

## Keyboard

Buttons use stable IDs (`id="kb-a"`, `id="kb-enter"`, etc.) that match the
`:has(#kb-X:active)` selectors Kiln emits. HTML layout is free — button order
in the DOM does not need to match Kiln's `KEYBOARD_KEYS` array.

## Why four variants instead of one

`play.html` is the purity proof — the CSS runs with zero JavaScript. The turbo
and meter scripts are optional enhancements that require JS. Keeping them
separate means the pure-CSS claim is always verifiable with a simple
`grep -c "<script" player/play.html`.

## Not to be confused with

Calcite's browser frontend (`calcite/web/`) loads cabinets into the Calcite
WASM engine for speed. The player here is pure Chrome and exists to prove the
CSS-as-source-of-truth claim. Both are legitimate browser targets.
