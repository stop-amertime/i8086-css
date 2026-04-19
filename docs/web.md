# The web version

A browser-native frontend for CSS-DOS. Users upload a `.com` file (or
pick one from a library), watch the CSS cabinet get built in their
browser, and then play it in a JavaScript-free player page. Advanced
users can tweak config; everyone can download the finished cabinet as
a `.zip` for offline play or hand it off to calcite.

This document is the living reference for how the web version is
structured. Design context and open questions at the bottom.

## Goals

- **The player page contains zero JavaScript.** No `<script>` tag, no
  inline event handlers. A view-source on `play.html` shows a `<link>`,
  a `<style>`, and a `<key-board>` full of buttons. The CSS runs itself
  via the `@keyframes anim-play` clock that Kiln already emits. This is
  the purity claim. Optional `turbo.html` and `meter.html` variants add
  a small `<script>` for acceleration and speed measurement respectively
  and advertise that they do so — but the default player is pure.
- **The build happens in the user's browser.** Not on our servers. The
  user brings their `.com`, watches Kiln assemble a 300-500 MB cabinet
  out of their 13 KB program, and ends up with a file they can play,
  download, or share. The weirdness is the product; making the user
  complicit in summoning it is the point.
- **No "real" backend.** The site is static files. Build, storage, and
  playback are all client-side. Deployment is any static host (Vercel,
  Cloudflare Pages, Netlify, GitHub Pages, nginx on a box).
- **Shared source with the Node toolchain.** The browser builder imports
  the same Kiln source as `builder/build.mjs`. Browser-specific concerns
  live in thin adapters, not in Kiln itself. Anything that can be built
  from source in Node is built from source in the browser; only things
  that genuinely can't run in a browser (NASM) are pre-baked.

## Architecture

```
┌─────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────┐
│  index.html │──▶│  build.html  │──▶│ Cache Storage   │──▶│ play.html│
│  (gallery,  │   │ (browser     │   │ /cabinet.css    │   │ (JS-free,│
│  upload UI) │   │  builder,    │   │                 │   │  links   │
│             │   │  narrates)   │   │ served by       │   │  via SW) │
└─────────────┘   └──────────────┘   │ service worker  │   └──────────┘
                         ▲            └─────────────────┘
                         │
                  ┌──────┴───────┐
                  │ /prebake/*.bin│  (NASM outputs, static)
                  │ kiln source  │  (shared with Node path)
                  │ user .com    │  (File from <input>)
                  └──────────────┘
```

### The three pages

- **`index.html`** — landing page. Explains what this is, lists
  prebuilt cabinets from a gallery, and has an upload button to bring
  a `.com`. JS page. Not trying to be JS-free.
- **`build.html`** — build page. Takes the user's `.com` (or a gallery
  selection), runs the browser build pipeline, narrates each stage
  with progress, and writes the finished cabinet into Cache Storage at
  a stable URL. JS page. On completion, offers **Play**, **Download .zip**,
  and **Open in calcite** buttons.
- **`play.html`** / **`turbo.html`** / **`meter.html`** — the player
  pages. Each is a static file with a fixed `<link rel="stylesheet"
  href="/cabinet.css">`. A service worker intercepts that fetch and
  returns the bytes from Cache Storage. `play.html` has no `<script>`
  at all; `turbo.html` adds the acceleration script; `meter.html` adds
  the speed meter; both can coexist in a combined `turbo-meter.html`.

### The build pipeline (in the browser)

The browser builder composes the cabinet from three kinds of inputs:

1. **The user's program.** Bytes from `.com` file, read via `File` API.
2. **Pre-baked NASM outputs.** Fetched as static assets from
   `/prebake/muslin.bin`, `/prebake/init.bin`, etc. One per BIOS flavour
   we support. These are committed build artifacts; see "Pre-bake
   pipeline" below.
3. **Kiln source, running live in the browser.** The transpiler, the
   floppy builder, memory layout, cycle-count table, opcode dispatch
   emission — all pure JS, imported as modules from `kiln/` and
   `builder/lib/` via a thin adapter layer.

Orchestration lives in `web/browser-builder/main.mjs`, which plays the
same role as `builder/build.mjs` does for Node: it wires cart
resolution + preset merging (from `builder/lib/`) through the floppy
builder and into Kiln, then finalises the output. `main.mjs` is
browser-specific because it deals with `File`, `fetch`, and Cache
Storage. `builder/lib/`, `kiln/`, and the floppy builder are shared
across both paths; `builder/build.mjs` itself stays Node-only.

Output is a `Blob` of the final cabinet CSS. Written to Cache Storage
under `/cabinet.css` (or a user-chosen name if we offer a library).

### Storage

- **HTTP cache** — static assets (pages, JS modules, pre-baked `.bin`s,
  gallery cabinets). Standard `Cache-Control` headers. Gzip on
  everything the host will compress.
