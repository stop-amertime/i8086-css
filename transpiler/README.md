# JS-to-CSS Transpiler

**Status: architecture finalized, implementation not yet started.**

This transpiler converts the reference 8086 emulator (`tools/js8086.js`) into
equivalent CSS that runs as a complete 8086 CPU in Chrome.

## Architecture decisions

These decisions were made through systematic analysis of the JS emulator, the
legacy CSS approach, and Calcite's optimization requirements. Each decision
optimizes for two criteria: (1) does it actually work, and (2) is it fast when
JIT compiled. CSS aesthetics and output size are not criteria.

### 1. Language: Node.js

The reference emulator and conformance tools are JS. The transpiler is JS.
One runtime, shared utilities, no context-switching.

### 2. Transpilation strategy: hybrid (catalog parser + hand-written emitters)

The transpiler parses `js8086.js` to extract the complete opcode catalog --
every switch case, every group sub-opcode. This is a safety net: it tells us
when we haven't handled an opcode. But the actual CSS generation is done by
hand-written emitter functions, one per opcode pattern family.

The parser gives us completeness. The emitters give us correctness. No
mechanical AST-to-CSS transform -- every CSS expression is written by someone
who understands both the JS semantics and the CSS execution model.

### 3. CSS function granularity: one @function per opcode

The generator emits one CSS `@function` per opcode (not per opcode group or
per family). Opcode 0x00 becomes `--op_00`, opcode 0x89 becomes `--op_89`.

This makes the generated CSS a literal, inspectable transliteration of the JS
emulator. You can put the JS case for 0x02 and the CSS function `--op_02` side
by side and verify by inspection.

The DRY happens in the generator source (JS helper functions like
`emitALU_RegRM(opcode, dir, width, aluOp)`), not in the generated CSS output.

### 4. Write-back model: per-register dispatches + memory write slots

**Registers:** Each of the 14 CPU registers (AX, BX, CX, DX, SP, BP, SI, DI,
CS, DS, ES, SS, IP, FLAGS) has its own dispatch table keyed on `--opcode`:

```css
--nextAX: if(
  style(--opcode: 0x04): calc(...);   /* ADD AL, imm8 */
  style(--opcode: 0x05): calc(...);   /* ADD AX, imm16 */
  ...
  else: var(--__1AX)                  /* unchanged */
);
```

An opcode only appears in the dispatch tables for registers it actually writes.
Most registers' dispatches contain entries for only the ~10-50 opcodes that
touch them. The `else` branch preserves the previous value.

This is the most JIT-friendly model: for a given opcode, the JIT can see at
compile time exactly which registers change. Unchanged registers resolve to
identity (`var(--__1AX)`) which the JIT can eliminate entirely.

**8-bit register writes:** When an instruction writes AL (not all of AX), the
AX dispatch entry merges the new low byte with the existing high byte:

```css
style(--opcode: 0xB0): --mergelow(var(--__1AX), var(--imm8));
```

A CSS `@function --mergelow` handles this, documented below for Calcite.

**Memory:** 3 memory write slots (`--memAddr0`/`--memVal0` through
`--memAddr2`/`--memVal2`). Most instructions use 0 or 1. The worst case is INT
which pushes 3 words (FLAGS, CS, IP). Each memory byte's update rule checks
all 3 slots:

```css
--m42: if(
  style(--memAddr0: 42): var(--memVal0);
  style(--memAddr1: 42): var(--memVal1);
  style(--memAddr2: 42): var(--memVal2);
  else: var(--__1m42)
);
```

**Why not the legacy's slot+side-channel model?** The legacy used 3 generic
dest slots (address code + value) plus 5 side channels (moveStack, moveSI,
moveDI, jumpCS, addrJump). Each register had bespoke update logic mixing slot
checks with side-channel fallbacks. Per-register dispatches are simpler: each
register's update is a pure function of opcode + previous state. No indirection
through address codes, no interaction between routing mechanisms.

### 5. Instruction fetch and decode

Direct dispatch on the raw opcode byte:

```css
--opcode: --readMem(var(--__1IP));
```

No translation layer. No instruction ID remapping.

For group opcodes (0x80-0x83, 0xD0-0xD3, 0xF6-0xF7, 0xFE-0xFF) where the
`reg` field of the ModR/M byte selects the actual operation, we use nested
dispatch:

```css
/* Outer: dispatch on opcode */
--nextAX: if(
  style(--opcode: 0x80): --group1_AX(var(--reg), ...);
  ...
);

/* Inner: dispatch on reg within the group */
@function --group1_AX(--reg, ...) {
  result: if(
    style(--reg: 0): calc(...);   /* ADD */
    style(--reg: 5): calc(...);   /* SUB */
    ...
  );
}
```

