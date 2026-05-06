# CSS-DOS Logbook

Chronological work entries. Newest first. The durable handbook
(current state, sentinels, gotchas, how to test) is in
[`STATUS.md`](STATUS.md).

Last updated: 2026-05-06

## 2026-05-06 — Phase B finished: bench harness migrated, set_keyboard retired

Closed out the keyboard-cheat retirement. The Phase B work from
2026-05-05 left two compatibility shims in place
(`engine.set_keyboard` on the wasm engine, the legacy `?key=0xHHHH`
URL form on the SW); both held back so the bench harness and
in-flight callers could keep working. Today they all moved to the
pseudo-class API and the shims came out.

**Calcite engine** — see `../calcite/docs/log.md` 2026-05-06 for the
engine-side details. Summary:

- New script-DSL action `pseudo_pulse=PSEUDO,SELECTOR,HOLD_TICKS`
  (mirror of `setvar_pulse` but on the pseudo-class surface). Same
  edge-pair semantics: flip active now, schedule a release after
  `HOLD_TICKS`. The skip-if-pending check now keys on a typed
  `PendingReleaseKind` enum (`Var{name}` vs `Pseudo{pseudo,selector}`)
  so the same registry handles both pulse types cleanly. Three new
  unit tests; 16/16 script tests green.
- `--press-events=TICK:[+|-]SELECTOR,...` replaces the legacy
  `--key-events=TICK:VALUE,...` flag on calcite-cli. Same use-case
  (script keyboard input at specific ticks for deterministic tests),
  driven on the pseudo edge instead of the `keyboard` state var.
  The interactive REPL keyboard handler routes through
  `set_pseudo_class_active("active", kb-X, true|false)` via a new
  `key_to_selector` map (mirrors `KEYBOARD_KEYS` from kiln).
- `engine.set_keyboard` deleted from calcite-wasm. The replacement
  `engine.set_pseudo_class_active(pseudo, selector, value)` was
  already exposed in 2026-05-05.

**CSS-DOS-side host migration**:

- `tests/bench/profiles/doom-loading.mjs`: title_tap and menu_tap
  watches now use `pseudo_pulse=active,kb-enter,50000` instead of
  `setvar_pulse=keyboard,0x1C0D,50000`. The driver-side `sendKey`
  fallback (used when the bench page race-conditions out of catching
  a poll-stride menu transition) switched from `?key=0x...` to
  `?class=kb-enter`.
- `tests/harness/bench-doom-stages.mjs` and
  `bench-doom-gameplay.mjs`: `?key=0x1C0D` → `?class=kb-enter`,
  `?key=0x4B00` → `?class=kb-left`.
- `web/site/sw.js::handleKbd`: dropped the `?key=0xHHHH` branch
  entirely; only `?class=kb-X` is recognised now. URLs pointing at
  the legacy form will silently no-op (intended — the legacy URLs
  are gone in our codebase, and external callers should migrate).
- `web/shim/calcite-bridge.js`: queue items are now plain selector
  strings (`'kb-X'`); the `kind: 'key' | 'active'` discriminator is
  gone. The `'kbd'` message type from the SW is no longer accepted —
  only `'kbd-active'`. Bridge version bumped to `v47-pseudo-only`.
- `web/player/calcite-canvas.html`: switched from
  `data-key="0xHHHH"` + `worker.postMessage({type:'keyboard'})` to
  `id="kb-X"` + `worker.postMessage({type:'press', selector, active})`.
  pointerup/pointercancel now flip the edge inactive — previous
  shape was edge-only (push on press, never release).
- `../calcite/web/calcite-worker.js` and `../calcite/web/index.html`
  (the calcite playground page, which lives outside this repo's
  build-UI): same `'press'` message migration. Comments updated to
  describe the principled path.

### Verification

- Smoke 7/7 PASS pre and post each step of the migration.
- doom-loading bench (CLI target) reaches in-game at tick 34,650,000
  — same as the legacy `setvar_pulse=keyboard` baseline. The new
  `pseudo_pulse=active,kb-enter` watch path drives the cabinet
  through title and menu identically.
