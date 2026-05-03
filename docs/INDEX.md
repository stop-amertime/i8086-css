# CSS-DOS documentation index

Start at the top, go as deep as you need.

## Start here

| Doc | For |
|---|---|
| [`logbook/STATUS.md`](logbook/STATUS.md) | **Always, before any work.** Current state, working carts, sentinel addresses, model gotchas, open work. |
| [`logbook/LOGBOOK.md`](logbook/LOGBOOK.md) | Chronological work entries. Read when you want history; STATUS is what you actually need. |
| [`architecture.md`](architecture.md) | Tight overview: glossary, pipeline, cardinal rule, memory sketch. |
| [`cart-format.md`](cart-format.md) | The cart schema. Canonical reference for `program.json`. |

## Building and running

| Doc | For |
|---|---|
| [`building.md`](building.md) | End-to-end walkthrough: cart → cabinet. Stages and toolchain. |
| [`rebuild-when.md`](rebuild-when.md) | Artifact graph, the `ensureFresh` primitive, and the dev server's `/_reset` / `/_clear` cache-clearing endpoints. |
| [`hack-path.md`](hack-path.md) | The raw `.COM` path (no DOS). Conformance testing, tiny demos. |

## The machine

| Doc | For |
|---|---|
| [`memory-layout.md`](memory-layout.md) | Every memory zone, rom-disk mechanics, the 0x4F0 pitfall. |
| [`bios-flavors.md`](bios-flavors.md) | Gossamer / Muslin / Corduroy at a glance. Links to each BIOS's own README. |
| `../bios/gossamer/README.md` | Gossamer in detail. |
| `../bios/muslin/README.md` | Muslin in detail. |
| `../bios/corduroy/README.md` | Corduroy in detail. |
| `../kiln/README.md` | Kiln's layout + emit entry point. |
| `../kiln/AGENT-GUIDE.md` | How to add a new instruction. |

## Testing, benchmarking, debugging

| Doc | For |
|---|---|
| [`TESTING.md`](TESTING.md) | **Start here.** The two-entrypoint split: correctness (`tests/harness/`) vs perf (`tests/bench/`). |
| `../tests/harness/README.md` | Correctness harness — smoke, conformance, ref-machine, fulldiff, screenshot, baseline. |
| `../tests/bench/README.md` | Perf harness — profiles, page+driver, native+web targets, ensureFresh artifact registry. |
| [`script-primitives.md`](script-primitives.md) | Watch-spec grammar. The DSL bench profiles use to detect stages and react to engine state. |
| [`perf-iteration.md`](perf-iteration.md) | Perf-iteration tooling: snapshots, CS:IP sampling, op-distribution profiling, calcite worktrees. Read when you're optimising. |
| [`agent-briefs/doom-perf-mission.md`](agent-briefs/doom-perf-mission.md) | The Doom8088 perf mission: priority leads, success criteria, where the time is going. |
| [`debugging/workflow.md`](debugging/workflow.md) | Standard debugging process: find divergence, diagnose, fix, verify. |
| [`debugging/calcite-debugger.md`](debugging/calcite-debugger.md) | HTTP API, endpoints, typical sessions. Points at [Agent-oriented tooling](../../calcite/docs/debugger.md#agent-oriented-tooling) for the MCP surface. |
| [`debugging/known-bugs.md`](debugging/known-bugs.md) | Known bugs + patterns to watch for. |
| [`reference/kernel-boot-sequence.md`](reference/kernel-boot-sequence.md) | What EDR-DOS does during boot; what BIOS services it needs. |
| [`reference/tick-benchmarks.md`](reference/tick-benchmarks.md) | Rough tick counts for boot milestones — size debugger runs, spot stalls. |
| [`reference/debugging-dos-kernel.md`](reference/debugging-dos-kernel.md) | EDR-DOS internals, map file, Ralf Brown's, edrdos source. |
| `../conformance/README.md` | Reference emulators for diff testing. |

## Logbook and coordination

| Doc | For |
|---|---|
| [`logbook/STATUS.md`](logbook/STATUS.md) | Durable handbook (auto-loaded by CLAUDE.md). |
| [`logbook/LOGBOOK.md`](logbook/LOGBOOK.md) | Chronological entries. |
| [`logbook/PROTOCOL.md`](logbook/PROTOCOL.md) | How to write logbook entries. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Repo-wide changelog. |

## Plans and archive

| Path | For |
|---|---|
| `plans/` | Per-workstream task lists. |
| `archive/` | Completed specs, old plans, historical session notes. |

## Calcite (sibling repo)

| Path | For |
|---|---|
| `../calcite/CLAUDE.md` | Calcite's architecture and cardinal rule. |
| `../calcite/docs/debugger.md` | MCP debug server API. |
| `../calcite/docs/conformance-testing.md` | Conformance concepts. (The legacy `tools/fulldiff.mjs` / `diagnose.mjs` / `ref-dos.mjs` are broken — use `tests/harness/pipeline.mjs fulldiff` instead.) |
| `../calcite/docs/codebug.md` | Co-execution debugger for side-by-side JS/calcite comparison. |
| `../calcite/docs/benchmarking.md` | Performance numbers, Chrome comparison. |
