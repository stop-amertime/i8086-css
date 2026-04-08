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
- `transpiler/` — the new approach (**not yet started**, this is the next work item)
- `tools/` — conformance testing infrastructure (reference emulator + comparison tools)
- `bios.asm` / `bios.bin` — minimal BIOS/DOS stub (still active, used by both approaches)
- `examples/` — test programs (fib.asm, etc.)

## Project layout

```
transpiler/          NEW: JS→CSS transpiler (not yet built — start here)
  README.md          Architecture doc explaining what to build and how
tools/               Conformance testing
  js8086.js          Vendored reference 8086 emulator (~2700 lines JS)
  ref-emu.mjs        Runs reference emulator, outputs register trace
  compare.mjs        Tick-by-tick comparison against calcite output
bios.asm             Minimal BIOS: INT 10h, 16h, 1Ah, 20h, 21h handlers
bios.bin             Compiled BIOS binary (loaded at F000:0000)
bios.lst             NASM listing for bios.asm
examples/            Test binaries
  fib.asm / fib.com  Fibonacci (simplest test case)
tests/               Test output artifacts
legacy/              OLD approach — see legacy/README.md
  build_css.py       Old transpiler (binary → CSS via JSON database)
  base_template.css  CSS skeleton with @function definitions (USEFUL REFERENCE)
  base_template.html HTML wrapper with visualization
  build_c.py         C → 8086 binary via gcc-ia16
  x86-instructions-rebane.json  Instruction metadata database
  extra/             Instruction table generator tools
  web/               Browser-based transpiler (TypeScript/Vite)
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
# 1. Generate CSS (once transpiler exists)
python transpiler/generate.py program.bin -o program.css

# 2. Generate reference trace
node tools/ref-emu.mjs program.bin > ref-trace.json

# 3. Run through calcite
cargo run -p calcite-cli -- program.css --trace-json > calcite-trace.json

# 4. Compare
node tools/compare.mjs program.css ref-trace.json
```

The conformance tools find the first tick where registers diverge, which is
how you debug instruction implementation bugs.

## BIOS

`bios.asm` is a minimal BIOS stub compiled with NASM. It provides:

| Interrupt | Function |
|-----------|----------|
| INT 10h | Video services (teletype output, cursor, scroll) |
| INT 16h | Keyboard input |
| INT 1Ah | Timer tick |
| INT 20h | Program exit (sets halt flag) |
| INT 21h | DOS services (AH=02h print char, AH=09h print string, AH=30h version, AH=4Ch exit) |

The BIOS is loaded at segment F000:0000 and the IVT (interrupt vector table)
at addresses 0x0000-0x03FF is pre-populated to point to these handlers.

To rebuild after editing bios.asm:
```sh
nasm -f bin -o bios.bin bios.asm -l bios.lst
```

## Relationship to calcite

Calcite is a sibling repo at `../calcite`. This repo produces CSS; calcite
runs it fast. There is no code dependency between them — calcite reads whatever
CSS file it's given and evaluates it. The only shared interface is the CSS format.

Calcite has pattern recognition for dispatch tables, broadcast writes, and
bitwise operations. The transpiler should emit CSS that naturally falls into
these patterns (e.g., `if(style(--opcode: N))` chains become dispatch tables).

## Relationship to the original x86css

This project was forked from [rebane2001/x86css](https://github.com/rebane2001/x86css).
The original implemented a subset of 8086 in CSS as a proof of concept. We extended
it to full ISA coverage, then pivoted to the transpiler approach for correctness.