- Browser e2e `pseudo-active-api-probe.html` PASS in headless Chrome
  against the fresh wasm (no `set_keyboard` export): 561 → 8338 → 0
  sequence through `set_pseudo_class_active` + `tick_batch`.
- 16/16 calcite-core script tests green (3 new); 1 new
  `pseudo_pulse_make_then_release` evaluator test.

### Cardinal-rule check

The cabinet's CSS pays for itself in calcite the same way it pays for
itself in raw Chrome. There's no calcite-side knowledge of which
selectors are "keys" or which property is "the keyboard" — the
recogniser fires on pure shape (`&:has(#IDENT:IDENT) { --PROP: V }`)
and the host flips arbitrary `(pseudo, selector)` edges. A 6502
cabinet that emitted `&:has(#trigger:active) { --gunFiring: 1 }`
would get the same treatment with no calcite-side change.

The `0x500` literal (CSS-DOS BDA keyboard slot) is gone from
calcite, the `set_keyboard` wrapper is gone, the `?key=0xHHHH` URL
is gone, the bridge `'kbd'` message kind is gone, and the
`--key-events` CLI flag is gone. What remains in the keyboard path:
the cabinet's own CSS rules (host-agnostic, expressed in CSS-DOS
vocabulary) plus calcite's structural recogniser
(upstream-agnostic). Nothing in between speaks both languages.

## 2026-05-05 — calcite-genericity cleanup: tasks 1-4 of the audit list

Worked through the post-keyboard "make calcite not cheat" list (LOGBOOK
2026-05-05 line 271-278). Four of five items landed; the fifth is its
own mission, deferred.

**Task 1: delete `column_drawer_fast_forward`.**
Off by default since 2026-04-29 (net perf loss; doom-specific 21-byte
ROM body recogniser, fired 159 times across a 35M-tick run). Removed
the function, its `FusionDiag` thread-local funnel, the
`CALCITE_FUSION_FASTFWD` and `CALCITE_FUSION_DIAG` env-var gates, and
the `rom_match` helper from `crates/calcite-core/src/compile.rs`.
Stripped the corresponding `fusion_diag_enable` /
`fusion_diag_snapshot` / `fusion_fire_count` plumbing from
`crates/calcite-cli/src/main.rs`. Smoke 7/7 PASS pre and post.

**Task 2: move `summary.rs` out of `calcite-core`.**
Per-tick event log + block segmenter for execution diagnostics — every
field name (CS/IP/opcode/_irqActive) was upstream-aware. New crate
`calcite-debug-summary` (lib, depends on calcite-core), registered in
the workspace `Cargo.toml` and as a workspace dependency. The
`calcite-debugger` consumer was migrated from
`calcite_core::summary::*` to `calcite_debug_summary::*`. The
calcite-core integration test for summary moved to a new test in the
new crate (and updated to bootstrap `State` via `parse_css` +
`load_properties` rather than poking the `pub(crate) state_var_index`
directly). 5 unit tests + 1 integration test green; smoke 7/7 PASS.

**Task 3: move CGA renderer + CP437 + DAC palette out of `calcite-core`.**
`State::render_screen` / `render_screen_ansi` / `render_screen_html` /
`render_framebuffer` / `read_framebuffer_rgba` / `read_video_memory`,
the `CGA_PALETTE` and `VGA_DAC_LINEAR` constants, and the
`cp437_to_unicode` helper all baked PC-video conventions into the
engine crate. New crate `calcite-pc-video` (lib, depends on
calcite-core) re-hosts them as free functions taking `&State`.
Consumers migrated: calcite-wasm (its `pub fn render_screen` /
`render_framebuffer` / `read_framebuffer_rgba` / `read_video_memory`
methods now delegate to the new crate, and the wasm public surface is
unchanged), calcite-cli (CGA palette + render_screen_ansi +
render_framebuffer call sites), calcite-debugger (its
`Session::render_screen` helper). Wasm rebuilt via `wasm-pack build
crates/calcite-wasm --target web --out-dir ../../web/pkg --release` so
the JS bindings reflect the new build. Smoke 7/7 PASS.

