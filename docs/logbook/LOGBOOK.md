# CSS-DOS Logbook

**This is the single source of truth for project status.** Every agent MUST
read this before starting work and MUST update it before finishing.

Last updated: 2026-04-14 (session 9)

---

## Current status

**V4 architecture boots DOS + bootle.com on master (commit 8c407d9).**
Rom-disk WIP on `feature/rom-disk` (1f21f76) — disk bytes moved outside
the 1 MB 8086 space, accessed via `--readDiskByte(--idx)` dispatch and
a BIOS window at 0xD000:0000. Bootle builds end-to-end (457 MB CSS) but
calcite compile freezes on the ~68K-branch dispatch because the existing
compiler has no flat-array fast path for single-parameter literal
dispatches. Calcite work in flight in sibling repo.

**One BIOS, one build path:** `bios/css-emu-bios.asm` is the assembly
BIOS. `transpiler/generate-dos.mjs` is the build script. No microcode
BIOS, no `build.mjs`, no opcode 0xD6 dispatch.

**Kernel identity:** kernel.sys is EDR-DOS (SvarDOS build), NOT FreeDOS.

## Active blocker

Calcite flat-array dispatch optimization. The rom-disk plan's
`@function --readDiskByte(--idx)` with one branch per disk byte is parse-
fast but compile-frozen in calcite — it iterates every branch and emits a
full `Vec<Op>` per entry instead of detecting the "all entries are integer
literals" pattern and emitting a single `DispatchFlatArray` op backed by a
`Vec<i32>`. See `docs/architecture/rom-disk-plan.md`. Work in progress in
the calcite repo.

## What's working

- V4 single-cycle architecture with 8 memory write slots
- Full DOS boot: BIOS init → kernel → bootle.com (hearts on screen)
- Assembly BIOS (`bios/css-emu-bios.asm`) with all v3 improvements:
  - INT 10h: Mode 13h set/clear, AH=1Ah display combination code
  - INT 16h: BDA ring buffer (proper keyboard buffer, not memory polling)
  - INT 1Ah: auto-incrementing tick counter (workaround for no PIT)
- VGA Mode 13h framebuffer zone (0xA0000-0xAFA00) + text buffer
- Contiguous conventional memory (0-640KB, no gap)
- SP overflow fix (16-bit clamp) + initialRegs support
- Shift flag OF (Overflow Flag) computation for shift-by-CL
- `--cycleCount` register: real 8086 cycle costs per instruction
- Keyboard CSS support (--keyboard property, :active button rules)
- Prune options (--no-gfx, --no-text-vga) for CSS size optimization
- Boot trace tool (`calcite/tools/boot-trace.mjs`)
- Hack path (.COM programs) fully working
- Conformance tests passing: timer-irq, rep-stosb, bcd, keyboard-irq

## What's next (in priority order)

1. **INT 13h hard disk rejection** — currently the kernel probes hard
   disks and gets floppy geometry back, which happens to work. Properly
   rejecting hard disks (DL >= 0x80 → CF=1) causes a stall after the
   version string. This needs investigation — likely the kernel hits a
   timeout loop that requires real PIT ticks to exit.
2. **PIT timer** — real PIT counter driven by `--cycleCount`. The
   `cycleCount` register is already accumulating; need to derive PIT
   countdown from it and fire INT 08h when it crosses zero.
3. **More programs** — test with rogue, other DOS programs.
4. **Rewrite BIOS in C** — assembly is hard for Claude to reason about. OpenWatcom
   targeting 8086 real mode. Spec-driven, not a translation of gossamer.

## Recent decisions

- **skipMicrocodeBios for assembly BIOS builds** — `emitCSS()` was
  unconditionally registering opcode 0xD6 microcode BIOS handlers even when
  the assembly BIOS is used (no 0xD6 stubs in ROM). This caused the kernel
  crash. `build.mjs` now passes `skipMicrocodeBios: true`. (2026-04-14)
