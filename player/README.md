# player

Static HTML shell that runs a cabinet in Chrome. No build step; just a
static file.

## Usage

```
open player/index.html?cabinet=../mycart.css
```

The query string points the player at a cabinet. The player `<link>`s
the CSS into the page and drives the clock with a tiny JS loop.

## Why a separate player

Cabinets are pure CSS. Chrome loads the CSS, the CSS is the machine.
The player is what ticks the CSS clock and surfaces the video buffer.
It's the same HTML for every cabinet — you swap the cabinet via the
URL, the player never changes.

This replaces the old `--html` mode where Kiln inlined an HTML wrapper
into the cabinet itself. Cabinets are now pure CSS; the wrapper is
static.

## Not to be confused with

Calcite's browser frontend (`calcite/web/`) is a different thing — it
loads cabinets into the Calcite WASM engine for speed. The player
here is pure Chrome, slow, and exists to prove the CSS-as-source-of-truth
claim. Both are legitimate browser targets.