**Task 4: strip doom/DOS comments from non-test calcite-core code.**
Surgical comment pass — converted `doom8088`/`DOOM`/`x86CSS`/`CSS-DOS`
references in production-path comments to generic phrasings ("the
reference cabinet", "measured cabinets", "the cabinet's bytecode").
Kept calibration citations where they're load-bearing context (e.g.
"95% of all such pairs in the reference cabinet") and didn't touch
test code or comments inside `rep_fast_forward` (those describe real
cardinal-rule violations the *code* makes; reframing them in comments
without fixing the code would just hide the issue — see task 5).
Files touched: lib.rs, compile.rs, eval.rs, conformance.rs,
parser/fast_path.rs, pattern/broadcast_write.rs, pattern/byte_period.rs,
pattern/fusion_sim.rs, pattern/packed_broadcast_write.rs. Comment-only;
calcite-core builds clean.

**Task 5: reframe `rep_fast_forward` as a generic CSS-shape recogniser
— DEFERRED.**

This is the audit's "perf-gated mission" item, not a quick refactor.
The function (~341 lines + helpers in calcite-core/src/compile.rs)
inspects an x86 string-op opcode latch (`--opcode` ∈ {0xA4, 0xA5,
0xAA, 0xAB, 0xA6, 0xA7, 0xAE, 0xAF}), decodes 8086 REPE/REPNE
semantics, segment overrides, the direction flag, and bulk-applies CX
iterations. It also encodes a list of "virtual" memory regions
(0x0500-0x0502 keyboard bridge, 0xD0000-0xD0200 ROM-disk,
0xF0000-0x100000 BIOS ROM) that the bulk path mustn't trample, and
panics if it would. None of that knowledge is derivable from CSS
shape — it's pure upstream awareness encoded in the engine.

Generalising means recognising "function repeats body N times,
incrementing/decrementing addr, until counter hits 0" as a CSS shape
without ever spelling 0xA4. That's the design the affine-loop
fastforward plan (`docs/plans/2026-05-01-affine-loop-fastforward.md`)
already sketches for non-REP loops, but applying it to REP requires:
(a) detecting the shape at compile time keyed off the function name
the cabinet uses, (b) deriving the (init, step, terminator) tuple
from the body, (c) replacing the hardcoded x86 flag-word semantics
with whatever the body says, (d) replacing the hardcoded
virtual-region check with a generic "this address falls outside the
bulk-writable range" predicate driven by the address-map's dispatch
exceptions. Plus the perf gate — doom8088 web+CLI must stay within 1%
of current.

Multi-session work. Punted to its own brief.

## 2026-05-05 — Phase B landed: pseudo-class input-edge recogniser

Phase B of the keyboard-cheat plan from earlier today landed. Calcite
now structurally recognises the cabinet's `&:has(#SELECTOR:PSEUDO) { --PROP: V; }`
rules and exposes a generic host API. The CSS-DOS-side host plumbing
migrated to use it.

**Calcite engine work** — see `../calcite/docs/log.md` 2026-05-05
("Phase B: structural input-edge recogniser + `set_pseudo_class_active`")
for the engine details. Summary: parser preserves `:has(...:pseudo)`
edges as `InputEdge { property, pseudo, selector, value }` triples on
`ParsedProgram::input_edges`; `Evaluator` applies them pre-tick by
summing the values of host-active edges into the underlying state-var
slot; `engine.set_pseudo_class_active(pseudo, selector, bool)` is the
host-facing API. Doom8088 cabinet picks up 59 input edges at parse time
(matches the kiln-emitted rule count for the full PC layout that
landed earlier today).

**CSS-DOS-side changes**:

- `web/site/sw.js::handleKbd` accepts both URL shapes:
  `/_kbd?key=0xHHHH` (legacy → bridge calls `set_keyboard`) and
  `/_kbd?class=kb-X` (new → bridge calls `set_pseudo_class_active`).
  Either path reaches the same drainer.
