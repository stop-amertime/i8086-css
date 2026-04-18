# Corduroy BIOS

The **structured BIOS**: same IBM-PC-BIOS contract as Muslin, rewritten
in C (with just enough assembly glue for the entry stub and interrupt
handlers that need register-level control). Experimental.

## When to pick it

Set `"preset": "dos-corduroy"` or `"bios": "corduroy"`. Pick Corduroy if
you want the splash screen, or want to hack on the BIOS itself. Pick
Muslin if you want the boot-proven default.

## What it implements

Everything Muslin does, plus a Mode 13h splash screen with the CSS-DOS
logo before it jumps to the kernel. The modular C layout (separate
`bios_init.c` / `handlers.asm` / `splash.c` / `font.c`) is designed to
absorb future work (PIT, PIC, real IRQs) more easily than Muslin's
monolithic assembly.

## Files

| File | Role |
|---|---|
| `entry.asm`    | Far-entry stub at `F000:0000`. Sets up stack, calls `bios_init`. |
| `handlers.asm` | IVT table + INT handlers in assembly. |
| `bios_init.c`  | IVT/BDA init, splash, jump to kernel. |
| `splash.c`     | CSS-DOS logo rendering in Mode 13h. |
| `logo_data.c`  | Logo bitmap (generated from `tests/logo.bin` via `tools/bin-to-c.py`). |
| `font.c`       | 8×8 VGA font table. |
| `link.lnk`     | OpenWatcom linker script. |
| `toolchain.env` | Tool paths (NASM, wcc, wlink, Watcom include dir). |
| `build.mjs`    | Orchestrates NASM + wcc + wlink into `build/bios.bin`. |

## Build

Requires NASM **and** OpenWatcom (`wcc`, `wlink`). See `toolchain.env`.

```
node build.mjs
```

Emits `build/bios.bin`. The top-level builder calls this automatically
when `bios: "corduroy"` is selected.

## Status

Boots to splash. Kernel boot from Corduroy is not yet fully validated
against Muslin; treat as experimental until the conformance suite
adopts a ref-corduroy emulator.
