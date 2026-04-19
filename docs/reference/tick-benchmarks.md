# Tick benchmarks

Rough tick counts for common execution milestones. Use these to size
debugger runs and spot anomalies (e.g. "I ran 100M ticks and the game
never started — something is wrong, not 'needs more ticks'").

All numbers are approximate, measured with Corduroy BIOS on the V4
single-cycle architecture. Actual values vary ±20% with code path.

## Boot milestones (DOS carts, Corduroy BIOS)

| Milestone                                  | Ticks     |
|--------------------------------------------|-----------|
| Splash / logo draw complete                | ~60,000   |
| BIOS init finished, jumps to kernel        | ~100,000  |
| EDR-DOS prints version string              | ~300,000  |
| CONFIG.SYS read, SHELL= parsed             | ~700,000  |
| Autorun program receives control           | ~1,000,000 |
| Rogue title screen drawn                   | ~1,000,000 |

## Cost references

A reference point for judging "is this reasonable?":

- 1 tick = one CSS evaluation cycle = roughly one 8086 instruction
  (variable: multi-cycle ops still complete in one tick under V4).
- `cycleCount` accumulates real 8086 clock cycles per instruction.
  Average is ~5.6 cycles/tick across typical DOS workloads.
- Real 4.77 MHz 8086 ≈ ~850,000 ticks/sec when throttled to 1×.
- Calcite unthrottled on a modern CPU: 200k–300k ticks/sec (single
  thread, full DOS cart).

## Diagnostic

If you're at **10M+ ticks and haven't reached your milestone**, something
is wrong. Typical causes:

- Stuck in a BIOS init loop (IP stays in F000 range, AX never reaches
  its terminal value). Usually means an `install_ivt`-style loop is
  looping but a write isn't taking effect, or the loop guard compares
  against a value that's never reached. Happens when memory writes for
  the BIOS area aren't wired up.
- COMMAND.COM-only carts: COMMAND.COM currently doesn't work under
  either DOS BIOS. The boot reaches the kernel but stalls before
  returning control to anything. Use `boot.autorun` to run a program
  directly instead.
- Kernel version string appears but nothing else: likely F5/F8 option-key
  timeout is spinning because PIT ticks aren't advancing. Check
  `pitReload` and `--_pitFired` in the debugger.

## Short-circuit: the unknownOp halt warning

If `calcite-cli` prints `[!] Unknown opcode 0xNN`, it has latched the
`--haltCode` sticky var and execution is effectively stalled (the CPU's
next instruction fetch will return the same unsupported byte forever).
The message fires within ~500ms of the halt, so you don't need to run
long to see it. If you haven't seen the warning after a few hundred
thousand ticks, the halt isn't happening.

Note: the warning is computed from `--unknownOp = 1` on any tick where
`--opcode` has no dispatch entry. This can false-positive during TF or
IRQ-delivery ticks if IP transiently points at an unimplemented byte in
data / stack memory — the IRQ override takes execution elsewhere but
the latch still sets. If the warning fires at a surprising opcode,
first check whether CS:IP is in code or data at that tick.
