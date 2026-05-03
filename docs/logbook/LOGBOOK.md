# CSS-DOS Logbook

Chronological work entries. Newest first. The durable handbook
(current state, sentinels, gotchas, how to test) is in
[`STATUS.md`](STATUS.md).

Last updated: 2026-05-02

## 2026-05-02 — kbdtap → bench reaches in-game

Calcite-core gets a new `setvar_pulse=NAME,VALUE,HOLD_TICKS` action
that schedules a make/break edge pair, and `cond:repeat` is fixed to
sustain mode (fire on every gated poll while held, matching its
existing doc) instead of the previous rising-edge implementation.
See `../calcite/docs/log.md` 2026-05-02 for the engine-side details.

The CSS-DOS-side `doom-loading` profile uses these to spam Enter
through title and menu screens. The CLI bench reaches in-game:

```
text_drdos    1.5 s    tick=450 K
text_doom     5.3 s    tick=1.55 M
title        13.3 s    tick=3.85 M
menu         13.3 s    tick=4.10 M
loading      14.3 s    tick=5.10 M
ingame      145.8 s    tick=34.65 M  (GS_LEVEL reached, halt)
```

Pre-cleanup baseline (old `--cond/--spam` DSL): 119 s / 35 M ticks.
Post-kbdtap: 145.8 s / 34.65 M ticks. +22 % wall is the new
watch-poll overhead (8 cond watches gated on a 50 K-tick stride);
ticks/cycles essentially identical.

Open follow-ups: web-target bridge tickloop progression after
`bench-run` (likely SW + viewer-port plumbing); retire the old
`tests/harness/bench-doom-stages*.mjs` scripts once web target also
passes.

## 2026-05-01 — Repo cleanup: script primitives + bench harness + web/player merge

Big-bang cleanup across both repos. Branches `cleanup-2026-05-01`
in CSS-DOS and calcite.

**Calcite engine — script-primitive layer.** Logged in
`../calcite/docs/log.md` 2026-05-01. Generic measurement primitives
(stride/burst/at/edge/cond/halt + actions emit/halt/setvar/dump/
snapshot) in calcite-core, exposed identically on calcite-cli
(`--watch` flag) and calcite-wasm (`engine.register_watch`). Old
`--cond` / `--poll-stride` / `--script-event` removed cleanly.
Three new modules in calcite-core (`script.rs`, `script_eval.rs`,
`script_spec.rs`); ~280 LOC removed from calcite-cli/main.rs.
Grammar reference: [`docs/script-primitives.md`](../script-primitives.md).

**CSS-DOS bench harness.** New harness at `tests/bench/`:

- `lib/ensure-fresh.mjs` — staleness primitive. Mtime check artifact
  vs declared inputs (file globs + transitive artifact deps);
  rebuild if stale; `--no-rebuild` bypass.
- `lib/artifacts.mjs` — declarative manifest of every built artifact
  (`wasm:calcite`, `cli:calcite`, `prebake:{corduroy,gossamer,muslin}`,
  `cabinet:{doom8088,zork1,montezuma,hello-text}`).
- `driver/run.mjs` — Node CLI. Two transports (web via Playwright,
  cli via calcite-cli). Calls `ensureArtifact` for every required
  artifact before running.
- `page/index.html` — page-side bench runner. Spawns the
  calcite-bridge worker, posts cabinet-blob, listens for compile-done.
- `profiles/compile-only.mjs` — sanity profile; passes end-to-end.
- `profiles/doom-loading.mjs` — six-stage doom8088 boot bench
  (CLI target reaches in-game with kbdtap landed 2026-05-02).

**CSS-DOS-side web/player merge.** `player/*` → `web/player/*`
(history preserved via git mv). `player/calcite-bridge.js` →
`web/shim/calcite-bridge.js`. URL paths kept stable (`/player/...`,
`/sw.js`, `/cabinet.css`, `/_stream/fb`, `/_kbd?key=`); only the
dev-server alias map changed. `?bench=1` inline `<script>` block
removed from `web/player/calcite.html` — the player is now zero-script.
The service worker stays at `web/site/sw.js` because SW scope must
be at-or-above `/`.

**Calcite-side cleanup.** ~17 K LOC removed: `site/`, `programs/`,
`output/`, `serve.mjs`, `serve.py`, 6 `.bat` files; 9 zombie tools
moved to `tools/archive/`; `menu.rs` stripped of the
`node ../CSS-DOS/builder/build.mjs` shell-out (cardinal-rule
violation). `cargo test --workspace` clean.

**Docs.** `docs/rebuild-when.md` (artifact graph + ensureFresh +
/_reset/_clear endpoints); `tools/README.md` rewritten;
`docs/INDEX.md` updated; logbook discipline rule added to both
CLAUDE.md files. Calcite-perf entries (10 days, 2026-04-28 to
2026-05-01) migrated from this LOGBOOK to `../calcite/docs/log.md`
(stubs cross-link). Old `bench/` directory removed; 43 fast-shot
PNGs deleted from `tests/harness/results/` and gitignored; 8
calcite probe `.exe`s deleted (source files stay).

