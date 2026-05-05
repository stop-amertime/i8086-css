# CSS-DOS status

The durable handbook. Auto-loaded by `CLAUDE.md`. Contains everything
a new agent needs to start work — current state, sentinel addresses,
how-to-test pointers, recurring gotchas. Chronological entries live
in [`LOGBOOK.md`](LOGBOOK.md).

## Current state

**Working carts:** zork, montezuma, sokoban, zork-big (2.88 MB),
command-bare, shelltest, smoke set (dos-smoke, hello-text,
cga4-stripes, cga5-mono, cga6-hires). Doom8088 reaches in-game on
**both** web player and calcite-cli. Prince of Persia reaches title
screen.

**Regression gate:** `node tests/harness/run.mjs smoke` (7 carts).

**Architecture:** V4 single-cycle. Every instruction completes in one
CSS tick with a configurable number of memory write slots
(minimum 6; the 3-word-slot scheme is the current default and saves
~6% wall on doom8088 vs the 6-byte scheme).

**Default BIOS:** Corduroy (`bios/corduroy/`). Muslin
(`bios/muslin/muslin.asm`) and Gossamer still available.

## Two-entrypoint testing

| Question                                          | Entrypoint              |
|---------------------------------------------------|-------------------------|
| Did my change break something? Diff vs reference. | `tests/harness/`        |
| How fast does this cabinet boot / load?           | `tests/bench/`          |

See [`docs/TESTING.md`](../TESTING.md) for the full split,
[`docs/script-primitives.md`](../script-primitives.md) for the
watch-spec grammar bench profiles use.

## How to test (Doom8088 perf)

Web for *seeing*, CLI for headless/batch. Same JSON shape.

```sh
node tests/bench/driver/run.mjs doom-loading                # web
node tests/bench/driver/run.mjs doom-loading --target=cli   # native
```

Both emit `runMsToInGame` / `ticksToInGame` / `cyclesToInGame`. Quote
JSON before/after perf claims. If only one of the two regresses,
that's a real regression in *that target* — investigate, don't
dismiss. Web vs native must agree (different speeds, same observable
result).

**Don't diagnose by running the player interactively** — build a
measurement tool.

For the Doom8088 perf mission (priority leads, success criteria,
where the time is going), see
[`docs/agent-briefs/doom-perf-mission.md`](../agent-briefs/doom-perf-mission.md).
For perf-iteration tooling (snapshots, CS:IP sampling, op
distribution, calcite worktrees), see
[`docs/perf-iteration.md`](../perf-iteration.md). To compose your own
stage detectors, see
[`docs/script-primitives.md`](../script-primitives.md).

## Boot sequence (dos-corduroy)

Generic carts: (1) Mode 13h splash → (2) Text-mode kernel + ANSI
banner → (3) Game.

Doom8088 (six stages, sentinels below):

1. `stage_text_drdos` — kernel banner in 80×25 VRAM
2. `stage_text_doom`  — DOOM init log in VRAM
3. `stage_title`      — mode 13h, title splash
4. `stage_menu`       — `_g_menuactive=1`
5. `stage_loading`    — `_g_usergame=1`, gamestate still GS_DEMOSCREEN
6. `stage_ingame`     — gamestate flips to GS_LEVEL

"Ticks running" ≠ pass — peek the doom globals or use the bench.

## Sentinel addresses (Doom8088)

| Symbol            | Linear  | Notes                                              |
|-------------------|---------|----------------------------------------------------|
| `_g_gamestate`    | 0x3a3c4 | enum: 0=LEVEL 1=INTERMISSION 2=FINALE 3=DEMOSCREEN |
| `_g_menuactive`   | 0x3ac62 | bool                                               |
| `_g_gameaction`   | 0x3ac5e | TRANSIENT (cleared within one game tic)            |
| `_g_usergame`     | 0x3a5af | latches when G_InitNew runs                        |

`_g_gameaction` is the wrong sentinel for stage gating — cleared on
the next G_Ticker, a 250 ms poll usually misses it. `_g_usergame` is
the durable equivalent.

Re-derive on cabinet rebuild from the `.map` file (the offsets shift
with any kiln/builder change that moves data).

## Open work

- **EMS/XMS for Doom8088 — partial scaffold, inactive.** Corduroy
  hooks INT 2Fh / INT 67h, reserves "EMMXXXX0" magic at BIOS_SEG bytes
  0x0A..0x11. DOOM8088 detects EMS via `open("EMMXXXX0", O_RDWR)`
  (synthesised DOS char device) — still doesn't see it. Doom runs
  with `-noxms -noems -nosound` baked into `program.json` and
  sidesteps. Files: `bios/corduroy/{entry,handlers,bios_init}.{asm,c}`.
- **Memory packing pack=2 vs pack=1.** Native probe converges
  ≥500 K ticks; pack=2 slightly faster. Browser verification pending.
- **Bench harness web target** — driver runs end-to-end on CLI; web
  bridge tickloop doesn't progress after `bench-run`. Likely
  SW + viewer-port plumbing the bench page bypasses. Once fixed, the
  legacy `tests/harness/bench-doom-stages*.mjs` scripts retire.
- **Keyboard input via `:active` (Phase A done, Phase B pending).**
  Cabinet CSS already emits `.cpu { &:has(#kb-X:active) { --keyboard:N }}`
  per key (kiln/template.mjs::emitKeyboardRules). Raw player
  (`web/player/raw.html`) has matching `id=kb-X` buttons and renders
  correctly in Chrome with no JS — verified end-to-end via
  `web/player/experiments/raw-keyboard-probe.mjs`. Calcite player
  (`calcite.html`) gained matching `id=kb-X` attributes on its
  `<a class="kb-key">` keyboard. Calcite-core's `0x500` keyboard
  literal in `eval.rs::property_to_address` is gone. **Pending**:
  calcite recogniser for `:has(...:pseudo)` edges + generic
  `engine.set_pseudo_class_active(pseudo, class, value)` API, then
  retire `engine.set_keyboard`. See LOGBOOK 2026-05-05.

## Model gotchas

- Don't run the player interactively to "check if loaded" — build a
  measurement tool instead.
- Don't trust the visible halt opcode — CPU was redirected upstream;
  trace back.
- Test a suspected primitive in isolation before binary-patching
  downstream.
- A renderer using a "borrow path" (clone extended, scratch state)
  instead of unified-read makes write ports whose CSS sink doesn't go
  through `write_mem` invisible.
- Don't accumulate "defensive" fixes whose root cause you can't
  reproduce.
- `tools/fulldiff.mjs` / `compare-dos.mjs` / `ref-dos.mjs` reference a
  deleted transpiler — use `tests/harness/pipeline.mjs fulldiff`.

