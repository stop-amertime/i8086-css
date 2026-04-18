# CSS-DOS Logbook

**This is the single source of truth for project status.** Every agent MUST
read this before starting work and MUST update it before finishing.

Last updated: 2026-04-18 (session 11d — launcher tidy-up, builder defaults, preset tracking)

---

## Current status

**Session 11 — repo-wide restructure for release readiness.** All
top-level paths renamed; vocabulary pinned down (cart / cabinet / floppy /
Kiln / builder / Gossamer / Muslin / Corduroy / player). New `builder/`
orchestrator replaces the three `generate-*.mjs` scripts. New
`program.schema.json` and `docs/cart-format.md` canonicalise the cart
manifest. Old `transpiler/src/` is now `kiln/`. BIOS files fanned out
into `bios/gossamer/`, `bios/muslin/`, `bios/corduroy/`. Player HTML
extracted out of Kiln into `player/index.html`. Ref emulators moved to
`conformance/` and renamed per BIOS. See `CHANGELOG.md` for the full
move list.

**Architecture unchanged.** V4 single-cycle CSS; 8 memory write slots;
rom-disk window at 0xD0000 dispatching to `--readDiskByte`; Muslin BIOS
boots EDR-DOS; Calcite's flat-array fast path makes it usable.

**Next big target: Doom8088.** The session 11a readiness check (PR #24,
merged into master and carried into this branch) identified three
concrete CSS-side gaps and delivered Phases 1-3 (PIC/PIT port decode,
PIT countdown + picPending edge, IRQ delivery). Remaining Doom blockers
live in the "What's next" section below. Everything else Doom8088 needs
(Mode 13h framebuffer, INT 21h file I/O via rom-disk, 640 KB
conventional, 8086 ISA with `-march=i8088`, port 0x60 IN) already
works. Build Doom8088 with `-march=i8088 -nosound -noxms -noems`.

**Build path, post-rename:** `builder/build.mjs` is the orchestrator.
Cart manifest at `program.json` (see `docs/cart-format.md`). Muslin
BIOS at `bios/muslin/muslin.asm` is the default for DOS carts. No
microcode BIOS, no opcode 0xD6 dispatch.

**Kernel identity:** `dos/bin/kernel.sys` is EDR-DOS (SvarDOS build), NOT
FreeDOS. (Confirmed, repeated here because the v3 `kwc8616.map` was
misleadingly named after a FreeDOS kernel. The other kernel variants
were pruned in this session.)

## Active blocker

