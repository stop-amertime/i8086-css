# Doom8088 perf-optimisation mission

**Audience:** worker agents pulling Doom8088 perf tasks. Read this in
full before touching anything. The cardinal rules below override your
generic instincts. If you're unsure whether a planned change is allowed,
stop and ask.

---

## What this is

Doom8088 boots, reaches the title splash, accepts Enter, shows the
skill menu, starts a New Game, and reaches in-game gameplay.

Re-measured 2026-04-28 (current cabinet, current calcite):

| Path | runMsToInGame | loading→ingame delta | ticks |
|------|---------------:|---------------------:|------:|
| CLI  | ~87 s          | ~73 s                | 29.5 M |
| Web  | ~104 s         | ~88 s                | 29.5 M |

Web is ~1.21× slower than CLI on the level-load window. The web bench
also pays ~43 s of cabinet-compile time on cold open (vs ~3.8 s native);
that's wasm runtime cost, not bridge overhead. The level-load itself
is dominated by **engine work**, not the bridge — the same workload at
similar speed on both targets.

What this means for you: **the level-load is slow because the engine
has 29 M ticks of CPU work to do**, regardless of target. Per-cycle
CSS evaluation cost and slow REP fast-forward bails are what to
attack. Pure bridge optimisations (postMessage, framebuffer encoding)
will not move the headline number — the bridge isn't the bottleneck.

Your job is to make it faster. Either bench's
`headline.runMsToInGame`, plus the **steady-state cycles/sec** in
mode 13h, are the metrics that count. A change that makes one target
faster but the other slower is a regression — they should track each
other.

---

## Boot sequence — the stages

These are the stages a user sees from cold-boot to in-game. **Tick and
cycle counts are calcite-side timestamps** (`cycleCount` is real 8086
clock cycles; `tick` is one calcite evaluation). Numbers below are
point-in-time observations from 2026-04-28 against `doom8088.css`
(mode-13h low-detail, dos-corduroy preset, `program.json` autorun
`DOOM -noxms -noems -nosound`) from a single headed Chrome run.
They will drift — do not hard-code them in code or asserts. Use the
**sentinels**.

| # | Stage              | Sentinel                                                     | Tick    | Cycles    | What user sees                |
|---|--------------------|--------------------------------------------------------------|---------|-----------|-------------------------------|
| 0 | Pre-BIOS           | mode=0x03, BDA video bytes zero                              | 0       | 0         | Black                         |
| 1 | DR-DOS banner      | mode=0x03 AND VRAM 0xB8000 contains "DR-DOS"                 | ~0.4M   | ~5.5M     | Kernel banner                 |
| 2 | DOOM init log      | mode=0x03 AND VRAM contains "DOOM8088"                       | ~1.4M   | ~21M      | Z_Init / W_Init / R_Init …    |
| 3 | Title splash       | `_g_menuactive`=0 AND `_g_gamestate`=GS_DEMOSCREEN(3) AND mode=0x13 | ~3.8M   | ~47M      | id Software / DOOM splash     |
| 4 | Menu visible       | `_g_menuactive`=1                                            | ~4.1M   | ~52M      | Main menu (NEW GAME …) → skill menu (Hurt me plenty default) |
| 5 | Level loading      | `_g_usergame`=1 AND `_g_gamestate`=GS_DEMOSCREEN             | ~4.6M   | ~61M      | Door-melt wipe / loading… (DOOM is in G_DoLoadLevel) |
| 6 | In-game            | `_g_gamestate`=GS_LEVEL(0)                                   | ~34M    | ~383M     | Marine HUD + viewport         |

