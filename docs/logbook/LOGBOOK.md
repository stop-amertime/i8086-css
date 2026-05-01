# CSS-DOS Logbook

Last updated: 2026-05-01

## 2026-05-01 — Repo cleanup: Chunks D + E + F + G

**Chunk D (calcite engine — script-primitive layer):** logged in
`../calcite/docs/log.md` 2026-05-01. Generic measurement primitives
(stride/burst/at/edge/cond/halt + actions emit/halt/setvar/dump/
snapshot) in calcite-core, exposed identically on calcite-cli
(`--watch` flag) and calcite-wasm (`engine.register_watch`). Old
`--cond`/`--poll-stride`/`--script-event` removed cleanly. Three new
modules in calcite-core (`script.rs`, `script_eval.rs`,
`script_spec.rs`), ~280 LOC removed from calcite-cli/main.rs, ~120 LOC
added to calcite-wasm/lib.rs. 14 unit tests + 7 integration tests, all
green. Cardinal-rule check: zero upstream knowledge.

**Chunk E (CSS-DOS bench harness — partial):** new harness at
`tests/bench/`:

- `lib/ensure-fresh.mjs` (200 LoC) — staleness primitive. Mtime check
  artifact vs declared inputs (file globs + transitive artifact deps);
  rebuild if stale; `--no-rebuild` bypass. 15/15 unit tests green.
- `lib/artifacts.mjs` — declarative manifest of every built artifact:
  `wasm:calcite`, `cli:calcite`, `prebake:{corduroy,gossamer,muslin}`,
  `cabinet:{doom8088,zork1,montezuma,hello-text}`. Adding a new
  artifact is one entry.
- `driver/run.mjs` — Node CLI. Two transports (web via Playwright, cli
  via calcite-cli). Calls `ensureArtifact` for every required artifact
  before running.
- `page/index.html` — page-side bench runner. Spawns the
  calcite-bridge worker, posts cabinet-blob, listens for compile-done
  on `cssdos-bridge-stats`.
- `profiles/compile-only.mjs` — sanity profile. PASSES end-to-end.
- `profiles/doom-loading.mjs` — replacement for bench-doom-load /
  bench-doom-stages. CLI target reaches text_drdos / text_doom /
  title; title→menu progression NOT working (the new
  `setvar=keyboard,KEY` action doesn't generate make/break cycles the
  way the deleted `--cond ... :then=spam:KEY:every=N` did).

**Honest status of E**: foundation + structure done. The old
`bench-doom-stages.mjs` / `bench-doom-stages-cli.mjs` /
`bench-doom-load.mjs` / `bench-doom-gameplay.mjs` / `bench-web.mjs`
scripts are unchanged on this branch and remain the production
benches until the new harness reaches parity. Three follow-ups to
close E:

1. Add a `kbdpress=KEY` (or `kbdtap=KEY,duration=N`) action to
   calcite-core that emits make+break over consecutive emits. Touches
   `script.rs::Action`, `script_eval::poll`, parser. Small.
2. Once kbdtap lands, wire title/menu spam in `doom-loading.mjs` and
   verify the CLI bench reaches `ingame` within ~150 s (matching the
   pre-cleanup baseline).
3. Web-target debugging: page→bridge→engine completes compile-done
   but the bridge's tick loop doesn't progress when `bench-run`
   triggers. Likely an interaction with the SW + viewer-port plumbing
   the bench page bypasses. Probably fixable by either opening a
   dummy `/_stream/fb` fetch on the bench page or wiring keyboard via
   the bridge's existing `kbd` MessagePort handler instead of the
   SW's `/_kbd` URL.

Once those are in, retire the 6 old bench scripts in one commit.

**Chunk F (docs):** `docs/rebuild-when.md` (artifact graph +
ensureFresh + /_reset/_clear endpoints), `tools/README.md` rewritten,
`docs/INDEX.md` updated to point at `tests/bench/README.md`.
mcp-shim autostart claim reconciled with `start-debugger-daemon.bat`.
Logbook discipline rule added to both `CLAUDE.md` files.
Calcite-perf entries (10 days of work, 2026-04-28 to 2026-05-01)
migrated from this LOGBOOK to `../calcite/docs/log.md` — stubs
remain here cross-linking. Per audit §7.