- `web/shim/calcite-bridge.js` queue items now carry a `kind` —
  `'key'` for legacy scancode dispatch, `'active'` for pseudo-class
  edges. The drainer pulses each through the same `KEY_HOLD_BATCHES` /
  `KEY_GAP_BATCHES` cycle the legacy path used (set true → hold → set
  false → gap), so the cabinet's edge detector sees the same 0→N→0
  transition shape regardless of which path the host took. Bridge
  version bumped to `v46-pseudo-active`.
- `web/player/calcite.html` keyboard buttons rewritten from
  `href="/_kbd?key=0xHHHH"` to `href="/_kbd?class=kb-X"` (61 buttons).
  The `id=kb-X` attribute already matched what kiln's
  `&:has(#kb-X:active)` rules expect.
- `web/player/experiments/pseudo-active-api-probe.html` — wasm-level
  e2e verification page. Loads a tiny synthetic cabinet (one
  `@property --keyboard`, one `--opcode`, two input-edge rules), calls
  `engine.set_pseudo_class_active`, runs `tick_batch`, asserts
  `--keyboard` reflects the gated value. ALL PASS in headless Chrome.

### What's not migrated (yet)

The legacy `engine.set_keyboard` API stays on the wasm engine —
removing it now would break:

- `tests/bench/profiles/doom-loading.mjs` (uses `setvar_pulse=keyboard`
  via the calcite-cli `--watch` mechanism; not the `set_keyboard`
  surface, but in the same family).
- `tests/harness/bench-doom-stages*.mjs` (legacy stage detectors).
- Any external host that hasn't seen this commit.

When the bench harness migrates to drive the pseudo API instead of
`setvar_pulse`, `set_keyboard` can be deleted from calcite-wasm.

### Verification

- Smoke 7/7 PASS pre and post change.
- New calcite-core integration test
  (`input_edges_drive_keyboard_via_set_pseudo_class_active`) green.
- Wasm e2e probe (api-probe.html) green: 561 → 8338 → 0 sequence
  through `set_pseudo_class_active` + `tick_batch`.
- doom8088 cabinet recognises 59 input edges (matches kiln's
  `:has(#kb-` rule count).

The cabinet's CSS now actually pays for itself in calcite the same
way it pays for itself in raw Chrome: the
`&:has(#kb-X:active) { --keyboard: V }` rules drive the value through
the recogniser; the host only flips the pseudo edge.

## 2026-05-05 — keyboard: full PC layout (Esc/F1-F10/Ctrl/Shift/Caps + responsive)

Doom8088 uses Ctrl to fire — without it the on-screen keyboard can't
shoot. While in there, brought the on-screen keyboard up to a full PC
layout (6 rows, 11 cols) and made the screen responsive.

- `kiln/template.mjs::KEYBOARD_KEYS` gains Ctrl (0x1D), Shift (0x2A),
  Caps (0x3A), Del (0x53), F1–F10 (0x3B–0x44). All ASCII=0x00 (the
  cabinet just sees scancode in the high byte of `--keyboard`).
  `emitKeyboardRules` writes 56 rules now (was 45); cabinet rebuilds
  pick up `.cpu { &:has(#kb-X:active) { --keyboard: N } }` for each.
- `web/player/calcite.html` — keyboard rebuilt as an explicit 6-row
  11-col grid:
  - Row 1: Esc | F1–F10
  - Row 2: 1–9 0 Bksp
  - Row 3: Tab Q–P
  - Row 4: Caps A–L Enter
  - Row 5: Shift Z–/
  - Row 6: Ctrl Space
  Each key gets explicit `grid-row` / `grid-column` so reordering
  doesn't drift the layout. Modifiers/digits/F-keys use a smaller
  font (11 px) since their labels are multi-char; letters stay at
  the default 16 px. Arrow keys still live in the right stack as
  fixed 32×32 squares right-aligned.
- Screen now responsive: `.screen-cell` and `.screen` use
  `width: 100%; max-width: 640px; aspect-ratio: 640/400` instead of
  fixed 640×400, so narrow viewports shrink the screen
  proportionally rather than overflowing.
- `calcite-canvas.html` left untouched (still on the JS `data-key →
  worker.postMessage` path; will get its own update once Phase B
  lands).
- Smoke suite (7 carts) PASS.

