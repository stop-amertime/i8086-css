# CSS-DOS (formerly i8086-css)

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome —
no JavaScript, no WebAssembly. [Calcite](../calcite) is a JIT compiler that
makes it fast enough to be usable.

IMPORTANT: WHEN DEBUGGING, DO NOT RUSH TO CONCLUSIONS. Take a measured approach, gather information, and don't apply speculative fixes. Your biggest failure mode in debugging is jumping to conclusions and making assumptions. Prefer to create good debugging infrastructure so you can inspect what is happening clearly, rather than chasing individual bugs around. 

## Current status

**Architecture pivot in progress.** We are replacing the v1 JSON instruction
database approach with a JS→CSS transpiler. See GitHub issue #49 for the full
plan.

- `legacy/` — the old approach (preserved for reference, not actively developed)
- `transpiler/` — the new approach
- `tools/` — conformance testing infrastructure (reference emulator + comparison tools)
- `bios/` — Gossamer BIOS source (gossamer.asm, gossamer-dos.asm)
- `build/` — compiled BIOS binaries and listings (generated from bios/)
- `tests/` — test assembly sources (.asm) and compiled binaries (.com)

## Project layout

```
transpiler/          JS→CSS transpiler
  README.md          Architecture doc
  generate-hacky.mjs Generate CSS from a .COM binary (hack path, non-canonical layout)
  generate-dos.mjs   Generate CSS via DOS boot (full DOS mode)
  src/               Transpiler source modules
bios/                Gossamer BIOS source
  gossamer.asm       Simple BIOS: INT 10h, 16h, 1Ah, 20h, 21h
  gossamer-dos.asm   DOS boot BIOS: disk I/O, kernel loading
build/               Compiled BIOS outputs (gitignored except .bin)
  gossamer.bin       Compiled simple BIOS (loaded at F000:0000)
  gossamer-dos.bin   Compiled DOS BIOS
  gossamer.lst       NASM listing
  gossamer-dos.lst   NASM listing
tools/               Conformance testing
  js8086.js          Vendored reference 8086 emulator (~2700 lines JS)
  ref-emu.mjs        Runs reference emulator, outputs register trace
  compare.mjs        Tick-by-tick comparison against calcite output
tests/               Test assembly sources and binaries
dos/                 DOS kernel and system files
  bin/               kernel.sys, command.com, etc.
legacy/              OLD approach — see legacy/README.md
  base_template.css  CSS skeleton with @function definitions (USEFUL REFERENCE)
  base_template.html HTML wrapper with visualization
```

## The cardinal rule

The CSS is a working program that runs in Chrome on its own. It is the source
of truth. Calcite is a JIT compiler for CSS — it must produce the same results
Chrome would, just faster. Calcite has zero x86 knowledge.

This means:
- **The CSS must work in Chrome.** If Chrome can't evaluate it, it's wrong.
- **Calcite can't change the CSS.** It can only find faster ways to evaluate
  the same expressions.
- **Never suggest CSS changes to help calcite.** That's backwards.
- **If calcite disagrees with Chrome, calcite is wrong.**

### When Chrome stops being a practical source of truth

Chrome has limitations that make it impractical as the sole test oracle at
scale:

- **Speed:** Chrome evaluates ~200 ticks in ~78 seconds. Calcite does 3500
  ticks in ~0.15 seconds (~500x faster). Testing programs that need thousands
  of ticks is only feasible through Calcite.
- **@function nesting depth:** Chrome silently fails when `@function` calls
  are nested too deeply (e.g., a function whose body calls `--xor` which
  decomposes into 33 local variables). There is no error — the property
  just evaluates to the initial value. This was hit with OF flag helpers
  that called `--xor` internally.
- **@function local variable limit:** Chrome silently fails with >7 local
  variables in a single `@function`. Again, no error, just wrong values.
- **Argument restrictions:** Chrome `@function` arguments cannot themselves
  be `@function` calls (e.g., `--foo(--bar(x))` fails). Native CSS math
  functions like `calc()`, `mod()`, `min()`, `max()`, `round()`, `pow()`
  are fine as arguments since they are part of the CSS math grammar.