**Chunk G (debris sweep):** old `bench/` directory removed. 43
fast-shot PNGs deleted from `tests/harness/results/` and gitignored
along with conformance JSON snapshots. `tmp/` wiped. 8 calcite probe
`.exe` binaries deleted from `target/release/` (source files stay).
`docs/superpowers/` untracked.

**Validation against Chunk A baseline:**
- Web bench (post-merge, mid-cleanup): 143 s runMsToInGame / 34.3 M
  ticks / 398.7 M cycles. Baseline pre-cleanup: 134.6 s / 34.5 M
  ticks / 407 M cycles. +6.5% wall, ticks/cycles essentially
  identical. Within ±10% budget.
- CLI bench (new harness): cabinet build + parse + compile working;
  7 watches register; 3 stages detect (text_drdos / text_doom /
  title) before the keyboard-input gap.
- Calcite cargo test: 161 PASS / 4 pre-existing rep_fast_forward
  failures (unchanged from chunk A).
- wasm-pack: clean.

## 2026-05-01 — Logbook migration: calcite-engine entries moved to calcite/docs/log.md

Per audit §7: ~10 days of calcite-perf entries (2026-04-28 to
2026-05-01) accidentally written to CSS-DOS LOGBOOK because CLAUDE.md
auto-loads it. Migrated them to `../calcite/docs/log.md`. Stubs
remain here cross-linking to the new location. The new logbook
discipline rule (in both CLAUDE.md files) prevents this recurring.

## 2026-05-01 — Repo cleanup: Chunks B + C complete

**Chunk B (calcite-side):** see `../calcite/docs/log.md` 2026-05-01 entry.
5 commits on `cleanup-2026-05-01` calcite branch deleting CSS-DOS-shaped
infrastructure (`site/`, `programs/`, `output/`, `serve.mjs`, `serve.py`,
6 .bat files), archiving 9 zombie tools to `tools/archive/`, deleting 2
BROKEN tools, and stripping menu.rs of the `node ../CSS-DOS/builder/
build.mjs` shell-out. ~17 K LOC removed. `cargo test --workspace`: 148
PASS / 4 pre-existing rep_fast_forward failures (no regression). wasm-pack
builds cleanly.

**Chunk C (CSS-DOS-side, web/player merge):** one big commit `430a507`.
- `player/*` → `web/player/*` (calcite.html, raw.html, bench.html,
  calcite-canvas.html, turbo-meter.html, serve.mjs, README.md, assets/,
  fonts/, experiments/) — 22 files, history preserved via git mv.
- `player/calcite-bridge.js` → `web/shim/calcite-bridge.js`
- `web/site/assets/calcite-bridge-boot.js` → `web/shim/calcite-bridge-boot.js`
- `calcite/web/video-modes.mjs` → `web/shim/video-modes.mjs` (copied;
  the calcite-side copy stays for now so calcite/web/calcite-worker.js
  keeps resolving — calcite-side cleanup is a follow-up).
- `web/site/sw.js` stays at `web/site/sw.js`. Service workers must be
  served at or above their scope, and ours is `/`. Conceptually shim,
  physically site/ — documented in dev.mjs.
- URL paths kept stable (`/player/...`, `/sw.js`, `/cabinet.css`,
  `/_stream/fb`, `/_kbd?key=`); only the dev-server alias map and a
  handful of script-src attributes change. `/shim/` alias added.
- `?bench=1` inline `<script>` block removed from web/player/calcite.html.
  Player is now zero-script: pure HTML+CSS as designed.
- `.gitignore` updated to cover root cabinets and `tests/bench/cache/`.

**End-to-end verified:**
- Web bench against the merged tree: 143.3 s runMsToInGame / 34.3 M ticks
  / 398.7 M cycles (cabinet=332 MB). Baseline pre-merge: 134.6 s / 34.5 M
  ticks / 407 M cycles. +6.5 % wall, within the ±10 % budget; ticks and
  cycles essentially identical (so calcite is doing the same work).
- All 6 doom8088 stages reached: text_drdos → text_doom → title → menu
  → loading → ingame.
- Dev server: every URL surface (`/build.html`, `/sw.js`,
  `/shim/{calcite-bridge,calcite-bridge-boot,video-modes}.mjs`,
  `/player/{calcite,bench,raw}.html`, `/player/assets/player.css`)
  serves 200 from new resolution.

**Watchout for the next agent (or future me):** `tests/harness/bench-*.mjs`
default to `--port=5173`. If you have an old dev server running on 5173
and start a new one on a different port, the bench will silently hit the
old one. Lost an hour to this. The bench harness rebuild in Chunk E
should pick the dev-server port from `_status` rather than defaulting.