- **Kernel is EDR-DOS, not FreeDOS** — the map file `kwc8616.map` is for
  FreeDOS and doesn't match kernel.sys. The `../edrdos/` source is correct.
  kernel.sys = kernel-edrdos.sys = kernel-svardos.sys (same hash). (2026-04-14)
- **Batched write slots for REP string ops** — added 32 write slots that only
  activate during REP MOVSB/MOVSW/STOSB/STOSW. Each memory byte checks all
  32 slots. CSS grows ~5x but calcite optimizes via HashMap lookups. This is
  the pragmatic middle ground between v2's 6 parallel slots (all instructions)
  and v3's 1 slot (too slow for boot). (2026-04-13)
- **pit.mjs reload=0 fix** — real PIT treats reload=0 as 65536. CSS PIT was
  treating it as "off". Fixed by adding `_pitEffectiveReload` property and
  checking `pitMode` instead of `pitReload` for the "not active" guard. (2026-04-13)
- **Revived assembly BIOS for DOS boot** — the microcode BIOS (bios.mjs) was
  architecturally cleaner but didn't boot. The old gossamer assembly BIOS did
  boot on the v2 CSS. Copied to `bios/css-emu-bios.asm`. (2026-04-13)
- **Hard disk probe bug** — INT 13h must check DL >= 0x80 and return CF=1 for
  all hard disk calls. Without this, the kernel builds a corrupt DDSC chain
  from floppy parameters and loops forever. (2026-04-13)
- **C BIOS is the long-term plan** — Claude can't reliably read/write x86
  assembly. OpenWatcom C targeting 8086 is the plan for a maintainable BIOS.
  Assembly BIOS is the interim solution. (2026-04-13)

## Uncommitted work

### CSS-DOS repo
- V4 architecture replacing V3 (this session)
- V3 microcode files archived to `legacy/v3/`
- `tools/ref-asm-bios.mjs` — JS emulator with assembly BIOS
- (all prior uncommitted work from sessions 1-7 still uncommitted)

### Calcite repo
- `run.bat` — updated to use `generate-dos.mjs`
- `crates/calcite-debugger/src/main.rs` — `/watchpoint` endpoint
- `tools/boot-trace.mjs` — boot progress tracer
- (all prior uncommitted work from sessions 1-7 still uncommitted)

---

## Entry log

Newest entries first. See `docs/logbook/PROTOCOL.md` for how to write entries.

### 2026-04-14 — Session 9: rom-disk implementation on feature branch

**What:** Implemented the rom-disk plan on a feature branch. Disk bytes no
longer baked into 8086 memory — they live at CSS addresses outside the 1 MB
space and are accessed through a 512-byte window at 0xD0000 controlled by
an LBA register at linear 0x4F0.

Also committed the V4 session 7/8 work as commit `8c407d9` on master before
branching (previously all uncommitted).

**Commits:**
- master `8c407d9` — "V4 architecture: restore single-cycle..." (bundles all
  prior V4 work including the assembly BIOS revival, batched write slots,
  skipMicrocodeBios flag, session 6/7/8 work that was uncommitted in the
  working tree).
- feature/rom-disk `1f21f76` — "WIP: rom-disk — disk bytes outside 1MB..."
  (rom-disk implementation + `extended186.mjs` 80186 patterns file).

**Files touched (rom-disk branch only):**
- `bios/css-emu-bios.asm` — `DISK_SEG = 0xD000`; new `disk_lba equ 0x4F0`;
  `.disk_read` rewritten to write LBA word to physical [0x4F0] then
  `REP MOVSW` 256 words from 0xD000:0000 → ES:DI, LBA++, sector count--.
  Used `xor ax,ax; mov ds,ax` for absolute segment (not BDA_SEG — see
  BDA offset pitfall below).
- `transpiler/src/emit-css.mjs` — added `emitReadDiskByteStreaming` that
  emits `@function --readDiskByte(--idx <integer>)` with one
  `style(--idx: N): byte;` branch per non-zero disk byte. Window addresses
  0xD0000–0xD01FF dispatch to
  `--readDiskByte(calc((m1264 + m1265*256) * 512 + off))`.