## 2026-05-05 — plan + initial cleanup: JS-free keyboard via `:active`

Captures the plan plus what landed today.

**Done in this session**:

- Architectural proof (`web/player/experiments/active-input.html` +
  `active-input-probe.mjs`) — verified `:root:has(.kb-XXXX:active)`
  propagates a custom property in raw Chrome via Playwright. 11/11
  assertions pass.
- Discovered the cabinet's CSS *already* emits the right rules
  (`kiln/template.mjs::emitKeyboardRules` writes
  `.cpu { &:has(#kb-X:active) { --keyboard: N } }` per kiln-side
  KEYBOARD_KEYS; `--keyboard` is declared as `@property`). The raw
  player (`web/player/raw.html`) already has matching `id=kb-X`
  buttons inside a `.cpu` wrapper. **The cardinal-rule path is
  already wired in raw.html.**
- Real-cabinet probe (`raw-keyboard-probe.mjs`) — load `raw.html`,
  stub `/cabinet.css` with the actual keyboard rules extracted from
  `doom8088.css`, drive mouse-down/-up on five keys, assert
  `--keyboard` on `.cpu`. 11/11 green.
- The calcite player (`web/player/calcite.html`) was missing
  `id=kb-X` on its `<a class="kb-key">` buttons. Added them so the
  same DOM surface that works in raw Chrome is exposed to calcite
  too. Comma/period/slash stay id-less — they aren't in
  `KEYBOARD_KEYS` (separate gap).
- Calcite-core: deleted the `0x500` keyboard literal in
  `crates/calcite-core/src/eval.rs::property_to_address`. Dead code
  in current cabinets (kiln declares `@property --keyboard`,
  `load_properties` registers it). Smoke suite (7 carts) passes
  pre and post deletion. See `../calcite/docs/log.md` 2026-05-05.

### The cheat being removed

Today's keyboard path:

1. Click `<a class="kb-key" href="/_kbd?key=0x1c0d" target="kbd-sink">`.
2. Iframe navigation triggers SW route `/_kbd`.
3. SW calls `engine.set_keyboard(0x1c0d)` on the wasm engine.
4. Engine writes guest memory `0x500` (BIOS keyboard slot).
5. Cabinet polls `0x500`.

Calcite's `eval.rs::property_to_address` has a hardcoded fallback:
`keyboard / __1keyboard / __2keyboard → 0x500`. That's a name-based
literal, violates the cardinal rule. But the deeper issue is that
the cabinet's CSS has *no path* into the keyboard slot — the only
input mechanism is the `set_keyboard` host call. Raw Chrome (no
calcite) can boot a cabinet but can't type into it. The CSS doesn't
pay for itself.

### The fix, in two layers

**CSS-DOS side (the actual fix):** kiln emits a small "input wiring"
section per cabinet:

```css
@property --kb_1c0d { syntax: "<integer>"; initial-value: 0; inherits: true; }
:root:has(.kb-1c0d:active) { --kb_1c0d: 0x1c0d; }
/* ... one rule per key ... */
:root { --keyboard: max(var(--kb_1c0d), var(--kb_1e61), …); }
```

