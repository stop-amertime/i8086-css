# Audit summary and revised plan

Consolidates the conclusions from the 2026-04-30 / 2026-05-01 design
discussion into one place. Supersedes the prior framing in
`adapter-split-sketch.md` (deleted — obsoleted by the no-Rust-adapter
landing) and `adapter-split-agents.md` (being revised to match this
doc).

This doc has two sections: what the audit and discussion concluded
(the **landing point**), and what the cleanup work consists of given
that landing (the **spec + implementation outline**).

---

## Where we landed

### 1. The cardinal rule, in two sentences

Calcite is a CSS evaluator. Its only contract is "evaluate a CSS
cabinet faster than Chrome would, with the same result." It has no
business knowing about x86, BIOS, video modes, Doom, or any specific
program. CSS-DOS is a program-shaped consumer of calcite — it produces
cabinets and drives calcite to run them.

### 2. Calcite cheating is out of scope for this work

Calcite today violates its own cardinal rule in several places
(`column_drawer_fast_forward`, `rep_fast_forward`'s opcode-awareness,
`bda_push_key`, `render_framebuffer`, the keyboard property → 0x500
hardcode, etc.). The audit's §11 catalogues these.

**These cheats are calcite-internal localised problems and are
deliberately out of scope here.** They can stay where they are. If
they're moved, they move *within* calcite (e.g. into a clearly-labelled
`cheats/` module) — they do **not** move out into CSS-DOS.

There is **no Rust adapter** in this work's destination. The framing
"calcite exposes a `BulkPattern` registry; CSS-DOS-side adapter
registers x86 patterns" was a category error — that's just the cheat
relocated, not eliminated. Cleaning up calcite's cheats is a separate
future project.

What stays as work: knowing where the cheats are (the audit captures
this) and not propagating them further.

### 3. The player and the bench are different categories

The **player** is the published artifact. Its contract is "open this
URL, no install, the cabinet runs." This forces:

- The page itself contains effectively no JS. It's just HTML, CSS,
  `<img>`, `<a href>`. (Today: one tiny `<script>` block under
  `?bench=1`; user is removing it.)
- A **service worker** intercepts page requests (`GET /_stream/fb`,
  `GET /_kbd?key=X`) and responds with calcite-computed bytes. The SW
  *is* the shim — it sits in the protocol position the page expects
  and silently substitutes calcite for what would otherwise be
  Chrome's CSS evaluation.
- Calcite-wasm runs *inside* the SW. The page never imports calcite.

The **bench** is a development tool, not a deliverable. Nobody opens
the bench in production. The constraints that justify the player's
SW-shim contortions don't apply.

The bench can be — and should be — a **normal web app**:

- Rich JS on the page itself: profile runner, measurement collection,
  test orchestration, charting.