In practice, this means:
- **Simple instructions** (MOV, ADD, JMP, etc.) can be validated in Chrome.
- **Complex instructions** (IMUL with signed conversion, multi-step flag
  computations) may exceed Chrome's nesting/complexity limits and can only
  be validated through Calcite + reference emulator comparison.
- **The reference JS emulator (`tools/js8086.js`) becomes the primary source
  of truth** for instruction correctness, with Calcite as the execution
  engine. Chrome remains the source of truth for CSS *semantics* (how
  `calc()`, `mod()`, `if()`, `@function` etc. should behave) but not for
  whether a particular deeply-nested expression actually evaluates in
  Chrome's implementation.

## What CSS-DOS is (and isn't)

**CSS-DOS is a DOS/PC emulator, not a bespoke 8086 sandbox.** The machine we
present to programs must look like a real PC-compatible machine, because the
entire point is that unmodified DOS programs can run on it. If we take
shortcuts that diverge from real hardware, we build a thing that only runs
*our* programs — which is not the goal.

### The canonical machine

The memory map, BIOS entry points, BDA layout, IVT, and hardware regions must
match what a real PC looks like. Programs assume this layout and we do not
get to move things around for convenience:

| Region           | Address         | Purpose                            |
|------------------|-----------------|------------------------------------|
| IVT              | 0x00000–0x003FF | Interrupt vector table             |
| BDA              | 0x00400–0x004FF | BIOS Data Area (video mode, etc.)  |
| Conventional RAM | 0x00500–0x9FFFF | Program + stack + DOS              |
| VGA graphics     | 0xA0000–0xAFFFF | Mode 13h framebuffer (64000 bytes) |
| VGA text         | 0xB8000–0xB8FFF | 80x25 color text (4000 bytes)      |
| BIOS ROM shadow  | 0xF0000–0xFFFFF | Gossamer BIOS code                 |

### Rules that follow from this

- **No flags that programs can't see.** A program that does `MOV AX, 0x13; INT 10h`
  expects Mode 13h regardless of how the CSS was baked. Transpiler flags must
  never change semantics that a running program could observe.
- **BDA state must be real.** Fields like `video_mode` at 0x0449 must reflect
  actual state. Never hardcode values in INT 10h handlers and hope.
- **INT 10h handlers must actually do the thing.** `AH=00h` writes mode to BDA
  and clears the framebuffer. `AH=0Fh` reads BDA. `AH=1Ah` reports the real
  display adapter. A program that calls these and gets lies breaks in ways
  that are nearly impossible to debug.
- **The runner trusts the machine.** When deciding whether to show text or
  graphics output, the runner reads BDA 0x0449 — it does not guess from CSS
  content or UI toggles. That's what a real monitor does.
- **The raw `.COM` path in `generate-hacky.mjs` is the "hack path".** It explicitly
  does not try to be a DOS machine and is fine to have a simpler layout.
  Everything above applies to `generate-dos.mjs` (the DOS boot path).

### Bake-time memory pruning

Because CSS can't load files at runtime — all memory is serialized as CSS
properties up front — *unused* memory regions cost real bytes in the output
file. This gives us one legitimate form of optimization: **prune-only flags**
that omit regions we know the program can't touch.

The rules:

- **Default = full canonical layout.** `generate-dos.mjs` with no flags emits
  every region above. A program that never touches 0xA0000 still has it; the
  region is just zeros and costs ~1 MB in the CSS. This is the correct default
  because *we don't know* what a program will touch.
- **Pruning is opt-in and prune-only.** Flags like `--no-gfx` or `--no-text-vga`
  *remove* regions from the output. They never relocate, substitute, or fake
  anything. A pruned CSS file is a strict subset of the canonical CSS file.
- **Pruning is an author's promise.** If you pass `--no-gfx`, you are asserting
  this program does not write to 0xA0000. If it does, it silently writes into
  nothing and the failure mode is weird. Only prune when you know.
