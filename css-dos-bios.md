# css-dos-bios

**Status: design concept, not yet started.**

A BIOS for CSS-DOS that eliminates hand-written 8086 assembly by implementing
services as JS functions dispatched through a reserved callback opcode. The
handlers are transpiled to CSS by the same pipeline that transpiles the CPU
core. Replaces gossamer.asm / gossamer-dos.asm. Consistent with the
transpiler-first policy described in `CLAUDE-pending-edits.md`.

## Why gossamer has to go

Gossamer is NASM assembly, assembled to a flat binary, loaded at F000:0000,
executed by the CPU as regular 8086 machine code. It is the buggiest part of
the project for three compounding reasons:

1. **Hand-written assembly.** Maximum foot-gun per line. No unit test harness,
   no type checking, every handler is a mini state machine held in your head.
2. **Written around transpiler gaps.** gossamer-dos.asm's top comment reads:
   "CONSTRAINTS (CSS transpiler limitations): No 0x0F-prefixed opcodes,
   segment override prefixes may not work in all contexts, all memory access
   via DS where possible." Contorted code paths are bug farms, and the
   workarounds themselves are a violation of the transpiler-first policy —
   the fix belongs in the transpiler, not in code written around it.
3. **BIOS bugs look like CPU bugs.** If `int 10h` teletype prints garbage,
   three layers might be at fault: the BIOS handler's logic, the CPU's
   implementation of the handler's instructions, or the conformance
   comparison. Three layers of maybe-wrong per bug.

None of this is fixable by polishing the assembly. The category is wrong.

## Core idea

The BIOS region at F000:xxxx contains **trap stubs**, not executable handlers.
Each BIOS service's entry point is a tiny byte sequence: a reserved "callback"
opcode, a 1-byte callback ID, and an IRET. When the CPU fetches the callback
opcode, it dispatches to a matching JS handler instead of executing a normal
instruction. The handler reads and writes CPU state directly (AX, BX, memory,
flags), returns, and the CPU proceeds to the IRET, which unwinds the interrupt
stack frame normally.

The BIOS handlers are JS functions written as pure transformations of CPU
state. They are transpiled to CSS by the same pipeline that transpiles
js8086's CPU core. The generated CSS contains a dispatch table for the
callback opcode, structurally identical to the dispatch tables for MOV, ADD,
or any other instruction.

This does not violate the project's rules. The callback opcode is *part of
the CPU specification* — we are defining a CPU that has one extra opcode, in
an encoding unused by real software, that performs native dispatch. The BIOS
is a regular user of that opcode.

## The callback opcode

Reserve a single 8086 opcode encoding for native dispatch. Candidates:

- 0xF1 (undocumented on real 8086; no software emits it)
- 0x0F 0xFF (invalid 80286+ encoding, never emitted by compilers)
- An encoding outside the real ISA, recognised only by our CPU

The exact choice is a detail. The important property is that no real software
emits it, so no conformance test or legal program can collide.

When the CPU decodes this opcode, the byte at IP+1 is the callback ID (0-255),
and the dispatch flow is:

1. Read callback ID from the instruction stream.
2. Look up the JS handler for that ID in a static registry.
3. Invoke the handler with the current CPU state and memory.
4. Handler writes updated registers / queues memory writes / sets flags
   through the same mechanisms any opcode dispatch case uses.
5. IP advances past opcode + ID.

## Handler registry

Handlers are JS functions with a uniform signature, something like:

```
cbios.register(0x00, function int10h_ah0E(cpu, mem) { /* teletype */ });
cbios.register(0x01, function int10h_ah09(cpu, mem) { /* write char/attr */ });
cbios.register(0x10, function int13h_ah02(cpu, mem) { /* disk read */ });
```

The registry is a flat table indexed by callback ID. At transpile time, the
transpiler reads the registry and emits one dispatch case per handler inside
the callback opcode's dispatch table. The result is a two-level switch
(opcode → callback, then callback ID → handler body), which the JIT recognises
as a nested dispatch, the same shape as group-opcode sub-dispatches like 0x80
/ 0xD0 / 0xF6 / 0xFE.

Callback IDs are a flat namespace. There is no structural distinction between
"INT 10h AH=0Eh" and "INT 13h AH=02h" at the ID level — each distinct service
is one ID. The mapping from (INT number, AH value) to callback ID is
established by the ROM layout.

## ROM layout

The F000 segment is still a real, readable memory region populated at
generation time. Its contents:

1. **Signature and fingerprint region.** `55 AA` extension signatures,
   version strings, copyright text, date stamps, a plausible power-on self
   test fingerprint. Data bytes only, never executed, exists so DOS kernels
   and programs that probe the BIOS ROM find what they expect.
2. **Trap stub region.** One stub per registered handler. Each stub is three
   bytes: `<callback opcode> <callback ID> CF` (CF is IRET). The transpiler
   lays these out contiguously and records their offsets. The IVT is built
   so that each INT vector / AH-dispatch path resolves to the correct stub
   offset.
3. **INT number dispatcher stubs.** INTs with multiple AH subfunctions need a
   small dispatch-by-AH layer before the trap, because the IVT is one entry
   per INT number. Two options: (a) the IVT entry points at a short assembly
   stub that compares AH and jumps to the right trap; or (b) the IVT entry
   points at a single trap whose handler branches on AH in JS. Option (b) is
   cleaner and avoids residual hand-written assembly — the AH branch lives in
   JS, transpiled like everything else.
4. **Boot stub.** A small amount of real assembly (~50 lines) that runs once
   at CPU reset. Its job: set up IVT entries pointing at the trap stubs,
   initialise the BDA at 0040:xxxx, load the DOS kernel from the disk image,
   jump to it. This is the only hand-written assembly that remains. It runs
   exactly once before control hands off to the OS, and its instructions are
   standard and idiomatic — no transpiler workarounds.

## What gets transpiled

- js8086's CPU core (already done)
- The callback opcode dispatch case (new, small)
- The handler registry as a dispatch table on callback ID
- Individual handler JS function bodies, emitted as CSS expressions per ID
- The ROM image itself (signatures, trap stubs, boot stub bytes) baked as
  initial memory values

Everything above is transpiled by the existing pipeline. No hand-written CSS.
Handler authors write JS, run generate-dos.mjs, get CSS.

## Conformance

Unchanged model. The callback opcode is implemented in js8086 the same way
any opcode is. The handler registry runs in ref-emu-dos.mjs with the same JS
functions the transpiler emits into CSS. The tick-by-tick comparison via
tools/compare-dos.mjs catches any divergence — bugs are in either the handler
JS or its transpilation, both fixable in one place.

Handler unit tests become trivial. Each handler is a JS function that takes
CPU-state fixtures and produces new state. Test without running the emulator
at all: construct an input state, call the handler, assert on the output.
This is impossible with gossamer's assembly.

## Migration from gossamer

Not a big-bang rewrite. Incremental, handler at a time:

1. **Add the callback opcode to js8086 and the transpiler.** Empty handler
   registry. Ship and verify the existing gossamer-based conformance path
   does not regress.
2. **Port one handler.** INT 10h AH=0Eh (teletype) is the simplest and most
   exercised. Replace its case in gossamer with a trap stub, add the JS
   handler, diff ref-emu + Calcite traces before and after.
3. **Port subsequent handlers one at a time.** Each is a small, reviewable
   diff. gossamer's assembly shrinks handler by handler. The conformance
   oracle is exact at every intermediate step.
4. **Retire gossamer.** Rename gossamer-dos.asm to `boot-stub.asm` (or
   similar), shrink to only the boot sequence, and the migration is done.

At any intermediate state, some INTs go through trap dispatch and some still
execute assembly. Both work. The mix is seamless because trap dispatch and
normal execution are both just CPU dispatch cases.

## Caveats

- **Software that reads BIOS ROM bytes.** Some DOS kernels and programs probe
  F000 for signatures, version strings, or patch points. Handled by keeping
  the ROM populated with plausible data in the signature region — the trap
  stubs coexist with it, they do not replace it.
- **Software that CALLs FAR into internal BIOS code addresses.** Rare but
  not unheard of. Programs that expect to jump into the middle of a BIOS
  handler (not via INT) will land on a trap stub or undefined bytes and
  fail. For the programs CSS-DOS targets (SvarDOS, Rogue, Doom8088) this
  does not happen.
- **Single-step debugging across an INT.** If a future debugger single-steps
  (TF=1) through an INT, it will see the callback opcode, then the IRET, and
  nothing in between. The handler is invisible to 8086-level debugging
  because it is not made of 8086 instructions. Matters only for
  development-time use of an in-emulator debugger; does not affect
  correctness or conformance.
- **Residual hand-written assembly.** The boot stub still exists. ~50 lines,
  runs once, doesn't grow, idiomatic. Acceptable residue.
- **Performance as a side effect, not a goal.** Each BIOS call becomes one
  CSS tick instead of dozens. Not the reason to do this — the reason is
  correctness and maintainability — but it happens.
