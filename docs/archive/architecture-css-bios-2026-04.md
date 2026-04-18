# CSS-BIOS

The BIOS is implemented as **microcode** in `transpiler/src/patterns/bios.mjs`.
There are no assembly files for the handlers — each BIOS interrupt handler is a
set of CSS calc() expressions emitted by the transpiler.

## How it works

The BIOS ROM at F000:0000 contains:
1. An **init stub** (`bios/init.asm`) — real x86 code that sets up IVT, BDA,
   VGA splash, and jumps to the kernel
2. Tiny **3-byte stubs**: `[0xD6, routineID, 0xCF]` for each handled interrupt

When the CPU executes `INT xxh`:
1. It vectors through the IVT to one of the 3-byte stubs
2. Opcode 0xD6 is the BIOS sentinel — calcite and Chrome dispatch on the
   routine ID byte to run the appropriate microcode handler
3. The handler executes as a uOp sequence (same machinery as CPU instructions)
4. On retirement, the IRET (0xCF) byte is never reached — handlers fold IRET
   into their retirement uOp (pop IP, CS, FLAGS in one step)

## Handler table

| Interrupt | Handler | Status |
|-----------|---------|--------|
| INT 08h | Timer tick (increments BDA tick counter at 0x046C) | Working |
| INT 09h | Keyboard (reads `:active` buttons, stuffs BDA ring buffer) | Working |
| INT 10h | Video services | Partial — see below |
| INT 11h | Equipment list (reads BDA 0x0410) | Working |
| INT 12h | Memory size (returns 640 in AX) | Working |
| INT 13h | Disk I/O (reads from memory-mapped disk image) | Working |
| INT 15h | System services (extended memory = 0, wait = no-op) | Working |
| INT 16h | Keyboard input (blocking read from BDA buffer) | Working |
| INT 19h | Bootstrap loader (sets halt flag) | Working |
| INT 1Ah | Time of day (tick count, RTC time/date) | Working |
| INT 20h | Program terminate (sets halt flag) | Working |

### INT 10h subfunctions

| AH | Function | Status |
|----|----------|--------|
| 00h | Set video mode | Working |
| 02h | Set cursor position | Working |
| 03h | Get cursor position | Working |
| 06h | Scroll window up | **Not implemented** |
| 08h | Read char+attr at cursor | **Not implemented** |
| 09h | Write char+attr at cursor | **Not implemented** |
| 0Eh | Teletype output | Working |
| 0Fh | Get video mode | Working |
| 1Ah | Get display combination | Working |

### INT 13h notes

The handler dispatches on DL to separate floppy (DL < 0x80) from hard disk
(DL >= 0x80) calls. All hard disk calls return CF=1 (no hard drives).

Key floppy subfunctions:
- AH=00h: Reset — returns CF=0
- AH=02h: Read sectors — byte-copy loop using biosSrc/biosDst/biosCnt state vars
- AH=08h: Get parameters — returns 1.44MB geometry (79 cyl, 18 sec/track, 1 head)
- AH=15h: Get disk type — returns AH=1 (floppy, no change detect)
- AH=16h: Disk change — returns CF=0 (not changed)

## Dual implementation

Every handler exists in two places:
1. **CSS microcode** — `transpiler/src/patterns/bios.mjs` (uOp sequences)
2. **JS reference** — `tools/lib/bios-handlers.mjs` (imperative JS)

The JS version is the source of truth for behavior. The CSS version must
match exactly. Conformance testing catches discrepancies.

## The deadlock problem (INT 16h)

INT 16h AH=00h blocks until a key arrives. The key arrives via IRQ 1 -> INT 09h.
IRQ injection only happens at instruction boundaries (uOp=0). The BIOS handler
sentinel (opcode 0xD6) at uOp=0 is treated as an instruction boundary by the
IRQ injection logic, so the INT 16h hold is interruptible.

**Architectural constraint:** Only uOp 0 holds are safe for interruptible waits.
If a handler held at uOp > 0, IRET would restart at uOp 0 (not the held uOp).

## Folded IRET

All handlers fold IRET into their final retirement uOp — they pop IP, CS,
FLAGS from the stack and adjust SP in one uOp. This avoids a multi-uOp IRET
sequence that would corrupt the decode pipeline (popping IP changes `--__1IP`
on the next tick, causing opcode fetch from the wrong address).