- **Pruning does not change BIOS behavior.** INT 10h still tracks mode in BDA
  even if the framebuffer region is pruned — because we might still care about
  the mode byte for display routing. Handlers never branch on "is this region
  present".

## The two approaches

### v1: JSON instruction database (legacy/)

A JSON database of all 8086 instructions drove code generation. Each instruction
was decomposed into ~10 parallel dispatch tables that each returned one aspect of
the instruction's behavior. The tables were reassembled via cross-property
references. **Problem:** when tables disagreed, subtle bugs appeared that were
extremely hard to trace.

### v2: JS→CSS transpiler (transpiler/) — THE ACTIVE APPROACH

Transliterate the reference emulator's decode/execute switch directly into CSS.
One dispatch on opcode, each branch computes everything inline. Fewer intermediate
properties, fewer bugs.

The reference emulator is `tools/js8086.js` (~2700 lines, clean ~200-case switch).
The transpiler reads its structure and emits equivalent CSS. Not a general JS→CSS
compiler — just handles the specific patterns in this emulator.

**Key challenge:** CSS evaluates all properties simultaneously. Sequential JS
(read → compute → write → flags) must be flattened into parallel expressions
that produce the same result in one evaluation pass.

Read `transpiler/README.md` for detailed architecture and implementation plan.

## Conformance testing workflow

```sh
# 1. Assemble test program (if .asm)
C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe -f bin -o tests/prog.com tests/prog.asm

# 2. Generate CSS — NOTE: only ONE positional arg (the .com file).
#    gossamer.bin is auto-loaded from build/. Do NOT pass gossamer.bin as an arg.
node transpiler/generate-hacky.mjs tests/prog.com --mem 1536 -o tests/prog.css

# 3. Run conformance comparison — takes THREE positional args: .com, gossamer.bin, .css
node tools/compare.mjs tests/prog.com build/gossamer.bin tests/prog.css --ticks=500
```

The compare tool runs both the reference JS emulator and calcite, then finds the
first tick where registers diverge. It handles REP-prefixed instructions
(which take 1 tick in the reference but N ticks in CSS) via IP-aligned comparison.

## Gossamer BIOS

`gossamer.asm` is the Gossamer BIOS, compiled with NASM. It provides:

| Interrupt | Function |
|-----------|----------|
| INT 10h | Video services (teletype output, cursor, scroll) |
| INT 16h | Keyboard input |
| INT 1Ah | Timer tick |
| INT 20h | Program exit (sets halt flag) |
| INT 21h | DOS services (AH=02h print char, AH=09h print string, AH=30h version, AH=4Ch exit) |

The BIOS is loaded at segment F000:0000 and the IVT (interrupt vector table)
at addresses 0x0000-0x03FF is pre-populated to point to these handlers.

To rebuild after editing:
```sh
nasm -f bin -o build/gossamer.bin bios/gossamer.asm -l build/gossamer.lst
nasm -f bin -o build/gossamer-dos.bin bios/gossamer-dos.asm -l build/gossamer-dos.lst
```

## Relationship to calcite

Calcite is a sibling repo at `../calcite`. This repo produces CSS; calcite
runs it fast. There is no code dependency between them — calcite reads whatever
CSS file it's given and evaluates it. The only shared interface is the CSS format.

Calcite has pattern recognition for dispatch tables, broadcast writes, and
bitwise operations. The transpiler should emit CSS that naturally falls into
these patterns (e.g., `if(style(--opcode: N))` chains become dispatch tables).

## Tools

**NASM** (assembler): installed at `C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe`.
Not in PATH — use the full path or set a variable. Used to assemble `.asm` files
(BIOS, test programs) into flat binaries.

**Playwright MCP**: available for browser automation if you need to run the
generated HTML/CSS in Chrome and extract register state. Prefer other approaches
(Calcite traces, reference emulator comparison) when possible — Playwright is
slow and should be a last resort for debugging CSS execution issues.

## Relationship to the original x86css

This project was forked from [rebane2001/x86css](https://github.com/rebane2001/x86css).
The original implemented a subset of 8086 in CSS as a proof of concept. We extended
it to full ISA coverage, then pivoted to the transpiler approach for correctness.