Two levels, each a clean single-key dispatch table. This is the structure
easiest for a JIT to recognize: it's a switch within a switch, not a
multi-variable predicate.

### 6. Flag computation: shared @function helpers

~5 `@function` helpers cover the entire ISA's flag behavior:

| Helper | Used by | Flags set |
|--------|---------|-----------|
| `--addFlags(w, dst, src, res)` | ADD, ADC, INC | CF, PF, AF, ZF, SF, OF |
| `--subFlags(w, dst, src, res)` | SUB, SBB, CMP, DEC, NEG | CF, PF, AF, ZF, SF, OF |
| `--logicFlags(w, res)` | AND, OR, XOR, TEST | CF=0, OF=0, PF, ZF, SF |
| `--shiftFlags(w, res, lastBit)` | SHL, SHR, SAR | CF, PF, ZF, SF, OF |
| `--incFlags(w, dst, res, oldFlags)` | INC, DEC | PF, AF, ZF, SF, OF (CF preserved) |

Each opcode's `--nextFlags` dispatch entry calls the appropriate helper.

**Note for Calcite:** These flag helpers are called on nearly every tick. They
are pure functions of their inputs with no side effects. Calcite should inline
them at every call site. The function boundary exists for correctness (single
source of truth for flag logic), not for runtime abstraction.

### 7. Memory model

Each byte of memory is a CSS custom property (`--m0` through `--mN`). Reading
is a flat dispatch on address:

```css
@function --readMem(--at <integer>) returns <integer> {
  result: if(
    style(--at: 0): var(--m0);
    style(--at: 1): var(--m1);
    ...
  );
}
```

Memory size is configurable at generation time (default 0x600 = 1,536 bytes of
writable memory). Embedded data (program binary, BIOS) is baked as constants
into the read dispatch -- those bytes never change so they don't need
corresponding write properties.

**Note for Calcite:** `--readMem` is the single hottest function in the system.
It is called 2-6 times per tick (opcode fetch, ModR/M byte, immediates,
operand loads). The dispatch is a sequential integer key mapping -- it is
an array lookup and should be compiled as such. Similarly, the per-byte write
rules (`--m0`, `--m1`, ...) each check the 3 memory write slot addresses --
this is a broadcast-write pattern where typically 0-2 of the slots match on
any given tick.

**Future optimization:** For memory sizes above ~4KB, a two-level hierarchical
dispatch (page + offset, 256 entries per level) would reduce Chrome's native
CSS evaluation cost from O(N) to O(sqrt(N)). Not needed at current memory
sizes. Would not affect Calcite (which should compile either form to O(1)).

### 8. Input/output

Single command:

```sh
node transpiler/generate.mjs program.bin -o program.css
```

Produces one CSS file containing the CPU (opcode dispatches, register updates,
flag helpers, execution engine) and the memory image (program binary, BIOS,
IVT, initial register values). Internally the generator separates these
concerns but they ship as one file.

Flags inherited from the legacy:
- `--mem SIZE` — writable memory bytes (default 0x600)
- `--data ADDR FILE` — embed binary at address (repeatable)
- `--html` — wrap in HTML template with visualization

### 9. Test strategy

Use the existing conformance pipeline:

```sh
# 1. Generate CSS
node transpiler/generate.mjs program.bin -o program.css

# 2. Reference trace
node tools/ref-emu.mjs program.bin > ref-trace.json

# 3. Calcite trace
calcite program.css --trace-json > calcite-trace.json

# 4. Compare
node tools/compare.mjs program.css ref-trace.json
```

Calcite already runs the legacy CSS. It will need adaptation for the new CSS
patterns (per-register dispatches instead of slot routing), but the CSS is
correct if Chrome evaluates it correctly. Calcite adapts to the CSS, not the
other way around.

### 10. Byte-merge helpers

Two `@function` helpers for 8-bit register writes:

```css
@function --mergelow(--old <integer>, --new <integer>) returns <integer> {
  result: calc(round(down, var(--old) / 256) * 256 + --lowerBytes(var(--new), 8));
}

@function --mergehigh(--old <integer>, --new <integer>) returns <integer> {
  result: calc(var(--new) * 256 + --lowerBytes(var(--old), 8));
}
```

**Note for Calcite:** These appear at every 8-bit register write site (60-80
call sites across the generated CSS). They are trivial pure functions. Inline
them.

## What to reuse from legacy

The `legacy/base_template.css` has working `@function` implementations that we
adopt directly (same algorithm, possibly cleaned up):