**Validation.** Web bench post-merge: 143 s runMsToInGame /
34.3 M ticks / 398.7 M cycles (cabinet=332 MB). Pre-cleanup
baseline: 134.6 s / 34.5 M ticks / 407 M cycles. +6.5 % wall (within
±10 % budget); ticks/cycles essentially identical. Cargo test:
161 PASS / 4 pre-existing rep_fast_forward failures. wasm-pack: clean.

## 2026-05-01 — keyboard latch: port 0x60 holds break code until ISR services it

Three coupled bugs in the keyboard input path, all surfacing on
doom8088 because it's the only cart that hooks INT 09h directly
(replacing corduroy's stub). All fixed.

**Bug 1: zork "G" → "gg" (double-press).** `calcite-wasm::set_keyboard`
was calling both `state.bda_push_key(key)` AND `set_var("keyboard", k)`.
Once corduroy installed an INT 09h handler that also pushes to the BDA
ring, every press doubled. Fix: drop the wasm-side bda_push_key. The
cabinet's ISR is the single source of ring writes.
(`calcite-wasm/src/lib.rs::set_keyboard`.)

**Bug 2: doom "left arrow held forever".** Bridge's release path was
`setTimeout(() => set_keyboard(0), 100)`. The bridge worker lives in
build.html (background tab); Chrome throttles setTimeout in
background-tab workers to ~1Hz, so releases fired seconds late or
piled up. Fix: drive the release off the tickLoop counter (which uses
MessageChannel, immune to throttling). 3 batches ≈ 100ms wall but
bound to engine progress, not wall clock.
(`web/shim/calcite-bridge.js` v43-tick-driven-release.)

**Bug 3: Enter doesn't open the menu in demo loop.** This was the
real sink. `--_kbdPort60` returned the break code only on the *single
tick* the release edge fired:

```css
--_kbdPort60: if(
  style(--_kbdRelease: 1): --or(prevScancode, 128);
  else: scancode_or_zero
);
```

`_kbdRelease=1` for one tick (the transition); the IRQ pends in
`--picPending` but DOOM's ISR may not run until N ticks later (IF
gates, nested PIT IRQ, etc.). By then, port 0x60 returns 0, ISR sees
scancode 0, DOOM's "left held" flag never clears.

Fix: new state-var `--kbdScancodeLatch` holds the most recent
scancode (make on press, break on release) until the next edge. Port
0x60 reads the latch on non-edge ticks. Required three coupled
changes in Kiln:

1. `STATE_VARS` entry → `@property` decl + double-buffer rotation +
   `--__1kbdScancodeLatch` snapshot (otherwise the var never
   registers with calcite, get_state_var returns 0, and the latch is
   invisible).
2. `regOrder` entry + custom default expression mirroring port 0x60's
   edge logic.
3. Updated `_kbdPort60` to fall through to `__1kbdScancodeLatch`.

Verified via Playwright diagnostic: `_g_usergame` flips to 1 at
t=55.9 s — DOOM accepted "New Game" from menu.

Files: `kiln/template.mjs`, `kiln/emit-css.mjs`,
`kiln/patterns/misc.mjs`, `web/shim/calcite-bridge.js`,
`calcite-wasm/src/lib.rs`. Cabinet rebuild required. Snapshots
from before this date are invalidated (state-var ordering changed).

Cardinal-rule check: the latch is generic CSS-side keyboard-controller
modelling. Any cabinet whose CSS sets `--keyboard` and reads
`_kbdPort60` benefits — the rule is "scancode is level-readable
until the next edge", which is what real PC kbd hardware does. No
upstream knowledge encoded.

## 2026-05-01 — LoadPackedByte: euclid → bitwise byte extract

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-05-01.

## 2026-04-30 — FxHashMap swap: +25% ingame fps, −24% web level-load

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-30.

## 2026-04-30 — Web flamegraph: exec_ops dominates, hashing is 17%

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-30.

## 2026-04-30 — read_mem borrow-overhead fix: dead lead, reverted

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-30.

## 2026-04-30 — BIfNEL2 fusion: dead lead, off by default

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-30.

## 2026-04-29 — runtime op-adjacency profile (post-fusion truth)

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — REP FFD: leave alone

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — calcite: DiskWindow → WindowedByteArray rename

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — load+compare+branch widening: dead lead, reverted

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — fusion FFD: funnel data + verdict (dead end on this window)

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — fusion FFD: framing + diag redesign

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — bridge: hash-gated emit + 30Hz sampler