None known. All CSS-side Doom8088 blockers (#24 + #25 + #26 + #27 + #28)
are closed. Next concrete step is to actually build an upstream Doom8088
cart and attempt to boot it, then deal with whatever comes up.

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
- Hardware IRQ delivery (PR #24 + session 11c): PIT fires IRQ 0 through
  IVT[8]; keyboard press/release each fire IRQ 1 through IVT[9]; port
  0x60 IN returns make scancode on press ticks, break scancode on
  release ticks; port 0x21 IN returns --picMask
- C BIOS (corduroy) has a real INT 09h handler + EOI on INT 08h/INT 09h

## What's next (in priority order)

Doom8088 is the driving target. Items 1-5 are its blockers. Items 6+ are
parallel/follow-on work.

1. **INT 13h hard disk rejection** — kernel currently probes hard disks
   and gets floppy geometry, which happens to work. Proper rejection
   (DL >= 0x80 → CF=1) causes a stall after the version string — the
   kernel hits a timeout loop that requires real PIT ticks. With the PIT
   now actually firing (PR #24 + the follow-ups below), should self-unblock.
2. **Rom-disk WAD validation** — retest Zork+FROTZ (~284 KB), then
   attempt Doom8088's processed WAD (hundreds of KB). Confirms calcite's
   flat-array dispatch scales to larger disks.
3. **Build + boot Doom8088 end-to-end** — compile upstream with
   `-march=i8088 -nosound -noxms -noems`, pack the WAD + EXE into a
   DOS-corduroy cart, boot through the C BIOS. All known CSS-side
   blockers (#25/#26/#27/#28) now resolved; next unknown is whatever
   Doom hits at runtime.
4. **More programs** — rogue and other DOS programs.

Recently completed (session 11c, 2026-04-18):
- **#25 C BIOS INT 09h handler** — `bios/corduroy/handlers.asm` now has
  `int09h_handler` (reads port 0x60, packs scancode+ASCII into BDA ring
  buffer via an in-ROM scancode2ascii LUT, acks port 0x61 bit 7, EOIs,
  IRETs). `bios_init.c` installs IVT[9], and the interrupt_table entry
  was flipped from int_dummy. Still TODO in muslin.asm — corduroy only.
- **#26 EOI on INT 08h** — tick handler now sends `OUT 0x20, 0x20`
  before IRET. Same EOI added to the new INT 09h handler.
- **#27 Break scancodes on release** — kiln's `emitIRQCompute` now emits
  `--_kbdPress`, `--_kbdRelease`, `--_kbdEdge` (OR of both), and
  `--_kbdPort60` (returns `prevKeyboard_scancode | 0x80` on release ticks,
  current scancode otherwise). Port 0x60 IN paths in `emitIO` read
  `--_kbdPort60`. Verified via per-tick trace: pressing raises IRQ 1
  with picPending=2; releasing raises IRQ 1 with picPending=2 (and prev
  scancode now readable with the break-bit set).
- **#28 Conformance diff** — ran `tools/compare.mjs` on keyboard-irq +
  timer-irq against `tools/peripherals.mjs`. Two compare.mjs bugs fixed:
  (a) stale v3 `uOp === 0` check now falls back to 0 for v4's single-
  cycle model; (b) calcite's ANSI screen-clear prefix stripped from the
  JSON line, and `--screen-interval=0` passed to suppress mid-trace
  redraws. Also found a real CSS gap: port 0x21 IN was returning 0 (a
  `read current mask → and → write back` pattern would zero the mask).
  Fixed in kiln/patterns/misc.mjs: 0x21 IN now returns `--picMask`.
  First 5-15 instructions of both tests match tick-for-tick with the
  reference. Subsequent divergence is structural (ref's INT 16h spins
  while CSS really delivers IRQ 1; ref's PIT advances by 1 per
  instruction while CSS advances by cycleCount/4 — issue #28 flagged
  this as the expected divergence shape).

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
- None from this session.

### Calcite repo
- Session 11d reconnected `run-web.bat` → `builder/build.mjs` via the
  CLI launcher. `run.bat`, `run-js.bat`, and `serve.mjs` are still the
  old generator shape and remain deferred.
- Other prior uncommitted work from earlier sessions — unchanged by this
  session.

---

## Entry log

Newest entries first. See `docs/logbook/PROTOCOL.md` for how to write entries.

### 2026-04-18 — Session 11d: launcher tidy-up, builder defaults, preset tracking

**What:** Post-big-rename housekeeping. The calcite launcher was still
invoking `transpiler/generate-dos.mjs` (gone since session 11b), so every
cart built via `run-web.bat` / the calcite CLI menu silently failed. Built
the missing bridge, and while there, cleaned up a few defaults that had
crept in wrong. Default DOS BIOS is now Corduroy (user request).

**CSS-DOS changes:**

- `.gitignore` — removed blanket `*.json`. It was swallowing `builder/presets/*.json`
  so fresh checkouts couldn't resolve any DOS preset. Replaced with focused
  `*-trace.json` / `trace-*.json` / `ref-trace.json` rules plus `.claude/`.
- `builder/presets/{dos-muslin,dos-corduroy,hack}.json` — now tracked.
  Also dropped `"autorun": null` from the two DOS presets so auto-detection
  fires when a cart has exactly one `.com`/`.exe` (the explicit null was
  satisfying the `=== undefined` check at `config.mjs:40` and preventing
  auto-run, always landing at a COMMAND.COM prompt).
- `builder/lib/cart.mjs` — `resolveCart` accepts a bare `.com`/`.exe`. It
  copies the file into a scratch temp dir and runs the normal cart pipeline
  from there. Uniform handling; no special `hack-cart-only` path.
- `builder/lib/config.mjs` — default preset flipped from `dos-muslin` to
  `dos-corduroy`. Muslin stays available via `"preset": "dos-muslin"`.
- `tools/mkfat12.mjs` — root directory bumped from 16 entries (1 sector)
  to 224 (14 sectors, standard 1.44 MB floppy). Sokoban's 84 files plus
  KERNEL.SYS/CONFIG.SYS/COMMAND.COM overflowed the old 16. BPB's
  RootEntries field is derived from the same constant, so the kernel
  reads the new geometry via the BPB; no other code assumes 16.

**Calcite changes (sibling repo):**

- `crates/calcite-cli/src/menu.rs` — `resolve_to_css` now invokes
  `../CSS-DOS/builder/build.mjs` instead of the gone `generate-dos.mjs`.
  `Entry::Program` replaces `{ exec, siblings }` with `{ cart, is_dir }`.
  Subdirectories under `programs/` now surface as one entry each (was
  one entry per .com/.exe inside, duplicating carts with multiple
  runnables). Dropped the old `calc-mem.mjs` invocation and the
  `--data`/`--mem` flags — `builder/build.mjs` discovers files from the
  cart folder itself.
- `tools/serve-web.mjs` — tightened `Cache-Control` to match
  `serve.py`: `no-store, no-cache, must-revalidate, max-age=0` + `Pragma: no-cache`.

**Known limits / deferred:**

- Corduroy can't load COMMAND.COM. CONFIG.SYS `SHELL=\COMMAND.COM` boots
  fine under Muslin but prints "Bad or missing command interpreter" under
  Corduroy. Not investigated this session — auto-detect for single-runnable
  carts sidesteps it (no COMMAND.COM on disk when autorun is set).
- `calcite/run.bat`, `run-js.bat`, `serve.mjs` (from the session 11b
  deferred list) still reference old paths. This session only unblocked
  the `run-web.bat` path.

### 2026-04-18 — Session 11c: Doom8088 blockers #25/#26/#27/#28

**What:** Closed out all four open Doom8088-blocking issues identified in
PR #24. The C BIOS (corduroy) now installs a real INT 09h handler and
sends EOI from both INT 08h and INT 09h. Kiln synthesizes break scancodes
on key release and exposes the full press/release edge pair through a new
`--_kbdPort60` computed property. Port 0x21 IN gap found during
conformance and fixed. `tools/compare.mjs` updated for v4.

**Files touched:**

- `bios/corduroy/handlers.asm` — added `int09h_handler` (read 0x60, pack
  scancode+ASCII via new in-ROM `scancode2ascii` LUT, push into BDA ring
  buffer, ack port 0x61 bit 7, EOI, IRET); added `OUT 0x20, 0x20` before
  IRET in `int08h_handler`; flipped interrupt_table entry for INT 09h
  from `int_dummy` to `int09h_handler`; added `global int09h_handler`.
- `bios/corduroy/bios_init.c` — added extern, `#pragma aux`, and IVT
  install line for `int09h_handler`.
- `kiln/patterns/misc.mjs` — `emitIRQCompute()` now emits `--_kbdPress`,
  `--_kbdRelease`, `--_kbdEdge` (OR of both), and `--_kbdPort60` (break
  scancode on release). `emitIO()` — port 0x21 IN now returns
  `--picMask` for all four IN shapes (0xE4/0xE5/0xEC/0xED); port 0x60
  IN now reads `--_kbdPort60` instead of the raw keyboard high byte.
- `tools/compare.mjs` — trace parser strips ANSI prefix and locates
  `[{` anywhere in the line (calcite's single-array output can be
  preceded by a screen-clear escape); `--screen-interval=0` added to
  the calcite invocation to suppress ANSI mid-trace; `advanceToIP`
  treats missing `uOp` as 0 (v4 single-cycle trace has no uOp field).

**Findings from conformance (#28):**

- The read-modify-write mask pattern in `tests/keyboard-irq.asm`
  (`in al, 0x21; and al, 0xFD; out 0x21, al`) was reading 0 instead of
  the real mask. That would have caused every program that unmasks a
  specific IRQ to accidentally unmask *all* IRQs. Fixed by routing
  port 0x21 IN to `var(--__1picMask)`. First 5 instructions of
  keyboard-irq and 15 instructions of timer-irq now match the JS
  reference tick-for-tick.
- Beyond that, the two emulators diverge by design:
  - `keyboard-irq`: the JS reference's `createBiosHandlers` intercepts
    INT 16h synchronously, so the reference never takes the IRQ path.
    CSS now really delivers IRQ 1 through IVT[9]. Different machine
    shape, not a CSS bug.
  - `timer-irq`: JS's `PIT.tick()` advances by 1 per instruction; CSS
    advances by `floor(cycleCount/4)` per instruction, which is faster
    for multi-cycle instructions. Issue #28 predicted this and listed
    it as expected.

**Verified via per-tick trace:** keyboard press at tick 50 raises IRQ 1
(picPending = 2, prevKeyboard latches the current scancode); release at
tick 100 raises IRQ 1 again (picPending = 2, --_kbdPort60 returns
scancode | 0x80). Rogue cart still builds cleanly (regression check).

**Still open / deferred:**

- Muslin (default DOS BIOS) still has `int_dummy` for INT 09h and no
  EOI in INT 08h. Not blocking Doom — Doom ships with its own ISRs —
  but any DOS program that relies on BIOS keyboard IRQ while running
  under Muslin will hit the same #25 + #26 shape. Separate issue when
  relevant; not opening now.
- `IN AX, port` reads return the full `--keyboard` word (not the
  `--_kbdPort60`-synthesized break word). Doom uses byte-wide reads,
  so this is fine; noting for the next program that cares.
- `ref-muslin.mjs` hasn't been updated for the new port-0x21 IN
  semantics — if someone diffs against it they may see a mismatch in
  the PIC-mask read. ref-hack.mjs also untouched.

### 2026-04-18 — Session 11b: the big rename (repo-wide restructure)

**What:** Repo-wide tidy-up for release readiness. No functional code
changed — this session is pure restructuring, renaming, and doc-writing.
Happened on the `big-rename` branch; see `CHANGELOG.md` for the full
move list.

**Why:** The repo had grown organically across ~10 sessions. Three
generator scripts (`generate-dos.mjs`, `generate-dos-c.mjs`,
`generate-hacky.mjs`) did ~80% the same thing. Two BIOSes lived
side-by-side with no clear "this one is default" signal. Reference
emulators were scattered across `tools/` and `calcite/tools/`. Nothing
had a consistent name. A new contributor couldn't tell what was current
from what was legacy. With release approaching, this became blocking.

**Working-session summary:**

1. **Vocabulary.** A multi-round design conversation (no code) produced
   the glossary now in `docs/architecture.md`: cart / floppy / cabinet
   / Kiln / builder / BIOSes (Gossamer / Muslin / Corduroy) / player /
   Calcite. Each name is a proper noun that says exactly one thing.
2. **Schema first.** Before any renaming, wrote `program.schema.json`
   and `docs/cart-format.md`. The schema is the contract between cart
   authors and the builder. Every field is tagged implemented /
   partial / aspirational so follow-up agents know what needs plumbing
   (disk.size, disk.writable, memory knobs on hack carts, sub-640K
   conventional).
3. **Filesystem audit** via subagent before moving anything — caught
   several files I hadn't known about (three kernel variants, a SvarDOS
   distribution dir, debris at repo root, the critical
   `tools/lib/bios-symbols.mjs`).
4. **Moves + deletes.** One atomic branch: see CHANGELOG. No
   deprecation shims — pre-release, no external callers.
5. **New builder.** `builder/build.mjs` orchestrates three stages
   (`bios.mjs`, `floppy.mjs`, `kiln.mjs`) plus cart resolution and
   preset merging in `builder/lib/`. Three presets: `dos-muslin`,
   `dos-corduroy`, `hack`.
6. **Player extracted.** HTML wrapper gone from `kiln/template.mjs`.
   `player/index.html` is a static file; cabinets are pure CSS.
7. **Docs rewritten.** `docs/architecture.md` (tight, single-page),
   `docs/memory-layout.md`, `docs/bios-flavors.md`, `docs/hack-path.md`,
   `docs/building.md`. Per-folder READMEs for builder/kiln/player/dos/
   each BIOS/conformance/carts. Old architecture/ and reference/ docs
   archived to `docs/archive/`.

**Deferred to follow-up agents (listed in CHANGELOG):**

- `calcite/run.bat` / `run-web.bat` / `run-js.bat` / `serve.mjs` still
  reference old paths. These need full refactors, not just path
  updates — holding until the v1 release is over.
- Aspirational schema fields need implementation: `disk.size`,
  `disk.writable` (INT 13h write path), `memory.gfx`/`textVga` on hack,
  sub-640K DOS memory.
- Conformance tool consolidation (`calcite/tools/*.mjs`) into
  calcite-debugger subcommands.
- `ref-corduroy.mjs` once Corduroy stabilizes.

**Not touched:** `tests/`, `docs/logbook/*`, `docs/plans/*`,
`docs/superpowers/*`, Calcite repo, `icons/`. V4 architecture, rom-disk
mechanism, flat-array fast path all unchanged.
### 2026-04-18 — Session 11a: Doom8088 readiness audit; starting hardware IRQ work

**What:** Audited CSS-DOS against Doom8088's runtime requirements and
identified the concrete remaining work. Updated "What's next" to make
Doom8088 the driving target. Started on the port-decode refactor that
underlies all the IRQ work.

**Doom8088 requirements (summary, source: upstream github.com/FrenkelS/Doom8088):**
- CPU: default build targets i286 (gcc-ia16 `CPU=i286`), but an i8088 variant
  exists (`-march=i8088`) that emits pure 8086 ISA — matches V4 patterns.
- Input: installs a custom **INT 09h handler** (`I_KeyboardISR`), reads port
  0x60 directly, clears with port 0x61 (bit 7 toggle), EOIs with `OUT 0x20, 0x20`.
  Does NOT use INT 16h for gameplay.
- Timing: installs custom **INT 08h handler** (`TS_ServiceSchedule`),
  reprograms PIT via `OUT 0x43, 0x36` then reload LO/HI to port 0x40.
  Chains to the BIOS tick counter every 65536 ticks. EOI via 0x20.
- Video: default is **Mode 13h** (framebuffer 0xA000, palette 0x3C8/0x3C9).
  A text-mode variant exists (`bt80x25.sh`, framebuffer 0xB8000) and an MDA
  variant (`bmda.sh`, framebuffer 0xB000). Text variants are simplest for
  first-run validation; Mode 13h is the "real" experience.
- Memory: ~450 KB conventional. EMS/XMS are **optional** (`-noems`, `-noxms`).
- Disk: WAD loaded via `fopen`/`fread` (INT 21h file I/O) — rom-disk path
  handles this.
- Sound: PC speaker only (port 0x61 toggling, PIT channel 2). Disable
  with `-nosound`.
- Binary: ~90-130 KB unpacked, smaller with LZEXE.

**Current CSS-DOS capability vs Doom8088:**

Already works:
- 8086 ISA matches i8088 build. PUSH imm, IMUL imm, BCD, FAR indirect
  CALL/JMP all covered. (80186 extras in `extended186.mjs`; i286 build
  would hit gaps at 0xC0/0xC1/0x60/0x61/0xC8/0xC9/0x62/0x6C-0x6F.)
- Mode 13h framebuffer zone (0xA0000-0xAFA00) emitted by memory.mjs.
- Rom-disk (feature branch) handles WAD-sized images.
- INT 21h file I/O through EDR-DOS kernel.
- 640 KB conventional memory contiguous.
- Port 0x60 IN returns scancode.

Gaps (Doom8088 blockers):
- No PIT-driven INT 08h auto-fire. `--cycleCount` accumulates but nothing
  derives a tick countdown from it.
- No INT 09h on keyboard edge. `--keyboard` updates via :active but no
  IRQ is raised.
- No port 0x20/0x21/0x40-0x43/0x61 OUT handlers — `emitIO()` in misc.mjs
  makes all OUT a no-op.
- No palette register writes (port 0x3C8/0x3C9) — Doom's damage-flash
  palette changes would be silent. Acceptable for first validation.

**Historical note:** V3 had all of this — `legacy/v3/transpiler/src/patterns/pit.mjs`
and `irq.mjs` (via 0xF1 sentinel opcode). V3 was abandoned because the
μOp sequencer had unrelated bugs that prevented boot. The PIT/IRQ designs
themselves were sound. V4 port: same state and port-decode logic, but
single-cycle (no μOp split) — mirror what the V4 0xCD handler does in
one tick with 8 write slots.

**Stale-doc check:** Issue #6 ("Road to DOS games") still captures the
right three priorities (keyboard port, PIC EOI, timer IRQ). Will leave
open with a scope-update comment rather than rewrite.

**Delivered this session (3 commits on `claude/doom8088-readiness-check-6BRWJ`):**

Phase 1 — port decode + state vars (`5afa52e`):
- New STATE_VARS in template.mjs: picMask (init 0xFF), picPending,
  picInService, pitMode, pitReload, pitCounter, pitWriteState.
- emitIO() in patterns/misc.mjs dispatches OUT 0x20/0x21/0x40/0x43
  to the right state var per port. Non-specific EOI on OUT 0x20 uses
  the `(x & (x-1))` trick to clear the lowest in-service bit.
- Dispatch entries fall through to `var(--__1NAME)` (hold) for
  unrelated ports — the entry fires per-opcode, so the hold is explicit.

Phase 2 — PIT countdown + picPending edge (`27c972a`):
- emit-css.mjs learns per-register customDefaults so pitCounter/picPending
  can opt into tick/edge expressions instead of default hold.
- --_pitTicks (cycleCount/4 delta), --_pitDecrement (×2 in mode 3),
  --_pitFired (zero-crossing guarded by pitReload != 0).
- pitCounter decrements by --_pitDecrement each tick; reloads on zero
  crossing. Port-write dispatch entries fall through to the same tick
  expression (an OUT to port 0x21 must not stall the PIT).
- picPending default ORs --_pitFired into bit 0. No IRQ delivery yet.

Phase 3 — IRQ delivery + keyboard edge (`4bd502e`):
- Single-cycle "sentinel" override, parallel to TF. No 0xF1 opcode —
  the override fires on the instruction-boundary tick, reusing slot 0-5
  memory writes for the FLAGS/CS/IP push while register dispatches land
  the new IVT values.
- prevKeyboard state var + --_kbdEdge on press (0 → non-zero).
- --_picEffective / --_ifFlag / --_irqActive / --picVector / --_irqBit
  computed in the .cpu rule (emitIRQCompute).
- IRQ_OVERRIDES for SP/IP/CS/flags/cycleCount/picPending/picInService.
- Fixed latent bug: TF trap used to still fire normal-instruction writes
  in slots 6-7. Now both TF and IRQ suppress (-1, 0) in unused slots.

**What works now (in principle):**
- PIT channel 0 actually counts down and fires IRQ 0 if Doom programs it.
- OUT 0x21 sets picMask, OUT 0x20 acks.
- Keyboard press raises IRQ 1, IP/CS/FLAGS pushed, jumped to IVT[9] vector.
- --_cycleCount feeds the PIT naturally, so no separate real-time clock.

**Known limits / follow-ups:**
1. Only IRQs 0 and 1 wired (no lowestBit helper). Sufficient for Doom8088.
2. --_kbdEdge fires only on press. Doom8088 reads break codes (high-bit
   set) on release to track held keys — without those, WASD held-movement
   breaks. Next session: inject break scancode on keyboard→0 transitions,
   or expose released-key snapshot in --_kbdRelease.
3. No palette port 0x3C8/0x3C9 writes — Mode 13h damage-flash is silent.
4. No validation yet that a build actually runs — the transpiler emits
   correct-shaped CSS, but no conformance diff has been run (`gossamer.bin`
   not present in this checkout). Running the `keyboard-irq.asm` test
   through `compare.mjs` is the next logical step; it exercises OUT 0x21
   and INT 16h round-trip via the BDA buffer.

### 2026-04-15 — Session 10: rom-disk end-to-end working; calcite fast path + CLI menu

**What:** Bootle boots end-to-end through the rom-disk window. Verified
live in calcite with keyboard + framebuffer rendering.

**Calcite side (sibling repo, uncommitted):**
- Wired up the previously-inert `Op::DispatchFlatArray` instruction. The
  compile-side builder (`try_build_flat_dispatch` at
  `calcite/crates/calcite-core/src/compile.rs`) fires when a dispatch
  table has ≤1 parameter, every entry and the fallback are i32 literals,
  and max_key - min_key ≤ 10M. The compiled program owns a
  `Vec<FlatDispatchArray>`; at runtime the op does a single bounds-checked
  array index. Multi-parameter / non-literal / sparse dispatches still go
  through the old per-entry path unchanged.
- Added a name-keyed cache (`flat_dispatch_cache`) so repeated call sites
  of the same function reuse the same array. Critical: the rom-disk
  window's 512 dispatch sites would otherwise rebuild the full disk array
  per site.
- Added parse + compile progress bars (`render_progress` in compile.rs,
  wired into the parser via a byte-position meter). Opt out via
  `CALCITE_NO_PROGRESS=1`.
- Replaced the old `--ticks` default (was `1`) with `Option<u32>`. Absent →
  unlimited / interactive; explicit → N ticks non-interactive. Fixes a
  regression where menu-launched programs ran one tick and exited.
- Rewrote `calcite-cli` into a proper launcher: when `--input` is omitted,
  a keyboard-driven grid menu appears showing every `output/*.css`,
  every top-level `programs/*.{com,exe}`, and every `.com`/`.exe` inside
  `programs/*/` subdirs. On select, invokes `generate-dos.mjs` with all
  sibling files (inside subdirs) as `--data`. CSS-DOS logo (from PNG in
  `icons/css-dos-logo-32x32.png`) during the menu/generation phase;
  calc(ite) ASCII banner during parse/compile.
- Full bootle compile: parse 4.7s, compile ~16s (down from "frozen" /
  48 GB allocation). Runtime unchanged (1 tick ≈ 74 µs).

**CSS-DOS side (this commit):** logbook + rom-disk-plan updates only.
Everything actually doing the work landed in session 9's `1f21f76`.

**Follow-ups:**
- Retest Zork+FROTZ (~284 KB disk) through the rom-disk path.
- Profile calcite's flat-array lookup under heavy INT 13h load (REP MOVSW
  hitting the window 256× per sector) to confirm it's as fast as expected.
- Commit calcite-side work (separate repo, separate checkpoint).
- Merge `feature/rom-disk` → master once Zork is green.

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
