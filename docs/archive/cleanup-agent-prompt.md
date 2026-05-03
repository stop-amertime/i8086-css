# Cleanup work — agent prompt

You're picking up an infrastructure cleanup. The audit and plan were
done in the prior session; you're executing.

## Read first (in order)

1. `docs/audit-summary-and-plan.md` — the landing + 6-chunk plan. **The
   plan section is your work.**
2. `docs/audit-2026-04-30.md` — the underlying audit. Sections 1-9 are
   factual inventory you'll need; §10/§11 are reframed pointers back to
   the summary.
3. `CLAUDE.md` and `docs/logbook/LOGBOOK.md` (you'll see these
   auto-loaded anyway).

## What this work is

A repo cleanup, not a refactor. Move/delete the genuinely-mislocated
stuff between `calcite/` and `CSS-DOS/`, build one bench harness with
named profiles to replace the current six bench scripts, add a generic
script-primitive layer to calcite-core, reconcile the docs, sweep
debris.

## What this work is NOT — do not pull these in

- Removing calcite's cheats (`column_drawer_fast_forward`,
  `rep_fast_forward`'s opcode-awareness, BDA hardcode, renderers in
  calcite-core, etc.). They stay where they are. The audit §11
  catalogues them for future work.
- Building a Rust adapter on calcite-core, or any `BulkPattern` /
  `TickHook` extension API. There is **no Rust adapter** in the
  destination.
- Treating the bench as a shim. The bench is a normal web app — page
  with full JS, calcite-wasm in a worker, Playwright driver. The
  zero-JS-on-page constraint is the player's contract, not CSS-DOS-wide.
- MCP debugger overhaul, calcite-as-a-published-crate, kiln rewrites.

## How to execute

The plan's 6 chunks (A-F, G optional) in the summary doc give you
goals, deliverables, and verification per chunk. Sequencing:

```
A (inventory, ~1hr)
↓
B (calcite cleanup) ┐  parallel, both afternoons
C (CSS-DOS moves)   ┘
↓
D (script primitives in calcite-core, days)
↓
E (bench harness rebuild, days)
↓
F (doc reconciliation, day)
+ G (debris sweep, optional, fold into F)
```

Bigbang shape: one feature branch in each repo, many small commits for
bisectability, validate against Chunk A's baseline at the end. Don't
preserve always-green between phases — it's not worth the structural
overhead for a single-developer cleanup.

## Logbook discipline

- Calcite engine work → `../calcite/docs/log.md`
- CSS-DOS platform/harness/bench work → `docs/logbook/LOGBOOK.md`
- Cross-cutting → both

This is one of the things you'll *establish* in Chunk F (adding the
rule to both CLAUDE.md files), but follow it as you go.

## Open questions to resolve as you hit them

The summary doc lists four. Address them when the relevant chunk
forces a decision; don't pre-emptively resolve them. Bring any
additional ambiguities back to the user — don't guess silently.

## Start

Begin with Chunk A. Run smoke + both doom benches; capture baseline to
`tmp/split-baseline.json`. Resolve the inventory questions. Log the
results. Then proceed to B and C in parallel.

If anything in the plan turns out to be wrong on contact, stop and
flag it before continuing.
