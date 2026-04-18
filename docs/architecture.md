# CSS-DOS architecture

This is the tight overview. For specifics, each section points to a
depth doc.

## What CSS-DOS is

CSS-DOS is a **platform** for running DOS programs as pure CSS. An
Intel 8086 PC implemented entirely in CSS custom properties and `calc()`.
The CSS runs in Chrome unaided — no JavaScript, no WebAssembly, no
browser extensions. Calcite (a sibling repo) is the JIT compiler that
makes cabinets fast enough to actually play.

## The cardinal rule

The CSS is the source of truth. Chrome is the reference implementation.

- The CSS must work in Chrome. If Chrome can't evaluate it, it's wrong.
- Calcite can't change the CSS — only evaluate it faster.
- CSS restructuring is fine if Chrome still produces the same result
  (expressing the same computation in a different, more
  pattern-recognisable shape). But no dummy code, no metadata
  properties, no side-channels whose only purpose is to sneak
  information to Calcite.
- If Calcite disagrees with Chrome, Calcite is wrong.

## The four axes

CSS-DOS used to feel messy because it grew along four axes without
separating them. Now:

### 1. What the BIOS is

A progression of faithfulness:

- **Gossamer** — the thin shim. Just enough to fool one `.COM` program
  into thinking it's on a PC.
- **Muslin** — the current real BIOS. Hand-written 16-bit assembly that
  implements enough of the IBM-PC BIOS contract to boot DOS.
- **Corduroy** — the structured successor. Same contract as Muslin,
  built in C. Experimental.

Depth: [`bios-flavors.md`](bios-flavors.md) and each BIOS's own
`bios/<flavor>/README.md`.

### 2. What the build produces

A **cabinet** — a single self-contained `.css` file. The inputs vary:

- Which BIOS
- What's in memory at t=0 (just a `.COM`, or a full DOS boot with a
  floppy image)
- Where CS:IP starts
- Which optional memory zones are included (VGA gfx, VGA text,
  rom-disk window)

These four knobs are what used to be encoded in three different
generator scripts. They're now fields on the cart's `program.json`.

Depth: [`cart-format.md`](cart-format.md).

### 3. What stage of the build you're in

Four stages, each a module in `builder/stages/`:

1. `resolveCart` — find the cart (folder or zip), parse
   `program.json`, list files.
2. `resolveManifest` — merge the preset, validate, fill in defaults.
3. `buildBios` — produce BIOS bytes and the entry point.
4. `buildFloppy` — FAT12 image (DOS carts only).
5. `runKiln` — invoke the transpiler, stream CSS to the output.

The orchestrator (`builder/build.mjs`) only wires stages together and
writes the cabinet header.

Depth: [`building.md`](building.md) and `builder/README.md`.

### 4. What you do with the cabinet

Three runtime targets:

- **Chrome**, via the **player** — static HTML at `player/index.html`
  that loads a cabinet with `?cabinet=path.css`. The source-of-truth
  demonstration; slow.
- **Calcite CLI** — native JIT. Fast.
- **Calcite web** — WASM-compiled Calcite inside a Web Worker. Fast in
  the browser.

Diff-testing and debugging is a separate activity, served by the
reference emulators in `conformance/` and Calcite's debugger + diff
tools.

## Pipeline, end to end

```
         cart (folder or zip)
                  │
                  ▼
          builder/build.mjs
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
 buildBios   buildFloppy    runKiln
     │            │            │
     ▼            ▼            ▼
  BIOS        FAT12 bytes    kiln/emit-css.mjs
  bytes                          │
                                 ▼
                           cabinet (.css)
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       player/index.html     calcite-cli       calcite-wasm
       (Chrome direct)       (terminal)        (browser)
```

## Relationship to Calcite

Calcite lives at `../calcite/` as a sibling repo. It has:

- **calcite-core** — the parser + JIT + evaluator library (Rust).
- **calcite-cli** — native terminal runner.
- **calcite-debugger** — HTTP debug server for conformance + inspection.
- **calcite-wasm** + **web/** — browser runner.

The relationship is strict: CSS-DOS owns every scrap of x86 knowledge;
Calcite is domain-agnostic and just evaluates CSS. The flat-array
dispatch optimization that makes rom-disk fast enough to use is a
generic CSS pattern that happens to fire on a shape CSS-DOS emits —
not an x86-specific hack inside Calcite.

Depth: `../calcite/CLAUDE.md`.

## Memory, briefly

A cabinet's memory is a flat set of **zones** that each contain a
range of 8086 linear addresses. Every addressable byte is a CSS
custom property. Zones:

- **Conventional RAM** — `0x00000–0xA0000` for DOS carts (640K). IVT,
  BDA, program, stack, kernel.
- **VGA gfx** — `0xA0000–0xAFA00` — Mode 13h framebuffer. Optional.
- **VGA text** — `0xB8000–0xB8FA0`. Optional.
- **Rom-disk window** — `0xD0000–0xD01FF` — 512 bytes that dispatch to
  a `--readDiskByte(idx)` CSS function, so disk bytes live *outside*
  the 8086 address space.
- **BIOS ROM** — `0xF0000+` — included as read-only literal bytes.

Depth: [`memory-layout.md`](memory-layout.md).
