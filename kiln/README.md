# Kiln

**Kiln is the CSS-DOS transpiler.** It takes an 8086 memory image (BIOS
bytes + kernel or .COM + rom-disk) and emits CSS that, when evaluated by
Chrome or Calcite, behaves as a complete 8086 PC running that memory.

This folder used to be `transpiler/src/`. It was renamed in the big tidy
so the proper noun (Kiln) matches the folder. If you want to know *what*
the transpiler is and why it exists, read
[`../docs/architecture.md`](../docs/architecture.md). The notes below
are the implementation guide.

## Layout

```
kiln/
  emit-css.mjs       Top-level emitter. Wires dispatch tables + memory + template.
  decode.mjs         Instruction decode @functions.
  memory.mjs         Zone builders, --readMem emission, write slots.
  template.mjs       Execution engine: clock, double buffer, register aliases.
  css-lib.mjs        Utility @functions (bitwise, shifts, byte extraction).
  cycle-counts.mjs   Per-opcode 8086 cycle counts.
  patterns/
    alu.mjs          ADD/SUB/CMP/AND/OR/XOR/ADC/SBB/TEST/INC/DEC.
    control.mjs      JMP/Jcc/CALL/RET/INT/IRET/LOOP.
    stack.mjs        PUSH/POP/PUSHF/POPF.
    mov.mjs          MOV/XCHG/LEA/LDS/LES.
    misc.mjs         HLT/NOP/string ops/flag manipulation/CBW/CWD/XCHG.
    group.mjs        Group opcode dispatch (80-83, D0-D3, F6-F7, FE-FF).
    shift.mjs        SHL/SHR/SAR/ROL/ROR.
    extended186.mjs  80186+ patterns (PUSH imm, IMUL imm, ENTER/LEAVE, INS/OUTS).
    flags.mjs        Flag-computation @functions shared by ALU.
  AGENT-GUIDE.md     How to add a new instruction.
```

## Entry point

```js
import { emitCSS } from './kiln/emit-css.mjs';

emitCSS({
  programBytes,   // bytes loaded at programOffset (kernel for DOS, .COM for hack)
  biosBytes,      // BIOS ROM bytes, placed at 0xF0000
  memoryZones,    // [[start, end), ...] writable zones
  embeddedData,   // [{ addr, bytes }, ...] extra regions (e.g. IVT seeding)
  diskBytes,      // rom-disk payload, routed through --readDiskByte
  programOffset,  // where programBytes loads
  initialCS,
  initialIP,
  initialRegs,    // override default register values
  header,         // optional cabinet header comment string
}, writeStream);
```

`emitCSS` streams directly to the output — cabinets are too big to build
as a single string.

## The transpilation strategy

Hand-written emitters, not mechanical AST-to-CSS translation. Each
`patterns/*.mjs` file registers opcode entries with a `DispatchTable`.
The central `emit-css.mjs` assembles those entries into a per-register
`if(style(--opcode: N): ...)` dispatch — one for each of
AX/CX/DX/BX/SP/BP/SI/DI/CS/DS/ES/SS/IP/flags/halt/cycleCount.

Memory writes live in 6 parallel slots (`--memAddr0`/`--memVal0` …
`--memAddr5`/`--memVal5`). Each opcode's entry can contribute to up to
6 slots — six is the maximum any instruction uses (INT / TF trap /
hardware IRQ push FLAGS/CS/IP = 3 words = 6 bytes). Slot 0 carries
single-byte stores; 0–1 carry word stores; 2–3 carry CALL FAR's
4-byte pushes; 4–5 carry the 6-byte FLAGS/CS/IP frame.

Slot gating: each slot is fronted by a per-tick `--_slotNLive`
property that is 1 only when the current opcode uses slot N (or a TF
trap / hardware IRQ is pushing the 6-byte frame). The per-byte write
rule nests all six slot checks behind these gates, so non-writing
instructions — NOP, MOV reg,reg, jumps, most ALU reg-reg, flag ops —
short-circuit at slot 0 and evaluate zero `style(--memAddrN: addr)`
branches. Calcite's broadcast-write recogniser
(`crates/calcite-core/src/pattern/broadcast_write.rs`) peels each gate
off and skips the entire address table for gated-off slots; Chrome
gets the same speedup from the normal top-down `if()` short-circuit.

## The execution engine

Inherited from the earliest x86-in-CSS work and refined into the V4
single-cycle architecture. One tick = one instruction. Double-buffered
registers (`--__1X` = previous tick, `--__2X` = next tick). Animation
keyframes store/execute.

See [`../docs/architecture.md`](../docs/architecture.md) and
[`AGENT-GUIDE.md`](AGENT-GUIDE.md).

## Adding an instruction

See [`AGENT-GUIDE.md`](AGENT-GUIDE.md) for the step-by-step.
