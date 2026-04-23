# CSS-DOS Logbook

**Single source of truth for project status.** Every agent MUST read this
before starting work and MUST update it before finishing.
See `PROTOCOL.md` for the entry format. Pre-session-12 entries archived to
`docs/archive/logbook-sessions-1-12-2026-04.md`.

Last updated: 2026-04-23 (session 17 — Doom8088 crash triaged to lost IRET return frame from INT 21h)

---

## Current status

V4 single-cycle CSS, 6 memory write slots (slot-live gated), rom-disk window at 0xD0000.
Corduroy (C BIOS) is the default DOS BIOS; Muslin (asm) is the fallback.
Full DOS boot works (BIOS → EDR-DOS kernel → bootle.com). Hardware IRQ
delivery is live: PIT fires IRQ 0 through IVT[8]; keyboard press/release
fire IRQ 1 through IVT[9]; ports 0x20/0x21/0x40–0x43/0x60 all decode.
Build pipeline is `builder/build.mjs` against a `program.json` cart;
three presets (`dos-corduroy`, `dos-muslin`, `hack`). Player is
`player/index.html`. Kernel is EDR-DOS (SvarDOS build) — the
`kwc8616.map` file is FreeDOS and does NOT match.

**Driving target:** Doom8088. All audited CSS-side blockers
(#24/#25/#26/#27/#28) are closed. Everything Doom needs (Mode 13h
framebuffer, INT 21h file I/O, 640 KB conventional, 8086 ISA, port 0x60
IN, IRQ delivery) already works. Build with
`-march=i8088 -nosound -noxms -noems`.

## Active blocker

**Doom8088 crashes at cycleCount ~15.09M (tick 879509)** with
`--unknownOp=1, --haltCode=0xC0` at CS=0 IP=0x4C. 0xC0 is a 186+ opcode
(shift r/m8, imm8); execution has wandered into the IVT (linear 0x4C
is the IP-low byte of IVT[0x13]). Root cause traced to a lost IRET
return frame from `INT 21h AH=0x30` (Get DOS Version) — see session 17
entry for the full causal chain.

**Key observation:** This may unblock eliza too. Eliza's symptom
(stuck on all-zero data in Watcom runtime) is consistent with the same
pattern: Watcom C apps' restore-context stubs ending up with zero
registers. Worth retesting eliza after the Doom fix.

Prior blocker (eliza / COMMAND.COM "keyboard doesn't work", session 12)
still open but demoted — Doom has the cleaner reproduction.

## What's working

- V4 single-cycle, 6 memory write slots (slot-live gated), contiguous 0–640 KB RAM, SP 16-bit clamp.
- BIOS: INT 10h (Mode 13h, AH=1Ah), INT 13h (floppy via REP MOVSW),
  INT 16h (BDA ring buffer), INT 1Ah (auto-incrementing ticks).
- Corduroy: real INT 09h handler, EOI on INT 08h/09h.
- Hardware: PIT countdown from `--cycleCount/4`, picMask/picPending/
  picInService, keyboard press + release edges, `--_kbdPort60` returns
  break scancode on release, port 0x21 IN returns `--picMask`.
- Rom-disk window at 0xD0000 dispatching to `--readDiskByte` (LBA at
  linear 0x4F0, NOT BDA_SEG:0x4F0). Calcite's flat-array op makes it fast.
- Hack path (.COM) fully working. Conformance tests pass: timer-irq,
  rep-stosb, bcd, keyboard-irq, vsync-poll.
- Port 0x3DA (VGA input status 1) decodes to a simulated 70 Hz retrace
  on the `--__1cycleCount` clock (bit 3 = retrace, bit 0 = display-enable).
  Player has a paint-mode gate: `sim` (default) paints on simulated
  retrace edges, `wall` paints on wall-clock 70 Hz, `turbo` paints every
  batch. Selectable via `?vsync=` URL param or status-bar dropdown.
- Text modes 0x00–0x03 and MDA 0x07 render pixel-by-pixel on the grid
  player through the 8×16 VGA ROM font (`player/fonts/vga-8x16.bin`).
  Worker rasterises 4000-byte text buffer + attribute bytes through the
  font atlas into the same RGBA buffer Mode 13h uses; grid paints via
  its palette-slot className path.
- CGA mode 0x04 (320×200×4) renders end-to-end. INT 10h AH=00h accepts
  it in Corduroy and Gossamer; kiln decodes `OUT 0x3D9` (CGA palette
  mode register) and shadows the byte to linear 0x04F3; both renderer
  paths (`player/calcite-bridge.js` and `calcite/web/calcite-worker.js`)
  import the same decoder from `calcite/web/video-modes.mjs` via a
  shared MODE_TABLE. Conformance test: `tests/cga4.test.mjs`.
- Memory zones (Mode 13h, text, CGA 0x04) are per-cart opt-ins via
  checkboxes in the builder UI. Default for DOS presets: text+gfx on,
  cga off. Hack preset picks up the same `memory.{gfx,cgaGfx}` fields.

## What's next (priority order)

1. **Resolve Doom8088 crash (active blocker).** Replay from tick 879341
   (the moment Doom hits `INT 21h AH=0x30`) and step through Corduroy's
   INT 21h handler watching SS:SP = 0x31CD:0xFFFA (linear 0x41CE4). The
   question to answer: why does the IRET at tick 879468 pop zeros
   instead of the flags/CS/IP pushed at tick 879341? Either (a)
   Corduroy's int21 handler trampled the return frame, (b) the stack
   wrap put the frame somewhere the handler cleared, or (c) we have a
   corduroy bug specific to `AH=0x30`. Cart at `tmp/doom8088.css`
   (549.7 MB), source at `carts/doom8088/`. See session 17.
2. **INT 13h hard disk rejection.** DL >= 0x80 → CF=1. Previously
   caused a stall in a timeout loop; with the PIT now firing, should
   self-unblock. Retest.