## 2026-05-01 — Repo cleanup: Chunk A baseline + inventory

Bigbang cleanup branch `cleanup-2026-05-01` opened in both repos
(`f8df6ef` calcite WIP committed first, `0f7ae2d` CSS-DOS WIP committed
first; both pushed to origin). Driven by `docs/cleanup-agent-prompt.md`
and `docs/audit-summary-and-plan.md`.

**Decisions locked in:**
- web/ becomes the unified front-end root; player/ folds in as web/player/
- player shim consolidates under web/shim/
- Bench harness lives at `tests/bench/`, with `tests/bench/cache/` for
  cabinets (ephemeral, gitignored)
- Build staleness handled by an `ensureFresh(artifact)` helper that
  consumers (bench, smoke, dev server) call before reading. mtime check
  vs declared inputs; rebuild if stale; `--no-rebuild` bypass. Same
  primitive for cabinets, prebake bins, calcite-wasm. Documented in
  `docs/rebuild-when.md` (Chunk F).
- `--cond` DSL on calcite-cli replaced cleanly by Chunk D's primitives;
  no back-compat alias.

**CLI baseline** (`tmp/baseline-cli-doom.json`, fresh-rebuilt
doom8088.css, calcite-cli at f8df6ef):

```
totalWallMs        137 182
text_drdos         1 597 ms / 450K ticks
text_doom          5 090 ms / 1.55M ticks
title             12 678 ms / 3.85M ticks
menu              13 795 ms / 4.15M ticks
loading           18 529 ms / 5.5M ticks
ingame           119 012 ms / 35M ticks (cycles 397 459 342)
```

Note: this is slower than 2026-04-28's "73s loading→ingame" / 91 s ingame
figures because calcite f8df6ef merges the FxHash WIP from main but the
release binary in `target/release/` was built before that change. Chunk
E's bench-rebuild verification uses this baseline as-is (apples-to-apples
against the same calcite-cli the rest of the cleanup will see).

**Web baseline:** running in background.

**Inventory verdicts** (audit §6/§9 zombie-status questions):
- `out/` — doesn't exist locally. Builder default; vestigial. Builder's
  default-output convention can be revisited in Chunk E.
- `tools/compare-dos.mjs`, `calcite/tools/{fulldiff,ref-dos}.mjs` — all
  three confirmed BROKEN (header self-declares; imports deleted
  `transpiler/`). Delete in B.
- `calcite/tools/{diagnose,codebug,boot-trace,calc-mem,ref-emu,
  compare,serve-js8086,serve-web,test-daemon-smoke}.mjs` — imports
  resolve, headers don't say BROKEN. But several reference
  `../CSS-DOS/builder/build.mjs` shell-out (cardinal-rule violation,
  audit §11 Severity 1). Per plan: move to `calcite/tools/archive/`
  rather than delete outright (reversible).
- `calcite/programs/`, `calcite/output/`, `calcite/site/`, `calcite/
  serve.mjs`, `calcite/serve.py` — confirmed CSS-DOS-shaped. Per plan
  Chunk B: delete (Severity 1 from audit §11). The "WORKS" status
  reported by deeper inspection is irrelevant — they belong in CSS-DOS
  or nowhere, and CSS-DOS already has its own dev server (`web/scripts/
  dev.mjs`).
- `bench/` (CSS-DOS) — 4 prebuilt cabinets + 3 carts + run.mjs +
  results.md (last entry 2026-04-20). Audit user-confirmed deletable.
  Removed in Chunk E once the new harness is in place.
- `docs/superpowers/` — tracked despite being in .gitignore (committed
  before the gitignore entry). Untrack in Chunk F.
- `player/calcite.html` — still has the `?bench=1` `<script>` block at
  line ~295. Plan says user is removing it; they haven't. Will handle
  in Chunk C.
- `--cond` flag — only consumer outside calcite-cli's parser is
  `tests/harness/bench-doom-stages-cli.mjs`. Clean replacement is safe.
- 20 `probe_*.rs` source files; 8 corresponding `.exe`s in
  `target/release/`. Source stays (rebuildable diagnostic tools); .exes
  swept in Chunk F.

Doom8088 cabinet rebuilt fresh from `carts/doom8088` (`builder/build.mjs
carts/doom8088 -o doom8088.css`, ~13s, 316.9 MB). Replaces the stale
2-day-old root cabinet; matches what the new bench harness will see.