- `transpiler/src/memory.mjs` — disk window excluded from stored memory;
  0x4F0/0x4F1 are normal writable RAM inside the conventional zone.
- `transpiler/generate-dos.mjs` — `DISK_LINEAR = 0xD0000`; disk bytes passed
  through `opts.diskBytes` instead of `embData`. Added `--args` flag so
  CONFIG.SYS can run `FROTZ ZORK1.Z3` etc.

**BDA offset pitfall (documented for future agents):** The original plan
doc said "BDA offset 0x4F0". The intended location is **linear 0x4F0**
(inside the BDA intra-application area 0x4F0–0x4FF), reached as
`0x0000:0x04F0`. Interpreting it as "BDA_SEG (0x40) * 16 + 0x4F0" gives
linear 0x8F0, which is inside the loaded kernel and would corrupt code.
The rom-disk-plan.md has been clarified.

**Two-parameter dispatch OOM:** The plan sketched
`--readDiskByte(--lba, --off)`. Calcite's dispatch compiler cross-products
parameter domains before pruning — a first bootle build with this shape
OOM'd trying to allocate 48 GB during compile. Switched to single parameter
`--idx = lba*512 + off`. Composition happens at the dispatch site
(`calc((...) * 512 + off)`), so only the ~N disk-byte branches exist, not
an N×M matrix.

**Single-param still froze calcite (fixed):** With the ~68K single-parameter
branches from bootle's disk, calcite parsed in 4.5s but froze in compile —
`compile_dispatch_call` iterated every entry and compiled a full `Vec<Op>`
per entry. The rom-disk-plan doc previously claimed calcite flattens this
to a byte array, but that code was aspirational. Fixed in calcite (separate
repo, uncommitted there): wired up the pre-existing-but-unreachable
`Op::DispatchFlatArray` op — the fast path fires when a dispatch has
≤1 parameter, all entries are i32 literals, and key span ≤10M. Now:
**bootle parse 4.7s, compile 29s, 1 tick in 74µs**; all 88 calcite tests
pass. This is a generic CSS optimization (no x86 knowledge) and respects
the cardinal rule.

**Smoke test:** `node transpiler/generate-dos.mjs ../calcite/programs/bootle.com`
produces a 457 MB CSS file at `calcite/output/bootle-romdisk.css`.
Verified: one `@function --readDiskByte` definition, 512 window dispatch
branches at 0xD0000–0xD01FF, LBA composition uses linear 0x4F0 (not 0x8F0),
first disk bytes `EB 3C 90` match the FAT12 boot sector signature. Boot-
level validation in calcite/Chrome not yet performed — blocked on calcite
flat-array work.

**Also included in feature branch:** `transpiler/src/patterns/extended186.mjs`
(previously untracked) — 80186+ instruction patterns (MUL/DIV imm, PUSH imm,
ENTER/LEAVE, INS/OUTS) needed for modern DOS toolchain output.

**Also included on master in 8c407d9:** debris files `gossamer-dos.asm`
and `gossamer-dos.lst` at repo root (legacy build artifacts), plus
`docs/superpowers/` plans/specs directory.