**Problem.** Web bridge claimed 20 fps (TARGET_MS=50, BMP/batch).
User-perceived rate doom8088 gameplay = ~1-2 fps. The other 18
paints/s were duplicates (~5-10 ms each: BMP alloc + transferable
post + browser BMP-decode + DOM put).

**Fix** (`web/shim/calcite-bridge.js` v41):

- Decouple paint cadence from tick loop. New setInterval at
  FRAME_SAMPLER_HZ=30 calls `maybeEmitFrame` independently of batches.
- Hash-gate emit. `maybeEmitFrame` computes FNV-1a over sparse 1KB
  rgba subsample, short-circuits when unchanged.
- Drop produced-frame adaptive batch sizing (didn't help). Fixed
  TARGET_MS=33ms, simple 0.5×/2×.

**Results** (doom8088, 60s LEFT, fusion OFF):

```
simulatedFps = 34.2  (vs native 35Hz)
vramFps      = 1.6   (cabinet's true visible-frame rate)
paintFps     = 2.1   (was 19.5 pre-hash-gate — 9× fewer dups)
```

Each gametic only renders one column strip; full visible frame builds
over many gametics → ~600 ms per fully-painted screen.

## 2026-04-29 — fusion disabled by default (net loss, investigation pending)

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — fusion-sim: 88.6% body compose on doom column-drawer

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-29 — calcite-v2-rewrite Phase 1 lands

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-29.

## 2026-04-28 — calcite Phase 3 prototype: closure backend

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — calcite Phase 2: recogniser substrate

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — Load-time fusion: byte_period + fusion_sim

Calcite-engine work (incl. body-composition probe followup). Logged
in `../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — Replicated-body recogniser: built, dead lead

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — XLAT segment-override fix (kiln correctness)

Kiln emitted `--_xlatByte` with DS hard-coded, ignoring 0x26 / 0x2E /
0x36 / 0x3E prefix. Doom8088 column drawer uses `ss xlat` twice per
pixel for SS:BX colormap (`i_vv13ha.asm`, `i_vv13ma.asm`,
`i_vv13la.asm`, `i_vegaa.asm`, `i_vmodya.asm`, `i_vcgaa.asm`) —
every textured pixel read from DS:BX+AL. Fix: use `--directSeg`
(override-or-DS) at `kiln/decode.mjs:362`.

Verified: smoke 7 carts green; Doom8088 reaches in-game on web
(`stage_ingame` tick 34.4 M, `runMsToInGame` 110 s); gameplay frame
correct. Title splash unaffected (V_DrawRaw, no XLAT).

Also rewired smoke list — small carts moved to `carts/test-carts/`
so harness was silently running only zork+montezuma; now all 7 fire.

## 2026-04-28 — 3 word-slot scheme

Kiln moves from **6 byte-slots → 3 word-slots** for memory writes.
Each slot carries `--_slotKWidth` (1 or 2): width=2 packs addr/addr+1
byte pair into one slot whose `--memValK` holds the un-split 16-bit
word. INT/IRQ frames (FLAGS+CS+IP = 3 words) fit new 3-slot worst
case exactly. `--applySlot` becomes 6-arg (loOff, hiOff, val,
width): aligned-word, byte, odd-addressed straddle splices.

Calcite recogniser (`packed_broadcast_write.rs` + parser fast-path)
updated to 6-arg shape; `CompiledPackedBroadcastWrite` gains
`width_slot`; `compile.rs`/`eval.rs` apply 1- or 2-byte writes per
port per tick.

| Cart    | 6-slot   | 3-slot   | Δ      |
|---------|---------:|---------:|-------:|
| dos-smoke (test) | 152.6 MB | 139.9 MB | −8.3% |
| zork1   | 299.6 MB | 274.7 MB | −8.3% |
| doom8088 | 341.7 MB | 316.9 MB | −7.3% |

Doom8088 stage bench:

| Stage         | 6-slot     | 3-slot     | Δ        |
|---------------|-----------:|-----------:|---------:|
| text_drdos    |  1 110 ms  |  1 083 ms  | −2.4%    |
| text_doom     |  3 751 ms  |  3 635 ms  | −3.1%    |
| title         |  9 524 ms  |  9 284 ms  | −2.5%    |
| menu          | 10 304 ms  | 10 024 ms  | −2.7%    |
| loading       | 13 655 ms  | 13 319 ms  | −2.5%    |
| **ingame**    | **90 995** | **85 323** | **−6.2%** |
| ticksToInGame | 35 000 000 | 35 000 000 | identical |
| cyclesToInGame| 397 458 534| 397 458 534| identical |

Same cycle/tick counts → CPU work identical; savings = per-tick CSS
eval. Level-load (loading→ingame, 29.5 M ticks): 77.3 s → 72.0 s =
−6.9%. Zork1 5M-tick: ~3% per-tick speedup, no per-cycle regression,
20% faster compile.