- **Cache Storage API** — assembled cabinets. The service worker reads
  from here. Handles 500 MB+ Blobs; survives across sessions; large
  quota (typically ~60% of free disk on Chrome). One canonical entry at
  `/cabinet.css` for "the current cabinet", plus optional named entries
  for a saved library.
- **IndexedDB** — user's `.com` files they've uploaded (tiny, KB-level)
  and their named build history. Optional; v1 can skip this and treat
  every visit as single-cabinet.

### Service worker

Its only job is to intercept fetches for paths that correspond to
assembled cabinets and serve them from Cache Storage instead. Everything
else passes through. The SW is JS, but it's in a separate context from
the player page — the player page itself still has zero `<script>` tags.
`navigator.serviceWorker.register(...)` happens on `index.html` /
`build.html`; by the time the user reaches `play.html`, the SW is
already installed and doing its thing.

### Pre-bake pipeline

- **Source of truth:** the `.asm` files under `bios/gossamer/`,
  `bios/muslin/`, `bios/corduroy/`. These stay as they are.
- **Pre-bake step:** a Node script at `web/scripts/prebake.mjs` runs
  `nasm.exe` on each `.asm`, writes the resulting bytes to
  `web/prebake/<name>.bin`, and updates `web/prebake/manifest.json`.
- **Committed artifacts:** the `.bin` files and the manifest are
  committed. This is sloppy but pragmatic — it means deploying the
  site doesn't require NASM on the build machine. Can be tightened to
  a CI artifact later.
- **Browser usage:** `web/browser-builder/prebake-loader.mjs` fetches
  the relevant `.bin` at build time, turns it into a `Uint8Array`, and
  hands it to Kiln's BIOS emission code in place of whatever `fs.readFileSync`
  would have returned in Node.

## Repository layout

New top-level `web/` folder for everything cloud-specific. Existing
folders (`builder/`, `kiln/`, `bios/`, `player/`, etc.) are shared between
the Node and browser paths.

```
CSS-DOS/
├── builder/                    ← Node orchestrator (unchanged)
├── kiln/                       ← transpiler (shared; small browser-safety refactor)
├── bios/                       ← BIOS sources (unchanged)
├── player/                     ← HTML player templates
│   ├── play.html               ← JS-free (default)
│   ├── turbo.html              ← + turbo script
│   └── meter.html              ← + meter script
├── conformance/
├── carts/
├── docs/
│   ├── web.md                  ← this file
│   └── ...
└── web/                        ← NEW: the cloud version
    ├── README.md               ← local dev + deploy instructions
    ├── site/                   ← the deployable static site
    │   ├── index.html          ← landing / gallery
    │   ├── build.html          ← builder UI
    │   ├── assets/
    │   │   ├── site.css
    │   │   └── gallery/        ← pre-built cabinets for the gallery
    │   ├── sw.js               ← service worker
    │   └── (symlinks or copies of player/*.html at build time)
    ├── browser-builder/
    │   ├── main.mjs            ← entry point for build.html
    │   ├── kiln-adapter.mjs    ← wraps kiln/ for browser use
    │   ├── floppy-adapter.mjs
    │   └── prebake-loader.mjs
    ├── prebake/
    │   ├── muslin.bin
    │   ├── init.bin
    │   ├── gossamer.bin
    │   └── manifest.json       ← names, versions, sizes, source hashes
    ├── scripts/
    │   ├── prebake.mjs         ← runs NASM, refreshes prebake/
    │   ├── dev.mjs             ← local dev server
    │   └── build.mjs           ← bundles site/ for deployment
    └── vercel.json             ← (or netlify.toml etc.)
```

The player HTML lives in `player/` because it's shared with the Node
path (`node builder/build.mjs` still produces cabinets that open via the
player). The `web/site/` build step either copies or symlinks those
files into the deployable site.

## The player page in detail

### Clock (zero-JS mode)

Kiln already emits the pieces needed. The cabinet CSS contains:

```css
@keyframes anim-play {
  0%   { --clock: 0 }
  25%  { --clock: 1 }
  50%  { --clock: 2 }
  75%  { --clock: 3 }
}
.clock {
  animation: anim-play 400ms steps(4, jump-end) infinite;
  --clock: 0;
}
.cpu {
  animation: store 1ms infinite, execute 1ms infinite;
  animation-play-state: paused, paused;
  @container style(--clock: 1) { animation-play-state: running, paused }
  @container style(--clock: 3) { animation-play-state: paused, running }
}
```

This is Lyra's technique and it works without any JS. At 400ms per
8086 instruction that's 2.5 instructions/sec; since `cycleCount`
accumulates real 8086 cycle costs (~4-10 cycles per instruction on
average), the speed meter will show something like 10-25 Hz in
pure-CSS mode. Slow, but the purity claim is what we're trading speed
for.

Kiln currently has an `htmlMode` flag that suppresses the
`anim-play` animation (because the old HTML player was JS-driving
`--clock` and wanted to disable the CSS fallback). **This flag is
removed as part of the web version work.** Cabinets always ship with the
CSS clock enabled. If anything wants to drive faster, it does so by
overriding `--clock` from JS, which works alongside the animation rather
than replacing it.