**What:** Catalogued every difference between V2 (cc97447, boots) and V3
(current, doesn't boot). Concluded the v3 μOp microcode architecture was
the root cause of the boot failure — not the BIOS, not the INT 13h handler.
Built V4: the v2 single-cycle architecture with all useful v3 improvements
ported and boot-verified one at a time.

**Why μOps were abandoned:** The v3 rewrite converted every multi-write
instruction (INT, PUSH, CALL, MOV to memory, etc.) from single-cycle with
6 parallel write slots to multi-cycle with 1 write slot and a μOp state
machine. This introduced massive complexity — hand-coded state machines for
dozens of instructions, changed stack address calculations, removed TF
support, required every IP emitter to manually include `+ var(--prefixLen)`.
Testing proved v3 can't boot even with the original v2 BIOS, confirming the
μOp sequencer itself has bugs.

**V4 improvements ported from V3 (each boot-verified):**
1. 8 memory write slots (up from 6, headroom for future use)
2. Contiguous conventional memory (no gap between low/high areas)
3. VGA Mode 13h framebuffer zone (0xA0000-0xAFA00) + prune options
4. SP overflow fix (16-bit clamp) + `initialRegs` support
5. OF (Overflow Flag) in shift-by-CL flag functions
6. INT 10h: Mode 13h set/clear, AH=1Ah display combination code, get_mode fix
7. INT 16h: BDA ring buffer (proper keyboard buffer)
8. Keyboard CSS support (--keyboard property, :active rules, HTML buttons)
9. `--cycleCount` register (real 8086 cycle costs per instruction)

**What was NOT ported (broken or V3-infrastructure-only):**
- μOp sequencer and all multi-cycle instruction rewrites
- PIT/PIC/IRQ hardware emulation (needs cycleCount-based PIT, not μOps)
- Microcode BIOS handlers (opcode 0xD6 dispatch)
- INT 13h hard disk rejection (causes stall — needs PIT to resolve timeout)

**INT 13h investigation:** Adding `cmp dl, 0x80; jae .no_drive` causes the
kernel to take a different init path that stalls after printing the version
string. This happens in both V3 and V4 — it's not a μOp bug. The likely
cause: the kernel's F5/F8 option key prompt has a timeout that requires
real BDA tick advancement via PIT/INT 08h. The auto-incrementing INT 1Ah
hack advances ticks on INT 1Ah calls but the timeout loop may not call
INT 1Ah frequently enough. Without the hard disk rejection, the kernel
skips this code path entirely and boots fine.

**File changes:**
- V3 microcode files archived to `legacy/v3/`
- `transpiler/src/emit-css.mjs` — v4 single-cycle architecture (8 slots)
- `transpiler/src/template.mjs` — keyboard, cycleCount, SP fix
- `transpiler/src/memory.mjs` — contiguous zones, NUM_WRITE_SLOTS, prune
- `transpiler/src/cycle-counts.mjs` — new: real 8086 cycle costs
- `transpiler/src/decode.mjs` — v2 decode (no IRQ sentinel override)
- `transpiler/generate-dos.mjs` — v4 build (no microcode, uses bios/ path)
- `bios/css-emu-bios.asm` — v4 BIOS (v2 base + INT 10h/16h improvements)
- `transpiler/src/patterns/shift.mjs` — OF computation for shift-by-CL
- All pattern files — v2 single-cycle (no μOp parameters)
- `calcite/run.bat` — updated to use `generate-dos.mjs`

### 2026-04-14 — Session 7: Boot crash fixed (opcode 0xD6 collision), extensive boot investigation

**What:** Found and fixed the boot crash at `CALL FAR [SS:1000]`. Also
conducted extensive investigation of the boot sequence, fixed SP overflow,
added debugger watchpoint feature, and verified v2 CSS still boots.

**Boot crash root cause:** `emitCSS()` unconditionally called
`emitAllBiosHandlers()` which registered microcode BIOS handlers for opcode
0xD6 (SALC on real 8086), even when `build.mjs` uses the assembly BIOS (no
0xD6 stubs in ROM). The EDR-DOS kernel binary contains 53 instances of byte
0xD6. When executed as part of the instruction stream, the microcode handlers
activated and corrupted CPU state, causing the kernel to take a wrong code
path that eventually hit the uninitialized `lock_bios` far pointer at
SS:0x1000.

**Fix:** Added `skipMicrocodeBios` option to `emitCSS()`. `build.mjs` sets
it to `true`. CSS output dropped from ~1.3GB to ~245MB. Calcite compile time
dropped from ~40s to ~6s.

**SP overflow fix:** `template.mjs` computed SP initial value as `memSize - 8`
which produced 0x9FFF8 (20-bit) for 640KB memory. SP is a 16-bit register.
Added `& 0xFFFF` clamp. `build.mjs` and `generate-dos.mjs` now pass
`initialRegs: { SP: 0 }` for the DOS boot path since the BIOS sets SS:SP.

**How the crash was found:**
- Debugger watchpoint on address 0x97750 (SS:0x1000 at crash time) found the
  bad data written at tick ~39923 during a REP MOVSB kernel relocation copy
- The source data was already wrong — the kernel's code segment (TGROUP) and
  data segment (DGROUP) overlap after relocation, so code bytes appear where
  function pointer stubs should be
- This bad data exists in BOTH v2 and v3 — it's a pre-existing issue, not the
  crash cause
- The crash happened because v3 reached a code path that dereferences
  `lock_bios` (called from `device_driver` in bdevio.asm) while v2 did not
- The different code path was caused by the 0xD6 microcode handlers corrupting
  execution

**V2 verification:** Checked out v2 transpiler at commit cc97447 into a git
worktree (`/tmp/css-dos-v2`). Built v2 CSS with `generate-dos.mjs`. Loaded
in current calcite debugger. V2 CSS boots to bootle.com (hearts on screen).
V2 CSS also has bad data at SS:0x1000 (`18 19 1A 1B`) — same as v3. V2 just
never hits the code path that reads it. V2's `emit-css.mjs` did not import
or call `emitAllBiosHandlers` — that function didn't exist in v2.

**Kernel identity confirmed:** kernel.sys is EDR-DOS (SvarDOS build),
identified by boot message "Enhanced DR-DOS kernel 20250427 (rev 72ae65f)".
The map file `kwc8616.map` in dos/bin/ is for a FreeDOS kernel (different
binary) and is useless for debugging. `kernel.sys` = `kernel-edrdos.sys` =
`kernel-svardos.sys` (same hash). `kernel-freedos.sys` is different.

**Assembly BIOS diff (gossamer-dos.asm vs css-emu-bios.asm):** bios_init
code is identical. Handler differences: INT 10h gained AH=1Ah (display
combination code) and Mode 13h support in AH=00h. INT 13h gained hard disk
rejection (DL >= 0x80), AH=16h (disk change), and REP MOVSW disk read
(replacing manual word loop). INT 16h switched from polling 0000:0500 to
BDA ring buffer.

**Current state after fix:** The crash no longer occurs. The kernel prints
its version string (it did before the fix too — the crash happened after
that point). The kernel is now stuck after the version string — not booting
to the program. The cause of the stall is unknown. V2 CSS boots all the way
to the program without PIT or timer interrupts, so whatever blocks v3 now
is a separate issue that needs investigation.

**Infrastructure added:**
- Calcite debugger: `/watchpoint` endpoint — ticks forward until a memory
  byte changes, reports tick and full CPU state at the change point
- `tools/ref-asm-bios.mjs` — JS reference emulator using the assembly BIOS
  with no INT interception
- QEMU installed on the system for future hardware emulation testing

### 2026-04-13 — Session 6: Batched write slots, boot crash investigation, PIT fixes

**What:** Added 32 batched write slots for REP string ops (MOVSB/MOVSW/
STOSB/STOSW), making boot tracing practical. Rewrote INT 13h disk read to
use REP MOVSW. Fixed pit.mjs reload=0 bug. Investigated boot crash.

**Batched write slots:** Each memory byte now checks 32 write slots instead
of 1. Extra slots only activate during REP string opcodes (0xA4/0xA5/0xAA/
0xAB). Non-string-op ticks: all extra slots = -1 (no write). CSS grows ~5x
(~1.3GB) but calcite handles it via HashMap lookups. This gives ~16x speedup
on REP MOVSW and ~32x on REP MOVSB. Files changed: `emit-css.mjs` (memory
write rules, slot emission), `patterns/misc.mjs` (batch helpers, slot
generation), `decode.mjs` (lookahead source byte reads).

**Unfixed DF bug:** Batched slot source reads and destination addresses
always go forward (+N from SI/DI) regardless of direction flag. Code using
`STD; REP MOVSB` would be corrupted by batching.

**INT 13h disk read fix:** Replaced the 12-instruction-per-word push/pop
segment-switching loop with `REP MOVSW`. Sets DS to source segment, uses
ES:DI as destination. Each sector is 256 words via REP MOVSW, then DS
advances by 32 paragraphs for the next sector.

**pit.mjs fix:** CSS PIT treated `pitReload=0` as "not active" but real
hardware treats it as 65536. Added `--_pitEffectiveReload` property that
substitutes 65536 when pitReload is 0. Changed "not active" guards to check
`pitMode=0` instead of `pitReload=0`.

**PIT/EOI in BIOS (attempted, reverted):** Added PIT channel 0 programming
(mode 3, reload 0x0000) and PIC IRQ 0/1 unmask to bios_init. Also added
EOI (`OUT 0x20, 0x20`) to INT 08h handler. Reverted because timer
interrupts during early kernel init (before CLI) caused the kernel version
string to stop appearing. The EOI fix itself is correct — just needs to be
re-added when PIT is safely enabled.

**Boot crash investigation:** The kernel prints its version string, does
device init, opens files, reads CONFIG.SYS. Then at 0E91:2981 it does
`CALL FAR [SS:1000]` (bytes `36 FF 1E 00 10`). The far pointer at
SS:1000 = 9675:1000 contains 1B1A:1918, which is uninitialized memory
(all zeros). The CPU then executes `ADD [BX+SI],AL` (opcode 0x00) forever,
advancing IP through empty memory. This happens regardless of batching,
PIT state, or which program is loaded. The JS reference emulator with the
microcode BIOS hits a different failure: it loops at 9675:61D7 because BDA
ticks never advance (PIT not programmed, IRQ 0 masked).

**Key insight:** The boot failure is NOT caused by batching or PIT. It's a
pre-existing issue in the kernel's init sequence. The function pointer at
SS:1000 targets memory that was never written to. Next step: debug why
that pointer targets zeros — either the kernel failed to write code there,
or something about the BIOS/memory layout is wrong.

### 2026-04-13 — Session 5: Assembly BIOS revival, hard disk fix, boot trace tool

**What:** Revived the old gossamer assembly BIOS as `bios/css-emu-bios.asm`.
Created `transpiler/build.mjs` as a clean build script. Found and fixed a
hard disk probe bug in INT 13h (DL >= 0x80 not checked). Built
`calcite/tools/boot-trace.mjs` for high-level boot progress tracing.

**Why:** The microcode BIOS (sessions 1-4) was architecturally complex and
didn't boot DOS. The old assembly BIOS had previously booted DOS on the v2
CSS. Reviving it gives a working baseline to iterate from.

**Hard disk bug:** INT 13h didn't check DL, so `AH=08h DL=0x80` returned
floppy geometry as if it were a hard disk. The kernel built a DDSC chain
with corrupt data that looped forever (detected via boot-trace.mjs at
8991:255A-258B). Fix: reject all calls with DL >= 0x80 (CF=1, AH=1).

**Boot trace tool:** `boot-trace.mjs` samples IP at intervals via the
calcite debugger HTTP API, cross-references the kernel map file for symbol
names, and detects IP loops. This identified both the DDSC loop and the
overall boot progression (BIOS init → kernel decompress → device init →
file opens → disk reads).

**Current state after fix:** Boot gets through BIOS init, kernel version
string, device driver init, file opens, and disk reads (INT 13h). It has
not been confirmed where it ultimately stalls — v3 tick speed makes testing
slow (REP MOVSW with CX=30000 takes 30000+ ticks).

**Key decision:** Long-term BIOS should be rewritten in C (OpenWatcom)
because Claude can't reliably reason about x86 assembly. The assembly BIOS
is an interim solution.

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
