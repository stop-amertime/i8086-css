# CSS-DOS Logbook

**This is the single source of truth for project status.** Every agent MUST
read this before starting work and MUST update it before finishing.

Last updated: 2026-04-13

---

## Current status

**V3 microcode execution model** — the transpiler generates cycle-accurate CSS
with uOp sequences for multi-byte-write instructions. BIOS handlers are
microcode (`transpiler/src/patterns/bios.mjs`), not assembly.

**3740 instructions conformant** on the DOS boot path (`bootle.com`). The CSS
and JS reference emulators agree on the first 3740 instructions.

## Active blocker

**PIT/PIC/IRET likely needed for DOS boot** — the kernel boot sequence doc
predicts the F5/F8 key polling loop (`biosinit.asm:option_key`) will block
because it calls INT 1Ah waiting for 36 ticks, and the PIT doesn't fire.
This has NOT been verified — the kernel may hit a different bug first.

If the PIT is indeed the next blocker, it requires:
1. Programming PIT channel 0 in `bios/init.asm` (OUT 0x43/0x40)
2. Unmasking IRQ 0 in PIC (OUT 0x21)
3. Fixing pit.mjs to treat reload=0 as 65536 (8253 behavior)
4. Adding IRET to INT 08h/09h handlers (currently just skip sentinel)

An earlier attempt to do all four at once caused a regression (kernel
version string stopped appearing). Root cause unknown. These need to be
added one at a time with verification after each step.

**Seg-override decode bug** (may or may not still be present) — instruction
3740: `CS: POP [0x8633]` (2E 8F 06 33 86). Memory mismatch at high byte.
See `docs/debugging/known-bugs.md`.

## What's working

- Full v3 microcode infrastructure (phases 1-4 complete)
- BIOS microcode handlers: INT 08h, 09h, 10h, 11h, 12h, 13h, 15h, 16h, 19h, 1Ah, 20h
- INT 1Ah AH=00h reads BDA tick count (was hardcoded 0)
- INT 10h AH=0Eh handles CR/LF/BS/BEL control chars via `--biosAL` dispatch
- `--biosAL` latched property (mirrors `--biosAH` pattern)
- Keyboard IRQ path: `:active` buttons -> IRQ 1 -> INT 09h -> BDA buffer -> INT 16h
- PIT timer, PIC interrupt controller in both JS and CSS
- BIOS init stub (`bios/init.asm`) — real x86 code that sets up IVT, BDA, splash screen
- `generate-dos.mjs` rewritten to use microcode BIOS (no more gossamer-dos.asm)
- Hack path (.COM programs) fully working with keyboard-irq test
- Conformance tests passing: timer-irq, rep-stosb, bcd, keyboard-irq

## What's next (in priority order)

1. **PIT/PIC/IRET** — enable timer IRQ so F5/F8 timeout works (see active blocker)
2. **Resume DOS boot conformance** — use `fulldiff.mjs` to find next divergence
3. **INT 10h gaps** — AH=06h (scroll up), AH=09h (write char+attr), AH=08h (read char+attr)
4. **Validate INT 13h disk read** — implemented but untested
5. **ROM disk plan** — move disk image outside 1MB address space for large programs
6. **End-to-end test** — boot DOS to COMMAND.COM prompt

## Recent decisions

- **BIOS init is real x86 assembly** (`bios/init.asm`), not JS-side construction.
  This lets the kernel's drbio layer run properly. (2026-04-13)
- **Tick-accurate conformance not viable for DOS boot** — CSS does BIOS calls in
  microcode ticks, JS does them instantly via int_handler hook. Debugging uses
  documentation + calcite debugger instead. (2026-04-13)
- **Folded IRET** — all BIOS handlers pop IP/CS/FLAGS in a single retirement uOp
  rather than separate uOps, to avoid decode pipeline corruption. (2026-04-13)

## Uncommitted work

### CSS-DOS repo
- `transpiler/src/patterns/bios.mjs` — all BIOS handler emitters
- `transpiler/src/template.mjs` — biosAH, biosSrc/biosDst/biosCnt state vars
- `transpiler/src/emit-css.mjs` — biosAH computed property, keyboard CSS rules
- `transpiler/src/memory.mjs` — removed memory gap in dosMemoryZones
- `transpiler/generate-dos.mjs` — rewritten to use microcode BIOS
- `tools/lib/bios-handlers.mjs` — JS reference BIOS handlers
- `tools/ref-emu-dos.mjs` — updated for microcode BIOS path
- `dos/config.sys` — updated
- `bios/init.asm` — BIOS init stub

