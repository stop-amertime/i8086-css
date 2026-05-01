# Affine self-loop fast-forward — non-REP back-edges

**Status**: planning. Targets the doc-level idea (c) from
`../calcite/docs/optimisation-ideas.md`. REP-prefixed variant is already
landed (`rep_fast_forward`); this extends it to the non-REP back-edge
shape (`dec/inc + cmp + jne` and friends).

**Goal**: 2× steady-state throughput on doom8088 gameplay. Current web
gameplay ~430K calcite t/s; native ~540K t/s. Target web ~860K t/s.

## What "affine self-loop" means here

Not an x86 concept — a CSS-bytecode-shape concept, per the cardinal rule.

After Kiln + Calcite compile a cabinet, every CPU instruction that the
guest executes turns into one calcite tick. A "self-loop" in calcite
terms is: **the same dispatch-table entry fires for many consecutive
ticks, with the guard slot (typically a register) advancing by a
constant each tick, until the guard reaches a literal.**

Concretely:

- Dispatch entry E fires this tick. Its body computes a deterministic
  effect on N slots and one optional memory store.
- The post-body state is such that the *next* tick will re-dispatch E.
  (i.e. CS:IP, prefix flags, opcode all unchanged after the body, OR
  unchanged-modulo-the-back-edge-jump that arithmetic bumps IP back.)
- One slot in the body's read-set advances by an integer-literal delta
  (`slot += k`).
- A `BranchIfNotEqLit` (or `LoadStateAndBranchIfNotEqLit`, or
  DispatchChain miss) gates exit on that slot reaching a literal.

When all four hold, the entry is a **closed-form-evaluable loop**: we
can compute N (iterations until guard fires), apply the deltas N times
in one step, advance the cycle counter by N × cycles_per_iteration,
and break.

This is the standard induction-variable-simplify + loop-idiom-recognise
pass. LLVM's `IndVarSimplify`/`LoopIdiomRecognize`. We're just doing it
on calcite bytecode.

## Why this and not the other ideas

The doc lists six candidates with stated payoffs. I want to be honest
about why (c) and not the others.

| Idea | Doc-projected payoff | Status / why not now |
|---|---|---|
| (a) Native bitwise | 1.9× (DONE) | landed |
| (b) LoadLit sinking | 25% on old baseline (~5-8% now) | quick win, sub-2× |
| (c) Affine self-loop | **100× on splash fill** | **this plan** |
| (d) 2-key dispatch chain | 5-10% | sub-2× |
| (e) Value-keyed memoisation | 10-100× speculative | architectural; (c) first |
| (f) Change-gated ops | unsized | speculative; (c) first |

(c) is the only candidate with a multi-× projection that's both clearly
generic and unimplemented. (e) could match it but is architectural;
(c) is a contained pass.

The 100× number was for the splash fill (64,000-iteration mode-13h
clear). doom8088 gameplay isn't splash-fill-bound — its hot loops are
much shorter (per-pixel column drawer, span renderer). Realistic
payoff for doom: depends on average loop trip count in steady state.
Need to measure before committing to a 2× claim. The plan is to build
it incrementally and measure between each phase.

## What's already there to build on

- `rep_fast_forward` (calcite-core/src/compile.rs) — REP-prefixed
  STOSB/MOVSB/CMPSB/SCASB fast-forward. Same shape as this plan, but
  scoped to ops with the REP prefix latch set.
- `column_drawer_fast_forward` (logbook 2026-04-29) — overfit to one
  21-byte body in doom8088. **Net loss at runtime** because per-tick
  detection cost > savings. **Disabled by default.** That failure mode
  is the cautionary tale this plan must avoid.
- `pattern/byte_period.rs` — finds periodic ROM regions; supplies
  static fusion-site catalogue.
- `pattern/fusion_sim.rs` — symbolic interpreter for verifying body
  composition. 88.6% FULL on doom8088's column-drawer body.

## Lessons from `column_drawer_fast_forward`'s failure

The 2026-04-29 logbook entry on the runtime fusion FFD funnel is the
key data:

