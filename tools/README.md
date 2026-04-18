# tools

Utility scripts shared by the builder, conformance emulators, and
various build-time converters. Not user-facing.

## Files

| File | Purpose |
|---|---|
| `mkfat12.mjs`  | Builds a FAT12 floppy image from a list of files. Used by the floppy stage of the builder. |
| `js8086.js`    | Vendored reference 8086 CPU core. Used by the `conformance/ref-*.mjs` emulators. |
| `peripherals.mjs` | PIC / PIT / keyboard controller classes that plug into `js8086.js`. |
| `compare.mjs`  | Tick-by-tick diff between a CSS trace and a JS reference trace. Slated for consolidation into calcite-debugger. |
| `compare-dos.mjs` | Same, for the DOS boot path. Slated for consolidation. |
| `bin-to-c.py`  | Converts `.bin` files to C arrays (used by the Corduroy BIOS to embed the logo). |
| `png-to-vga.py` | Converts PNGs to VGA Mode 13h palette data. |
| `lib/bios-handlers.mjs` | JS implementations of BIOS INT handlers, bound to the `js8086` emulator. |
| `lib/bios-symbols.mjs`  | Parses NASM `.lst` files to recover symbol offsets (e.g. `bios_init`). Used by the builder's BIOS stage. |

## Not to be confused with

- `conformance/` — reference emulators that use these utilities.
- `builder/` — the orchestrator. Invokes `mkfat12.mjs` and
  `lib/bios-symbols.mjs` (indirectly) when building.
- `kiln/` — the CSS transpiler; unrelated to anything here.
