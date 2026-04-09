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
- `gossamer.asm` / `gossamer.bin` — Gossamer BIOS (still active, used by both approaches)
- `examples/` — test programs (fib.asm, etc.)

## Project layout

```
transpiler/          NEW: JS→CSS transpiler (not yet built — start here)
  README.md          Architecture doc explaining what to build and how
tools/               Conformance testing
  js8086.js          Vendored reference 8086 emulator (~2700 lines JS)
  ref-emu.mjs        Runs reference emulator, outputs register trace
  compare.mjs        Tick-by-tick comparison against calcite output
gossamer.asm         Gossamer BIOS: INT 10h, 16h, 1Ah, 20h, 21h handlers
gossamer.bin         Compiled BIOS binary (loaded at F000:0000)
gossamer.lst         NASM listing for gossamer.asm
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
#    gossamer.bin is auto-loaded from the project root. Do NOT pass gossamer.bin as an arg.
node transpiler/generate.mjs tests/prog.com --mem 1536 -o tests/prog.css

# 3. Run conformance comparison — takes THREE positional args: .com, gossamer.bin, .css
node tools/compare.mjs tests/prog.com gossamer.bin tests/prog.css --ticks=500
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

To rebuild after editing gossamer.asm:
```sh
nasm -f bin -o gossamer.bin gossamer.asm -l gossamer.lst
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
