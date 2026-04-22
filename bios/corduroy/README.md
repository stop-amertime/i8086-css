# Corduroy BIOS

The **default DOS BIOS**: same IBM-PC-BIOS contract as Muslin, rewritten
in C (with just enough assembly glue for the entry stub and interrupt
handlers that need register-level control). Has a real INT 09h keyboard
handler and sends EOI on INT 08h/09h, so games that rely on BIOS
keyboard IRQ work here (they don't under Muslin).

## When to pick it

Default. `"preset": "dos-corduroy"` (or no preset at all) gives you
Corduroy. Drop to Muslin with `"bios": "muslin"` if a specific cart
misbehaves.

## What it implements

Everything Muslin does, plus a Mode 13h splash screen with the CSS-DOS
logo before it jumps to the kernel. The modular C layout (separate
`bios_init.c` / `handlers.asm` / `splash.c` / `font.c`) is designed to
absorb future work (PIT, PIC, real IRQs) more easily than Muslin's
monolithic assembly.

### Supported video modes (INT 10h AH=00h)

| Mode | Kind | Clear behaviour |
|---|---|---|
| 0x00 | CGA 40×25 mono text (remapped to 0x01) | 4 KB text buffer → spaces + black-on-white |
| 0x01 | CGA 40×25 colour text | 4 KB text buffer → spaces + black-on-white |
| 0x03 | CGA 80×25 colour text (default) | 4 KB text buffer → spaces + black-on-white |
| 0x04 | CGA 320×200×4 graphics | 16 KB CGA aperture → 0 |
| 0x13 | VGA Mode 13h 320×200×256 | 64 KB framebuffer → 0 |

Any other mode byte is silently remapped to 0x03. The raw requested
byte is shadowed to linear `0x04F2` so the JS renderer can surface
"unsupported mode" warnings without the BIOS needing to know about
player-side UI.

CGA mode 0x04 also needs `memory.cgaGfx: true` in the cart manifest so
the builder emits the 16 KB aperture at `0xB8000–0xBC000`. Programs
configure the palette via `OUT 0x3D9, AL` — kiln shadows that byte to
linear `0x04F3` for the renderer to pick up.

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
