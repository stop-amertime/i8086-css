# CSS-DOS Logbook

Last updated: 2026-05-01

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

3 exec arms (production, profiled, traced) of `Op::LoadPackedByte`
replaced `cell.rem_euclid(256) / cell.div_euclid(256).rem_euclid(256)`
with the documented form `(cell >> (off * 8)) & 0xFF`. Equivalent for
all i32 cells (verified against negative two's-complement); skips a
branch in libcore's signed-euclid path. Doc on Op::LoadPackedByte
already specified this form; the executor was the outlier.

Web bench (vs FxHashMap baseline, same cabinet, headed):

|                          | fxhash only | + bitwise | Δ      |
|--------------------------|------------:|----------:|-------:|
| loading→ingame           |  66,524 ms  | 62,740 ms |  −5.7% |
| runMsToInGame            |  78,506 ms  | 74,307 ms |  −5.4% |
| gameplay ticks/sec       |     426,299 |   430,106 |  +0.9% |
| gameplay simulatedFps    |        43.5 |      43.8 |  +0.7% |
| gameplay vramFps         |        2.39 |      2.38 |   noise|
| gameplay cycles/sec      |   5,930,982 | 5,968,883 |  +0.6% |

Asymmetric — LoadPackedByte fires hard during level-load (window-byte
reads from disk into RAM), but is only ~3% of dispatched ops in
steady-state gameplay (per 2026-04-29 op-profile). So we shave the
load curve and barely move gameplay. Real but small.

Cardinal rule check: just bitwise byte extraction following the op's
existing documented semantics. Generic across any pack value.

## 2026-04-30 — FxHashMap swap: +25% ingame fps, −24% web level-load

Followup to today's flamegraph. Replaced `std::HashMap` (SipHash) with
`rustc_hash::FxHashMap` in the runtime hot-path tables only:

- `state.extended` — `HashMap<i32, i32>` for the >0xF0000 fallback in
  `read_mem` (9% in flamegraph).
- `DispatchChainTable.entries` — `HashMap<i32, u32>` for `Op::DispatchChain`.
- `CompiledDispatchTable.entries` — `HashMap<i64, (Vec<Op>, Slot)>` for
  `Op::Dispatch` (the 4% `hash_one` frame's call site).
- `CompiledBroadcastWrite.address_map` — `HashMap<i64, i32>` for
  per-tick broadcast write fan-out.
- `CompiledSpillover.entries` — `HashMap<i64, (Vec<Op>, Slot)>`.

Compile-time string-keyed maps in `CompilerCtx` and `dispatch_tables`
left as std::HashMap — touched once at load, swap would ripple across
crates for no benefit.

**Same cabinet, same cycles, same ticks; pure per-tick eval speedup.**

| Bench                              | baseline   | fxhash     | Δ        |
|------------------------------------|-----------:|-----------:|---------:|
| CLI loading→ingame (29.5M ticks)   |  72,000 ms |  61,562 ms |  −14.5%  |
| Web loading→ingame (29.8M ticks)   |  88,200 ms |  66,524 ms |  −24.5%  |
| Web runMsToInGame                  | ~125,000 ms|  78,506 ms |  −37%    |
| Gameplay ticks/sec (60s LEFT)      |    333,000 |    426,299 |   +28%   |
| Gameplay simulatedFps              |       34.7 |       43.5 |   +25%   |
| Gameplay vramFps                   |        1.6 |        2.4 |   +50%   |
| Gameplay cycles/sec                |  4,970,000 |  5,930,982 |   +19%   |

ticksToInGame: 35,000,000 → 34,650,589 (−1%, stage-detect race; not
real). cyclesToInGame: 397M (CLI) — identical, confirms zero work
elision.

**Why this works.** The flamegraph showed SipHash + hash_one + extended
HashMap calls totalling 17% of worker CPU. SipHash is constant-time
hardened and runs ~30 cycles per i32 key; FxHash is ~3 cycles
(multiply + xor). On runtime maps that get hit per-tick (`Op::Dispatch`
inner loop, `read_mem` BIOS-region fallback, broadcast-write
address_map fan-out), the difference is the dominant cost in those
samples.

Why bigger win on web than CLI: native Chrome's V8 wasm interpreter
makes hash function calls relatively more expensive vs the loop body
than native code's loop-unrolled hot path. Same delta in absolute
seconds, larger as a percentage of the slower web baseline.

Smoke gate: 4 PASS / 3 pre-existing FAIL — same set as before
(dos-smoke, zork1, montezuma fail with `ticks=0` due to harness
build-budget issue documented 2026-04-29, unrelated to this change).
calcite-core unit tests: 148 PASS / 4 pre-existing FAIL (rep_fast_forward
no-opcode panics).

Calcite commit: includes `rustc-hash = "2"` dep + 6 type swaps in
`compile.rs` + 1 in `state.rs`. ~12-line diff, 0 algorithmic change.

The cliff is breakable. Top of next flamegraph will be a different
shape — re-profile if/when chasing the next 10%.

## 2026-04-30 — Web flamegraph: exec_ops dominates, hashing is 17%

New tool: `tests/harness/flamegraph-doom.mjs` drives Playwright + raw CDP
to capture V8 cpuprofile (worker + main thread) and chrome trace JSON for
two phases: LOAD (snapshot-restore from `stage_loading`, run to GS_LEVEL)
and INGAME (snapshot-restore from `stage_ingame`, hold LEFT 60s).
`resolve-cpuprofile.mjs` parses the wasm `name` section and rewrites the
profile in place so DevTools shows real Rust names.

To get names, calcite must be built without wasm-opt's name-section
strip: `wasm-pack build crates/calcite-wasm --target web --profiling
--no-opt`. Profiling build is ~5% slower but the % breakdown matches
release.

**Worker self-time (LOAD 173s / INGAME 60s, near-identical shapes):**

```
                                             LOAD   INGAME
calcite_core::compile::exec_ops             76.07%  75.40%
calcite_core::state::State::read_mem         9.10%   9.35%
core::hash::sip::Hasher::write               4.07%   4.11%
core::hash::BuildHasher::hash_one            3.85%   3.88%
calcite_core::compile::execute               2.94%   3.11%
(idle)                                       1.62%   1.69%
calcite_core::compile::rep_fast_forward      0.49%   0.57%
... everything else < 0.5% individually
```

**Main thread:** 99% idle. Bridge is not the problem; render is not the
problem; it's all wasm.

**Headlines:**
- LOAD: 173s wall, 33M ticks, 200K t/s steady state
- INGAME: 60s wall, 10M ticks, 171K t/s
  (matches LOGBOOK 2026-04-29 gameplay bench at 333K ÷ ~2 for the slower
  profiling build — % shape unchanged.)

**Reading.** `exec_ops` is the per-op dispatch loop. It's 76% — that's
the headline. But the other 17% (`read_mem` + SipHash + hash_one) is
almost entirely **HashMap lookup overhead**: `read_mem` hits a
`HashMap<linear_addr, byte>` for sparse/MMIO writes, and `hash_one` is
called from `Dispatch` Op evaluation (the per-register dispatch table is
a HashMap). SipHash is the default `std::collections::HashMap` hasher.

That's the answer the user asked for. Two real leads, both generic
(no upstream-layer knowledge needed):

1. **Replace HashMap with FxHash or AHash** in the hot lookups.
   SipHash is ~5x slower than FxHash and 17% of total CPU is
   hash-related. Even a 3x speedup here = ~10% wall.
2. **`read_mem`'s HashMap is sparse-overlay over the dense ROM/RAM**.
   At 9% of CPU there's likely a path that takes the slow `HashMap.get`
   even when the address is in the dense regions. Worth a flame-graph
   zoom on what's calling it.

The 76% in `exec_ops` is the main interpreter. To break that down further
would need finer sub-function profiling (LLVM-level), or a
function-pointer-table dispatch backend (calcite Phase 3 closure backend
prototype, 2026-04-28 logbook entry, was 1.19× slower with only 10/50
ops specialised — the work isn't proven dead, just paused).

Artifacts:
- `tmp/flamegraph/load/{worker,main}.cpuprofile` — load in DevTools
  → Performance for the actual flame chart.
- `tmp/flamegraph/load/trace.json` — perfetto/about:tracing.
- Same under `tmp/flamegraph/ingame/`.
- `tmp/flamegraph/{load,ingame}/summary.json` — top-N tables.

Stop chasing peepholes. Real next swing: kill the SipHash overhead.

## 2026-04-30 — read_mem borrow-overhead fix: dead lead, reverted

Gated `read_mem`'s three `RefCell::try_borrow_mut` probes behind a
`Cell<bool>`. Theoretical save ≤0.25%; web doom8088 level-load 133–134s
both runs, no signal. Reverted.

## 2026-04-30 — BIfNEL2 fusion: dead lead, off by default

`Op::BranchIfNotEqLit2` collapses adjacent diff-slot AND-guard BIfNEL
pairs (1330/1395 in doom8088). Fired 794×, dropped runtime BIfNEL→BIfNEL
adjacency 12.35% → 9.41%. Web bench in noise floor (ON avg 2.5% slower
across 2 runs, sign flips). Saved dispatch absorbed by `pc += 2;
continue;`. Disabled behind `CALCITE_BIF2_FUSE=1`. Calcite `ac0e7bb`.

Stop chasing 1-3% peepholes. 405K → 200K throughput is a 2× cliff;
flame-graph the hot path before next attempt.

## 2026-04-29 — runtime op-adjacency profile (post-fusion truth)

Built `--op-profile=PATH` in calcite-cli (calcite `pattern/op_profile.rs`).
Records (prev_kind, curr_kind) counts for every op dispatched, including
inside dispatch entries / function bodies / broadcast-write value_ops.
Thread-local matrix, ~10ns/op when enabled, ~1ns when disabled. Doom8088
restored from `stage_loading.snap`, 200K-tick window, 169M ops dispatched.

**Top kinds (% of dispatched, runtime not static):**
```
LoadSlot              27.34%
BranchIfNotEqLit      20.08%
LoadState             11.05%
LoadLit                8.38%
DispatchChain          4.24%   ← chains *are* hot, despite collapsing 208 of them
Add                    4.03%
LoadPackedByte         3.26%
MulLit                 2.97%
Dispatch               2.81%
AddLit                 2.69%
```

LoadSlot+BIfNEL+LoadState+LoadLit = **66%** of all dispatched ops. The
earlier static-bytecode 27%/25% numbers were directionally right.

**Top adjacencies:**
```
BIfNEL  -> BIfNEL                12.35%   ← biggest spike
LoadSlot -> LoadSlot              9.63%
LoadSlot -> BIfNEL                5.23%
LoadState -> LoadSlot             3.31%
LoadSlot -> LoadPackedByte        3.26%   ← packed-byte load setup
LoadPackedByte -> LoadSlot        3.26%
LoadSlot -> DispatchChain         3.26%
LoadLit  -> LoadSlot              3.22%
LoadState -> LoadState            2.72%   ← back-to-back state reads
LoadSlot -> Jump                  2.14%
```

**Verdict.** `BIfNEL → BIfNEL` at 12% is the only striking spike. This
shape is what `dispatch_chains` is built to collapse, yet it survives —
either chains below threshold (< 3), testing different slots, or
adjacent across control-flow rather than in the static op array. Worth
investigating: **why does the dispatch_chains pass leave so many bare
BIfNEL→BIfNEL pairs adjacent at runtime?** That's the real next lead.

`LoadSlot → BIfNEL` at 5% looked like the previous fuser's target, but
that fuser fired 0× because it required same-slot
(`LoadSlot(dst) → BIfNEL(a=dst)`); the 5% here is overwhelmingly
different-slot — dst is being loaded for a *later* instruction, not the
adjacent branch. Confirmed dead lead.

`LoadState → LoadState` at 2.7% (back-to-back state reads) is a
candidate fuse-target — but only 2.7%, and CSS-shape detection needs
to be careful (the two reads may target unrelated addresses).

## 2026-04-29 — REP FFD: leave alone

`CALCITE_REP_DIAG=1` boot-to-ingame: 213K fires / 1.64M iters elided, no
missing-variant bails (no REPNE, no segment-override). The "REPNE/REPE
SCASB+CMPSB missing" open item is stale — removed.

## 2026-04-29 — calcite: DiskWindow → WindowedByteArray rename

Cardinal-rule fix (calcite `cff0902`). Recogniser was named after upstream
concept (rom-disk) instead of CSS shape (windowed byte array indexed by
key cell + stride). Pure rename, no behavior change.

## 2026-04-29 — load+compare+branch widening: dead lead, reverted

Built `fuse_loadslot_branch` mirroring the state-source fuser. **Fired 0
times** on doom8088. `LoadSlot(dst, src) → BranchIfNotEqLit(a=dst)` doesn't
exist as adjacent ops post-`fuse_cmp_branch` (77K fires) and
`dispatch_chains` (208 chains collapsed). Op-profile's "27% LoadSlot + 25%
BranchIfNotEqLit" is misleading — those exist program-wide but aren't
adjacent (i, i+1) by the time peepholes run. Reverted. Real widening lead
is residual unfused chains *upstream* of those passes, not more downstream
peepholes.

## 2026-04-29 — fusion FFD: funnel data + verdict (dead end on this window)

thread_local `FusionDiag` (no atomics on hot path). Boot-to-ingame
doom8088 native, 35M ticks:

```
              fusion off    fusion on
total wall    136.74 s      140.85 s    (+3.0% slower)
ticks/sec     255,968       248,495
cycles        397,458,534   397,603,025 (+144,491)
```

Funnel (fusion ON):
```
pass_b0  (0x88 at IP)       48,715   0.139 %
pass_b1  (0xF0 at IP+1)      5,298   0.0151%   ← 89% filtered
pass_flags                   5,153   0.0147%
pass_rom (full 21-byte)        159   0.0005%   ← fires
body_iters_applied           1,708             ← avg 10.7/fire
```

Verdict: detector fires 159× / 35M ticks. Max theoretical save = 1708 /
35M = **0.0049%**. Earlier "1.4% wall" was noise; this run shows opposite
sign. Cycle delta ~144K matches 1708 fires × ~50 cycles + noise → work
*is* elided correctly, just not enough for wall-time.

Why detection cost matters at low fire rate: fast-out runs every tick.
~35M `read_mem` (byte 0) + 50K (byte 1) per run; `read_mem` does
`RefCell::try_borrow_mut` on `read_log` (~5-10ns each) = ~350ms overhead /
137s = the observed 3% slowdown.

This bench is boot+level-load, not gameplay. Earlier
bench-doom-gameplay also showed -3%, but with hash-gated paint and only
1.6 visible-fps the column drawer's CPU share may be smaller than static
analysis (21×16 reps × 30 occurrences) implied.

**Direction.** Stop polishing polling shape. Move detection compile-time:
byte_period finds 30 ROM occurrences of the 21-byte body — mark linear
addresses at compile time, insert a single guarded op keyed on
`--ip == known_site`, collapsing detection to one slot-compare/tick. If
that doesn't pay either, fusion belongs in another cabinet's perf budget.

## 2026-04-29 — fusion FFD: framing + diag redesign

Two upstream issues blocking the investigation:

**1. Runtime feature gates are env-vars + cfg stubs, not real config.**
`CALCITE_FUSION_FASTFWD`, `CALCITE_REP_FASTFWD`, `CALCITE_FUSION_DIAG`
read via `std::env::var`, latched in `OnceLock<bool>`, with
`#[cfg(target_arch = "wasm32")]` stubs hardcoding per-target default.
Web isn't toggleable from JS; latch prevents per-cabinet/per-test
control. Right shape: `RunOptions` struct on `CompiledProgram` (or
threaded into `execute`), populated by both calcite-cli and calcite-wasm
callers. Not refactored — flagged. (Web fusion was tested by hardcoding
the wasm stub to true; net-loss finding holds across both targets.)

**2. Diag counters distorted measurements.** First-cut used
`AtomicUsize::fetch_add` per tick at each funnel stage — at 10M ticks/s
that's 50-100ms/s pure `lock xadd` overhead, showing up *as* the fusion
overhead it was measuring. Replaced with `&mut FusionDiag` threaded
through `execute → column_drawer_fast_forward`. Same problem in
`rep_fast_forward`'s diag (atomics) — fix later.

**Three places fusion detection could live:**
- (a) End-of-tick polling (current). O(ticks). 10ms/s detection floor
  even with perfect 1-byte fast-out. Pays on every cabinet.
- (b) Hot-IP gating. O(ticks-while-CS-in-hot-segment). Generic version
  is "compile-time detect which CS values execute most ROM bytes, gate
  fusion on those," not "0x55 is hot."
- (c) Compile-time ROM scan + op-stream rewrite — the real fix.
  `byte_period` already finds matches (4065 regions on doom8088). Either
  rewrite the dispatch entry for that IP to invoke `Op::FusedColumnDrawer`,
  or insert `Op::FusedSiteHook` guarded by
  `LoadStateAndBranchIfEqLit(IP, KNOWN_FUSION_IP)`. Cardinal-rule clean:
  the generic primitive is "fuse any periodic ROM region of N bytes × K
  reps."

(c) is the JIT-correct pattern: detection cost paid once at load,
runtime = one slot-read + immediate-compare/tick.

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

Initial fusion fast-forward hook (`column_drawer_fast_forward`,
end-of-tick parallel to `rep_fast_forward`) showed +1.4% wall on
level-load. `bench-doom-gameplay.mjs` flipped sign:

| Window               | fusion off  | fusion on (with byte-0/1 fast-out) |
|----------------------|------------:|-----------------------------------:|
| ticks/sec            | 333K        | 319K (-3%)                         |
| simulatedFps         | 34.7        | 35.4 (+2%)                         |
| vramFps              | 1.6         | ~1.7 (noise)                       |
| cycles/sec           | 4.97M       | 4.83M                              |

(Without fast-out, -34% throughput from per-tick 21-byte ROM scan.)

Fusion *does* fire (cycle delta confirms), but per-tick detection cost
across 10M non-firing ticks/s exceeds savings. 20M `state.read_mem`/s
just to detect.

**Disabled by default** (`CALCITE_FUSION_FASTFWD=1` to enable). To
re-enable needs: profile gameplay fire rate; gate on coarser hot-IP
signal (e.g. CS=0x55); move detection from end-of-tick to hot-IP
callback; tune cycle-charge (currently 50/iter).

Simulator + lowerer (88.6% body compose, 94% op shrink) are correct;
runtime hook needs smarter trigger.

## 2026-04-29 — fusion-sim: 88.6% body compose on doom column-drawer

Pushed body-composition probe from 52% → 88.6% FULL via real
dispatch-table support and per-byte decoder pinning.

**Probe** (`crates/calcite-cli/src/bin/probe_fusion_compose.rs`):
- Per-body-byte decoder pin table — for each opcode-byte, asserts
  `--prefixLen`, `--opcode`, `--mod`, `--reg`, `--rm`, `--q0`/`--q1` at
  fire time.
- Body-invariant slot pins each fire: `--hasREP=0`, `--_repActive=0`,
  `--_repContinue=0`, `--_repZF=0`, all segment-override flags = 0.
- Skip non-fire bytes (modrm + immediates) — phantom dispatches were
  bailing.
- Bail-reason histogram (`CALCITE_DUMP_BAIL_OPS`).

**fusion_sim** (`crates/calcite-core/src/pattern/fusion_sim.rs`):
- `Op::DispatchChain` Const-keyed: walk `chain_tables[chain_id]` with
  Const value, jump body PC or `miss_target`. Eliminated 8 dispatch*
  bails (bytes 2 0xd0, 15 0x81).
- `Op::Dispatch` Const-keyed: recursively simulate HashMap entry's ops,
  write `result_slot` into `dst`. Threads `dispatch_tables` through
  `simulate_ops_full_ext`.
- `Op::DispatchFlatArray` non-Const → new `SymExpr::FlatArrayLookup`.

**Probe results** (44 fire tables, 21-byte body):
```
                  FULL   partial   bail
baseline           23     16        5      52.3%
+ pin per-byte     27     17        0      61.4%
+ skip non-fire    30     14        0      68.2%
+ DispatchChain    36      8        0      81.8%
+ Dispatch         38      6        0      86.4%
+ flag invariants  39      5        0      88.6%
+ FlatArrayLookup  39      5        0      88.6% (no change)
```

Last 5 partials are deep flag-side: first FlatArrayLookup result flows
into `BranchIfNotEqLit` needing Const but getting symbolic — needs
symbolic branch outcomes (partial compilation through if-trees), out of
scope.

Sample composed expressions (post-body state vs entry-state slots):
```
table 40: LowerBytes(BitOr16(Slot(--rmVal16), Add(Slot(--immByte), Mul(BitExtract(Slot(--immByte), Const(7)), Const(...))))
table 42: LowerBytes(Add(Floor(Div(Slot(--rmVal16), Const(2))), Mul(BitExtract(Slot(--rmVal16), Const(0)), Const(...))))
table 50: Shr(LowerBytes(Add(Floor(Div(Slot(--rmVal16), Max([Const(1), Slot(--_pow2CL)]))), ...
```

Tests: 13 fusion_sim pass. wasm32 clean.

**SymExpr → Op lowering** (same session). `SymExpr::lower_to_ops` emits
flat `Vec<Op>`. Lit-folded fast paths (`AddLit`/`SubLit`/`MulLit`/
`ShlLit`/`ShrLit`/`AndLit`/`ModLit`) when one operand is Const. 3
round-trip tests confirm `simulate(ops) → expr → lower(expr) →
simulate` matches (16/16 fusion_sim green).

End-to-end shrink (39 FULL tables → fused op sequences):
```
total original ops: 2174
total fused ops:    131
shrink:             94.0%
```

Per-table range: 99.8% (420 → 1 op, flag tables collapse to Const) down
to -50% on some pixel-write expressions (no CSE in naive lowering).

**Memory-write capture extended**: `simulate_with_effects_ext` threads
chain_tables + dispatch_tables. StoreMem/StoreState inside
DispatchChain/Dispatch entries captured to `SimResult.writes`.

**Not done**: runtime CS:IP fusion-site detector, `Op::FusedBody`
variant, runner integration, correctness verification. Real compiler
work, est. 3-5 sessions.

**Smoke gate observation** (pre-existing, not regression): zork1,
montezuma, dos-smoke fail `tests/harness/run.mjs smoke` with runTicks=0
because compile through `calcite-debugger` takes ~8s vs 15s wall budget.
Independent of this session. 4 fast-compiling cabinets (hello-text,
cga4-stripes, cga5-mono, cga6-hires) pass. Fix: raise budget to 30s, or
runner uses calcite-cli (~3.8s compile).

**Runtime fast-forward landed**: end-of-tick hook in `compile.rs`
detects column-drawer body in ROM at current CS:IP, bulk-applies net
effect derived from x86 opcode definitions (two memory reads
palette+colormap, AX broadcast, two stosw, DI advance + 0xEC, DX advance
+ BP). Up to 16 stacked iterations per fire. Gated by
`CALCITE_FUSION_FASTFWD` (later disabled by default — see above).

Level-load measurement (29.5M ticks):
```
fusion OFF: 135.837s / 323,102,046 cycles
fusion ON:  133.948s / 323,246,537 cycles
Δ: 1.4% wall faster, +144,491 cycles (0.04%)
ticksToInGame identical.
```

(Later invalidated by funnel data — see top entry.)

Open follow-ups: gameplay-frame bench; auto fusion-site catalogue from
byte_period; cycle-charge tuning; regression bisection.

## 2026-04-29 — calcite-v2-rewrite Phase 1 lands

Parallel stream, branch `calcite-v2-rewrite`. Clean rewrite from
`ParsedProgram` (parser output) instead of `Vec<Op>` (v1 bytecode), so
DAG + rewriters aren't downstream of v1 pattern decisions.

**Phase 1**: v2 DAG walker matches Chrome on primitive conformance.
Backend enum (`Bytecode | DagV2`) on `Evaluator`; default Bytecode,
opt-in via `set_backend(Backend::DagV2)`.

**Phase 0.5 conformance**: v2 41 PASS / 5 SKIP / 3 XFAIL — identical to
v1. Same 3 documented gaps (div-by-zero serialisation, ignored-selector,
var-undefined-no-fallback invalidity).

**Walker**: terminals topo-sorted at DAG-build by `LoadVar Current`
deps. Per-tick value cache (state-var slots `Vec<Option<i32>>`, memory
sparse `HashMap`). `LoadVar Current` reads cache then committed state;
`LoadVar Prev` reads committed directly. Buffer-copy assignments
(`--__0/__1/__2`) skipped — prefix-stripped slot model already exposes
prior tick as `LoadVar Prev`.

**Phase 1 stubs**: `FuncCall` delegates to v1's `eval_function_call` by
rebuilding `Expr::Literal` args. `IndirectStore` (broadcast write) stub;
conformance suite doesn't exercise broadcasts.

**Two v1 fixes ported in** (real CSS-spec compliance):
- `compile.rs`: gate `rep_fast_forward` on new
  `CompiledProgram::has_rep_machinery` flag (true iff program declares
  `--opcode`). Fixes pre-existing main-branch panic on every cabinet
  without `--opcode`.
- `CalcOp::Mod` fixed in 4 places (compile const-fold, exec_ops Op::Mod,
  Op::ModLit, eval.rs interpreter) → CSS-spec floor-mod
  (`mod(-7, 3) == 2`), not Rust `%`. Caught by `calc_mod_negative`.

`cargo test -p calcite-core`: 196 pass (5 pre-existing rep-fast-forward
fails unrelated). `wasm-pack`: clean.

Next gate: Phase 2 ≥30% DAG node-count reduction on Doom — needs Doom
in worktree + broadcast/dispatch recognisers consuming
`prebuilt_broadcast_writes`. Phase 1 wraps; not merging — owner
reconciles streams.

## 2026-04-28 — calcite Phase 3 prototype: closure backend

Option (c) per mission doc. Each block lowers to `Vec<Box<dyn Fn>>` +
pre-resolved `TerminatorPlan`. No match-on-Op on hot path. Specialised
closures for ~10 common ops; rest fall through to exec_ops on one-op
slice.

162 tests green: backend_equivalence (bytecode/dag/closure 200 ticks
bit-identical), primitive_conformance under all three. wasm32 clean.
web/demo.css throughput: bytecode 261k t/s, dag 210k, closure 220k —
1.19× slower than bytecode, matches spec for prototype with only 10/~50
ops specialised. (c) ceiling 3-5× with full specialisation.

Bugs found writing closure backend:
- `Op::AndLit` val is mask bits, not bit-width. Phase 2's BitFieldMatch
  + LitMerge::And had wrong semantics; fixed.
- `ShrLit`/`ShlLit` are signed i32, not unsigned. Closure was masking
  u32; fixed.

Phase 3 main (option (a) hand-emitted wasm) deferred — weeks of work,
prototype validates the lowering shape codegen would build on. Revisit
once Doom cabinet is in worktree.

## 2026-04-28 — calcite Phase 2: recogniser substrate

14-shape idiom catalogue (derived from `kiln/emit-css.mjs`), `Pattern`
trait + driver in `dag/normalise.rs`, 9 generic recognisers in
`dag/patterns.rs` (LitMerge, BitField, Hold, RepeatedLoad). Annotations
parallel to ops → bit-identical by construction. 161 calcite-core tests
green; Phase 1 gates pass; wasm32 clean. Annotation density on
`web/demo.css` 0.1% — expected (v1 already collapses dominant shapes).
Real metric is Doom; revisit when in worktree.

## 2026-04-28 — Load-time fusion: byte_period + fusion_sim

Bottom two layers of load-time fusion pipeline.

**Layer 1: byte_period detector** (calcite, generic). Walks rom-disk,
finds periodic regions (period P, K reps). doom8088: 610ms over 1.83MB,
4065 regions. Headline: 21×16 at offset 86306 (column-drawer kernel),
21×14 sibling at 86661 (variant). 30 total occurrences of the 21-byte
body. Driver: `probe-byte-periods`.

**Layer 2: fusion_sim symbolic interpreter** (calcite, generic). Walks
compiled Op trees, threads slot reads as `SymExpr::Slot` free vars,
composes arith/bitwise symbolically. Distinguishes calcite's `And`/
`AndLit` (lowerBytes truncation) from `BitAnd16` (true bitwise). Bails
on branches, memory side-effects, unsupported variants. Driver:
`probe-fusion-sim`.

**Concrete win** in table 21 (232-entry per-register dispatch,
`result_slot=386862` = `--ip`): IP-advance composed for **12 of 15**
body bytes:
- `0x88` → `Add(Const(2), Slot(37))` — 2-byte instr base + offset
- `0x81` → `Add(Add(Const(2), Slot(37)), Const(2))` — 4-byte
- `0xea` → `Add(Slot(27), Mul(Slot(28), Const(256)))` — far jump

3 bail: `0xe8` (Div), `0xab` STOSW (Branch on `--df`), `0xcb` (nested
LoadMem). `0xab` needs branch eval under known-flag assumptions
(CLD before body → `--df=0`).

Files: `crates/calcite-core/src/pattern/byte_period.rs`,
`pattern/fusion_sim.rs`, `crates/calcite-cli/src/bin/probe_byte_periods.rs`,
`probe_fusion_sim.rs`. 19 unit tests pass (10 + 9). Smoke not re-run
(diagnostic-only, no execution-path changes).

### 2026-04-28 (followup) — Body-composition probe

`probe-fusion-compose`: simulates every dispatch table's entries across
the 21-byte body in sequence (slot env threaded), reports per-table
FULL/partial/BAIL.

Extended fusion_sim Ops: `Bit`, `Div`, `Round`, `Min`, `Max`, `Abs`,
`Sign`, `Clamp`, `CmpEq`, `DispatchFlatArray` (const-key). Added
`Assumptions` for resolving `LoadState`/`LoadStateAndBranchIfNotEqLit`
against compile-time-known flags (e.g. `--df=0` after CLD).

doom8088 column-drawer body (44 fire tables):
- Initial: 14/44 FULL (32%)
- +CFG/assumptions: 14/44 (no change)
- +Bit/Div/Round/Min/Max/Abs/Sign/Clamp/CmpEq: 23/44 (52%)
- +DispatchFlatArray (const-key): 23/44 (no change — keys symbolic)

Remaining bails: `Branch (non-const)` byte 4 (0x89 `mov r/m, r` with
non-const reg comparison) or `DispatchFlatArray (non-const key)` byte 18
(0x00 imm). To push past 52%: track register-shaped slots symbolically
(partial register lattice), or SymExpr nodes for symbolic array indexing.

**Decision** (later superseded by 88.6% session above): paused. Code
stays — correct, well-tested diagnostic infra.

## 2026-04-28 — Replicated-body recogniser: built, dead lead

Generic recogniser folding unrolled straight-line regions into
`Op::ReplicatedBody`. Period detector + per-Op-variant operand stride
classifier + eval arms in 3 runners (production/profiled/traced) +
pipeline wiring after `compact_slots`. 34 unit tests, smoke green (7
carts).

**doom8088: zero regions folded.** `CALCITE_DBG_REPL=1`: largest
straight-line region in 405K-op main array is **32 ops**; 11 regions
across 24,596 reach 16-op threshold; period-detector finds no period.

Why: asm-level "16× unrolled XLAT body" lives in `i_vv13ha.asm` etc. as
16 back-to-back 6-op pixel kernels, but **Kiln compiles each x86 instr
into its own CSS dispatch entry**. Repetition is at runtime (dispatch
loop fires opcodes 1..6 sixteen times), not in static op stream.
Detecting it would need a dispatch-trace cycle analyser — different
problem, and risks "calcite knows about emitter-shaped opcodes" cardinal
violation.

Lesson: *measure static shape calcite sees before designing recogniser
around asm shape*.

Code stays in main: correct, ~0ms compile cost when nothing matches,
may fire on future cabinets with flat unrolled bodies.

Files: `crates/calcite-core/src/pattern/replicated_body.rs` (~750 LoC
incl. tests), `compile.rs` (Op::ReplicatedBody variant, eval arms in 3
runners, `recognise_replicated_bodies` pass).

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
