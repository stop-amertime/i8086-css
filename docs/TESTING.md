# Testing

If you're doing **anything** that changes the output of a cart — kiln
emitter edits, BIOS changes, builder tweaks, Calcite engine work — you
should be running it through `tests/harness/`.

## Quick start

```sh
# Full smoke suite — builds every reference cart, runs 15s, checks it's alive.
# Use this before/after any non-trivial change.
node tests/harness/run.mjs smoke

# Run the conformance diff — this is the "is calcite correctly running
# x86?" oracle. Takes several minutes for the full set.
node tests/harness/run.mjs conformance --max-ticks=5000
```

Reports land in `tests/harness/results/latest.json` (plain JSON, easy for
agents and CI to parse). Exit code: 0 = all passed, 2 = test failures,
1 = harness couldn't start.

## Single-cart commands

```sh
# Build + run + screenshot — the one-command "does this cart work?" check.
node tests/harness/pipeline.mjs full carts/dos-smoke

# Run fulldiff to find the first tick where calcite disagrees with the
# JS reference 8086 emulator. This is the main debugging tool.
node tests/harness/pipeline.mjs fulldiff <cabinet>.css --max-ticks=10000

# Screenshot at a specific tick — actually see what the cart is showing.
node tests/harness/pipeline.mjs shoot <cabinet>.css --tick=500000 --out=shot.png
```

Everything is documented in more detail in
[`tests/harness/README.md`](../tests/harness/README.md) — the harness's
own README has workflow recipes for common debugging scenarios.

## Budgets beat hopes

Every long-running command accepts `--wall-ms`, `--max-ticks`, and
`--stall-rate`. Use them. The native `run_until` tool has no wall-clock
ceiling; it'll run forever if the condition never triggers.

## Reference emulator = ground truth

`tests/harness/lib/ref-machine.mjs` stands up a JS reference 8086 with
real PIC/PIT peripherals using the BIOS/kernel/disk sidecar bytes the
builder emits. If calcite disagrees with the ref, **calcite is wrong**
(or the CSS is wrong — either way it's a bug we can fix).

## When to use the MCP debugger directly vs the harness

| Task | Tool |
|---|---|
| Exploratory: "what's going on at tick X?" | MCP debugger (interactive) |
| Scripted: "does this pass?" | `tests/harness/run.mjs` |
| Bisecting a divergence | `tests/harness/pipeline.mjs fulldiff`, then MCP debugger to dig |
| Visual sanity | `tests/harness/pipeline.mjs shoot` |
| Regression check | `tests/harness/pipeline.mjs cabinet-diff` or `baseline-verify` |