The DOM elements are the existing `<a class="kb-key">` keyboard in
`web/player/calcite.html`. `:active` fires on mouse-down, reverts on
release. `:has()` propagates the active state to `:root`, so an
unrelated readout (or the cabinet's BIOS poll) reads `--keyboard`
via `var()`. Pure HTML+CSS, no JS on the page. Chrome runs it.

The `<a href>` + SW link route stays for the calcite path — it's a
JS-free way for a click to cross from the page into the host
runtime. The constraint is "no JS on the page", not "no SW".

**Calcite side (the recogniser, not a cheat):** at compile time,
walk the parsed assignment graph; for any RHS that depends on a
`:has(…:pseudo)` selector match, record an `InputEdge { pseudo,
class, slot }`. Expose to the host:

```
engine.input_edges() -> [{ pseudo, class, property_slot }]
engine.set_pseudo_class_active(pseudo, class, value)
```

The SW parses `class=` from the URL, calls
`set_pseudo_class_active("active", "kb-1c0d", true)` for the
press-hold window, then `false`. Calcite owns the matching
internally. The `0x500` literal in `property_to_address` deletes —
the cabinet's `@property --keyboard` declaration supplies the
address through the normal address map.

The recogniser is structural: any cabinet (6502, brainfuck,
non-emulator) that drives a property from `:has(...:active)` gets
the same treatment. No upstream knowledge.

### Architectural proof

`web/player/experiments/active-input.html` +
`web/player/experiments/active-input-probe.mjs` verify the CSS
mechanism end-to-end in headless Chrome via Playwright. All eleven
assertions pass: rest=0, hold-Enter→7181, hold-A→7777,
hold-B→12386, release→0, cross-key isolation. So the
`:root:has(...:active)` propagation reaches a `@property`-registered
custom property visible via `getComputedStyle`. Confirms the design
is feasible before any kiln/calcite work commits to it.

Run: `node web/player/experiments/active-input-probe.mjs`. Headed:
add `--headed`.

### Work remaining

The CSS-DOS-side cardinal-rule path is wired (kiln rules, raw.html
DOM, `--keyboard` propagation verified end-to-end). The literal
calcite cheat is gone (`0x500` deleted). What's still side-channel:

The SW link route writes `--keyboard` directly via
`engine.set_keyboard(scancode)`, short-circuiting the cabinet's
`:has(#kb-X:active)` rules entirely. Calcite-wasm doesn't currently
evaluate `:active` selectors; instead the host pushes the scancode in.
That's *legitimate host plumbing under the no-page-JS constraint* — but
the principled version is for calcite to recognise the
`:has(#kb-X:active)` shape and let the host flip the edge generically.

Phase B — calcite recogniser for `:has(...:pseudo)` edges:

1. Parser preserves `:has(…:pseudo)` predicates in the assignment
   graph (verify they aren't stripped today).
2. Compile-time pass enumerates `InputEdge { pseudo, class, slot }`
   triples; expose `input_edges()` on `CalciteEngine`.
3. Evaluator: when computing an assignment that depends on an
   input-edge pseudo-class match, consult host-supplied state
   (`set_pseudo_class_active` writes a per-edge bool); fall through
   to false otherwise.
4. SW link handler switches from `engine.set_keyboard(scancode)` to
   parsing `class=` from URL and calling
   `engine.set_pseudo_class_active("active", class, true)` with the
   release scheduled by the existing key queue (KEY_HOLD_BATCHES /
   KEY_GAP_BATCHES in `web/shim/calcite-bridge.js`).
5. Delete `engine.set_keyboard` once nothing references it.
6. Verify: doom8088 in calcite-wasm responds to on-screen button
   clicks identically to today; bench-doom-loading swaps
   `setvar_pulse` for click-driven input.

Polishing items:

- Add comma, period, slash to `kiln/template.mjs::KEYBOARD_KEYS` so
  those keys also work in raw Chrome.
- `web/player/calcite-canvas.html` uses `data-key="0xHHHH"` instead
  of `id=kb-X`; align with `calcite.html`/`raw.html` pattern if it's
  still in use.

### Scope notes

- Out of scope for now: physical keyboard support (`:active` is
  mouse-driven; physical keys would need a JS shim or a
  `<label for="checkbox">` + accesskey trick — separate question).
- Out of scope: chord/modifier support. Single-key-at-a-time first.
- Out of scope: `setvar_pulse` removal in general. The primitive
  remains useful for non-keyboard test inputs and watch actions;
  bench profiles just stop using it for keyboard once the new
  surface lands.
- The "calcite is generic" cleanup also covers (separately):
  delete `column_drawer_fast_forward` (off by default, net loss);
  move `summary.rs` out of `calcite-core` (diagnostic, x86-named);
  move `state::render_screen / render_framebuffer / CGA_PALETTE`
  into a `calcite-pc-video` crate or CSS-DOS-side adapter; strip
  doom/DOS comments from `calcite-core` non-test code; reframe
  `rep_fast_forward` as a generic CSS-shape recogniser (perf-gated
  mission, doom8088 web+CLI within 1 % of current).

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