3. **Rom-disk WAD validation.** Retest Zork+FROTZ (~284 KB), then
   Doom8088's WAD. Confirms flat-array dispatch scales.
4. **Build + boot Doom8088 end-to-end.**
5. More programs (rogue, etc.).

Parallel/deferred: Muslin still has `int_dummy` for INT 09h and no EOI
on INT 08h (not blocking Doom); `calcite/run.bat`, `run-js.bat`,
`serve.mjs` still reference pre-rename paths; aspirational cart-schema
fields (`disk.size`, `disk.writable`, `display.vsyncMode`, sub-640K,
hack memory knobs) not yet plumbed into the builder/player; bulk-copy
work delegated to calcite worker (Op::MemoryCopy + runtime REP
fast-forward for 0xAA/0xAB/0xA4/0xA5); `ref-corduroy.mjs` not yet
written.

## Recent decisions

- Video-mode decoder knowledge lives in `calcite/web/video-modes.mjs`
  (calcite owns the renderer, not CSS-DOS). Both CSS-DOS's bridge worker
  and calcite's own worker import from it — CSS-DOS reaches the file via
  the dev-server alias `/calcite/` → `../calcite/web/`. Adding a new
  video mode is now one MODE_TABLE entry plus (if the decode is novel)
  one function — not a triple-edit across renderer files. (2026-04-22)
- Paint cadence is driven by the simulated retrace clock (`sim` mode)
  by default, not wall-clock or per-batch. Rationale: a program that
  polls port 0x3DA and waits for retrace gets tear-free frames; a
  program that doesn't tears. That matches real hardware — the player
  shouldn't impose a cadence the guest program can't observe. `wall`
  and `turbo` are available for debugging and for programs that don't
  poll retrace. (2026-04-20)
- Default DOS BIOS is Corduroy (C), not Muslin (asm). (2026-04-18)
- `skipMicrocodeBios: true` on assembly-BIOS builds — unconditional
  0xD6 handler registration collided with 53 x 0xD6 bytes in the
  EDR-DOS kernel. (2026-04-14)
- Kernel is EDR-DOS (SvarDOS); ignore `kwc8616.map`. (2026-04-14)
- 32 batched write slots for REP string ops (activate only on
  0xA4/0xA5/0xAA/0xAB; DF=1 not handled). (2026-04-13)
- `pitReload=0` means 65536 (real hardware semantics). (2026-04-13)
- C BIOS is long-term plan; asm is interim. (2026-04-13)

## Uncommitted work

**CSS-DOS (session 17):**
- `carts/doom8088/program.json` + DOOM.EXE + DOOM1.WAD + README.TXT —
  Doom8088 v20260304 cart (D8M13L.EXE, Mode 13h low-detail, 8088 build)
  + id Software shareware WAD. Reproduces the cycleCount ~15.09M crash.
- `docs/logbook/LOGBOOK.md` — session 17 entry + active-blocker swap
  (Doom8088 > eliza).

**CSS-DOS (session 16):**
- `bios/corduroy/handlers.asm` + `bios/gossamer/gossamer.asm` — INT 10h
  AH=00h accepts mode 0x04; Corduroy also shadows the raw requested mode
  byte to linear 0x04F2. CGA clear loops zero the 16 KB aperture via
  REP STOSW.
- `kiln/patterns/misc.mjs` — port 0x3D9 decode on OUT 0xE6/0xEE,
  shadowing AL to linear 0x04F3.
- `kiln/memory.mjs` — `comMemoryZones` now accepts a `prune` object like
  `dosMemoryZones`; hack carts get the CGA aperture + Mode 13h on opt-in.
- `builder/stages/kiln.mjs` — plumbs `manifest.memory.{gfx,cgaGfx}`
  through the hack path.
- `calcite/web/video-modes.mjs` (NEW) — canonical video-mode table, CGA4
  decoder, shared text-mode rasteriser. Both CSS-DOS's `calcite-bridge.js`
  and calcite's own `calcite-worker.js` import from here.
- `player/calcite-bridge.js` — `maybeEmitFrame()` now dispatches off
  `pickMode(get_video_mode())`; old `detect_video` region state gone.
- `calcite/web/calcite-worker.js` — `frame` case refactored around the
  shared mode table; duplicated rasteriser + palette deleted (~110
  lines removed).
- `carts/cga4-stripes/` + `tests/cga4_stripes.asm` — four-band smoke cart.
- `tests/cga4.test.mjs` — conformance test: greps kiln CSS for the port
  decode and shadow property, greps BIOS for mode-0x04 branches, runs
  the decoder against a known pixel pattern.
- `bios/corduroy/README.md` — documents the new set_mode table.

**CSS-DOS (session 14):**
- `kiln/patterns/misc.mjs` — port 0x3DA decode on IN opcodes
  0xE4/0xE5/0xEC/0xED (constants CYCLES_PER_FRAME=68182,
  RETRACE_CYCLES=3409).
- `player/calcite.html` — vsync mode parsing (`?vsync=...`), paint-mode
  gate in the render loop, status-bar dropdown.
- `tests/vsync-poll.asm` + `carts/vsync-poll/program.json` — smoke
  cart that reads 0x3DA via both IN forms.
- `tests/vsync-poll.test.mjs` — conformance test (builds the cart,
  greps CSS for the decode, re-derives the bit math in JS).
- `program.schema.json` + `docs/cart-format.md` — `display.vsyncMode`
  schema field (aspirational; not consumed by builder yet).
- `web/scripts/dev.mjs` — dev-server REPL with status/reset/clear
  commands + `_status` / `_reset` / `_clear` HTTP routes.
- `web/site/assets/build.js` — autorun dropdown default no longer
  sticks to COMMAND.COM when a user file is uploaded.
- `web/prebake/*.meta.json` — regenerated after schema + kiln changes.

**CSS-DOS (earlier, still uncommitted):** none.