```
pass_b0  (0x88 at IP)       48,715   0.139 %
pass_b1  (0xF0 at IP+1)      5,298   0.0151%   ← 89% filtered
pass_flags                   5,153   0.0147%
pass_rom (full 21-byte)        159   0.0005%   ← fires
body_iters_applied           1,708   ← avg 10.7/fire
```

At 35M ticks/run, fusion fired 159 times and saved 1,708 iterations.
Theoretical max wall savings = 0.005%. The detection cost (RefCell
borrow on `read_log` for funnel counters; per-tick byte 0/1 checks)
exceeded the saving.

The fix the logbook proposed but didn't execute: **move detection
compile-time**. Don't poll every tick. Find candidate sites once at
compile, install a guarded op that only checks "am I at a known
fast-forward site" via a single slot compare. That's what this plan
does.

## The pass

### Phase 1 — static recogniser

At compile time, walk every dispatch-entry body (and main.ops), looking
for the affine self-loop shape:

**Recogniser invariants** (all must hold):

1. **Side-effect bound.** The body contains zero `Op::Dispatch`,
   `Op::Call`, `Op::DispatchFlatArray`, `Op::DispatchChain`,
   `Op::MemoryFill`, `Op::MemoryCopy`, `Op::Bit`, `Op::ReplicatedBody`,
   `Op::StoreState` (except final), and at most **one**
   `Op::StoreMem` / `Op::StoreState` per iteration.
2. **One induction variable.** Exactly one slot S is read at body start,
   modified by `slot S = slot S + k` (literal k), and not otherwise
   re-read. (Detected by symbolic-walking the body via fusion_sim's
   existing machinery; bail on any non-additive use of S.)
