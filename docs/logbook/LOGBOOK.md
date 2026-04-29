# CSS-DOS Logbook

Last updated: 2026-04-29

## 2026-04-29 — fusion-sim: 88.6% body compose on doom column-drawer

Resumed the segment-0x55 fusion lead. Pushed the body-composition
probe from 52% → 88.6% FULL compose by extending fusion_sim with
real dispatch-table support and doing per-byte decoder pinning.

**Probe extensions (`crates/calcite-cli/src/bin/probe_fusion_compose.rs`):**
- Per-body-byte decoder pin table — for each opcode-byte in the
  21-byte column-drawer body, asserts the values of `--prefixLen`,
  `--opcode`, `--mod`, `--reg`, `--rm`, `--q0`/`--q1` at fire time.
- Body-invariant slot pins applied each fire — `--hasREP=0`,
  `--_repActive=0`, `--_repContinue=0`, `--_repZF=0`, all segment-
  override-active flags = 0. Eliminates STOSW REP-path branch bails.
- Skip non-fire bytes (modrm + immediates). Real execution only fires
  dispatch on opcode bytes; iterating modrm/imm bytes triggered phantom
  dispatches that the simulator was bailing on.
- Bail-reason histogram + targeted diagnostic (`CALCITE_DUMP_BAIL_OPS`).

**fusion_sim extensions (`crates/calcite-core/src/pattern/fusion_sim.rs`):**
- `Op::DispatchChain` Const-keyed resolution. Walk `chain_tables[chain_id]`
  with the keying slot's Const value, jump to body PC or `miss_target`.
  Eliminated 8 `dispatch*` bails on bytes 2 (0xd0) and 15 (0x81).
- `Op::Dispatch` Const-keyed resolution. Recursively simulate the
  HashMap entry's ops on the same env, then write `result_slot` into
  `dst`. Threads `dispatch_tables` through `simulate_ops_full_ext`.
- `Op::DispatchFlatArray` non-Const fallthrough → new `SymExpr::FlatArrayLookup`
  symbolic node. Lets the simulator carry runtime array lookups through
  the rest of the entry instead of bailing.

**Probe results on the 21-byte column-drawer body (44 fire tables):**
```
                  FULL   partial   bail
baseline (start)   23     16        5      52.3%
+ pin per-byte     27     17        0      61.4%
+ skip non-fire    30     14        0      68.2%
+ DispatchChain    36      8        0      81.8%
+ Dispatch         38      6        0      86.4%
+ flag invariants  39      5        0      88.6%
+ FlatArrayLookup  39      5        0      88.6% (no change)
```

Last 5 partials: deep flag-side bails — the first FlatArrayLookup result
flows into a `BranchIfNotEqLit` that needs Const but gets a symbolic
expression. Resolving that requires representing branch outcomes
symbolically (essentially partial compilation through if-trees), which
is a much larger lift than this session's scope. 88.6% is comfortably
above the threshold for fusion-emit to be useful.

**Sample composed expressions** at FULL tables (these are end-of-21-byte
post-body register/flag states expressed against entry-state slots):
```
table 40: LowerBytes(BitOr16(Slot(--rmVal16), Add(Slot(--immByte), Mul(BitExtract(Slot(--immByte), Const(7)), Const(...))))
table 42: LowerBytes(Add(Floor(Div(Slot(--rmVal16), Const(2))), Mul(BitExtract(Slot(--rmVal16), Const(0)), Const(...))))
table 50: Shr(LowerBytes(Add(Floor(Div(Slot(--rmVal16), Max([Const(1), Slot(--_pow2CL)]))), ...
```

Tests: 13 fusion_sim tests pass under release. (4 pre-existing failures
in `compile::tests` are unrelated — confirmed via stash diff against
main.) wasm32 build clean (no changes to wasm-relevant code).

**Not yet done.** SymExpr → Op translation, runtime CS:IP fusion-site
detector, CSS wiring, smoke gate. The simulator now produces a
production-quality intermediate representation; turning that into an
actual `Op::FusedBody` that fires at the right CS:IP and replays
memory writes correctly is the next layer.

## 2026-04-29 — calcite-v2-rewrite stream: Phase 1 lands