- Calcite-wasm in a Web Worker (kept only because heavy wasm compute
  can't block the UI thread).
- Page ↔ worker via standard `postMessage`.
- Playwright drives the page from Node.js as a regular consumer.

**The bench is not a shim.** The "no JS on the page" property is the
*player's* contract, not a CSS-DOS-wide invariant. Designing the bench
as a second shim shape was cargo-culting the player's constraint.

### 4. Calcite stays generic; pattern recognition is calcite's job

If a CSS shape is slow, calcite's pattern recognisers should detect it
generically and optimise it. They detect *CSS shape*, not upstream
intent. Pattern recognition is the entire point of calcite — that's
what a JIT does. Hardcoding "if opcode = 0xAA STOSB" is a failure of
generic recognition, not a feature.

If kiln emits CSS that calcite can't recognise generically, the
pressure goes onto **kiln** to emit a more recognisable shape, not
onto calcite to learn the shape. (This is the future-cleanup
direction; not this work's scope.)

### 5. There are three classes of code in CSS-DOS today

When auditing layering:

- **Calcite-the-engine** (`../calcite/crates/calcite-{core,cli,wasm}`):
  generic CSS evaluator. Has cheats today; cheats stay for now.
- **CSS-DOS-the-platform**: kiln, builder, BIOSes, carts, the player,
  the player's shim (SW), the bench harness, dev server.
- **The cabinet**: the `.css` file. The contract between the two.
  Produced by CSS-DOS, consumed by calcite or by Chrome.

There is **no fourth "adapter" category**. What the audit had been
calling adapter is just CSS-DOS-the-platform's own code — it consumes
calcite's outputs (memory state, framebuffer bytes), it doesn't hook
into calcite's internals.

Some code currently in the `calcite/` repo belongs in CSS-DOS by this
classification (e.g. `calcite/web/video-modes.mjs`, `calcite/site/`,
`calcite/serve.mjs`, `calcite/programs/`, the Doom-shaped `.bat`
files). Moving those is in scope.

Some code in `calcite/crates/calcite-core/` is cheating (renderers,
BDA, REP-opcode-awareness, etc.) — but per §2, that's out of scope.
Documented for future work.

### 6. The script-primitive layer is the key user-facing improvement

Audit §10 #1: the three condition/scripting DSLs (calcite-cli's
`--cond` + `--script-event` + `--poll-stride`; `tests/harness/lib/
script-runner.mjs`'s JSON; the per-bench inlined polling) collapse
into one substrate.

The substrate is: a small set of **measurement primitives** in
calcite-core, exposed identically on calcite-cli (for native runs)
and calcite-wasm (for browser runs). Primitives:

- **stride(N)** — fire every Nth tick.
- **burst(every=N, count=K)** — fire on K consecutive ticks every N.
- **edge(addr)** — fire on byte-value transitions.
- **cond(predicate)** — fire when a predicate holds. Predicates are
  generic memory comparisons, not `vram_text:NEEDLE`-shaped (those
  helpers wrap the generic primitive on the consumer side).
- **halt(addr)** — fire when byte at addr nonzero.

Each primitive can trigger actions: emit a measurement record, dump
memory, take a snapshot. Expensive primitives only fire when cheap
ones gate them — by structural design, not by discipline.

This is generic calcite-core work. No upstream knowledge.

### 7. Bench harness: profiles, not scripts

Audit §10 #2: replace the four `bench-doom-*.mjs` scripts +
`bench-web.mjs` + `bench/run.mjs` with one bench harness driving
**named profiles**. A profile is a small JS file declaring:

```
{ cart, target: 'web' | 'cli', stages: [...], report: '...' }
```

Each stage runs calcite (web or native) with a script built from the
primitives in §6, optionally restoring from a previous stage's
snapshot. Profiles compose; reports are named shapes computed from the
results stream.

This is JS work, lives in CSS-DOS. Replaces ~6 ad-hoc scripts with
one harness + a profiles directory.

### 8. The destination layout

```
calcite/                        — separate repo, generic CSS JIT
  crates/calcite-core           — engine + script primitives + (current
                                  cheats stay; documented as cheats but
                                  not relocated by this work)
  crates/calcite-cli            — generic CSS-cabinet runner
  crates/calcite-wasm           — wasm-bindgen wrapper
  examples/                     — trivial non-x86 cabinets that prove
                                  calcite is independently useful
                                  (a clock, a sieve in CSS, etc.)

CSS-DOS/                        — the cabinet-producing platform
  kiln/, builder/, bios/        — unchanged
  carts/                        — unchanged
  player/                       — published artifact: zero-JS pages,
                                  service worker, calcite-wasm-in-SW
    shim/   (or similar)          — the SW + supporting code, gathered
                                    in one place if not already
  bench/    (or tests/bench/)   — the bench harness + profiles. NOT a
                                  shim; a normal web app. Page has full
                                  JS; worker holds calcite-wasm.
    profiles/                     — named bench profiles (doom-loading,
                                    doom-gameplay, zork-steady, etc.)
    page/                         — bench page HTML/JS
    driver/                       — Node.js Playwright driver
  tests/harness/                — conformance + ref-machine + everything
                                  that isn't the bench harness
  web/                          — dev server, prebake
  dos/                          — DOS binaries
```

Note "shim" and "bench" folders are organisational suggestions, not
required exact paths. The principle: the player shim has one home,
the bench harness has another, and they don't share code unless
genuinely shared (probably almost nothing).

### 9. The bigbang vs. incremental decision

Earlier discussion concluded **bigbang is the right shape** for this
work: single developer driving agents, intermediate states are no
better than the start or end, rollback is `git reset`. So the agent
plan should reflect that — one big restructure on a feature branch,
many small commits for bisectability, validate against bench baseline
at the end, merge.

That's substantially fewer agents (and phases) than the original
incremental plan.

---

## Spec + implementation outline

The work splits into roughly five chunks. Within the bigbang shape
they all happen on one branch, but they're listed separately because
they're independent enough that one agent could own each and run in
parallel where the surfaces are disjoint.

### Chunk A — Pre-flight inventory (sequential, gates everything)

One agent. Resolves the "I'm not sure about X" items from audit §9
and captures a bench baseline that everything later diffs against.
About an hour.

Outputs:

- `tmp/split-baseline.json` with current CLI + web doom8088 numbers.
- A logbook entry resolving:
  - Status of `tools/compare.mjs`, calcite-side `tools/{diagnose,
    codebug,boot-trace,ref-emu,calc-mem}.mjs` (each: works / broken /
    zombie).
  - Whether `out/`, `bench/run.mjs`, `calcite/programs/`,
    `calcite/output/` have any live consumers.
  - Whether `calcite/site/` has any live consumers.
- Confirmation that `doom8088.css` at repo root rebuilds from
  `carts/doom8088` and matches what `bench-doom-stages-cli.mjs`
  reads.

This chunk doesn't move anything. It just answers the questions.

### Chunk B — Calcite-side cleanup (parallelisable with C)

One agent. Deletes the genuinely-dead calcite-side stuff that's
unambiguously a cardinal-rule violation or just abandoned.

In `calcite/`:

- Delete: `site/`, `serve.mjs`, `serve.py`, `programs/`, `output/`.
- Delete: the `.bat` files except `kill-and-rebuild.bat`, `run.bat`,
  `start-debugger-daemon.bat`. (The deleted ones are
  `bench-splash.bat`, `run-bios-test.bat`, `run-oldbios-test.bat`,
  `run-splash.bat`, `run-web.bat`, `run-js.bat` — all
  CSS-DOS-shaped.)
- Delete: `tools/fulldiff.mjs`, `tools/ref-dos.mjs` (BROKEN-marked).
- Move to `tools/archive/`: any of `tools/{diagnose,codebug,
  boot-trace,ref-emu,calc-mem,compare}.mjs` confirmed zombie in
  Chunk A.
- Delete: `target/release/calcite-debugger.exe.old`.
- Strip `calcite-cli/src/menu.rs` of its `node ../CSS-DOS/builder/
  build.mjs` shell-out. The interactive menu lists pre-built `.css`
  files only.
- Update `calcite/CLAUDE.md` to remove references to deleted things
  and to remove "Pre-built `.css` cabinets in `output/`" framing.

Verification: `cd ../calcite && cargo test --workspace` passes;
`wasm-pack build crates/calcite-wasm` succeeds; calcite builds with
CSS-DOS dir temporarily renamed (proves no cross-repo dep remains).

Logbook: `../calcite/docs/log.md`.

### Chunk C — CSS-DOS-side relocation (parallelisable with B)

One agent. Moves CSS-DOS-shaped code from `calcite/` to `CSS-DOS/`,
and consolidates CSS-DOS's player-shim code if it's currently
scattered.

In `CSS-DOS/`:

- Move: `calcite/web/video-modes.mjs` → wherever the player's shim
  code lives (likely `player/shim/video-modes.mjs` or similar).
  Update imports in `player/calcite-bridge.js` and
  `web/scripts/dev.mjs`.
- Decide: does the existing player shim code (currently scattered
  between `player/calcite-bridge.js`, the SW source if separate, and
  any helpers) need consolidation into a `player/shim/` (or
  `CSS-DOS/shim/`) folder? If yes, do that consolidation. If the
  current spread is fine, document it in `player/README.md`.
- Move CSS-DOS-shaped JS that today lives in
  `tests/harness/lib/` (specifically `cabinet-header.mjs` and parts
  of `ref-machine.mjs` that are sidecar-binary loaders) into the
  shim's home if it makes sense, or leave them in
  `tests/harness/lib/` as harness-side code. The decision is whether
  the shim and the harness share these — if they do, factor out;
  if not, leave alone.
- Remove the `?bench=1` script tag from `player/calcite.html`. (User
  is doing this; agent verifies it's been done before continuing.)

Verification: smoke + doom-stages bench within ±10% of baseline; web
player loads doom8088 to title; conformance harness still runs.

Logbook: `docs/logbook/LOGBOOK.md`.

### Chunk D — Script-primitive layer in calcite-core (sequential, must follow A)

One agent. Implements the watch / stride / burst / edge / cond / halt
primitives in calcite-core, exposes them on calcite-cli and
calcite-wasm.

Surface:

- In calcite-core: a public API for registering watches and emitting
  measurement events. Generic, no upstream knowledge. The existing
  `--cond` and `--poll-stride` and `--script-event` machinery
  becomes a clap-side wrapper that translates to the generic API.
- On calcite-cli: `--watch`, `--stride`, `--burst`, `--measure-out=PATH`
  flags. The current `--cond` becomes an alias for the new generic
  shape (or can be removed if no current consumer needs the old
  syntax — verify in Chunk A).
- On calcite-wasm: methods like `engine.registerWatch(...)`,
  `engine.registerStride(...)`. Results emitted as a stream the
  caller consumes.

Tests: trivial cabinets that exercise each primitive (no x86
content). E.g. a cabinet that increments a counter; verify
`stride(100)` fires every 100 ticks; verify `cond(--counter > 50)`
fires once.

Verification: existing `bench-doom-stages-cli.mjs` keeps working
(the generic primitives compose to the same effect).

Logbook: `../calcite/docs/log.md`.

### Chunk E — Bench harness rebuild (sequential, must follow D)

One agent. Replaces the four `bench-doom-*.mjs` + `bench-web.mjs` +
`bench/run.mjs` with one bench harness + a profiles directory.

The bench is a normal web app:

- Page (`tests/bench/page/index.html`): full JS, runs calcite-wasm
  in a worker via `postMessage`. UI shows progress / measurements
  / charts.
- Driver (`tests/bench/driver/run.mjs`): Node.js, drives the page
  via Playwright OR drives `cssdos-cli` for native runs. One driver,
  two transports.
- Profiles (`tests/bench/profiles/*.mjs`): one file per named
  benchmark.

Run with: `node tests/bench/run.mjs <profile-name>` or similar.

The native CLI is `calcite-cli` directly (no `cssdos-cli` since
there's no Rust adapter). For CSS-DOS-aware predicates (text VRAM
matching, framebuffer ready), the profile expresses them in terms
of the generic primitives from Chunk D — e.g. a profile that wants
to detect "DR-DOS appears in text VRAM" emits a generic
`watch byte_pattern_at(0xB8000, stride=2, needle="DR-DOS")` rather
than a `vram_text:` predicate. The upstream knowledge (text VRAM is
at 0xB8000 with stride 2) lives in the *profile*, where it
belongs — that's CSS-DOS-side code, expressing CSS-DOS-side
knowledge, in the right place.

Delete after migration: the six replaced bench scripts, the
`bench/` folder if it had run.mjs.

Verification: `node tests/bench/run.mjs doom-loading-window`
produces results within ±5% of Chunk A baseline.

Logbook: `docs/logbook/LOGBOOK.md`.

### Chunk F — Documentation reconciliation (sequential, last)

One agent. Walks through the doc drift catalogued in audit §7 and
fixes everything to match reality after the cleanup.

Concretely:

- Rewrite `tests/harness/README.md` "What each tool does" table from
  source.
- Remove `bisect` from `run.mjs` doc (not implemented).
- Update `tools/README.md`: remove "slated for consolidation" line;
  mark genuine status of each remaining tool.
- Update `conformance/README.md` for the ref-machine subsumption.
- Reconcile `mcp-shim.mjs` and `start-debugger-daemon.bat` claims
  about autostart.
- Update `docs/INDEX.md`, `docs/TESTING.md` for the new bench
  harness.
- New: `docs/rebuild-when.md` mapping "edit X → rebuild Y by command
  Z" for kiln/builder/calcite-core/calcite-wasm/prebake. Plus
  cache-clearing flow (the dev server's `/_reset` and `/_clear`
  endpoints).
- Update calcite/CLAUDE.md to reflect the cleanup (no `output/`,
  generic-CSS-JIT framing).
- Add to both CLAUDE.md files: "Calcite engine work is logged in
  `../calcite/docs/log.md`. CSS-DOS platform/harness/bench work is
  logged in `docs/logbook/LOGBOOK.md`. If the work touches both,
  log in both."
- Move recent calcite-perf entries from CSS-DOS LOGBOOK to calcite's
  log.md (per audit §7).

Logbook: both, with a brief entry describing the doc pass.

### Chunk G — Debris sweep (optional, can be folded into F)

Tidy the things audit §6 flagged:

- `tmp/` (243 files) — wipe, no migration needed.
- `tests/harness/results/` — delete the 60+ committed PNGs;
  add `*.png` to gitignore for that directory.
- `bench/build/` — delete (the harness it served is gone).
- `docs/superpowers/` — already in gitignore but tracked. Untrack.

---

## Sequencing

```
A (inventory)
↓
B (calcite cleanup) ┐  parallel
C (CSS-DOS moves)   ┘
↓
D (script primitives)
↓
E (bench harness)
↓
F (docs)
```

Total work, full-time: roughly 1-2 weeks. B and C are afternoons each.
D is a few days (real design + impl on calcite-core's public API). E
is a few days (mostly mechanical re-shape of existing JS). F is a
day. A is an hour.

All on one feature branch in each repo. Many small commits for
bisectability. Validate at the end against Chunk A's baseline; merge.
Rollback if needed is `git reset` to the start of the branch.

---

## What's deliberately NOT in this work

For the record, so future agents don't pull these into scope:

- Removing calcite's cheats (`column_drawer_fast_forward`,
  `rep_fast_forward`'s opcode-awareness, BDA hardcode, renderers in
  calcite-core, etc.). Documented in audit §11; deferred.
- Building a Rust adapter or `BulkPattern` extension API on calcite-core.
- The MCP debugger overhaul (audit §4).
- Publishing calcite as a versioned crate.
- Rewriting kiln to emit more-recognisable CSS shapes.
- Anything in calcite's `tests/fixtures/` (x86CSS test artifacts) —
  those exist and aren't great but aren't worth touching now.

Each is a defensible follow-on. None block this work.

---

## Open questions before any agent starts

1. **Shim folder location.** Does the player's SW + supporting code
   want a clear `player/shim/` (or `CSS-DOS/shim/`) home, or is the
   current spread fine with documentation? Affects Chunk C's scope.
2. **Bench location.** `tests/bench/` or top-level `bench/`? (The
   existing `bench/` is being deleted, so the slot opens up.)
   Affects Chunk E.
3. **`--cond` deprecation.** Are there any external consumers of
   calcite-cli's current `--cond` syntax that need it preserved as
   an alias, or can Chunk D replace it cleanly? Chunk A determines.
4. **Doom8088 `doom8088.css` at repo root.** Rebuild it as part of
   Chunk A's baseline, or document as "stale, expected to be rebuilt
   by anyone running the bench"? Per audit §2 there's no canonical
   answer; pick one and document.