## 2026-05-01 — keyboard latch: port 0x60 holds break code until ISR services it

Three coupled bugs in the keyboard input path, all surfacing on doom8088
because it's the only cart that hooks INT 09h directly (replacing
corduroy's stub). All fixed.

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
(`player/calcite-bridge.js` v43-tick-driven-release.)

**Bug 3: Enter doesn't open the menu in demo loop.** This was the real
sink. `--_kbdPort60` returned the break code only on the *single tick*
the release edge fired:
```css
--_kbdPort60: if(
  style(--_kbdRelease: 1): --or(prevScancode, 128);
  else: scancode_or_zero
);
```
`_kbdRelease=1` for one tick (the transition); the IRQ pends in
`--picPending` but DOOM's ISR may not run until N ticks later (IF gates,
nested PIT IRQ, etc.). By then, port 0x60 returns 0, ISR sees scancode
0, DOOM's "left held" flag never clears.

Fix: new state-var `--kbdScancodeLatch` holds the most recent scancode
(make on press, break on release) until the next edge. Port 0x60 reads
the latch on non-edge ticks. Required three coupled changes in Kiln:
1. `STATE_VARS` entry → `@property` decl + double-buffer rotation +
   `--__1kbdScancodeLatch` snapshot (otherwise the var never registers
   with calcite, get_state_var returns 0, and the latch is invisible).
2. `regOrder` entry + custom default expression mirroring port 0x60's
   edge logic.
3. Updated `_kbdPort60` to fall through to `__1kbdScancodeLatch`.

**Verified via Playwright diagnostic** (`tmp/diag-enter*.mjs`):
- Pre-fix: Enter at demo loop, 267 presses, BDA tail stuck at 34, never
  reach `_g_usergame=1`.
- Post-fix: 109 presses, ISR fires (`inService=1`), latch correctly
  shows make code 0x1c then break 0x9c, **`_g_usergame` flips to 1 at
  t=55.9s** — DOOM accepted "New Game" from menu.

Files: `kiln/template.mjs`, `kiln/emit-css.mjs`, `kiln/patterns/misc.mjs`,
`player/calcite-bridge.js`, `calcite-wasm/src/lib.rs`. Cabinet rebuild
required. Snapshots from before this date are invalidated (state-var
ordering changed: new `kbdScancodeLatch` slot inserted).

Cardinal-rule check: the latch is generic CSS-side keyboard-controller
modelling. Any cabinet whose CSS sets `--keyboard` and reads
`_kbdPort60` benefits — the rule is "scancode is level-readable until
the next edge", which is what real PC kbd hardware does. No upstream
knowledge encoded.

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

**Problem**: web bridge claimed 20fps (TARGET_MS=50, BMP/batch).
User-perceived rate doom8088 gameplay = ~1-2 fps. The other 18 paints/s
were duplicates (~5-10ms each: BMP alloc + transferable post + browser
BMP-decode + DOM put).

**Fix** (`player/calcite-bridge.js` v41):
- Decouple paint cadence from tick loop. New setInterval at
  FRAME_SAMPLER_HZ=30 calls `maybeEmitFrame` independently of batches.
- Hash-gate emit. `maybeEmitFrame` computes FNV-1a over sparse 1KB rgba
  subsample, short-circuits when unchanged.