Parallel stream to the additive `calcite-v2` worktree, branch
`calcite-v2-rewrite`. Clean rewrite from `ParsedProgram` (parser
output) instead of `Vec<Op>` (v1 bytecode), so the DAG and its later
rewriters aren't downstream of v1's pattern decisions.

Phase 1 deliverable: a v2 DAG walker that produces results matching
Chrome on the primitive conformance suite. Backend enum
(`Bytecode | DagV2`) on `Evaluator`; default stays Bytecode, opt-in
via `set_backend(Backend::DagV2)`.

**Phase 0.5 conformance against Chrome**: v2 41 PASS / 5 SKIP / 3
XFAIL — identical to v1's result. Same 3 documented gaps (div-by-
zero serialisation, ignored-selector handling, var-undefined-no-
fallback invalidity propagation) carry through.

**Walker shape**: terminals topologically sorted at DAG-build time by
`LoadVar Current` dependency edges. Walker runs sorted terminals
against a per-tick value cache (state-var slots: `Vec<Option<i32>>`;
memory: sparse `HashMap`). `LoadVar Current` reads cache then
committed state; `LoadVar Prev` reads committed state directly. CSS
spec: cascade resolves with substitution, this is the textbook
implementation. Buffer-copy assignments (`--__0/__1/__2` prefixed)
are skipped since the prefix-stripped slot model already exposes the
prior tick's value as `LoadVar Prev`.

**FuncCall**: Phase 1 stub delegates to v1's `eval_function_call` by
rebuilding `Expr::Literal` arguments from DAG-evaluated values.
Phase 2 inlines bodies natively. **IndirectStore** (broadcast
write): Phase 1 stub. Conformance suite doesn't exercise broadcasts;
real cabinet exercise is Phase 2.

**Two v1 fixes ported in along the way**, both real CSS-spec
compliance:
- `compile.rs`: gate `rep_fast_forward` on a new
  `CompiledProgram::has_rep_machinery` flag (true iff the program
  declares `--opcode`). Toy CSS programs and non-emulator cabinets
  skip the hook entirely. Side benefit: fixes pre-existing
  main-branch breakage where every cabinet without `--opcode`
  panicked at tick.
- `CalcOp::Mod` fixed in three places (compile const-fold,
  exec_ops Op::Mod, exec_ops Op::ModLit, eval.rs interpreter) to
  match CSS-spec floor-mod (`mod(-7, 3) == 2`), not Rust's
  sign-of-dividend `%`. Caught by the `calc_mod_negative` fixture.

`cargo test -p calcite-core`: 196 pass, 5 pre-existing rep-fast-
forward fails unrelated. `wasm-pack build`: clean.

Decision-gate read: paid off as foundation. The next decision gate is
Phase 2's "≥30% DAG node count reduction on the Doom cabinet" —
which requires a Doom cabinet in the worktree and the broadcast/
dispatch recognisers to consume `prebuilt_broadcast_writes` properly.
Phase 1 wraps; not merging to main — owner reconciles streams.

## 2026-04-28 — calcite Phase 3 prototype: closure backend over the DAG