**About the menu chain.** From the title splash, the user presses Enter
to reach the main menu (NEW GAME / OPTIONS / LOAD / QUIT), then Enter
selects NEW GAME → DOOM auto-skips the episode menu (shareware = 1
episode) → skill menu appears with cursor on Hurt me plenty (itemOn=2)
→ Enter selects Hurt me plenty → `M_ChooseSkill` queues `ga_newgame`.
G_Ticker → G_DoNewGame → G_InitNew (sets `_g_usergame=1`) →
G_DoLoadLevel (sets `_g_gamestate=GS_LEVEL`). Two Enters total after
title-dismiss. The bench Enter-spams every 500 ms once stage_menu
fires and stops as soon as `_g_usergame=1` is observed (durable
signal that newgame fired).

### Stages you DO NOT need to optimise

**Stages 0, 1, 2 are already fast in user-perception terms** (a few
seconds total on web; see baseline numbers above). They look slow
relative to "instant" but are imperceptible inside the boot flow.
**Do not spend cycles micro-optimising these.** Reward-hacking risk:
shaving them is a cheap way to "show progress" while the actual
problem (level-load) is untouched.

### Stages you MUST optimise

**Stage 5 (level loading) is the dominant cost.** Current baseline on
both targets: stage_loading → stage_ingame is **~130 s wall,
~322 M cycles, ~29 M ticks**. That is ~10× the cumulative cycles of
all earlier stages combined. **Target: <10 s** — equivalent to
~30× speedup. The headline metric is `headline.runMsToInGame`.

Other phases worth attention but lower-leverage today:

- **Stage 4 (menu navigation):** menu redraw is slow (~1 fps on web)
  but the menu chain is short and only matters as part of the
  pre-game boot. Lower priority than level-load.
- **Stage 6 steady-state (gameplay framerate):** currently ~0.2 fps.
  Target: anything over 5 fps would be transformative; over 15 fps
  would be excellent. Likely shares the same baseline-per-frame cost
  with menu redraw, so wins propagate.

---

## How to measure

**Use the bench, not interactive runs.**

- **Don't** spam Enter into a real run "to see if it advances".
- **Don't** wait minutes to confirm a change reached the menu.
- **Do** drive the bench harness — it watches sentinels via calcite-core
  script primitives and reports per-stage wall-clock automatically.

### The bench

`tests/bench/profiles/doom-loading.mjs` drives both targets through
the same set of stage-detector watch-specs (see
[`docs/script-primitives.md`](../script-primitives.md) for the grammar).

```sh
# Web target — Playwright drives tests/bench/page/index.html.
node tests/bench/driver/run.mjs doom-loading

# CLI target — calcite-cli with the profile's --watch flags.
node tests/bench/driver/run.mjs doom-loading --target=cli

# Pin the JSON output for diffing.
node tests/bench/driver/run.mjs doom-loading --target=cli --out=tmp/cli-out.json
node tests/bench/driver/run.mjs doom-loading              --out=tmp/web-out.json

# Skip ensureFresh rebuilds when iterating against an unchanged cabinet.
node tests/bench/driver/run.mjs doom-loading --target=cli --no-rebuild
```

The profile composes `cond:` watches with memory-pattern predicates
(`pattern@0xb8000:2:4000=DR-DOS`, `0x3a3c4=0`, etc.) for the six
stage detectors, and uses `setvar_pulse=keyboard,0x1C0D,N` to drive
the title→menu→loading transitions with make/break Enter taps.

Both targets emit the same JSON shape — stage names, `wallMs`,
`ticks`, `cycles` per stage. Headline fields: `runMsToInGame`,
`ticksToInGame`, `cyclesToInGame`. Web additionally reports
`pageMsToInGame` (page-load to first frame) which CLI can't.

When the two disagree by more than ~10% on a non-throughput metric,
investigate — either a regression in one target or a bench bug.

Fields you should care about:

- `stages.<name>.wallMs / .ticks / .cycles` and the matching `Delta`
  fields against the previous stage. Per-stage tick & cycle deltas are
  the most robust regression metric since wall time fluctuates with the
  host.
- `headline.pageMsToInGame` — full path from page-load to first in-game
  frame. The user-felt number.
