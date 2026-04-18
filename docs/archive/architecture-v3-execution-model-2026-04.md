# V3 Execution Model

The full specification is in `V3-PLAN-1.md` at the repo root. This is a
summary for quick reference.

## Core idea

One CSS evaluation tick = one cycle. One cycle = at most one memory byte
write. A `--uOp` register tracks which micro-operation within an instruction
is executing. Single-cycle instructions stay at uOp=0. Multi-cycle
instructions step through uOp 0,1,2,... and retire when uOp resets to 0.

## The double buffer

Every piece of CPU state is triple-buffered:
- `--AX` = computed value for this cycle (write side)
- `--__1AX` = committed value from previous cycle (read side)
- `--__2AX`, `--__0AX` = intermediate buffer stages

Clock animation has 4 phases (`--clock: 0,1,2,3`). Two keyframe animations
propagate values between cycles. All expressions read from `--__1*` and write
to `--*`.

## One memory write per cycle

Each cycle, `(--memAddr, --memVal)` determines which byte is written. -1 =
no write. Per-byte update rule: `if(style(--memAddr: N): var(--memVal); else: var(--__1mN))`.

This replaced v2's 6 parallel write slots, giving ~6x reduction in generated
CSS for the memory write block.

## Dispatch structure

Register dispatches use nested `if` for multi-cycle opcodes:

```css
--SP: if(
  style(--opcode: 0x50): if(
    style(--__1uOp: 0): calc(var(--__1SP) - 2);
    else: var(--__1SP));
  else: var(--__1SP));
```

Single-cycle opcodes stay flat (same as v2). The dispatch emitter optimizes
this automatically.

## Key examples

| Instruction | uOps | What each uOp does |
|-------------|-------|---------------------|
| MOV AX, BX | 1 | Copy BX to AX, advance IP |
| PUSH AX | 2 | uOp 0: SP-=2, write low byte. uOp 1: write high byte, advance IP |
| INT N | 6 | Push FLAGS (2 bytes), push CS (2 bytes), push IP (2 bytes) |

## Cycle counter

`--cycleCount` tracks real 8086 clock cycles (not uOps). Increments by the
instruction's real cycle count on retirement. PIT timer derives from this.

## Full specification

Read `V3-PLAN-1.md` for: complete uOp tables, REP handling, IRQ delivery
mechanism, peripheral chip integration, BIOS microcode, conformance testing
approach, and implementation phases.