**Calcite (sibling):**
- `/run-until` endpoint in `crates/calcite-debugger/src/main.rs`
  (session 12). Conditions: `cs_ip`, `cs`, `ip_range`, `int`,
  `int_num`, `property_equals`, `property_changes`, `mem_byte_equals`.
- Session-11d launcher wiring (`run-web.bat` → `builder/build.mjs`).
- Flat-array dispatch op wiring from session 10 + calc-cli menu rewrite.
- **Landed (session 14):** `Op::MemoryCopy` mirror of `Op::MemoryFill`
  and runtime REP fast-forward for 0xAA/0xAB/0xA4/0xA5 (STOSB/STOSW/
  MOVSB/MOVSW). Commits `4b12ba8`, `de740ea`, `7372e32`, `4472e60` on
  calcite main. Kiln is unchanged — initial misdiagnosis that kiln's
  `repIP()` was dropping the outer `+ prefixLen` wrapper was caused by
  reading a stale April-13 `tests/rep-stosb.css`. Current kiln output
  is correct. Refreshed the stale cabinet at
  `tests/rep-stosb.css` so future readers don't repeat the mistake.

---

## Entry log

Newest first. See `PROTOCOL.md` for format. Pre-session-12 history is
archived at `docs/archive/logbook-sessions-1-12-2026-04.md`; one-line
summaries below.

### 2026-04-23 — Session 17: Doom8088 crash triage — lost IRET return frame from INT 21h

**What:** Built Doom8088 cart (FrenkelS/Doom8088 v20260304, D8M13L.EXE
Mode 13h low-detail build + shareware DOOM1.WAD) and ran it under
corduroy. Confirmed user-reported crash at cycleCount ~15.09M.
Instrumented the crash backward using the calcite-debugger MCP
(`run_until` with `property_equals`, `cs_ip`, and `int` conditions) to
reconstruct the causal chain.

Implementation side (prior to triage, also in this session):
- `tests/dac-readback.test.mjs` (18/18 passing): verifies kiln emits
  dispatch entries for ports 0x3C7/0x3C8/0x3C9 with DAC shadow at
  linear 0x100000 and 12-read auto-index sequence semantics.
- `kiln/emit-css.mjs`: added `dacReadIndex`, `dacReadSubIndex` to
  `regOrder` — this unblocked dispatch emission for the new state vars
  (the declarations in `template.mjs` were already there; `regOrder`
  gates which ones become dispatch cases).
- `kiln/template.mjs`: added `--dacReadIndex` and `--dacReadSubIndex`
  state vars immediately after `--dacSubIndex`.
- `kiln/patterns/misc.mjs`: dispatch for IN on opcodes 0xE4/0xE5/0xEC/
  0xED routing ports 0x3C7/0x3C8/0x3C9 through the DAC path via
  `--readMem` on DAC_LINEAR.
- Committed as `3e78b69` before cart work.

Cart construction:
- Downloaded Doom8088 v20260304 release zip from GitHub
  (FrenkelS/Doom8088). No local ia16-elf-gcc cross-compiler — took the
  prebuilt executables instead. Picked D8M13L.EXE (the 8088 build,
  Mode 13h, low-detail 60×128 viewport) as DOOM.EXE, since it's the
  variant that matches what our emulation supports.
- `carts/doom8088/program.json` + DOOM.EXE (189,248 bytes, MD5
  736e97227aee0f80063b5f511547d643) + DOOM1.WAD (1,535,426 bytes,
  shareware). Boot args `-noxms -noems -nosound`.
- Build produces `tmp/doom8088.css` at 549.7 MB (the rom-disk window
  streams the 1.5 MB WAD; most of the cabinet size is WAD data).

**Triage findings:**

Crash at tick 879509: `--CS=0`, `--IP=76`, `--unknownOp=1`,
`--haltCode=192` (0xC0). 0xC0 is ROL/ROR/SHL/etc. r/m8,imm8 — a
186+ instruction, not 8086. The landing spot is inside the IVT
(linear 0x4C = middle of IVT[0x13], whose stored vector is
`0x0070:0x01C0` for DOS's hooked INT 13h). Execution has gone
badly astray and is walking through zero bytes (valid `ADD [BX+SI], AL`
on 8086) until it hits a non-8086 opcode.

Working back via the debugger:

1. **Tick 879468** — An IRET pops IP=0, CS=0, FLAGS=0. Previous tick
   had CS=0x55, IP=0x3941, SP=0xFFFA — Watcom runtime territory. The
   six bytes at SS:0xFFFA are all zeros, so the IRET pops zeros. After
   this tick, CPU is at CS=0 IP=0 with SP=0x10000 (wrapped).

2. **Tick 879341** — Program executes `INT 21h` with AH=0x30 (Get DOS
   Version) at CS=0x0DBB, IP=0x24. At the moment of the INT, SP=0.
   The INT pushes 6 bytes (flags, CS, IP), wrapping SP from 0 to
   0xFFFA, writing to SS:0xFFFA (SS=0x31CD, linear 0x41CE4). Values
   pushed: flags=0x0246, CS=0x0DBB, IP=0x0024 — all non-zero, all
   correct. Verified via `read_memory` at tick 879342.

3. **Tick 879333** — A restore trampoline at CS=0x0BFE, IP=0x10C2 sets
   SS:SP = CX:DI where DI=0. Disassembly of the stub (bytes I read
   from memory):
   ```
   8E D1    MOV SS, CX      ; CX=0x31CD
   8B E7    MOV SP, DI      ; DI=0   ← SP becomes 0
   06       PUSH ES
   56       PUSH SI
   8E DA    MOV DS, DX
   8E C2    MOV ES, DX
   33 DB    XOR BX, BX
   FB       STI
   CB       RETF
   ```
   This is the classic Watcom C runtime context-restore trampoline
   (setjmp/longjmp-style). It was called with DI=0, so either the
   saved context buffer held zero for SP, or the caller loaded
   registers incorrectly before calling.

The crash sequence: DOOM restore stub called with DI=0 → SP=0 → first
INT 21h push wraps SP to 0xFFFA → INT handler runs → IRET at tick
879468 pops zeros (not the flags/CS/IP that we know were pushed at
tick 879342) → CS:IP = 0:0 → CPU walks forward through the IVT as
zero-byte `ADD` instructions → hits 0xC0 inside IVT[0x13] → unknown
opcode → halt.

**The open question:** Between tick 879341 (INT 21h pushes correct
frame to SS:0xFFFA) and tick 879468 (IRET pops zeros from SS:0xFFFA),
something has zeroed those six bytes. Three possibilities:
- (a) Corduroy's INT 21h handler trampled the caller's frame — most
  likely suspect given the specific call is AH=0x30 which should be a
  trivial "return AX=major/minor" and would not normally touch the
  caller's stack. Worth looking at corduroy's int21h AH=0x30 path.
- (b) A BIOS handler between the INT and IRET pushed a deeper frame
  that zeroed that region.
- (c) A calcite/kiln bug around the SP=0 → 0xFFFA wrap for the push,
  such that the push *appeared* to succeed but wrote to a different
  linear address than the IRET's pop reads from. (Tests so far show
  the push DID write there; the wrap itself behaves correctly.)