- `headline.runMsToInGame` — post-compile to first in-game. Strips out
  the cabinet build + parse cost so calcite-eval-only changes are
  visible.
- `headline.cyclesToInGame` / `.ticksToInGame` — cumulative engine work.
- `firstUgSeenAt` — when `_g_usergame=1` first observed. Catching this
  proves the menu transition fired even if the bench bails on
  stage_ingame timeout (level-load is the bottleneck, not menu).
- `firstGaSeenAt` — caught only if the 250 ms poll happens to land in
  the one-game-tic window where ga_newgame is set. Diagnostic only.
- `bailed` — if the run hit a stage's wall budget × `BUDGET_MULT`. The
  bail's `stage` field tells you which transition wedged.

**Target: `headline.runMsToInGame` < 10 s.** Today's baseline is
~150 s on both web and native.

### Secondary tool: native profile

```sh
node tests/harness/profile-doom-load.mjs doom8088.css \
  --instr=80000000 --from=20000000 --top=25
```

Drives the **JS reference emulator** (not calcite) at ~7 M instr/s,
classifies CALL/RET, prints top hot call sites by self/inclusive time.
Use this to **decide WHERE to optimise**. Use the web bench to
**confirm the change actually helped.**

The reference emulator's flame data is what found the segment-0x55
zone-walk hot path (~70 % of level-load CPU). See
[LOGBOOK 2026-04-28](../logbook/LOGBOOK.md) and
[memory `project_doom8088_progress`](../../../../.claude/projects/C--Users-AdmT9N0CX01V65438A/memory/project_doom8088_progress.md).

### Sentinel definitions (deterministic, program-semantic memory reads)

The bench detects stages via cond-watch predicates on hard-coded
linear addresses, not framebuffer hashing. The addresses are doom8088
globals, derived by dumping memory at known stages and finding the
unique byte position whose value sequence matches the expected
program state.

| Sentinel name        | Test                                                                              |
|----------------------|-----------------------------------------------------------------------------------|
| `stage_text_drdos`   | BDA[0x449] = 0x03 AND VRAM 0xB8000..0xB8FA0 contains the ASCII "DR-DOS"           |
| `stage_text_doom`    | BDA[0x449] = 0x03 AND VRAM contains "DOOM8088"                                    |
| `stage_title`        | `_g_menuactive`=0 AND `_g_gamestate`=GS_DEMOSCREEN(3) AND BDA[0x449]=0x13         |
| `stage_menu`         | `_g_menuactive`=1                                                                 |
| `stage_loading`      | `_g_usergame`=1 AND `_g_gamestate`=GS_DEMOSCREEN(3) — menu transition fired,      |
|                      | level-load is in progress (slow on web — multi-minute on the current bridge)     |
| `stage_ingame`       | `_g_gamestate`=GS_LEVEL(0) — first in-game frame after level-load completes      |

#### Doom8088 global addresses (current cabinet)

| Symbol            | Linear  | Source                       | Notes                                |
|-------------------|---------|------------------------------|--------------------------------------|
| `_g_gamestate`    | 0x3a3c4 | g_game.c::_g_gamestate       | enum: 0=LEVEL 1=INTERMISSION 2=FINALE 3=DEMOSCREEN |
| `_g_menuactive`   | 0x3ac62 | m_menu.c::_g_menuactive      | bool: 0=not on menu, 1=menu visible  |
| `_g_gameaction`   | 0x3ac5e | g_game.c::_g_gameaction      | enum: 0=nothing 1=loadlevel 2=newgame ... TRANSIENT (consumed within one game tick) |
| `_g_usergame`     | 0x3a5af | g_game.c::_g_usergame        | bool: latches to 1 in G_InitNew, stays |

#### Why the bench needs both `_g_gameaction` AND `_g_usergame`

`_g_gameaction` is set in `M_ChooseSkill` (= `ga_newgame`, value 2) and
cleared in `G_DoNewGame` on the next `G_Ticker` call. That window is
one game tic, often shorter than the bench's 250 ms poll, so the bench
usually misses it. Don't use it as a stage gate.

