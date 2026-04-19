# CSS-DOS architecture

This is the tight overview. For specifics, each section points to a
depth doc.

## What CSS-DOS is

CSS-DOS is a **platform** for running DOS programs as pure CSS. An
Intel 8086 PC implemented entirely in CSS custom properties and `calc()`.
The CSS runs in Chrome unaided — no JavaScript, no WebAssembly, no
browser extensions. Calcite (a sibling repo) is the JIT compiler that
makes cabinets fast enough to actually play.

### 1. What the BIOS is

A progression of faithfulness:

- **Gossamer** — the thin shim. Just enough to fool one `.COM` program
  into thinking it's on a PC.
- **Muslin** — hand-written 16-bit assembly BIOS. Boots EDR-DOS.
- **Corduroy** — the default. Same contract as Muslin, rewritten in C,
  with a real INT 09h keyboard handler + EOI on INT 08h/09h, and a
  Mode 13h splash.

Both DOS BIOSes boot EDR-DOS, but COMMAND.COM isn't usable under either
— carts must set `boot.autorun` to run a program directly.

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