Option (c) per the mission doc — each block lowers to a Vec<Box<dyn Fn>>
plus a pre-resolved TerminatorPlan; the walker runs closures in order then
consults the terminator. No match on Op on the hot path. Specialised
closures for ~10 common ops; everything else falls through to exec_ops
on a one-op slice (same semantics, one closure-call's worth of indirection).

162 tests green, including backend_equivalence under all three backends
(bytecode/dag/closure, 200 ticks bit-identical) and primitive_conformance
under all three. wasm32 build clean. Smoke timings on web/demo.css:
bytecode 261k t/s, dag 210k, closure 220k. Closure is 1.19x slower than
bytecode — exactly what the spec predicts at the prototype stage (option
(c) ceiling is 3–5x with full op specialisation, this prototype only
specialises 10 of ~50 ops).

Two bugs shaken out by writing the closure backend:
- Op::AndLit val is the literal mask bits, not a bit-width. Phase 2's
  BitFieldMatch and LitMerge::And had the wrong semantics; fixed.
- ShrLit / ShlLit use signed i32 shifts, not unsigned. Closure was
  masking input as u32; fixed.

Phase 3 main (option (a) hand-emitted wasm) deferred — several weeks
of work and the prototype validates the lowering shape codegen would
build on. Revisit once a Doom cabinet is in the worktree so the 5x
speedup gate is measurable.

## 2026-04-28 — calcite Phase 2 — recogniser substrate landed

Idiom catalogue (14 CSS-structural shapes derived from
`kiln/emit-css.mjs`), `Pattern` trait + driver in `dag/normalise.rs`,
first batch of 9 generic recognisers in `dag/patterns.rs` (LitMerge,
BitField, Hold, RepeatedLoad). Annotations sit parallel to ops so
Phase 2 stays bit-identical by construction. 161 calcite-core tests
green; Phase 1 gates (backend equivalence, primitive conformance)
still pass; wasm32 clean. Annotation density on `web/demo.css` is
0.1 % — expected, since v1 already collapses the dominant shapes.
The metric is meant for Doom, which isn't in this worktree; revisit
when it lands.


## 2026-04-28 — Load-time fusion: byte-period detector + fusion-sim landed

Built the bottom two layers of the load-time fusion pipeline as a
fresh lead after the replicated-body recogniser came up empty.

**Layer 1: byte_period detector** (calcite, generic). Walks rom-disk
bytes, finds periodic regions (period P, K reps). On doom8088: scan
runs in 610 ms over the 1.83 MB image, finds 4065 periodic regions.
Headline match: 21-byte × 16-rep region at offset 86306 — the
column-drawer kernel. A 21×14 sibling at offset 86661 (different
column-drawer variant). 30 total occurrences of the 21-byte body
across the cart. Driver: `probe-byte-periods` calcite-cli binary.

**Layer 2: fusion_sim symbolic interpreter** (calcite, generic).
Walks compiled Op trees, threads slot reads as `SymExpr::Slot` free
variables, composes arithmetic/bitwise ops symbolically. Distinguishes
calcite's `And`/`AndLit` (lowerBytes truncation) from `BitAnd16`
(true bitwise). Bails on branches, memory side-effects, and currently-
unsupported variants. Driver: `probe-fusion-sim` calcite-cli binary.

**Concrete win** in table 21 (232-entry per-register dispatch with
`result_slot=386862` = `--ip`): simulator successfully composes the
IP-advance expression for **12 of 15** doom column-drawer body bytes:

  - `0x88` → `Add(Const(2), Slot(37))` — 2-byte instr base + offset
  - `0x81` → `Add(Add(Const(2), Slot(37)), Const(2))` — 4-byte instr
  - `0xea` → `Add(Slot(27), Mul(Slot(28), Const(256)))` — far jump

The remaining 3 bail: `0xe8` (Div), `0xab` STOSW (`Branch` on
`--df`), `0xcb` (nested `LoadMem`). Handling `0xab` requires the
simulator to evaluate branches under known-flag assumptions (CLD has
fired before the unrolled body, so `--df=0`).

**What's not done yet.** Composing across 21 dispatch entries (the
body) and 16 reps is the next layer. Wiring `--fusedKey` into the CSS
to fire fused entries instead of per-byte ones is the layer after.
Both pending.

Files (calcite repo): `crates/calcite-core/src/pattern/byte_period.rs`,
`crates/calcite-core/src/pattern/fusion_sim.rs`,
`crates/calcite-cli/src/bin/probe_byte_periods.rs`,
`crates/calcite-cli/src/bin/probe_fusion_sim.rs`. 19 unit tests pass
(10 byte_period + 9 fusion_sim). Smoke gate not re-run; this is
diagnostic infrastructure that doesn't touch any execution path.

### 2026-04-28 (followup) — Body-composition probe + simulator extensions

Added `probe-fusion-compose`: simulates every dispatch table's entries
across the full 21-byte doom column-drawer body in sequence (threading
slot env forward) and reports per-table FULL / partial / BAIL.

Extended fusion_sim's supported-Op set to include `Bit`, `Div`, `Round`,
`Min`, `Max`, `Abs`, `Sign`, `Clamp`, `CmpEq`, and `DispatchFlatArray`
(const-key path). Added `Assumptions` machinery for resolving
`LoadState`/`LoadStateAndBranchIfNotEqLit` against compile-time-known
flag values (e.g. `--df=0` after CLD).