`_g_usergame` flips to true inside `G_InitNew` (called by
`G_DoNewGame`) BEFORE `G_DoLoadLevel` runs, and stays true until the
user quits. That's the durable signal that "the menu transition fired,
level-load is happening, just hasn't finished". The bench latches on
this to stop the Enter spam and report `stage_loading`.

The gap between `stage_loading` (`_g_usergame=1`) and `stage_ingame`
(`_g_gamestate=GS_LEVEL`) is the level-load wall window — currently
multi-minute on the web bridge. That's the headline regression metric.

#### Re-deriving the addresses if the cabinet changes

If you rebuild doom8088 with a different binary layout, the addresses
will move. Re-derive with `calcite-cli --dump-mem-range=0x10000:0x90000`
at six known stages (text-mode boot, title splash, main menu visible,
20M-ticks-into-level-load, in-game-fresh, in-game-steady) and look for
unique byte positions where the value-sequence matches the expected
program-state pattern:

| Variable        | Pattern across (stage2, title, menu, loading, ingame, ingame2) |
|-----------------|----------------------------------------------------------------|
| `_g_gamestate`  | 3, 3, 3, 3, 0, 0                                               |
| `_g_menuactive` | 0, 0, 1, 0, 0, 0                                               |
| `_g_usergame`   | 0, 0, 0, 1, 1, 1                                               |
| `_g_gameaction` | 0, 0, 0, 0, 0, 0   (transient — won't show in dumps; needs the post-press dump trick) |

For `_g_gameaction` specifically: dump immediately after a tap.
Compose a watch that taps at tick N (`at:tick=N:then=setvar_pulse=keyboard,…`)
and another that dumps at tick N+1 (`at:tick=N+1:then=dump=ADDR,LEN,PATH`)
to catch ga_newgame=2 before G_DoNewGame consumes it.

#### Menu chain (shareware DOOM, default skill cursor on Hurt me plenty)

```
title splash + mode 13h
  → Enter (any) → main menu (NEW GAME / OPTIONS / LOAD / QUIT)
  → Enter on NEW GAME → skill menu (auto-skips episode select
                                    because shareware has only 1)
  → Enter on Hurt me plenty (cursor lands here by default,
                              via M_NewGame setting itemOn=2)
                              → M_ChooseSkill → ga_newgame → game
```

Two Enters total after the title-dismiss. The bench Enter-spams every
500 ms once `stage_menu` fires, and stops as soon as `_g_usergame == 1`
is observed (durable). Doom drops keypresses if it's only running ~1 fps
in the menu, so a 500 ms spam interval with multiple takes per game tic
is the right shape — too sparse and we wait minutes between presses.

#### Snapshot/restore for fast iteration

The bench `--capture-snapshots=DIR` saves a `.snap` file at every stage
transition. Restore from one of these to skip earlier stages and
measure only what's downstream — e.g. restore from `stage_menu.snap`
and you skip the 50s of compile+boot, landing right at the moment the
menu became visible. See `--restore=DIR/<which>` once that path is wired
up. The snapshot is invalidated by any cabinet rebuild or any calcite
change that touches parse/slot allocation.

---

## What success looks like

Three rules. They're outcome-shaped, not behaviour-shaped, because the
ways an optimisation can be correct are countable but the ways it can
be wrong are not — better to define the destination than to enumerate
wrong turns. If something you're considering would clearly violate one
of these in spirit, stop and reconsider; if you're not sure, ask
before shipping it.

### 1. The user's experience is the only metric

The system you're optimising is "a normal user opens the live web page
cold and plays Doom." Anything you change has to move that experience
in the right direction. Concretely:

- **Cold open, no warm cache, no flag, no devtools.** If your
  improvement requires a build mode, an env var, a pre-warmed
  snapshot, or a setting the user wouldn't flip, it doesn't count.
- **Load completes in ≤10 s** from page-load to first in-game frame.
- **Menu navigation feels instant** — Enter on a menu item produces
  the next frame within ~100 ms. Today this takes seconds, which is
  the loudest signal that the per-frame baseline cost in mode-13h is
  far too high.
- **In-game framerate is noticeably playable** — you can see the
  improvement without measuring it. Held keys don't roll; you can
  walk through a doorway without one frame per second.

The bench harness reports proxies for this (`headlineMsToInGame`,
`idleEncodedPerSec`, etc.) but those are proxies. If you've moved a
proxy without moving the user's actual experience, the proxy moved,
not the engine. Conversely, if the user's experience improves and the
proxy disagrees, fix the proxy. The user wins.

### 2. The menu is a strong diagnostic, not the only one

The main menu and difficulty menu redraw a small overlay on a
near-static background, and they are dramatically slow. That's hard to
explain by game-logic complexity (there's almost none) — it points at
the per-frame baseline cost of mode-13h itself: producing a frame,
applying the DAC, encoding for the bridge, transferring to the iframe,
rendering. Lowering that baseline is the highest-leverage thing on the
table, because it pays out in *every* mode-13h stage at once: title,
menu, difficulty, level-load idle, in-game.

But "the menu is slow" doesn't mean "every other slowness is the same
bug." The level-load is dominated by a known CSS-evaluation hot path
(segment 0x55 zone-walk); in-game has its own per-frame-redraw cost
that may share some of the menu's bottleneck and add its own. Lead
with the menu insight when you don't have a better lead, but profile
each stage on its own — the answer for one isn't necessarily the
answer for another.

A corollary: if you can identify *any* work the engine does that the
user doesn't observe, removing it is fair game. Producing identical
frames over and over while the screen content is stable is one
example, but only one. The line is observable user behaviour, not
internal machinery — match the observable behaviour, simplify the
machinery.

### 3. Calcite stays general-purpose

Calcite is a CSS JIT, not a Doom JIT. The test for any optimisation
that lives in calcite is **transferability**: would the same change
also help any other DOS program whose CSS happens to have the same
shape? If yes, it's the right kind of optimisation. If your change
helps Doom because it recognises something specifically Doom-ish
(a segment number, a function signature, a WAD layout, a Doom-only
opcode pattern at a specific address), you've encoded the program
into the engine, and that's a one-way door — every future program
will have to fight that bias.

This generalises the existing cardinal rule. Calcite has never been
allowed to know about x86, BIOS, or DOS; it now also can't know about
Doom. Pattern recognisers are still welcome — the existing
`--and`/`--or`/`--xor` body recognisers and REP fast-forward exist
because the *shape* of those CSS expressions is universal. New
recognisers for shapes that other DOS programs would also produce are
exactly the right path. Recognisers tied to a specific cabinet's
addresses or layout are not.

The same principle covers cabinet/CSS changes: restructuring the CSS
to make existing patterns easier to recognise is fine. Inserting
"hints" whose only purpose is to whisper to calcite — properties that
do nothing in Chrome — is not.

---

## Process you still have to follow

Three things below the rules — these are mechanics, not judgement
calls:

- **Don't break smoke.** Run `node tests/harness/run.mjs smoke` before
  shipping a perf change. Zork, Montezuma, sokoban, hello-text,
  dos-smoke, cga4-stripes, cga5-mono, cga6-hires must still pass.
- **Quote the bench numbers.** When you write a logbook entry for a
  perf change, include `tests/bench/driver/run.mjs doom-loading` JSON before and after.
  "Felt faster" is not evidence; nor is one-shot measurement (variance
  is real — median of 3 minimum).
- **Don't fire-and-forget.** Every run has a wall-clock budget — the
  top-level `CLAUDE.md` makes this explicit. If your chosen path
  doesn't fit the budget, build a path that does. Snapshot/restore
  is fine for iteration speed (you're shortening the boot for
  yourself, not the user); see § Iteration shortcut. Anything that
  shortens the boot for the *user* is a real fix, not a bench trick.
- **Git is fine — share carefully.** Commit + push your own work
  freely (it's encouraged). What needs explicit permission is
  anything that mutates other agents' working state: stash, add,
  rebase, checkout/restore, reset --hard, branch deletion, force-push.
  See `CLAUDE.md`.

---

## Where to look first

The level-load is doing 29 M ticks of real CPU work. Reducing the
per-tick cost or skipping ticks (via correct fast-forward) is what
moves the headline. Priority order:

Calcite-side measurement (2026-04-28, sampler over the full
loading→ingame window) — three segments cover 91 % of level-load CPU:

| Segment | % CPU | Burst shape | Likely role |
|---------|------:|-------------|-------------|
| 0x55    | 67.8 %| ~110 distinct IPs / 500-tick burst → medium-body fn called many times | gcc-ia16 paragraph→linear helper for `z_zone.c` |
| 0x2D96  | 15.0 %| ~46 IPs, all in one 256-byte page | Corduroy BIOS dispatch (DOS INTs) |
| 0x1122  |  8.3 %| ~46 IPs, cross-segment | Small dispatcher (purpose unknown — investigate) |

`calcite-bench --profile` shows >60 % of executed ops are un-fused
load-then-compare-then-branch chains (LoadSlot + BranchIfNotEqLit +
LoadState + LoadLit). The fused `LoadStateAndBranchIfNotEqLit` op
exists but is hit 0.7 % of the time. Recognisers that fuse common
chains move per-tick cost down across all stages.

Priority order:

1. **Segment-0x55 zone-walk pattern.** 67.8 % of level-load CPU.
   gcc-ia16's tail-merged paragraph→linear helper for `z_zone.c`.
   If calcite-core can pattern-recognise this body the way it does
   `--and`/`--or`/`--xor`, level-load gets dramatically faster
   without touching x86 semantics. The cardinal rule still applies —
   the recogniser must match the shape of the normal CSS the cabinet
   emits, no side-channel hints.

2. **More fused load+compare+branch ops.** The op-distribution shows
   the fused `LoadStateAndBranchIfNotEqLit` op fires on only 0.7 %
   of ops while the un-fused triple is >60 %. Adding more fusion
   shapes (LoadSlot+CmpEq+Branch, LoadLit+Cmp+Branch) is a flat
   per-tick cost reduction across all programs.

3. **REP fast-forward gaps.** Today `rep_fast_forward` only handles
   plain REP / REPE on MOVS/STOS (`repType=1`, opcodes 0xA4/0xA5/
   0xAA/0xAB). REPNE SCASB at `8AEC:7EA2` (DOOM-side libc strscan,
   CX≤256) bails to per-byte CSS. Add REPNE/REPE SCASB and CMPSB.

4. **BIOS dispatch (`2D96:`) is 15 % of level-load CPU** — corduroy
   serving DOS INTs. Bursts are 46 IPs in one 256-byte page —
   recogniser-friendly shape. Optimising it gives flat speedup
   across every DOS program, not just Doom.

5. **Segment 0x1122 (8.3 %)** — newly identified dispatcher-shaped
   loop. Investigate what it is before optimising.

6. **Wasm runtime / cabinet compile.** Web is ~1.21× slower than CLI
   on the level-load window and pays ~43 s of cabinet-compile cost
   on cold open vs ~3.8 s native (LTO + codegen-units=1 buys ~4 %
   on compile, no more — the gap is wasm runtime, not build flags).
   The bridge itself does no extra copies; the gap is `parse_css` +
   `Evaluator::from_parsed` running in wasm. Lower-priority than the
   engine wins above (which help both targets), but the cold-open
   compile is user-visible and worth a separate look.

---

## Iteration shortcut: snapshot / restore

`calcite-cli --snapshot-out PATH` writes the engine's runtime state
(state vars + memory + extended + string properties + frame counter)
**after** the run; `--restore PATH` loads it **before** the next run.
Pairs naturally with a `cond:…:then=emit+halt` watch to freeze at a
specific moment.

**Use this when iterating on calcite (Rust) and the cabinet is
unchanged.** Boot + menu + level-load takes tens of seconds even on
calcite-cli; if the change you're testing only affects the in-game
hot loop, restore from a "just-reached-in-game" snapshot and skip
the rest. Each iteration becomes seconds instead of a minute.

**Don't use this when:**

- The cabinet's CSS has changed (cart rebuild, kiln change, BIOS
  change). The snapshot's state-var indices were assigned at
  parse-time against the OLD CSS — they won't line up.
- The calcite change touched the parser, slot allocation, or
  dispatch-table layout. The same CSS will still parse to the same
  slot order under a stable parser, but a parser change can
  re-number slots silently. If you've touched anything in
  `crates/calcite-core/src/{parse,compile}.rs` that affects how
  state-vars or packed cells are indexed, regenerate the snapshot.
- You see a phash mismatch immediately after restore. That's the
  signal that the snapshot doesn't match the current parse — throw
  it away, rerun the boot, regenerate.

The bench harness has no built-in "verify post-restore phash" step
yet; if you're using snapshots in a measurement loop, add a sanity
check that the first frame after restore matches what the snapshot
was taken on.

## Working pattern

1. Pick a target — one of the four leads above, or one your profile
   identifies. Write down WHICH stage's metric you expect to move and
   BY HOW MUCH.
2. Measure baseline: `tests/bench/driver/run.mjs doom-loading` once, save the JSON.
3. Make the change.
4. Run the smoke suite (cheap; ~30 s). Bail if it fails.
5. Measure post-change: `tests/bench/driver/run.mjs doom-loading` once, compare.
6. If the move is real, write a logbook entry. Include the JSON
   diff. If the move is < 5 % and your prediction was 20 %+, your
   model of what was slow is wrong — back out and re-profile.

This is the structure that worked for the 20-minute → 24-second
level-load fix on 2026-04-28. Three bridge bugs, found by careful
measurement, each verified independently.

---

## Ideas not yet tried

Candidates that look plausible but aren't measured yet. Don't ship any
of these without baseline + post-change `tests/bench/driver/run.mjs doom-loading` JSON.

### Collapse 6 byte write-slots → 3 word write-slots

**Where it lives.** `kiln/memory.mjs:25` declares `NUM_WRITE_SLOTS = 6`.
Each writable cell in the emitted CSS evaluates a 6-deep `--applySlot`
cascade per tick (`kiln/emit-css.mjs:617-635`); calcite recognises the
shape via `pattern::packed_broadcast_write::recognise_packed_broadcast`
and turns the cascade into 6 `PackedSlotPort` checks per cell
(`crates/calcite-core/src/eval.rs:339-385`, `:816-829`).

**Why 6 today.** The worst-case writer is INT (and HW IRQ entry):
pushes FLAGS / CS / IP = 3 words = 6 bytes. The current API
(`addMemWrite`) calls in pairs: lo at addr, hi at addr+1
(`kiln/patterns/stack.mjs:52-59`, `mov.mjs:116-120`,
`misc.mjs` PUSHF, etc). Every word write is two consecutive byte slots;
INT is three pairs.

**Why 3 word slots is sufficient.** Every multi-byte write site already
emits a `(lo @ addr, hi @ addr+1)` pair. Three word slots covers the
INT worst case (3 pairs → 3 slots) and every other instruction. Single-
byte writers (MOV [mem],r8 / STOSB / OUT 0x3C9 DAC byte) need a
slot-width flag (`--_slot{N}Width`: 1 or 2) so a slot can write only
its low half when paired with a single-byte op. Calcite already has
prior art for word-write spillover in the *non-packed* broadcast-write
path (`CompiledSpillover` at `crates/calcite-core/src/compile.rs:574-585`
and `eval.rs:791-800`; see also `web/demo.css` for the
`--addrDestA`/`--addrValA1`/`--addrValA2`/`--isWordWrite` v3-era shape
the recogniser was originally written against). The current packed-cell
recogniser would need to learn the new 3-slot/word-width shape.

**Where the saving comes from.**
- **CSS volume:** `--applySlot` chain depth halves per cell. With
  ~320 K writable cells (640 KB ÷ pack=2), this is one of the bigger
  contributors to cabinet size. `@property` declarations for
  `--memAddrN` / `--memValN` / `--_slotNLive` halve too (six → three
  triples).
- **Per-tick gate cost (calcite):** the loop in `eval.rs:816` runs
  once per slot per tick. Halving slot count halves that loop's
  iteration count. The dominant cost is the cell write itself, which
  fires only on live-slot ticks, so the *gate-overhead* portion is
  what shrinks; the total saving depends on what fraction of per-tick
  time is gates vs writes.
- **Chrome (theoretical):** every cell does 6 nested style-query gates
  per tick → 3.

**Measure before designing.** Per the rule against "let me run it and
see" thinking from the 2026-04-27 logbook entry, the speedup claim
should be measured before paying the design cost of word-pair fusing.
Cheap-first path:

1. Microbench cart with heavy memory writes
   (`bench/carts/mov-heavy/` already exists). Run under
   `calcite-bench --profile` at `NUM_WRITE_SLOTS=6` for the baseline.
2. Hack `NUM_WRITE_SLOTS = 3` in `kiln/memory.mjs` *as-is*
   (no fusing yet) and run the bench again. INT-using carts will
   fail conformance — expected; this is a measurement, not a ship.
   Smoke carts that don't take an interrupt should still run.
3. If the saving on `mov-heavy` is small (<10 % cycles/sec), the
   plan is mis-prioritised and the gate-overhead model is wrong.
   Stop here.
4. If the saving is real, build Stage 1 properly: fuse adjacent
   `addMemWrite(opcode, addr, lo)` / `addMemWrite(opcode, addr+1, hi)`
   pairs at slot-allocation time into one word slot, fall back to
   byte-mode (with the width flag) for unpaired single-byte writes.
   Update `--applySlot` to splice 1 or 2 bytes based on width. Then
   Stage 2 — teach `recognise_packed_broadcast` the new shape.

**Genericity check (calcite side).** Word vs byte width is a
structural property of the CSS, not an x86 fact. Any cabinet whose
emitter pairs adjacent byte writes the same way gets the recogniser
for free. ✅ clean.

**Why this affects all five doom stages.** Memory-write-slot cost is
flat per-tick overhead. Title / menu / level-load / in-game all pay
it. The relative win is biggest in stages where per-tick work is
dominated by gate evaluation rather than the actual cell update — so
expect more leverage on idle-frame stages (menu, in-game-steady) than
on level-load (which is dominated by the segment-0x55 zone-walk hot
path, not write traffic).

---

## Doom8088 cart variants

All built from the FrenkelS/Doom8088 v20260304 release. The default
perf target is `doom8088` (mode-13h low-detail). Other shapes exist
under `carts/` for comparing modes:

- `doom8088-m13h` — mode 13h high-detail 240×128
- `doom8088-m13m` — mode 13h medium-detail
- `doom8088-cga4` / `doom8088-cgabw` — CGA colour / mono
- `doom8088-t80x50` — text-mode 80×50

All build to `.css` cabinets and exhibit the same level-load slowness.

## Reference docs

- `docs/logbook/LOGBOOK.md` — the source of truth for current status.
- `docs/reference/tick-benchmarks.md` — generic tick-count milestones
  for boot.
- `../calcite/docs/benchmarking.md` — calcite throughput numbers.
- `tests/harness/README.md` — the full harness reference.
- `docs/debugging/workflow.md` — standard debug process.