### Calcite repo
- `crates/calcite-core/src/compile.rs` — near-identity dispatch fix, tracing infra
- `crates/calcite-core/src/eval.rs` — trace_property, dump_ops_range APIs
- `crates/calcite-cli/src/main.rs` — --key-events flag, name-based --halt
- `crates/calcite-debugger/src/main.rs` — /trace-property, /dump-ops, /keyboard endpoints

---

## Entry log

Newest entries first. See `docs/logbook/PROTOCOL.md` for how to write entries.

### 2026-04-13 — Session 4: BIOS gap fixes (INT 1Ah, INT 10h CR/LF)

**What:** Fixed two BIOS gaps documented in `docs/kernel-boot-sequence.md`:
1. INT 1Ah AH=00h now reads BDA tick counter (0x046C/0x046E) instead of
   returning hardcoded 0. Both CSS (bios.mjs) and JS reference
   (bios-handlers.mjs) updated.
2. INT 10h AH=0Eh now handles control characters (CR, LF, BS, BEL) via
   `--biosAL` dispatch. Added `--biosAL` as a latched property mirroring
   the existing `--biosAH` pattern (template.mjs, emit-css.mjs).

**Why:** INT 1Ah returning 0 causes an infinite loop at the F5/F8 key
polling timeout in `biosinit.asm:option_key`. INT 10h printing CR/LF as
visible characters corrupts the display and cursor position.

**Also attempted (reverted):** PIT programming in init.asm, pit.mjs
reload=0→65536 fix, INT 08h/09h IRET. All four changes together caused
a regression (kernel version string stopped appearing). Root cause not
identified — these need to be added incrementally with testing.

**Key finding:** The F5/F8 loop still blocks boot because the PIT doesn't
fire (not programmed, IRQ 0 masked). The INT 1Ah fix alone is necessary
but not sufficient — the BDA ticks must actually advance via INT 08h.

### 2026-04-13 — Session 3: BIOS init stub + handler gaps

**What:** Created `bios/init.asm` — real x86 init code that runs at F000:0000.
Populates IVT, BDA, VGA splash, then JMP FAR to kernel. Added missing BIOS
handler subfunctions needed by drbio (INT 13h hard disk probes, INT 1Ah RTC
time/date, INT 16h shift flags, INT 10h set video mode). Rewrote
`generate-dos.mjs` to assemble init stub and start execution at BIOS ROM.

**Why:** Skipping drbio left kernel internal structures uninitialized (DDSC
chain, device drivers, MCB chain). Letting drbio run means the kernel
initializes itself properly.

**Key finding:** drbio probes hard disks (DL>=0x80) via INT 13h AH=41h, 08h,
15h, 48h. Without error responses for these, the kernel hangs. The `isHardDisk`
guard pattern works: check `DL >= 128` and return CF=1 for all hard disk calls.

**Blocked on:** Seg-override decode bug at instruction 3740.

### 2026-04-13 — Session 2: IRET fix + new BIOS handlers + DOS path rewrite

**What:** Fixed folded IRET corruption (collapsed all pops into single
retirement uOp). Added INT 08h, 11h, 12h, 13h, 15h, 19h handlers. Rewrote
generate-dos.mjs — no more gossamer-dos.asm dependency. Fixed memory gap bug
(split conventional memory zones causing unmapped gap at kernel relocation
target). Created compare-dos.mjs conformance tool.

**Why:** Multi-uOp IRET sequence corrupted decode pipeline because popping IP
changed `--__1IP` on next tick, causing opcode fetch from wrong address.

**Key finding:** One-uOp reads are always safe (readMem is not a write).
Multi-uOp writes need careful ordering because each uOp's writes become visible
to subsequent uOps via the double buffer.

### 2026-04-13 — Session 1: Calcite slot aliasing bug fix + INT 09h working

**What:** Found and fixed calcite compiler bug: slot compactor aliased LoadMem
destination with Dispatch destination inside nested dispatch tables. The
`compact_sub_ops` liveness analysis didn't examine slots referenced by nested
dispatch fallback_ops. Fix: inlined exception checks as BranchIfZero/Jump chain
instead of nested Dispatch.

**Why:** `--readMem(1052)` returned 0 instead of 30 when called from inside
branching if(style()) expressions, breaking INT 09h keyboard handler.

**Key finding:** The calcite debugger's `/compare-paths` is essential — it
showed compiled=1025 vs interpreted=1055 for memAddr, pinpointing the compiled
path as the source. The `/trace-property` endpoint (added this session) traces
every op execution in the compiled path.

**Infrastructure added:** Calcite debugger now has `/trace-property` and
`/dump-ops` endpoints for tracing compiled-path execution.