- Drop produced-frame adaptive batch sizing (didn't help). Fixed
  TARGET_MS=33ms, simple 0.5×/2×.

**New bench**: `tests/harness/bench-doom-gameplay.mjs`. Holds LEFT for
`--window-ms=N` (default 60000) post-`stage_ingame`; reports
simulatedFps (cycles/s ÷ cycles/gametic), vramFps (VRAM-hash deltas at
60Hz), paintFps (BMP emits).

**Results** (doom8088, 60s LEFT, fusion OFF):
```
simulatedFps = 34.2  (vs native 35Hz)
vramFps      = 1.6   (cabinet's true visible-frame rate)
paintFps     = 2.1   (was 19.5 pre-hash-gate — 9× fewer dups)
```

Each gametic only renders one column strip; full visible frame builds
over many gametics → ~600ms per fully-painted screen.

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

Calcite-engine work (incl. Body-composition probe followup). Logged in
`../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — Replicated-body recogniser: built, dead lead

Calcite-engine work. Logged in `../calcite/docs/log.md` 2026-04-28.

## 2026-04-28 — XLAT segment-override fix (kiln correctness)

Kiln emitted `--_xlatByte` with DS hard-coded, ignoring 0x26/0x2E/0x36/
0x3E prefix. Doom8088 column drawer uses `ss xlat` twice per pixel for
SS:BX colormap (`i_vv13ha.asm`, `i_vv13ma.asm`, `i_vv13la.asm`,
`i_vegaa.asm`, `i_vmodya.asm`, `i_vcgaa.asm`) — every textured pixel
read from DS:BX+AL. Fix: use `--directSeg` (override-or-DS) at
`kiln/decode.mjs:362`.

Verified: smoke 7 carts green; Doom8088 reaches in-game on web
(`stage_ingame` tick 34.4M, `runMsToInGame` 110s); gameplay frame
correct. Title splash unaffected (V_DrawRaw, no XLAT).

Also rewired smoke list — small carts moved to `carts/test-carts/` so
harness was silently running only zork+montezuma; now all 7 fire.

## Current status

Working carts: zork, montezuma, sokoban, zork-big (2.88 MB),
command-bare, shelltest, smoke set (dos-smoke, hello-text, cga4-stripes,
cga5-mono, cga6-hires). Doom8088 reaches in-game on **both** web player
and calcite-cli. Prince of Persia reaches title screen. Regression gate:
`tests/harness/run.mjs smoke` (7 carts).

## 2026-04-28 — 3 word-slot scheme (worktree-3slot)

Kiln moves from **6 byte-slots → 3 word-slots** for memory writes. Each
slot carries `--_slotKWidth` (1 or 2): width=2 packs addr/addr+1 byte
pair into one slot whose `--memValK` holds the un-split 16-bit word.
INT/IRQ frames (FLAGS+CS+IP = 3 words) fit new 3-slot worst case
exactly. `--applySlot` becomes 6-arg (loOff, hiOff, val, width):
aligned-word, byte, odd-addressed straddle splices.

Calcite recogniser (`packed_broadcast_write.rs` + parser fast-path) updated
to 6-arg shape; `CompiledPackedBroadcastWrite` gains `width_slot`;
`compile.rs`/`eval.rs` apply 1- or 2-byte writes per port per tick.

| Cart    | 6-slot   | 3-slot   | Δ      |
|---------|---------:|---------:|-------:|
| dos-smoke (test) | 152.6 MB | 139.9 MB | −8.3% |
| zork1   | 299.6 MB | 274.7 MB | −8.3% |
| doom8088 | 341.7 MB | 316.9 MB | −7.3% |

Doom8088 (`bench-doom-stages-cli.mjs`):

| Stage         | 6-slot     | 3-slot     | Δ     |
|---------------|-----------:|-----------:|------:|
| text_drdos    |  1 110 ms  |  1 083 ms  | −2.4% |
| text_doom     |  3 751 ms  |  3 635 ms  | −3.1% |
| title         |  9 524 ms  |  9 284 ms  | −2.5% |
| menu          | 10 304 ms  | 10 024 ms  | −2.7% |
| loading       | 13 655 ms  | 13 319 ms  | −2.5% |
| **ingame**    | **90 995** | **85 323** | **−6.2%** |
| **runMsToInGame** | **91.0 s** | **85.3 s** | **−6.2% (5.7s)** |
| ticksToInGame | 35 000 000 | 35 000 000 | identical |
| cyclesToInGame| 397 458 534 | 397 458 534 | identical |

Same cycle/tick counts → CPU work identical, savings = per-tick CSS
eval. Level-load (loading→ingame, 29.5M ticks): 77.3s → 72.0s = −6.9%.
Zork1 5M-tick: ~3% per-tick speedup, no per-cycle regression, 20%
faster compile.

Open follow-ups:
- Calcite-wasm rebuild + web bench cross-check (web has different
  per-tick fixed cost; bridge should still see ~6%).
- Snapshots from 2026-04-28 invalidated (slot count + applySlot arity).
  Recapture if needed.

Worktrees:
- CSS-DOS: `.claude/worktrees/3slot/`, branch `worktree-3slot`
- calcite: `.claude/worktrees/3slot/`, branch `worktree-3slot`

Set `CALCITE_REPO=/c/Users/.../calcite/.claude/worktrees/3slot` to run
worktree against matching calcite.

## Active focus — Doom8088 level-load

Re-measured 2026-04-28. `stage_loading → stage_ingame` (29.5M ticks):

| Path                            | wallMsDelta | ticks/s |
|---------------------------------|------------:|--------:|
| CLI (bench-doom-stages-cli)     |     73 000  | 405 K   |
| CLI (direct + restore snapshot) |     74 200  | 398 K   |
| Web (bench-doom-stages)         |     88 200  | 334 K   |

Web 1.21× slower than CLI on this window. Previous LOGBOOK 134/127K
figures were stale (different cabinet build). Web compile ~43s
(LTO+codegen-units=1) vs ~3.8s native — wasm runtime cost, not bridge
waste (bridge does single `new_from_bytes(bytes)`, no extra copies).

**Level-load cost is the engine, not the bridge.** Per-tick CSS eval
optimisations or REP-fast-forward bail elimination help both targets.
Bridge-only optimisations won't move the number.

Mission: [`docs/agent-briefs/doom-perf-mission.md`](../agent-briefs/doom-perf-mission.md).

### What level-load is doing (2026-04-28)

29.5M-tick window (snapshot-restore from `stage_loading.snap`, halt on
`_g_gamestate=GS_LEVEL`).

**CS:IP heatmap** (`tests/harness/analyse-cs-ip-samples.mjs` on CSV from
`calcite-cli --sample-cs-ip`):
- Segment 0x55: **67.8%**. Bursts: 110 IPs / 500 ticks → medium-body
  function called millions of times. Matches gcc-ia16 paragraph→linear
  helper hypothesis.
- Segment 0x2D96 (BIOS dispatch): **15.0%**, all in one 256-byte page,
  46 IPs → small dispatcher loop.
- Segment 0x1122: **8.3%**, same 46-IP small-loop shape.

Three segments = **91% of CPU**.

**Op distribution** (`calcite-bench --profile --batch=0` after restore):
- LoadSlot 27% + BranchIfNotEqLit 25% + LoadState 9% + LoadLit 8% →
  **>60% are un-fused load-then-compare-then-branch chains.**
- Dispatch 2.7% + DispatchChain 3.9% (each averaging 177 sub-ops) →
  recognisers fire on bulk; long tail above is real.
- LoadStateAndBranchIfNotEqLit 0.7% → fused op exists, almost never hit.
  **Adding more fused ops for common L+C+B patterns is a real lead.**
- BroadcastWrite 0% → packed-broadcast recogniser working.

**Caveat**: `--batch=0 --profile` reports snapshot+change-detect at ~91%
of time. Single-tick instrumentation artifact — `run_batch` doesn't run
either phase. Op-count distribution is real; time-split isn't.

## How to test (Doom8088 perf)

Web for *seeing*, CLI for headless/batch. Same JSON shape.

```sh
node tests/harness/bench-doom-stages.mjs --headed --json=tmp/web.json
node tests/harness/bench-doom-stages-cli.mjs --json=tmp/cli.json
```

Both emit `headline.runMsToInGame` / `ticksToInGame` /
`cyclesToInGame`. Quote JSON before/after perf claims. If only one of
the two regresses, that's a real regression in *that target* —
investigate, don't dismiss.

**Don't diagnose by running the player interactively.** 2026-04-27 trap.

## Boot sequence (dos-corduroy)

Generic carts: (1) Mode 13h splash → (2) Text-mode kernel + ANSI banner
→ (3) Game.

Doom8088 (six stages, sentinels in perf brief):
1. `stage_text_drdos` — kernel banner in 80×25 VRAM
2. `stage_text_doom` — DOOM init log in VRAM
3. `stage_title` — mode 13h, title splash
4. `stage_menu` — `_g_menuactive=1`
5. `stage_loading` — `_g_usergame=1`, gamestate still GS_DEMOSCREEN
6. `stage_ingame` — gamestate flips to GS_LEVEL

"Ticks running" ≠ pass — peek doom globals or use the bench.

## Test infrastructure

`tests/harness/` is the unified entrypoint.

- `run.mjs smoke|conformance|visual|full` — preset runner.
- `pipeline.mjs <subcommand>` — `build`, `inspect`, `run`, `shoot`,
  `fast-shoot`, `full`, `fulldiff`, `triage`, `cabinet-diff`,
  `baseline-record`, `baseline-verify`, `consistency`.
- `bench-doom-stages.mjs` / `bench-doom-stages-cli.mjs` — Doom stage
  bench (web/native). Web headed by default; `--headless` to opt out.
- `bench-web.mjs` — generic web throughput (Zork-shaped boots).
- `analyse-cs-ip-samples.mjs` — CSV from `calcite-cli --sample-cs-ip`
  → CS:IP heatmap + per-burst loop-shape report.

`calcite-cli --sample-cs-ip=STRIDE,BURST,EVERY,PATH` records CS:IP at
mixed wide-and-bursty intervals. Pairs with `--restore`.
`calcite-bench --restore=PATH` for op-distribution profiling.

JSON to stdout, progress to stderr, wall+tick+stall budgets enforced.
Don't fire-and-forget.

Builder emits `<cabinet>.bios.bin / .kernel.bin / .disk.bin /
.meta.json` sidecars. Reference emulator (`tests/harness/lib/
ref-machine.mjs`) uses these to stand up the same 1MB image calcite
sees. Cabinet carries `/*!HARNESS v1 {json}!*/` header.

Legacy `../calcite/tools/fulldiff.mjs`, `tools/compare-dos.mjs`,
`ref-dos.mjs` import deleted `transpiler/` — broken. Use harness.

## Snapshots

Calcite `State::snapshot` / `State::restore` exposed as `--snapshot-out`
/ `--restore` on calcite-cli, `engine.snapshot()` /
`engine.restore(bytes)` in calcite-wasm. Same-cabinet only.

`bench-doom-stages.mjs --capture-snapshots=DIR` saves `.snap` per
stage transition (~1.5MB). Restore from `stage_loading.snap` skips
boot+menu, saves ~25s/iteration.

Invalidated by any cabinet rebuild OR calcite parse/slot-allocation
change. phash mismatch after restore → recapture.

## Sentinel addresses (Doom8088)

| Symbol            | Linear  | Notes                                          |
|-------------------|---------|------------------------------------------------|
| `_g_gamestate`    | 0x3a3c4 | enum: 0=LEVEL 1=INTERMISSION 2=FINALE 3=DEMOSCREEN |
| `_g_menuactive`   | 0x3ac62 | bool                                           |
| `_g_gameaction`   | 0x3ac5e | TRANSIENT (cleared within one game tic)        |
| `_g_usergame`     | 0x3a5af | latches when G_InitNew runs                    |

Re-derivation procedure on cabinet rebuild: in perf brief.

`_g_gameaction` is wrong for stage gating — cleared on next G_Ticker, a
250ms poll usually misses it. Bench logs `firstGaSeenAt` if lucky but
never gates on it. `_g_usergame` is durable equivalent.

## Model gotchas

- Don't run interactively to "check if loaded" — build a measurement
  tool. (2026-04-27 → `feedback_doom_dont_run_blindly` auto-memory.)
- Don't trust visible halt opcode — CPU was redirected upstream, trace
  back.
- Test suspected primitive in isolation before binary-patching
  downstream. (2026-04-26 ROR.)
- Renderer using a "borrow path" (clone extended, scratch state) instead
  of unified-read makes write ports whose CSS sink doesn't go through
  `write_mem` invisible. (2026-04-26 DAC-palette bug.)
- Don't accumulate "defensive" fixes whose root cause you can't
  reproduce.
- `tools/fulldiff.mjs` / `compare-dos.mjs` / `ref-dos.mjs` reference
  deleted transpiler — use `pipeline.mjs fulldiff`.

## Open work

- **EMS/XMS for Doom8088 — partial scaffold, inactive.** Corduroy hooks
  INT 2Fh / INT 67h, reserves "EMMXXXX0" magic at BIOS_SEG bytes
  0x0A..0x11. DOOM8088 detects EMS via `open("EMMXXXX0", O_RDWR)`
  (synthesised DOS char device) — still doesn't see it. Doom runs with
  `-noxms -noems -nosound` baked into `program.json`, sidesteps. Files:
  `bios/corduroy/{entry,handlers,bios_init}.{asm,c}`.
- **Memory packing pack=2 vs pack=1.** Native probe converges ≥500K
  ticks; pack=2 slightly faster. Browser verification pending.

## Web vs native — must agree

CSS-DOS contract: calcite-cli, calcite-wasm, and a spec-compliant CSS
evaluator (Chrome) produce the same result from the same cabinet, at
different speeds. One target working + the other regressing = **bug**,
not acceptable trade-off. The two benches exist precisely to catch this.