**Results on doom8088 column-drawer body (44 tables fire for the body
bytes):**

  - Initial cut:    14/44 tables FULL compose (32%)
  - +CFG/assumptions: 14/44 (no change — bails were on non-LoadState slots)
  - +Bit/Div/Round/Min/Max/Abs/Sign/Clamp/CmpEq:  23/44 (52%)
  - +DispatchFlatArray (const-key):  23/44 (no change — keys are symbolic)

Examples of the non-trivial composed expressions yielded by the FULL
tables:

```
table 40: LowerBytes(BitOr16(Slot(49), Add(Slot(46), Mul(BitExtract(Slot(46), Const(7)), Const(...)))))
table 42: LowerBytes(Add(Floor(Div(Slot(49), Const(2))), Mul(BitExtract(Slot(49), Const(0)), Const(...))))
table 50: Shr(LowerBytes(Add(Floor(Div(Slot(49), Max([Const(1), Slot(81)]))), ...
```

These are real, fully-composed post-body register/flag states
expressed against entry-state slots. Exactly the symbolic
intermediate fusion needs.

**Remaining 16 partial + 5 bail tables:** mostly hit
`Branch (non-const)` on byte 4 (0x89 — `mov r/m, r` with non-const
register comparison) or `DispatchFlatArray (non-const key)` on byte 18
(0x00 in the immediate). These bail because the comparator/key slot
holds a non-Const symbolic expression. Pushing past 52% requires the
simulator to either:

  (a) Track which slots are "register-shaped" and reason about them
      symbolically at a higher level (essentially a partial register
      lattice), or
  (b) Add SymExpr nodes for symbolic array indexing.

Both push this lead into the territory of real compiler work.

**Strategic assessment.** Even at 100% compose, this lead targets the
column-drawer hot path (most of segment 0x55, ~50% of level-load CPU)
with maybe 5-15× per-tick speedup IF the simulator and CSS wiring
land cleanly. The next required work is real compiler engineering —
runtime CS:IP detection, memory-write-side-effect simulation, IP
advancement, correctness verification.

**Decision: pause this lead.** Code stays in main as committed —
correct, well-tested, and useful diagnostic infrastructure. Resume
if a future cabinet needs fusion as a tactical perf win.

Files added/extended:
  - `crates/calcite-core/src/pattern/fusion_sim.rs` — symbolic
    interpreter with CFG, assumptions, flat-array support
  - `crates/calcite-cli/src/bin/probe_byte_periods.rs` — byte-period scan
  - `crates/calcite-cli/src/bin/probe_fusion_sim.rs` — per-entry compose probe
  - `crates/calcite-cli/src/bin/probe_fusion_compose.rs` — full-body compose probe

Smoke not re-run (no execution-path changes).

## 2026-04-28 — Replicated-body recogniser: built, dead lead

Built a generic recogniser in calcite-core that detects unrolled
straight-line regions in the compiled op stream and folds them into
`Op::ReplicatedBody`. Period detector + per-Op-variant operand stride
classifier + eval arm in all three runners (production, profiled,
traced) + pipeline wiring after `compact_slots`. 34 unit tests covering
period detection, operand classification, apply-strides round-trip, and
end-to-end conformance against the unrolled equivalent. CSS-DOS smoke
green (7 carts).

**Empirical result on doom8088: zero regions folded.** Diagnostic
`CALCITE_DBG_REPL=1` showed the largest straight-line region in the
405K-op main array is **32 ops**; only 11 regions across 24,596 reach
the 16-op threshold; period-detector finds no period in any of them.

