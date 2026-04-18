# Architecture History

## v1: JSON instruction database (legacy/)

A JSON database of all 8086 instructions drove code generation. Each instruction
was decomposed into ~10 parallel dispatch tables. **Retired** — subtle bugs
from table disagreements. See `legacy/README.md`.

## v2: JS->CSS transpiler (transpiler/)

Transliterate the reference emulator's decode/execute switch directly into CSS.
One dispatch on opcode, each branch computes everything inline. 6 parallel
memory write slots per tick.

## v3: Cycle-accurate microcode model (current)

A partial rewrite of v2. Key changes:
- **One memory write per cycle** (was 6 parallel slots)
- **uOp register** for multi-cycle instructions
- **BIOS handlers as microcode** (was precompiled assembly)
- **Cycle counter** for PIT timer derivation
- **~6x smaller** memory write block in generated CSS

See `V3-PLAN-1.md` for the full specification and `architecture/v3-execution-model.md`
for a quick summary.

## Origin

Forked from [rebane2001/x86css](https://github.com/rebane2001/x86css). The
original implemented a subset of 8086 in CSS as a proof of concept. We extended
it to full ISA coverage, then pivoted to the transpiler approach for correctness.