3. **Guard.** The body's terminal control flow is `BranchIfNotEqLit
   { a: S, val: target, target: exit }` — i.e. the loop exits when S
   reaches `target`. Or equivalently, a DispatchChain miss when
   `S + k * N` lands outside the chain's flat-array range.
4. **Self-dispatch.** If we re-evaluate the dispatch key after the body
   runs, it produces the same key. (Symbolically: dispatch_key remains
   constant under the body, modulo the induction variable's contribution.)
5. **Bounded affine memory.** The optional store's address is
   `slot_A + slot_B + … + literal` where slot_A is the induction
   variable (or constant); coefficients all compile-time constants.
   We need to know enough to bulk-write N bytes.

Output: a `FastForwardSite` per recognised entry, recording:

- entry index (which dispatch table + which key)
- induction slot, delta k, exit target literal
- per-tick "other slot" deltas (additive deltas on slots other than the
  induction variable)
- one optional memory write descriptor: `(addr_expr_template, byte_value_template, count_axis_slot)`
- cycles per iteration (already computed; needed for cycle accounting)

This is purely static; no runtime overhead until something actually
fires.

### Phase 2 — runtime hook

The hot loop already does dispatch lookup. After dispatch resolves to a
body PC, **before** running the body, check if the body's entry has a
`FastForwardSite`. If yes, bulk-apply.

Concretely, change `Op::Dispatch`'s eval arm to:

```rust
if let Some(site) = entry_fast_forward_site {
    apply_fast_forward(site, state, slots);
    sstore!(*dst, sload!(*result_slot));
} else {
    exec_ops(entry_ops, ...);
    sstore!(*dst, sload!(*result_slot));
}
```

`apply_fast_forward` computes N from the induction variable's current
value and the exit literal, applies all deltas × N, and (if there's a
memory write) does one bulk-fill. Cycle counter advances by N ×
cycles_per_iter.

The check is **one HashMap probe per dispatch**, on the *recognised*
dispatch path only. When no site exists, zero overhead. Critically:
the check is keyed on entry identity, not body shape, so detection is
O(1) per dispatch.

### Phase 3 — broaden recogniser

Once Phase 1+2 land and aren't a regression, broaden:

- Multiple induction variables (`SI++`, `DI++`, `CX--` in MOVSB-style).
- Two-store-per-iteration (MOVSB itself: read [SI], write [DI]).
- Conditional early-exit (`SCASB` — exits on equality found, not just
  CX==0). This requires bulk-evaluating the condition over the
  to-be-fast-forwarded range, which is harder.

These are stretch; phase 1+2 are the deliverable.

## Verification plan

Each phase has a hard correctness gate plus a hard perf gate.

**Correctness gate**: run conformance suite + `pipeline.mjs fulldiff
doom8088.css`. State trace must match the unfast-forwarded run for
every tick where fast-forward did NOT fire, and must match the
post-N-iteration state for ticks where it did fire. Implementation:
add a `--validate-fast-forward` mode that runs both paths and panics
on divergence. Off in production.

**Perf gate** (pre-defined per phase, before measuring):

- Phase 1 alone (static recogniser, no runtime hook): zero perf delta.
  If this changes any number, the recogniser is leaking somewhere.
- Phase 1+2 together: must improve gameplay ticks/s by ≥ +5% with
  high confidence (n=3+ runs, each 60s window). Anything less = no win,
  abandon. We've spent enough sessions on fusers that didn't pay.
- Phase 3 (broadening): must move gameplay ticks/s by ≥ +10% over
  Phase 1+2.

If a phase fails its perf gate it does NOT land. The repo doesn't get
a `CALCITE_AFFINE_FF` env var. Either it pays unconditionally or it
gets reverted.

## Failure modes to watch for

1. **Detection cost outweighs savings.** Same as
   `column_drawer_fast_forward`. Mitigation: O(1) compile-time-keyed
   detection. The HashMap probe is the entire detection cost. If
   benchmarks show this still costs more than it saves, the
   fast-forward sites must be *too rare* — i.e. the loops in
   doom8088 trip too few iterations on average for fast-forward to
   pay. Measure trip-count distribution before committing.
2. **Cycle accounting drift.** REP fast-forward already had to handle
   this; reuse the same approach (advance `cycleCount` by N ×
   cycles_per_iter). Conformance suite catches drift via
   timer-interrupt timing.
3. **Memory model violations.** If a bulk-fill writes through the
   packed-cell layer wrong, the renderer sees garbage. The packed
   broadcast-write path already has range-write primitives; reuse
   them, don't reimplement.
4. **False-positive recogniser.** A body that *looks* affine but
   actually has a side effect we missed. Mitigation: bail-by-default,
   a long allowlist of "known-side-effect-free" Op variants. New Op
   variants must be added to the allowlist to participate; the
   default for an unknown Op is "this body is not fast-forwardable."

## Cardinal-rule check

The recogniser only consults: Op variant, slot indices, literal values,
control-flow edges. It never references:

- Property names (`--AX`, `--opcode`, etc.)
- x86 mnemonics or instruction shapes
- BIOS/DOS memory regions
- doom8088-specific behaviour

A 6502 cabinet with `LDX/DEX/BNE` would hit the same recogniser. A
brainfuck cabinet's `[-]` loop would hit it. A non-emulator cabinet
whose CSS happens to have an `if(style(--X: N): ...; else: <self>)`
self-recursion shape would hit it.

Operational test from CLAUDE.md: "could a calcite engineer who has
never seen a CPU emulator derive this rule by staring at CSS shape
alone?" — yes. The shape is "dispatch entry whose effect is bounded
deltas + one store + self-redispatch until guard." That's a generic
loop-recognition rule.

## Order of operations

1. Implement static recogniser (`pattern/affine_loop.rs`).
2. Wire `--probe-affine-loops` CLI flag that dumps the catalogue
   without enabling the runtime hook.
3. Run on doom8088 + zork1 + sokoban: how many sites? What trip-count
   distribution at runtime (need a small instrumentation pass)?
4. **Decision point.** If trip-counts are too low (e.g. avg < 4), this
   doesn't pay; abandon and try (e) value-keyed memoisation instead.
5. Implement runtime hook (Phase 2).
6. Bench n=3, gameplay window 60s. Apply Phase 1+2 perf gate.
7. If pass: proceed to Phase 3 broadening. If fail: revert + log + try (e).

## What I will not do

- Land an env-var-gated version. Either it pays or it goes back.
- Skip the n=3 verification. Single runs lie at this scale (we saw
  17% run-to-run variance today).
- Conflate this with peephole pair-fusion. This is a structural
  change to dispatch evaluation; pair fusion is a 1-3% game we've
  already established doesn't pay.
- Promise a 2×. The honest range is "5-100% on gameplay, depending on
  trip-count distribution." We'll know after step 3.
