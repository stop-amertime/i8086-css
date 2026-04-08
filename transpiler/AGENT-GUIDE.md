# Transpiler Agent Guide

How to add new 8086 instructions to the CSS transpiler.

## Architecture

The transpiler generates CSS that emulates an 8086 CPU. Each clock tick, CSS
evaluates all properties simultaneously. There are no loops or sequential
execution — everything is one big parallel evaluation.

### Dispatch system

Each instruction is an opcode (0x00-0xFF). The `DispatchTable` class in
`emit-css.mjs` collects entries from emitter functions and assembles them into
CSS `if(style(--opcode: N): expr; ...)` chains.

Key methods:
- `dispatch.addEntry(reg, opcode, expr, comment)` — register `reg` gets value
  `expr` when the current opcode matches. **One entry per (reg, opcode) pair** —
  duplicates throw an error.
- `dispatch.addMemWrite(opcode, addrExpr, valExpr, comment)` — queue a memory
  write. Each opcode can use up to 6 write slots (for INT which pushes 3 words).

### Register names

16-bit: `AX, CX, DX, BX, SP, BP, SI, DI, CS, DS, ES, SS, IP, flags, halt`

8-bit aliases (computed properties, read-only in dispatch):
`AL, CL, DL, BL, AH, CH, DH, BH` — accessed as `var(--AL)` etc.

To write an 8-bit register, you must write the full 16-bit parent using merge helpers:
- `--mergelow(parent16, newLow8)` — replaces low byte
- `--mergehigh(parent16, newHigh8)` — replaces high byte

### Reading values

Pre-computed decode properties (available in dispatch expressions):
- `var(--rmVal8)`, `var(--rmVal16)` — the r/m operand (register or memory)
- `var(--regVal8)`, `var(--regVal16)` — the reg-field operand
- `var(--ea)` — effective address (linear) for memory operands
- `var(--eaOff)` — effective address offset only (no segment)
- `var(--mod)`, `var(--reg)`, `var(--rm)` — ModR/M fields
- `var(--modrmExtra)` — extra bytes consumed by ModR/M addressing
- `var(--immByte)`, `var(--immWord)` — immediate after ModR/M+disp
- `var(--q0)`..`var(--q5)` — raw instruction bytes from CS:IP
- `var(--__1REG)` — previous tick's register value (double-buffered)
- `var(--_cf)` — carry flag bit (0 or 1)
- `var(--_zf)` — zero flag bit (0 or 1)
- `var(--AL)`, `var(--AH)`, etc. — 8-bit register aliases
- `var(--CL)` — CL register value (low byte of CX)

### CSS utility functions

- `--lowerBytes(val, bits)` — mod(val, pow(2, bits)) — truncate to N bits
- `--rightShift(val, bits)` — floor(val / pow(2, bits))
- `--bit(val, idx)` — extract single bit (0 or 1)
- `--u2s1(val)` — unsigned byte to signed (-128..127)
- `--u2s2(val)` — unsigned word to signed (-32768..32767)
- `--readMem(addr)` — read byte from memory
- `--read2(addr)` — read 16-bit word (little-endian)
- `--and(a, b)`, `--or(a, b)`, `--xor(a, b)` — bitwise (16-bit)
- `--and8(a, b)`, `--or8(a, b)`, `--xor8(a, b)` — bitwise (8-bit)
- `--not(val)` — bitwise NOT (16-bit, result = 65535 - val)
- `--parity(val)` — parity flag lookup

### Flag functions

- `--addFlags16(dst, src)`, `--addFlags8(dst, src)` — flags for ADD
- `--subFlags16(dst, src)`, `--subFlags8(dst, src)` — flags for SUB/CMP
- `--adcFlags16(dst, src, cf)`, `--sbbFlags16(dst, src, cf)` — with carry
- `--andFlags16(a, b)`, `--orFlags16(a, b)`, `--xorFlags16(a, b)` — logic flags
- `--incFlags16(dst, res, oldFlags)` — INC (preserves CF)
- `--decFlags16(dst, res, oldFlags)` — DEC (preserves CF)
- 8-bit variants of all the above

### IP advancement

Every instruction must add an IP entry:
- 1-byte instructions: `calc(var(--__1IP) + 1)`
- 2-byte with ModR/M: `calc(var(--__1IP) + 2 + var(--modrmExtra))`
- 3-byte (opcode + imm16): `calc(var(--__1IP) + 3)`
- With ModR/M + immediate: add the immediate size to the ModR/M length

### Memory writes

For byte writes: one `addMemWrite` call with address and value.
For word writes: two `addMemWrite` calls — lo byte at addr, hi byte at addr+1.
Address `-1` means "no write" (disabled slot).

### Pattern for 8-bit register destinations

8-bit registers map to 16-bit parents:
- rm 0-3 = AL,CL,DL,BL (low bytes of AX,CX,DX,BX)
- rm 4-7 = AH,CH,DH,BH (high bytes of AX,CX,DX,BX)

Use SPLIT_REGS pattern:
```js
const SPLIT_REGS = [
  { reg: 'AX', lowIdx: 0, highIdx: 4 },
  { reg: 'CX', lowIdx: 1, highIdx: 5 },
  { reg: 'DX', lowIdx: 2, highIdx: 6 },
  { reg: 'BX', lowIdx: 3, highIdx: 7 },
];
```

### Wiring up

After writing your emitter function, you must:
1. Export it from the pattern file
2. Call it from the `emitAll*` function in the same file (or add it to emit-css.mjs imports and calls)

### Testing

After making changes, run:
```
node transpiler/generate.mjs examples/fib.com -o tests/fib-pure.css
```
If it generates without errors, the dispatch table has no conflicts.

## Examples

See existing pattern files for reference:
- `patterns/misc.mjs` — simple 1-byte instructions (LAHF, SAHF, NOP, etc.)
- `patterns/control.mjs` — jumps, calls, returns
- `patterns/stack.mjs` — PUSH/POP
- `patterns/group.mjs` — group opcodes with reg-field sub-dispatch
- `patterns/mov.mjs` — MOV variants, LEA, LES/LDS
