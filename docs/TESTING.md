# Testing

Two peer entrypoints. Pick the one that matches your question.

| Question                                              | Entrypoint        |
|-------------------------------------------------------|-------------------|
| Did my change break a cart? Does calcite agree with the reference 8086? | `tests/harness/`  |
| How fast does this cabinet boot / run / load a level? | `tests/bench/`    |

Correctness lives in **`tests/harness/`** (smoke, conformance,
divergence-finding, screenshots). Performance lives in
**`tests/bench/`** (timed profiles, web + native targets,
ensureFresh-driven artifact rebuild).

## Correctness — `tests/harness/`

```sh
# Full smoke suite — builds every reference cart, runs ~15s, checks it's alive.
# Run before/after any non-trivial change.
node tests/harness/run.mjs smoke

# Conformance diff — "is calcite correctly running x86?" Several minutes for the full set.
node tests/harness/run.mjs conformance --max-ticks=5000
```

Reports land in `tests/harness/results/latest.json`. Exit code: 0 = all
passed, 2 = test failures, 1 = harness couldn't start.

### Single-cart commands

```sh
# Build + run + screenshot — "does this cart work?"
node tests/harness/pipeline.mjs full carts/test-carts/dos-smoke

# Find the first tick where calcite disagrees with the JS reference 8086.
# This is the main correctness-debugging tool.
node tests/harness/pipeline.mjs fulldiff <cabinet>.css --max-ticks=10000

# Screenshot at a late tick. fast-shoot drives calcite-cli (~375K ticks/s);
# use this for any tick past ~200K. The slow shoot path goes through
# calcite-debugger at ~1500 ticks/s and won't reach boot completion (2-4M
# ticks) inside a 2-minute budget.
node tests/harness/pipeline.mjs fast-shoot <cabinet>.css --tick=3000000 --out=shot.png

# Slow-path screenshot (early ticks only, or when sharing a daemon).
node tests/harness/pipeline.mjs shoot <cabinet>.css --tick=100000 --out=shot.png

# Raw byte dump from guest memory at end of run (no rendering).
# Repeatable for multiple regions per invocation.
../calcite/target/release/calcite-cli.exe -i <cabinet>.css \
    --speed 0 --dump-tick 1000000 \
    --dump-mem-range=0xB8000:4000:vram.bin \
    --dump-mem-range=0x449:1:mode.bin \
    --sample-cells=0

# Snapshot + restore for skipping boot in iterative debugging. Same-cabinet only.
../calcite/target/release/calcite-cli.exe -i <cabinet>.css \
    --ticks=60000000 --snapshot-out=in-game.snap
../calcite/target/release/calcite-cli.exe -i <cabinet>.css \
    --restore=in-game.snap --ticks=10000000
```

Full tool list and recipe walkthroughs in
[`tests/harness/README.md`](../tests/harness/README.md).

## Performance — `tests/bench/`

```sh
# Sanity: cabinet → parse → compile → done.
node tests/bench/driver/run.mjs compile-only

# Doom8088 boot through six stages (text → title → menu → loading → ingame).
node tests/bench/driver/run.mjs doom-loading                # web (default)
node tests/bench/driver/run.mjs doom-loading --target=cli   # native CLI
```

Profiles live in `tests/bench/profiles/`; each declares its required
artifacts and the driver auto-rebuilds anything stale before running.
See [`tests/bench/README.md`](../tests/bench/README.md) for the
profile API and [`docs/script-primitives.md`](script-primitives.md)
for the watch-spec grammar profiles use to express stage detectors.

## Reference emulator = ground truth

`tests/harness/lib/ref-machine.mjs` stands up a JS reference 8086 with
real PIC/PIT peripherals using the BIOS/kernel/disk sidecar bytes the
builder emits alongside every cabinet. If calcite disagrees with the
ref, **calcite is wrong** (or the CSS is wrong — either way it's a
bug we can fix). See `conformance/README.md` for the deeper story.

## Budgets, not hopes — every command needs an explicit ≤2-minute cap

Every long-running command accepts `--wall-ms`, `--max-ticks`, and
`--stall-rate`. **Use them.** Cabinets and the JS daemon can run
effectively forever; firing-and-forgetting a tool that doesn't
terminate burns real time. Boot reaches `A:\>` around tick 2-4M,
which is *not* reachable inside a 2-minute budget on the slow
`shoot` / `run` paths (~1500 ticks/s through `calcite-debugger`).
Use `fast-shoot` (`calcite-cli`, ~375K ticks/s) for late-tick
screenshots, or pick a tick count the chosen path can reach. If no
path fits the budget, **build a faster one** — that's how
`fast-shoot`, `--dump-mem-range`, and the bench harness all came to
exist.

The native `run_until` debugger tool has no wall-clock ceiling; it'll
run forever if its condition never triggers. Reach for
`pipeline.mjs run` or `lib/timed-run.mjs` instead.

## When to use the MCP debugger vs the harness

| Task                                  | Tool                                                       |
|---------------------------------------|------------------------------------------------------------|
| Exploratory: "what's going on at tick X?" | MCP debugger (interactive)                              |
| Scripted: "does this pass?"           | `tests/harness/run.mjs`                                    |
| Bisecting a divergence                | `tests/harness/pipeline.mjs fulldiff`, then MCP to dig in  |
| Visual sanity (early ticks, daemon)   | `tests/harness/pipeline.mjs shoot`                         |
| Visual sanity (late ticks / fresh)    | `tests/harness/pipeline.mjs fast-shoot`                    |
| Raw guest memory dump                 | `calcite-cli --dump-mem-range=ADDR:LEN:PATH`               |
| Regression check                      | `tests/harness/pipeline.mjs cabinet-diff` / `baseline-verify` |
| Timed boot/load measurement           | `tests/bench/driver/run.mjs <profile>`                     |
| React to engine state at runtime      | `--watch` / `register_watch` — see [`script-primitives.md`](script-primitives.md) |

The full MCP tool surface (`inspect_packed_cell`, `compare_paths`,
`watchpoint`, async `run_until`, multi-session diffs, `trace_property`,
`execution_summary`) lives in calcite's docs at
[Agent-oriented tooling](../../calcite/docs/debugger.md#agent-oriented-tooling).
The harness wraps each tool in
[`tests/harness/lib/debugger-client.mjs`](../tests/harness/README.md).