The user's prior "keyboard doesn't work" eliza blocker (session 12)
has the same fingerprint — Watcom C app stuck in all-zero runtime
data. Fixing whichever of (a)/(b)/(c) is the cause may unblock eliza
too.

**Mistakes to avoid:** I initially reported the crash tick as "15
million" but that's the `cycleCount` (~17 cycles/tick). Real tick
count is 879509. The debugger returns both; call out the distinction
explicitly in reports.

The debugger server died twice during investigation (once at ~879466
during a `seek`). The user restarted it manually; on a fresh session
the background `run_until` jobs didn't persist. Worth making those
survive restart, or at least failing the poll cleanly.

**Blocked on:** Need debugger session to resume. Next steps:
seek to tick 879341, tick through INT 21h into corduroy's handler,
watch linear 0x41CE4..0x41CE9 (the return frame), identify what
writes zero to those bytes.

**Uncommitted work (this session):**
- `carts/doom8088/` (new cart: program.json, DOOM.EXE, DOOM1.WAD,
  README.TXT). The .EXE and .WAD are copies of FrenkelS's release +
  id Software's shareware WAD; not new code, but bundled for repro.
- Logbook updates (this entry, active-blocker change, priority list
  reshuffle).
- `tmp/doom8088.css` (generated, gitignored).

DAC read-back work (`tests/dac-readback.test.mjs`, `kiln/emit-css.mjs`,
`kiln/template.mjs`, `kiln/patterns/misc.mjs`) already committed as
`3e78b69` earlier this session.

---

### 2026-04-22 — Session 16: CGA mode 0x04 end-to-end + shared mode table

**What:** Implemented CGA mode 0x04 (320×200, 4 colours, 2 bpp, even/odd
scanline interleave) end-to-end. While there, factored the video-mode
routing out of both renderer workers into a single shared module that
both consume.

Implementation:
- BIOS (`bios/corduroy/handlers.asm`, `bios/gossamer/gossamer.asm`):
  `INT 10h AH=00h` now accepts 0x04 alongside 0x01/0x03/0x13. On entry
  it stores the raw requested mode byte to linear 0x04F2 (previously
  the `get_requested_video_mode` API was wired on the calcite side but
  nothing populated that byte — fixed). The 0x04 path clears the 16 KB
  aperture at 0xB8000 via REP STOSW so calcite's bulk-fill op batches
  the init.
- Kiln (`kiln/patterns/misc.mjs`): `OUT 0x3D9` (CGA palette mode
  register) on 0xE6/0xEE opcodes shadows AL to linear 0x04F3 via the
  existing `addMemWrite` pattern. No CSS-side interpretation of the
  bits — the renderer reads the raw byte and resolves palette + bg + bank.
- Builder (`builder/stages/kiln.mjs`, `kiln/memory.mjs`): hack carts
  gained the same `manifest.memory.{gfx,cgaGfx}` opt-ins the DOS path
  already had; `comMemoryZones` now takes a `prune` object with the
  same "skip this zone" convention as `dosMemoryZones`.
- Renderer (`calcite/web/video-modes.mjs`, new): owns MODE_TABLE,
  `pickMode()`, `decodeCga4()`, `rasteriseText()`, the VGA 16-colour
  palette, and `CYCLES_PER_FRAME`. The CGA 0x04 decoder handles 2 bpp
  MSB-first packing and the even/odd plane split at 0x0000/0x2000,
  plus palette-bank selection from the 0x04F3 shadow byte.