Why the lead failed: the asm-level "16× unrolled XLAT body" lives in
`i_vv13ha.asm` etc. as 16 back-to-back 6-op pixel kernels, but
**Kiln compiles each x86 instruction into its own CSS dispatch entry**
(one entry per opcode). The repetition is at runtime — the dispatch
loop fires opcodes 1..6 sixteen times — not in the static op stream.
Calcite's per-array op sequences are short fragments, not unrolled
kernels. To recognise the repetition we'd need a dispatch-trace
analyser that detects cycles at execution time, which is a different
problem (and starts to overfit toward "calcite knows about
emitter-shaped opcodes" in a way the cardinal rule discourages).

What I should have done first: capture an unrolled region and verify
its CSS shape before committing the design. The 5-hour build is
reusable code (the recogniser is generic and correct), but it doesn't
fire on this cabinet, so the perf needle didn't move. Lesson logged for
future leads — *measure the static shape calcite actually sees before
designing a recogniser around the asm shape*.

Code stays in main: it's correct, costs ~0ms at compile time when
nothing matches, and may fire on future cabinets whose emitters do
produce flat unrolled bodies. Not reverted.

Files: `crates/calcite-core/src/pattern/replicated_body.rs` (new,
~750 LoC including tests), `crates/calcite-core/src/compile.rs`
(Op::ReplicatedBody variant, eval arms in all three runners,
`recognise_replicated_bodies` pass, `unreachable!` arms in slot
utilities, conformance tests).

Next: a fresh perf lead grounded in actual op-stream measurements
rather than asm intuition.

## 2026-04-28 — XLAT segment-override fix (kiln correctness)

Kiln was emitting `--_xlatByte` with DS hard-coded as the segment, ignoring
any 0x26/0x2E/0x36/0x3E prefix. Doom8088's column drawer uses `ss xlat`
twice per pixel to read the colormap from SS:BX (see `i_vv13ha.asm`,
`i_vv13ma.asm`, `i_vv13la.asm`, `i_vegaa.asm`, `i_vmodya.asm`,
`i_vcgaa.asm`) — so every textured wall/sprite/sky pixel was reading from
DS:BX+AL, returning whatever happened to live at that DS offset rather
than the colormap entry. Fix: use `--directSeg` (override-or-DS, same
helper MOV AL,[mem] uses) at `kiln/decode.mjs:362`.

Verified: smoke (7 carts) green; Doom8088 reaches in-game on the web
bench (`stage_ingame` at tick 34.4M, `runMsToInGame` 110s) and the
gameplay frame renders correctly. Title splash unaffected (uses
V_DrawRaw, no XLAT).

Also rewired the smoke list — small carts moved to `carts/test-carts/`
so the harness was silently running only zork+montezuma; now all 7 fire.

## Current status

Working carts: zork, montezuma, sokoban, zork-big (2.88 MB), command-bare,
shelltest, the smoke set (dos-smoke, hello-text, cga4-stripes, cga5-mono,
cga6-hires). Doom8088 reaches in-game on **both** the web player and
calcite-cli. Prince of Persia reaches the title screen.

The smoke suite at `tests/harness/run.mjs smoke` (7 carts) is the
regression gate.

## 2026-04-28 — 3 word-slot scheme (worktree-3slot)

The kiln moves from **6 byte-slots → 3 word-slots** for memory writes.
Each slot now carries `--_slotKWidth` (1 or 2): width=2 packs an
addr/addr+1 byte-write pair into one slot whose `--memValK` holds the
un-split 16-bit word. INT/IRQ frames (FLAGS+CS+IP = 3 words) fit the
new 3-slot worst case exactly. `--applySlot` becomes 6-arg
(loOff, hiOff, val, width) and handles aligned-word, byte, and odd-
addressed straddle splices.

Calcite recogniser (`packed_broadcast_write.rs` + parser fast-path)
updated to recognise the new 6-arg shape; `CompiledPackedBroadcastWrite`
gains `width_slot` and the splice paths in `compile.rs`/`eval.rs` apply
1- or 2-byte writes per port per tick.

Cabinet size and headline measurements (calcite-cli native, post-merge
on top of `23c01df`):

| Cart    | 6-slot   | 3-slot   | Δ      |
|---------|---------:|---------:|-------:|
| dos-smoke (test) | 152.6 MB | 139.9 MB | −8.3% |
| zork1   | 299.6 MB | 274.7 MB | −8.3% |
| doom8088 | 341.7 MB | 316.9 MB | −7.3% |

Doom8088 stage bench (`bench-doom-stages-cli.mjs`):

| Stage         | 6-slot     | 3-slot     | Δ     |
|---------------|-----------:|-----------:|------:|
| text_drdos    |  1 110 ms  |  1 083 ms  | −2.4% |
| text_doom     |  3 751 ms  |  3 635 ms  | −3.1% |
| title         |  9 524 ms  |  9 284 ms  | −2.5% |
| menu          | 10 304 ms  | 10 024 ms  | −2.7% |
| loading       | 13 655 ms  | 13 319 ms  | −2.5% |
| **ingame**    | **90 995 ms** | **85 323 ms** | **−6.2%** |
| **runMsToInGame** | **91.0 s** | **85.3 s** | **−6.2% (5.7 s saved)** |
| ticksToInGame | 35 000 000 | 35 000 000 | identical |
| cyclesToInGame| 397 458 534 | 397 458 534 | identical |

**Same cycle count, same tick count to in-game** — the CPU is doing
identical work; the saving is per-tick CSS evaluation cost. The
level-load window (loading→ingame, 29.5 M ticks) drops 77.3 s → 72.0 s
= −6.9%.

Zork1 5 M-tick run also shows ~3% per-tick speedup with no per-cycle
regression, plus 20% faster compile.

The change is feature-complete in the worktrees. Open follow-ups:
- Calcite-wasm rebuild + web bench cross-check (web has a different
  per-tick fixed cost; the bridge measurement should still see ~6%).
- Snapshot files from 2026-04-28 are invalidated by this change
  (slot count + applySlot arity changed). Recapture if you need to
  iterate on level-load.

Worktrees:
- CSS-DOS: `.claude/worktrees/3slot/`, branch `worktree-3slot` (kiln + docs)
- calcite: `.claude/worktrees/3slot/`, branch `worktree-3slot` (recogniser + splice)

To run a worktree against the matching calcite, set `CALCITE_REPO`:
```
export CALCITE_REPO=/c/Users/.../calcite/.claude/worktrees/3slot
```
See CLAUDE.md "Working in a git worktree".

## Active focus — Doom8088 level-load is too slow

Re-measured 2026-04-28 (current cabinet, current calcite). Both numbers
are `stage_loading → stage_ingame` deltas (29.5 M ticks):

| Path                            | wallMsDelta | ticks/s |
|---------------------------------|------------:|--------:|
| CLI (bench-doom-stages-cli)     |     73 000  | 405 K   |
| CLI (direct + restore snapshot) |     74 200  | 398 K   |
| Web (bench-doom-stages)         |     88 200  | 334 K   |

Web is ~1.21× slower than CLI on this window. (Previous LOGBOOK figures
of 134 000 / 127 000 ms were stale — different cabinet build.) Web
compile is ~43 s (with LTO + codegen-units=1) vs ~3.8 s native; that's
wasm runtime cost, not bridge waste — the bridge does one
`new_from_bytes(bytes)` call with no extra copies.

What this means for perf work: **the level-load cost is the engine
itself**, not the bridge. Optimisations that reduce per-tick CSS
evaluation cost or eliminate slow REP fast-forward bails help both
targets. Bridge-only optimisations won't move the level-load number.

The mission doc is
[`docs/agent-briefs/doom-perf-mission.md`](../agent-briefs/doom-perf-mission.md).
Read it before starting perf work.

### What the level-load is actually doing (2026-04-28)

Two new measurements against the 29.5 M-tick window (snapshot-restore
from `stage_loading.snap`, halt on `_g_gamestate=GS_LEVEL`):

**CS:IP heatmap** (`tests/harness/analyse-cs-ip-samples.mjs` on a
sample CSV from `calcite-cli --sample-cs-ip`):

- Segment 0x55: **67.8 %** of CPU. Bursts: 110 distinct IPs / 500 ticks
  → medium-body function (not a tight loop) called millions of times.
  Matches the brief's gcc-ia16 paragraph→linear helper hypothesis.
- Segment 0x2D96 (BIOS dispatch): **15.0 %**, all in one 256-byte page.
  Bursts: 46 distinct IPs → small dispatcher loop.
- Segment 0x1122: **8.3 %** (not in any prior analysis). Same 46-IP
  small-loop shape as 0x2D96.

Three segments = 91 % of level-load CPU.

**Op distribution** (`calcite-bench --profile --batch=0` after restore):

- LoadSlot 27 % + BranchIfNotEqLit 25 % + LoadState 9 % + LoadLit 8 %
  → **>60 % of ops are un-fused load-then-compare-then-branch chains.**
- Dispatch 2.7 % + DispatchChain 3.9 % (each averaging 177 sub-ops)
  → recognisers fire on bulk work, but the long tail above is real.
- LoadStateAndBranchIfNotEqLit 0.7 % → fused op exists, almost never
  hit. **Adding more fused ops for common load+compare+branch
  patterns is a real lead.**
- BroadcastWrite 0 % → packed-broadcast recogniser is doing its job.

**Caveat on the profile output**: `--batch=0 --profile` reports
snapshot+change-detect at ~91 % of time. That cost only fires in
single-tick mode and is an instrumentation artifact — in `run_batch`
execution neither phase runs. The op-count *distribution* is real;
the time *split* in that run is not representative of production.

## How to test (Doom8088 perf)

Use either bench. Web is preferred when you want to *see* what's
happening; CLI is preferred for headless or batch measurement. They
report the same shape of JSON.

```sh
# Web bench (Playwright, headed if you want to watch).
node tests/harness/bench-doom-stages.mjs --headed --json=tmp/web.json

# CLI bench (calcite-cli + memory-peek polling, no browser).
node tests/harness/bench-doom-stages-cli.mjs --json=tmp/cli.json
```

Both run the same six stages with the same sentinels and emit
`headline.runMsToInGame` / `ticksToInGame` / `cyclesToInGame`. Quote
the JSON before/after any claimed perf change. Don't trust "felt
faster".

If only one of the two regresses on a change, that's a real regression
in *that target* — investigate the difference rather than dismissing it.

**Don't diagnose by running the player interactively.** That's the
2026-04-27 trap; spend the time on the bench instead.

## Boot sequence (dos-corduroy)

For generic carts:

1. Mode 13h splash
2. Text-mode kernel + ANSI banner
3. Game starts

For Doom8088 the bench observes six stages — sentinel definitions live
in the perf brief:

1. `stage_text_drdos` — kernel banner in 80×25 VRAM
2. `stage_text_doom` — DOOM init log in VRAM
3. `stage_title` — mode 13h, title splash
4. `stage_menu` — `_g_menuactive=1`
5. `stage_loading` — `_g_usergame=1`, gamestate still GS_DEMOSCREEN
6. `stage_ingame` — gamestate flips to GS_LEVEL

"Ticks are running" is not a pass — peek the doom globals or use the
bench.

## Test infrastructure

`tests/harness/` is the unified entry point.

- `run.mjs smoke|conformance|visual|full` — preset-level runner.
- `pipeline.mjs <subcommand>` — single-command entrypoint for `build`,
  `inspect`, `run`, `shoot`, `fast-shoot`, `full`, `fulldiff`, `triage`,
  `cabinet-diff`, `baseline-record`, `baseline-verify`, `consistency`.
- `bench-doom-stages.mjs` / `bench-doom-stages-cli.mjs` — Doom-specific
  stage bench (web / native). Web bench is **headed by default**; pass
  `--headless` to opt out.
- `bench-web.mjs` — generic web throughput bench (Zork-shaped boots).
- `analyse-cs-ip-samples.mjs` — read CSV from `calcite-cli --sample-cs-ip`
  and emit a CS:IP heatmap + per-burst loop-shape report.

`calcite-cli --sample-cs-ip=STRIDE,BURST,EVERY,PATH` records CS:IP at
mixed wide-and-bursty intervals during a run. Pairs with `--restore`
to sample a specific window. `calcite-bench --restore=PATH` also
exists now for op-distribution profiling against a restored window.

Each command emits structured JSON to stdout, human progress to stderr,
and has wall-clock + tick + stall-rate budgets. Don't fire-and-forget.

The builder emits `<cabinet>.bios.bin / .kernel.bin / .disk.bin /
.meta.json` sidecars next to every `.css`. The reference emulator
(`tests/harness/lib/ref-machine.mjs`) uses these to stand up the same
1 MB image calcite sees, so divergence hunts compare like with like.
The cabinet itself carries a `/*!HARNESS v1 {json}!*/` header with
build meta.

The legacy tools at `../calcite/tools/fulldiff.mjs`, `tools/compare-dos.mjs`,
`ref-dos.mjs`, etc. import the deleted `transpiler/` directory and don't
run. Their headers say so. Use the harness instead.

## Snapshots — fast iteration substrate

Calcite has `State::snapshot` / `State::restore`, exposed as
`--snapshot-out` / `--restore` on calcite-cli and `engine.snapshot()` /
`engine.restore(bytes)` in calcite-wasm. Same-cabinet only.

`bench-doom-stages.mjs --capture-snapshots=DIR` saves a `.snap` at
every stage transition (~1.5 MB each). Restore from `stage_loading.snap`
to skip the boot+menu and only measure the level-load window — saves
~25 s per iteration.

Snapshots are invalidated by any cabinet rebuild OR any calcite change
that touches parse/slot allocation. If you see a phash mismatch right
after restore, throw the snapshot away and recapture.

## Sentinel addresses (Doom8088)

| Symbol            | Linear  | Notes                                          |
|-------------------|---------|------------------------------------------------|
| `_g_gamestate`    | 0x3a3c4 | enum: 0=LEVEL 1=INTERMISSION 2=FINALE 3=DEMOSCREEN |
| `_g_menuactive`   | 0x3ac62 | bool                                           |
| `_g_gameaction`   | 0x3ac5e | TRANSIENT (cleared within one game tic)        |
| `_g_usergame`     | 0x3a5af | latches when G_InitNew runs                    |

Re-derivation procedure (when the cabinet rebuilds with a different
binary layout) is in the perf brief.

`_g_gameaction` is the wrong signal for stage gating — the value is
cleared on the next G_Ticker call, so a 250 ms poll usually misses it.
The bench logs `firstGaSeenAt` if it gets lucky but never gates on it.
`_g_usergame` is the durable equivalent.

## Model gotchas

- Don't run interactively to "check if it's loaded yet" — build a
  measurement tool. The 2026-04-27 lesson is captured in
  `feedback_doom_dont_run_blindly` (auto-memory).
- Don't trust the visible halt opcode — the CPU was redirected
  somewhere upstream, trace backwards.
- Always test the suspected primitive in isolation before binary-
  patching downstream code (the 2026-04-26 ROR lesson).
- When a renderer uses a "borrow path" (clone extended, build scratch
  state) instead of the unified-read path, any write port whose CSS
  sink doesn't go through `write_mem` will be invisible. Pattern from
  the 2026-04-26 DAC-palette bug.
- Don't accumulate "defensive" fixes whose root scenario you can't
  reproduce after the actual bug is gone.
- Don't reach for the old `tools/fulldiff.mjs` / `compare-dos.mjs` /
  `ref-dos.mjs` — they reference a deleted transpiler. Use
  `pipeline.mjs fulldiff` instead.

## Open work

- **EMS/XMS for Doom8088 — partial scaffold, not active.** Corduroy
  hooks INT 2Fh / INT 67h and reserves the "EMMXXXX0" magic at
  BIOS_SEG bytes 0x0A..0x11. DOOM8088 still doesn't see it because
  it detects EMS by `open("EMMXXXX0", O_RDWR)` — a synthesised DOS
  character device. Doom currently runs with `-noxms -noems -nosound`
  baked into `program.json`, which sidesteps this entirely. Files:
  `bios/corduroy/{entry,handlers,bios_init}.{asm,c}`.
- **REPNE/REPE SCASB+CMPSB fast-forward** is missing. DOOM-side libc
  string scans bail to per-byte CSS evaluation. Each variant is a
  separate case in `crates/calcite-core/src/compile.rs::rep_fast_forward`.
- **Memory packing pack=2 vs pack=1.** Native probe converges on
  ≥500 K ticks; pack=2 is slightly faster than pack=1. Browser
  verification still pending.

## Web vs native — they should agree

CSS-DOS's contract is that calcite-cli, calcite-wasm in the browser,
and a spec-compliant CSS evaluator (Chrome) all produce the same result
from the same cabinet, at different speeds. If a change makes one
target work and the other regress, **that's a bug** — not an acceptable
trade-off. The two benches exist precisely so you can spot this
quickly.