### Clock (turbo)

`turbo.html` adds a `<script>` that yanks `--clock` between values via
`element.style.setProperty('--clock', n, 'important')` and forces
recomputation with `getComputedStyle(...).getPropertyValue('--__1IP')`,
inside a `requestAnimationFrame` loop. Same pattern Lyra uses. Output:
one 8086 tick per four property-sets, as fast as Chrome will compute
them. Actual speedup over the pure-CSS clock depends on cabinet size
and the user's machine; to be measured against real cabinets once
implementation lands.

### Speed meter

`meter.html` adds a `<script>` that samples `--__1cycleCount` twice
~1 second apart via `getComputedStyle`, computes delta, divides by
elapsed wall-clock milliseconds, and writes the result ("74 Hz", "3.2 KHz",
"1.4 MHz") into a visible `<span>`. `cycleCount` accumulates *real 8086
cycle costs*, not instruction counts, so the displayed number is the
actual effective 8086 clock rate of the simulation. About 15 lines of JS.

Meter works in pure-CSS mode too; someone who loads the cabinet in
`meter.html` without `turbo.html`'s script will see a genuine ~2.5 Hz
reading. A combined `turbo-meter.html` exists for the common case.

### Keyboard

The cabinet CSS emits rules like:

```css
.cpu:has(key-board button:nth-child(1):active) { --keyboard: 0x0231; }
.cpu:has(key-board button:nth-child(2):active) { --keyboard: 0x0332; }
/* ... */
```

The player's HTML must therefore have:

- A `<key-board>` element (custom tag, no registration needed).
- Direct children `<button>` elements in the **exact order** of Kiln's
  `KEYBOARD_KEYS` array (`template.mjs`).
- No intermediate wrappers between `<key-board>` and `<button>`, or the
  `nth-child` selectors break.

The styling is borrowed from calcite's web frontend (`calcite/web/`):
DOS-beige buttons (`#c0c0c0`) with 2px beveled borders that invert on
`:active`, slight amber tint on Enter, space bar spans the row. Layout
done entirely with CSS grid + `grid-column` / `grid-row` on specific
`nth-child` positions — achieves the calcite-web look (main letter block
on the left, Esc/Tab/Bksp row and arrow cluster on the right) without
nesting the HTML.

## Deferred until implementation / post-v1

These were flagged during design but don't block the structure above.

- **Chrome parse-time test on real cabinets.** Does Chrome actually
  parse a 458 MB CSS file `<link>`ed from a Cache-Storage-served URL in
  a reasonable time? Expected answer is "yes, slowly", but unverified.
  If parse time is > 30s we may want a pure-CSS loading visual on the
  player page before the cabinet's own styles take over. If it OOMs
  we're in a different conversation.
- **Streaming Blob construction in Kiln.** Node handles a 500 MB
  output because Kiln writes to a file stream. Browser JS will OOM if
  Kiln accumulates the whole cabinet into a single string. Fix: write
  chunks into a `Blob` as we go. Size of the refactor unknown; should be
  localised to wherever Kiln finalises output.
- **Kiln browser-safety audit.** Read through `kiln/` and
  `builder/lib/` and list every Node-only API call (`fs`, `path`,
  `Buffer`, `child_process`, `process.argv`). Expected to be a short
  list — Kiln looks mostly like string building. Handle each in the
  adapter layer rather than branching inside Kiln.
- **Which BIOS flavours the web version exposes.** Corduroy is default.
  Muslin might be worth exposing for advanced users. Gossamer
  (hack path) is probably not — different runtime shape, different
  cart format. Decide at implementation time.
- **Advanced config panel.** Memory size, prune options, BIOS flavour,
  initial registers. Collapsed "Advanced" section on `build.html`. Low
  priority for v1; the defaults should Just Work.
- **User library (IndexedDB).** v1 can treat every visit as
  single-cabinet (Cache Storage has one slot). Library with named
  builds is a polish item.
- **Download .zip.** Post-build, offer a zip containing `play.html` +
  `cabinet.css` for offline play. Uses a browser zip library; ~10 KB
  dependency. Post-v1.
- **Gallery content.** Which pre-built cabinets ship on the landing
  page. Pick 5-10 from `carts/` and existing working programs.

## Open design questions

None blocking.

## Related documents

- `docs/architecture.md` — how a cabinet is structured and what Kiln
  produces. The web version is orthogonal to the architecture; the
  cabinet format is unchanged.
- `docs/building.md` — the Node build pipeline. The browser builder is
  a port of this, not a replacement.
- `docs/cart-format.md` — the `program.json` schema. Web-uploaded carts
  are either a bare `.com` (implicit defaults) or a `.zip` containing
  a `program.json`.
- `player/README.md` — the current player (pre-web-work). Will be
  updated when the web work lands to describe the three variants.
- `web/README.md` — operational instructions (local dev, deploy,
  refresh pre-bakes). Does not yet exist; created with the first web
  implementation PR.