- `player/calcite-bridge.js` (the default player's bridge): dropped
  the `isGfxMode === 0x13` binary check and the old `videoRegions`
  state that tracked what `detect_video()` found at compile time. Now
  dispatches per-frame on `pickMode(get_video_mode())`. `maybeEmitFrame`
  branches on `mode.kind`: `mode13`/`text`/`cga4`.
- `calcite/web/calcite-worker.js` (grid/canvas players): same table-
  driven refactor. Deleted ~110 lines of duplicated rasteriser + VGA
  palette; now imports from the shared module. Also fixed a leftover
  `videoRegions.gfx = {…}` assignment in `setFramebufferSAB` that
  referenced a variable the refactor removed.
- `carts/cga4-stripes/` (new smoke cart): .COM sets mode 0x04, writes
  palette reg 0x30 (palette 1 + intensity), paints four horizontal
  bands of colours 0..3 via REP STOSW. Purpose-built so a working
  decoder shows black / bright cyan / bright magenta / white.
- `tests/cga4.test.mjs` (new conformance): 18 checks covering kiln
  port-decode emit, @property shadow at 0x04F3, CGA aperture bounds,
  BIOS mode-branch presence, and the JS decoder against a known
  pixel pattern.

Verified in browser via the preview server:
- Direct decoder test (`tmp/cga4-verify.html`) — hand-built VRAM,
  decoder output sampled at canvas row centres, all four bands exact.
- End-to-end through CSS-DOS's `calcite-bridge.js` path
  (`tmp/cga4-integration.html`) — fetched 13.3 MB cabinet, compiled
  via WASM engine, ran 400k ticks, read back BDA 0x0449 = 0x04 and
  0x04F3 = 0x30, ran the decoder, all four bands exact.
- End-to-end through calcite's `calcite-worker.js` path
  (`tmp/cga4-worker-integration.html`) — worker's table-driven
  dispatch picked the cga4 branch, shipped pixels via the
  transferable-buffer path, canvas samples matched.
- Text-mode regression smoke (`tmp/text-worker-integration.html`) —
  hello-text cart still rasterises through the worker's text path
  after removing the binary text/13h split.

**Why:** User asked for CGA 0x04 and flagged the older pre-pixel-mode
text rendering as tech debt. The immediate need is the CGA support;
the structural need is to stop having to touch three files in two
repos every time a new video mode lands. Before this session the same
VGA palette constant was declared in `calcite-bridge.js`, `calcite-
worker.js`, and `calcite-core/src/state.rs`; the text rasteriser was
near-identical in bridge and worker; the mode-select logic was
hand-coded `(mode === 0x13) ? ... : ...` in two places. Adding EGA
planar or Mode-X next would have multiplied that. Now there's one
table, one decoder per kind, and two thin dispatchers.

**Key finding:** The shared-module contract that makes this work is
the dev server's `/calcite/` alias, which already existed for loading
the WASM pkg (`/calcite/pkg/calcite_wasm.js`). Calcite owns the web
renderer — CSS-DOS is a consumer of it, reached through the alias.
Both `calcite-worker.js` (relative `./video-modes.mjs`) and CSS-DOS's
`calcite-bridge.js` (absolute `/calcite/video-modes.mjs`) point at
the same file. If the alias is misconfigured, the import 404s loudly
— no silent rendering-is-wrong failure mode.

Second finding: `get_requested_video_mode()` in calcite-wasm had been
shipped but nothing in CSS-DOS wrote to the 0x04F2 shadow. The
"unsupported mode" warnings the players show were never actually
seeing the raw request — they were comparing the mode byte to itself.
Wiring the BIOS to populate 0x04F2 brings that API to life.

**Blocked on:** Nothing — checkpoint complete. Next steps: the
hack-path gossamer now accepts 0x04 but the README and docs haven't
called out that it shares the Corduroy table; and `calcite-canvas.html`
/ `grid.html` / `grid2.html` still hold their own local `MODE_GEOMETRY`
tables that duplicate MODE_TABLE. Those are cosmetic — the worker is
the source of truth for rendering decisions. Follow-up cleanup, not
blocking.

---

### 2026-04-21 — Session 15: pixel-canvas text modes + memory-zone UI

**What:** Three connected changes that together turn text modes and CGA
0x04 into first-class citizens in the grid player. Text modes now
rasterise through a real 8×16 VGA ROM font onto the same pixel grid
Mode 13h uses — no more HTML-text shim. Memory zones are now per-cart
opt-ins via the builder UI so carts that don't need (say) the 64 KB
Mode 13h buffer or the 4 KB text buffer stop paying for them in
cabinet bytes.

Checkpoint 1 (schema + kiln + builder + UI):
- `program.schema.json`: `memory.cgaGfx: boolean` added. `memory.gfx`
  and `memory.textVga` descriptions now cite byte costs.
- `kiln/memory.mjs`: `dosMemoryZones` emits the 16 KB CGA aperture at
  `0xB8000–0xBC000` when enabled. Overlap with the 4 KB text zone is
  handled by `buildAddressSet`'s dedup — enabling both costs only the
  text-plus-extension bytes, matching real CGA hardware.
- `builder/stages/kiln.mjs`: `prune.cgaGfx` plumbed (opt-in).
- `builder/presets/*.json`: all three have `cgaGfx: false` explicit.
- `web/site/build-simple.html`: new "Video:" row with three checkboxes.
- `web/site/assets/build.js`: checkboxes override `manifest.memory.*`
  per build. Row hidden on hack preset (which stays text-only).
- Verified by building a tiny DOS cart three times with different
  combos and grep'ing the resulting cabinet for zone boundary
  properties — all three shapes match the expected address ranges.

Checkpoint 2 (pixel-canvas text modes):
- `player/fonts/vga-8x16.bin`: 4096-byte IBM VGA 8×16 ROM font fetched
  from github.com/spacerace/romfont (public-domain VGA BIOS fonts). One
  glyph = 16 bytes, bit 7 = leftmost pixel. Verified by inspecting the
  `A` glyph at offset 0x410 — classic tall-A bitmap.
- `calcite/crates/calcite-{core,wasm}`: new `read_memory_range(addr, len)`
  WASM method that returns raw bytes. Doesn't interpret them — that
  respects calcite's "no x86 knowledge" rule. Used by the worker to
  fetch char+attr pairs from text VRAM.
- `calcite/web/calcite-worker.js`: loads the font via a new `setFont`
  message. Each text-mode tick, reads `width*height*2` bytes via
  `read_memory_range`, rasterises through the font atlas into an RGBA
  framebuffer, and ships it out either through the SAB (cross-origin
  isolated) or as a transferable ArrayBuffer (fallback — used when the
  page isn't COI-isolated, e.g. some headless browsers). Attribute byte
  drives fg/bg through the standard 16-color VGA palette.
- `player/grid.html`: fetches the font at startup, sends `setFont` to
  worker. On each mode change, builds (or rebuilds) the pixel grid at
  the right size — 640×400 for 80×25 text, 320×400 for 40×25, 320×200
  for Mode 13h. Grid's paint loop is unchanged: text-mode RGBA and
  Mode 13h RGBA hit the same palette-slot + className path.
- Verified end-to-end in the browser. Booted a DOS cart (KERNEL.SYS +
  config), saw "Enhanced DR-DOS kernel 20250427..." rendered with real
  VGA glyph shapes — tildes, slashes, chunky bitmap ascenders. 45% of
  real 8086 speed.

**Why:** User wanted consistent pixel-based rendering across all video
modes instead of HTML-text for text modes and `putImageData` for 13h.
Also pushed back on the original proposal to unconditionally allocate
all VRAM zones — CSS-DOS pays per-byte CSS properties for every byte of
guest RAM, so unused VRAM is real cost, not notional. Now users only
pay for modes they'll actually use.

**Key finding:** The preview browser (automation Chrome) doesn't get
cross-origin isolation even when headers are set, so the SAB path I
initially relied on for text rasterisation wouldn't trigger. Adding the
transferable-ArrayBuffer fallback made the feature work everywhere and
cost nothing — Mode 13h already had the same fallback. Lesson for
future renderer work: mirror both paths (SAB fast + transferable
fallback) from the start so verification doesn't depend on COI.

**Blocked on:** Nothing — checkpoint complete. CGA 0x04 is the next
piece (port 0x3D9 decode in kiln, 2-bpp decoder in the player, test
cart, Montezuma retest). Not started this session.

**Uncommitted work (in addition to everything at the top of the file):**
- CSS-DOS: `player/fonts/vga-8x16.bin`, `player/fonts/README.md`,
  extensive edits to `player/grid.html`, the build-simple.html video
  row, build.js wiring, schema + preset + kiln memory changes.
- Calcite: `crates/calcite-wasm/src/lib.rs` (new `read_memory_range`),
  `web/calcite-worker.js` (font atlas + text-mode rasteriser + SAB
  geometry tracking + transferable fallback), rebuilt `web/pkg/*`.

---

### 2026-04-20 — Session 14: vsync infrastructure + player paint-mode gate

**What:** User complained Mode 13h "is visibly drawing pixels — you can
see it scanning." Treated as hardware modelling rather than a perf
bug. Added port 0x3DA (VGA input status 1) decode in `kiln/patterns/
misc.mjs` on all four IN forms (0xE4/0xE5/0xEC/0xED): bit 3 = vertical
retrace, bit 0 = display-enable, both derived from `var(--__1cycleCount)`
on a 70 Hz cadence (CYCLES_PER_FRAME=68182, RETRACE_CYCLES=3409, per
the 4.77 MHz 8086 timebase). Reworked `player/calcite.html` to pick
the paint cadence from `?vsync=sim|wall|turbo` (and a status-bar
dropdown) instead of unconditionally calling `putImageData`. Added
`tests/vsync-poll.{asm,com}` + `carts/vsync-poll` + a node conformance
test `tests/vsync-poll.test.mjs`. Added a dev-server REPL in
`web/scripts/dev.mjs` for cache-clearing and fixed the autorun
dropdown's default in `web/site/assets/build.js`. Delegated bulk-copy
work (Op::MemoryCopy + runtime REP fast-forward) to a calcite worker
via a self-contained prompt.

**Why:** Real VGA hardware has no paint event — the CRT scans
continuously, and programs that care about tearing poll 0x3DA and
wait for retrace. "Scanning" in Mode 13h wasn't a renderer bug, it
was the player painting at an arbitrary cadence while the guest CPU
wrote pixels linearly. Exposing the retrace clock to the guest (so
programs can wait for it) AND tying the player's repaint to the same
simulated clock turns the scanning artifact into real hardware
behaviour: tear-free for programs that poll retrace, torn for programs
that don't.

**Key finding:** The tick-rate metric is misleading when bulk ops are
folded. Spent significant time chasing a perceived "30% vs 80% speed"
regression before realising (a) it was a stale WASM cache, not any
code change, and (b) "speed" in this project means two different
things — compile time and runtime ticks/sec — and improvements in one
can look like regressions in the other when total work shrinks.
Before claiming a slowdown, always ask: is the runtime actually
slower, or is the tick count just lower because the work got
vectorised? The cache-clearing REPL in `dev.mjs` exists specifically
so "stale pkg" is never a plausible cause again.

Secondary finding: the default DOS BIOS stack fix (session 13) for
Corduroy had shipped but the prebaked `web/prebake/corduroy.bin` was
from before, causing "BIOS patch: signature 0xBEEF not found" when
building carts. Running `node web/scripts/prebake.mjs` fixes it;
the new `reset` REPL command in `dev.mjs` does this automatically.

**Blocked on:** Nothing — checkpoint complete. Calcite-side bulk-copy
work is out-of-process (delegated); the CSS-side `display.vsyncMode`
field is declared in the schema but not yet wired into the cabinet
emit or player default-pick — both follow-ups.

---

### 2026-04-20 — Session 14b: REP fast-forward landed, stale rep-stosb cabinet refreshed

**What:** Calcite-side bulk-copy work (delegated in 14) landed:
`Op::MemoryCopy` mirror + runtime REP fast-forward for 0xAA/0xAB/0xA4/
0xA5. User asked to "fix the bug in kiln" that the calcite worker had
reported in its commit message. Investigated and found no bug. The
worker had read `tests/rep-stosb.css` (timestamped 2026-04-13) and
concluded the outer `calc(... + var(--prefixLen))` wrapper was missing
from the IP dispatch — that wrapper WAS missing in the April-13 file
but IS present in the current `kiln/emit-css.mjs` output. Regenerated
the cabinet with `builder/build.mjs` and confirmed variant-A semantics
(post-tick IP stays at the REP prefix byte during a continuing
iteration, as `misc.mjs::repIP` documents).

Regenerated the local `tests/rep-stosb.css` (gitignored, not in repo —
so nothing to commit for the refresh; the bad copy lived in each
agent's workdir). No kiln or emit-css changes.

Calcite followup commit `4472e60` ("drop variant-B IP detection —
kiln is not buggy") removed the byte-inspection heuristic I'd
mistakenly added; fast-forward IP delta simplifies to
`IP + 1 + prefixLen`.

**Why:** The hidden trap: a test-fixture CSS under version control
can go stale silently. The calcite worker had no way to know its
input was old. The defensive fix (variant-detection heuristic) also
hid the fact that the stale file was producing wrong behaviour in
Chrome too — a real user running that CSS would see the double-
prefix-add bug. Refreshing it forces the issue into the open.

**Key finding:** `tests/*.css` is already `.gitignore`d (good — that's
why the stale copy wasn't tracked). But there's still no signal when a
local workdir has a stale cabinet that predates a kiln change. Worth
having the conformance runner auto-regenerate before each test, or at
least print the source cabinet's mtime alongside the kiln file mtimes.
Logged here rather than acted on — not in scope for this session.

**Blocked on:** Nothing.

---

### 2026-04-19 — Session 13: autofit memory fix (Corduroy stack)

**What:** User reported that DOS builds using `memory.conventional:
"autofit"` (the default for `dos-corduroy`) never boot — only `"640K"`
worked. Root-caused to the Corduroy entry stub hardcoding its stack at
`0x9000:0xFFFE` (linear 0x9FFFE), which sits outside autofit memory.
Autofit for a tiny program produces memBytes=0x44000 (272 KB), so the
stack lives in unmapped memory: every `push`/`ret` silently corrupts
control flow, `call bios_init_` never returns to a valid address, and
boot dies inside BIOS init.

**Fix:** `bios/corduroy/entry.asm` now loads `mov ax, 0xBEEE` before
`mov ss, ax; mov sp, 0xFFFE`. `patchBiosStackSeg()` in
`builder/stages/kiln.mjs` rewrites the 0xBEEE immediate to
`(memBytes - 0x10000) >> 4`, placing the stack in a 64 KB window ending
just below the configured memory top. Mirrors the existing `0xBEEF`
→ `conventional_mem_kb` patch pattern.

**Verification:** Built the same tiny .COM cart with autofit vs 640K.
At 2M ticks both produce identical cycle counts (13,311,444) and the
same IP (295). Before the fix autofit stalled at IP=94 (spinning in
the IRQ0 handler after the call chain corrupted); 640K reached IP=295.
Prebaked web/prebake/corduroy.bin refreshed automatically via
`refreshPrebake` — browser builder gets the fix on next build.

**Scope:** Only affects Corduroy. Muslin sets its stack at 0x0030:0x0100
(inside the IVT) and was never broken. Hack path (.COM) doesn't use
this BIOS stub.

---

### 2026-04-19 — Session 12: eliza / COMMAND.COM keyboard investigation (inconclusive)

**What:** User reported keyboard doesn't work in ELIZA.EXE or
COMMAND.COM (bootle works). Triaged a prior-agent "add 186 opcodes"
theory, then started actual debugging. Did not reach a fix.

**Why:** The "add 186 opcodes" theory needed to be ruled out before any
opcode work happened; after ruling it out, we needed to locate where
eliza actually fails.

**Ruled out:**
- **Not a 186/286/386 gap.** Disassembled ELIZA.EXE and unpacked
  COMMAND.COM (UPX-packed SVARCOM). Both are pure 8086 — every 0xC1 in
  eliza is a FAR-ptr operand or ModR/M byte, not a shift-imm opcode. No
  0x0F, 0x66, 0x67 prefixes reachable. Kernel the same.
- **Not a `--IP` overflow.** Debugger's `/state.registers` reports raw
  state-var storage > 0xFFFF; the `properties` block at the same tick
  reports the correctly masked --CS/--IP/--ipAddr. Debugger reporting
  artefact, not a fetch bug.

**Observed but not root-caused:**
- Eliza prints its prompt, then freezes at CS:IP = 0FC8:0BE0 cycling
  through 5 addresses (0BE0→0BE3→0BE7→0BCE→0BD2→0BE0, period 5).
  Loop body (disasm): `mov si,[es:si]; cmp si,[0x1E]; jnz 0xBCE;
  cmp dx,[es:si+6]; jnz 0xBE0; ...`. It's a linked-list walk. At every
  tick in the loop SI=0, ES=0x7B06, bytes at ES:SI are zero, so SI stays
  0 forever. IF=0, halt=0, cycleCount advances.
- Eliza is in the **Watcom runtime segment** (0x0FC8), not its own image
  (0x0DF2). Entry signature found via memory scan at linear 0xDD9D with
  `CALL FAR 0DF2:0000`.
- **RESPONSE.DAT contents are NOT in memory.** Scanning all addressable
  memory for "Don't you believe" returned zero hits. The filename
  "RESPONSE" string is present (linear 0x1A24, 0x8A8B4) but the file
  contents have not been loaded.
- Eliza only uses INT 21h for I/O (20×; 0× INT 16h, 0× INT 10h). Input
  via AH=06h / AH=3Fh. File open via AH=3Dh at img offset 0x0F76 with
  correct `JC` error check.

**Working hypothesis (unverified):** Eliza prints prompt → tries to
open/read RESPONSE.DAT → something fails (read returns 0 / parse
produces empty list) → enters a linked-list walk over all-zero nodes →
loops forever. "Keyboard doesn't work" is likely a misdiagnosis — the
program probably never reaches an input call.

**Key finding:** Before going deep on disassembly or memory forensics,
run the minimal key-echo test. A 21-byte ECHO.COM exists at
`AppData/Local/Temp/echo_test/ECHO.COM`; the built cart is at
`/tmp/echo_test.css`. Neither has been run yet. If keys echo, the
keyboard path is fine and this is 100% an eliza data-structure issue.

**Infrastructure added:** `/run-until` endpoint in calcite-debugger
(`crates/calcite-debugger/src/main.rs`, uncommitted in calcite).
Conditions listed in Uncommitted work above. `int_num: 33` tested and
correctly locates INT 21h calls.

**Mistakes to avoid next session:** (1) Do the echo test FIRST, not
last. (2) Use `run_in_background: true` for the debugger process, not
trailing `&` — processes died at turn boundaries and orphaned the port.
(3) The `--IP > 0xFFFF` red herring wasted time; trust the masked
`properties` block.

**Not checked:** COMMAND.COM failure mode (session 11d noted it fails
separately — "Bad or missing command interpreter" on Corduroy, unusable
prompt on Muslin); Muslin running eliza; why bootle's INT 21h usage
differs from eliza's (bootle is .COM single-seg, eliza is .EXE
multi-seg + Watcom runtime).

**Blocked on:** Unresolved — see "Active blocker".

---

## Earlier sessions (one-line index)

Full text at `docs/archive/logbook-sessions-1-12-2026-04.md`.

- **Session 11d (2026-04-18) — launcher tidy-up.** Bridged calcite launcher to
  `builder/build.mjs`. `.gitignore` no longer swallows presets. `mkfat12.mjs`
  root dir 16 → 224 entries. Default preset Muslin → Corduroy.
- **Session 11c (2026-04-18) — Doom8088 blockers #25/#26/#27/#28.** Corduroy
  INT 09h handler + EOI on INT 08h/09h. Kiln emits break scancodes and
  `--_kbdPort60`. Port 0x21 IN now returns `--picMask`. `compare.mjs` fixed
  for v4 (uOp, ANSI prefix).
- **Session 11b (2026-04-18) — the big rename.** Vocabulary
  (cart/cabinet/floppy/Kiln/builder/Gossamer/Muslin/Corduroy/player).
  `builder/build.mjs` replaces the three `generate-*.mjs`. `program.schema.json`
  + `docs/cart-format.md` canonical. BIOS files fan out. Player HTML extracted.
  Ref emulators → `conformance/`. See CHANGELOG for full move list.
- **Session 11a (2026-04-18) — Doom8088 readiness + IRQ phases 1–3.** PIC/PIT
  port decode, PIT countdown from `--cycleCount/4`, single-cycle IRQ override
  (SP/IP/CS/flags push, jump to IVT vector). IRQ 0 + IRQ 1 only. No palette
  writes, no break-scancode edge (closed later in 11c).
- **Session 10 (2026-04-15) — rom-disk end-to-end + calcite flat-array + CLI
  menu.** Bootle boots via rom-disk. Calcite's `Op::DispatchFlatArray` wired
  up. `calcite-cli` grid menu. Bootle: parse 4.7s, compile ~16s, 1 tick ~74µs.
- **Session 9 (2026-04-14) — rom-disk on feature branch.** Disk bytes outside
  the 1 MB space, accessed through a 512-byte window at 0xD0000; LBA at
  linear 0x4F0 (NOT BDA_SEG:0x4F0). Single-param `--readDiskByte(--idx)` to
  avoid the two-param cross-product 48 GB OOM. Commit `8c407d9` bundles V4
  on master.
- **Session 8 (2026-04-14) — V4 architecture.** Abandoned v3 μOp sequencer;
  restored v2 single-cycle with 8 write slots. Ported v3 improvements one at
  a time: Mode 13h, contiguous memory, SP clamp, OF shift-by-CL, `--cycleCount`,
  keyboard CSS, BDA ring buffer. V3 microcode archived to `legacy/v3/`.
- **Session 7 (2026-04-14) — boot crash fixed.** Root cause: unconditional
  0xD6 microcode BIOS handler registration collided with 53 x 0xD6 bytes in
  the kernel. Added `skipMicrocodeBios` flag. SP overflow (20-bit on 640 KB)
  fixed with `& 0xFFFF`. Calcite debugger gained `/watchpoint`.
- **Session 6 (2026-04-13) — batched write slots + PIT fixes.** 32 slots
  activate only on REP string opcodes (~5× CSS growth, HashMap-friendly).
  DF=1 not handled. `pitReload=0` now means 65536. PIT-in-bios_init attempt
  reverted (early-init IRQs clobbered the version string).
- **Session 5 (2026-04-13) — assembly BIOS revival.** Copied old gossamer BIOS
  to `bios/css-emu-bios.asm`. Fixed INT 13h hard-disk probe bug (DL >= 0x80
  must return CF=1). Built `boot-trace.mjs`. Decision: C BIOS is long-term.
- **Session 4 (2026-04-13) — BIOS gaps.** INT 1Ah AH=00h now reads BDA tick
  counter. INT 10h AH=0Eh handles CR/LF/BS/BEL via `--biosAL`. PIT/EOI
  attempt reverted (regression).
- **Session 3 (2026-04-13) — BIOS init stub + handlers.** `bios/init.asm`
  at F000:0000 populates IVT, BDA, VGA splash, JMP FAR to kernel. Added INT
  13h hard-disk probe responses, INT 1Ah, INT 16h shift flags, INT 10h set
  mode. `isHardDisk` guard pattern (DL >= 128) established.
- **Session 2 (2026-04-13) — IRET fix + DOS path rewrite.** Folded IRET
  pops into single retirement uOp to avoid decode pipeline corruption.
  Rewrote `generate-dos.mjs` without `gossamer-dos.asm`. Fixed memory gap at
  kernel relocation target. `compare-dos.mjs` added.
- **Session 1 (2026-04-13) — calcite slot aliasing fix + INT 09h.** Slot
  compactor aliased LoadMem dest with Dispatch dest inside nested dispatch;
  `compact_sub_ops` liveness didn't follow nested fallback_ops. Fixed by
  inlining exception checks as BranchIfZero/Jump chain. `/trace-property`
  and `/dump-ops` endpoints added.
