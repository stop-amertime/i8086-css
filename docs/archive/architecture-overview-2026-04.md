# CSS-DOS Architecture Overview

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome —
no JavaScript, no WebAssembly. [Calcite](../../calcite) is a JIT compiler
that makes it fast enough to be usable.

## What CSS-DOS is (and isn't)

**CSS-DOS is a DOS/PC emulator, not a bespoke 8086 sandbox.** The machine we
present to programs must look like a real PC-compatible machine, because the
entire point is that unmodified DOS programs can run on it.

We don't write the DOS kernel (it's EDR-DOS). We don't write the 8086 ISA.
These are decades-old standards with extensive public documentation. Search
the web or download a reference before guessing at how something works.

## The cardinal rule

The CSS is a working program that runs in Chrome on its own. It is the source
of truth. Calcite is a JIT compiler for CSS — it must produce the same results
Chrome would, just faster. Calcite has zero x86 knowledge.

- **The CSS must work in Chrome.** If Chrome can't evaluate it, it's wrong.
- **Calcite can't change the CSS.** It can only find faster ways to evaluate
  the same expressions.
- **Never suggest CSS changes to help calcite.** That's backwards.
- **If calcite disagrees with Chrome, calcite is wrong.**

### When Chrome stops being practical

Chrome has limitations — see `architecture/calcite.md` for details on nesting
depth, local variable, and argument restrictions. In practice:

- **Simple instructions** (MOV, ADD, JMP) can be validated in Chrome
- **Complex instructions** may exceed Chrome's limits — validate via Calcite +
  reference emulator comparison
- **The JS reference emulator (`tools/js8086.js`) is the primary source of
  truth** for instruction correctness

## The canonical machine

The memory map, BIOS entry points, BDA layout, IVT, and hardware regions must
match what a real PC looks like:

| Region           | Address         | Purpose                            |
|------------------|-----------------|------------------------------------|
| IVT              | 0x00000-0x003FF | Interrupt vector table             |
| BDA              | 0x00400-0x004FF | BIOS Data Area (video mode, etc.)  |
| Conventional RAM | 0x00500-0x9FFFF | Program + stack + DOS              |
| VGA graphics     | 0xA0000-0xAFFFF | Mode 13h framebuffer (64000 bytes) |
| VGA text         | 0xB8000-0xB8FFF | 80x25 color text (4000 bytes)      |
| BIOS ROM shadow  | 0xF0000-0xFFFFF | CSS-BIOS microcode stubs           |

### Rules

- **No flags that programs can't see.** Transpiler flags must never change
  semantics that a running program could observe.
- **BDA state must be real.** Fields like `video_mode` at 0x0449 must reflect
  actual state.
- **INT 10h handlers must actually do the thing.** Not fake it.
- **The runner trusts the machine.** Display routing reads BDA 0x0449.
- **The raw `.COM` path in `generate-hacky.mjs` is the "hack path"** — simpler
  layout, not trying to be a full DOS machine. The canonical layout applies to
  `generate-dos.mjs`.

### Bake-time memory pruning

Pruning (`--no-gfx`, `--no-text-vga`) removes regions from CSS output. It never
relocates, substitutes, or fakes anything. Default = full canonical layout. Only
prune when you know the program won't touch that region.

## Project layout

```
transpiler/          JS->CSS transpiler (active codebase, v3 microcode model)
  generate-hacky.mjs   Hack path: binary -> CSS, non-canonical layout
  generate-dos.mjs     DOS path: .com/.exe -> CSS via DOS boot
  src/                 Transpiler source modules
  src/patterns/bios.mjs  CSS-BIOS microcode handlers
tools/               Conformance testing
  js8086.js            Vendored reference 8086 emulator (~2700 lines JS)
  lib/bios-handlers.mjs  JS reference BIOS handlers
  ref-emu-dos.mjs      DOS reference emulator runner
  compare.mjs          Tick-by-tick comparison
tests/               Test assembly sources (.asm) and compiled binaries (.com)
dos/                 DOS kernel and system files
  bin/                 kernel.sys, command.com, etc.
bios/                BIOS init stub (real x86 assembly)
  init.asm             IVT setup, BDA init, VGA splash, JMP to kernel
legacy/              Retired code (v1 JSON approach + old Gossamer BIOS)
docs/                Documentation (you are here)
```

See `docs/reference/project-layout.md` for the full file tree.