- `--xor`, `--and`, `--or`, `--not` — 16-bit bitwise via per-bit decomposition
- `--leftShift`, `--rightShift` — shift via division/multiplication by powers of 2
- `--lowerBytes` — mask to N bits via `mod(val, pow(2, N))`
- `--u2s1`, `--u2s2` — unsigned-to-signed conversion for byte/word
- `--bit` — extract single bit at index

These are proven to work in Chrome. Do not reinvent them.

## The hard problem: sequential to parallel

CSS evaluates all properties simultaneously. The JS emulator's sequential
read-compute-write-flags must be flattened into parallel expressions.

The solution: double-buffered registers. Read from `--__1AX` (previous tick),
write to `--__2AX` (next tick). Within a tick, all reads see the previous
state and all writes target the next state. No conflicts.

Each opcode's CSS is a pure function: given the previous tick's register file
and memory, compute the next tick's register file and memory writes. No
intermediate state, no sequencing.

## Execution engine

Inherited from the legacy with minor adaptation:

1. **Clock**: 4-phase animation (`--clock: 0,1,2,3`) drives the tick cycle
2. **Store phase** (`--clock: 1`): Copy computed values to double-buffer
3. **Execute phase** (`--clock: 3`): Compute next state from buffered values
4. **Write-back**: Animation keyframes copy `--next*` to `--__2*` registers

## File layout

```
transpiler/
  generate.mjs            Entry point: binary -> CSS
  src/
    parse-emulator.mjs     Extract opcode catalog from js8086.js
    emit-css.mjs           Top-level CSS generation orchestrator
    patterns/
      alu.mjs              ADD/SUB/AND/OR/XOR/CMP/TEST/ADC/SBB/NEG
      mov.mjs              MOV/XCHG/LEA/LDS/LES
      control.mjs          JMP/CALL/RET/INT/IRET/conditional jumps/LOOP
      stack.mjs            PUSH/POP/PUSHF/POPF
      string.mjs           MOVS/CMPS/STOS/LODS/SCAS + REP
      shift.mjs            SHL/SHR/SAR/ROL/ROR/RCL/RCR
      group.mjs            Group opcode dispatch (80-83, D0-D3, F6-F7, FE-FF)
      flags.mjs            Flag computation @functions
      misc.mjs             CBW/CWD/XLAT/AAA/AAS/DAA/DAS/AAM/AAD/IO/NOP
    css-lib.mjs            Utility @functions (bitwise, shifts, sign extension)
    memory.mjs             Memory layout, segments, embedded data, IVT
    template.mjs           Execution engine (clock, double-buffer, write-back)
```

## Build order

### Phase 1: Skeleton
- Execution engine (clock, double-buffer, write-back for all 14 registers)
- Memory read/write infrastructure
- Utility `@function`s (bitwise, shifts, sign extension)
- Opcode fetch and ModR/M decode
- Validate with hand-written test binary: `MOV AX, 5 / MOV BX, 3 / ADD AX, BX / HLT`

### Phase 2: Core ISA
- MOV (all variants: reg-reg, reg-mem, reg-imm, segreg)
- ADD/SUB/CMP + flag computation
- INC/DEC
- AND/OR/XOR/NOT/TEST
- PUSH/POP
- JMP/Jcc (all conditional jumps)
- CALL near / RET
- Validate with tiny test binaries exercising each instruction class

### Phase 3: Full ISA
- Group opcodes (0x80-0x83, 0xD0-0xD3, 0xF6-0xF7, 0xFE-0xFF)
- MUL/IMUL/DIV/IDIV
- String operations (MOVSB/LODSB/STOSB/CMPSB/SCASB) + REP
- Far calls/returns (CALL FAR, RETF, IRET)
- INT
- Shifts and rotates (all 7 variants)
- CBW/CWD/XLAT, BCD, flag manipulation (CLC/STC/CLD/STD/CLI/STI), I/O
- LOOP/LOOPE/LOOPNE/JCXZ

### Phase 4: Integration
- Memory layout generation (configurable size, segments, BIOS, embedded data)
- IVT initialization
- VGA text-mode rendering
- **Milestone: fib.asm runs and matches reference trace tick-for-tick**
- Scale to more complex test programs

## Tiny test binaries

Hand-assembled .COM files for incremental validation:

| Binary | Bytes | Tests |
|--------|-------|-------|
| test_mov_add.com | `B8 05 00 BB 03 00 01 D8 F4` | MOV AX,5 / MOV BX,3 / ADD AX,BX / HLT |
| test_loop.com | `B8 0A 00 48 75 FD F4` | MOV AX,10 / DEC AX / JNZ -3 / HLT |
| test_stack.com | `B8 42 00 50 58 F4` | MOV AX,0x42 / PUSH AX / POP AX / HLT |

These are validated against `ref-emu.mjs` before being used as transpiler tests.
