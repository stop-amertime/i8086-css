# CSS-DOS documentation index

Start at the top, go as deep as you need.

## Start here

| Doc | For |
|---|---|
| [`logbook/LOGBOOK.md`](logbook/LOGBOOK.md) | **Always, before any work.** Current status, active blocker, priorities. |
| [`architecture.md`](architecture.md) | The tight overview: glossary, pipeline, cardinal rule, memory sketch. |
| [`cart-format.md`](cart-format.md) | The cart schema. Canonical reference for `program.json`. |

## Building and running

| Doc | For |
|---|---|
| [`building.md`](building.md) | End-to-end walkthrough: cart → cabinet. Covers the five stages and the toolchain. |
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

## Debugging

| Doc | For |
|---|---|
| [`debugging/workflow.md`](debugging/workflow.md) | Standard process: find divergence, diagnose, fix, verify. |
| [`debugging/calcite-debugger.md`](debugging/calcite-debugger.md) | HTTP API, endpoints, typical sessions. |
| [`debugging/known-bugs.md`](debugging/known-bugs.md) | Known bugs + patterns to watch for. |
| [`reference/kernel-boot-sequence.md`](reference/kernel-boot-sequence.md) | What EDR-DOS does during boot; what BIOS services it needs. |
| [`reference/tick-benchmarks.md`](reference/tick-benchmarks.md) | Rough tick counts for boot milestones — size debugger runs, spot stalls. |
| [`reference/debugging-dos-kernel.md`](reference/debugging-dos-kernel.md) | EDR-DOS internals, map file, Ralf Brown's, edrdos source. |
| `../conformance/README.md` | Reference emulators for diff testing. |

## Logbook and coordination

| Doc | For |
|---|---|
| [`logbook/LOGBOOK.md`](logbook/LOGBOOK.md) | **THE source of truth for project status.** |
| [`logbook/PROTOCOL.md`](logbook/PROTOCOL.md) | How to write logbook entries. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Repo-wide changelog, starting from the big rename. |

## Plans and archive

| Path | For |
|---|---|
| `plans/` | Per-workstream task lists. |
| `archive/` | Completed specs, old plans, historical session notes. |
| `superpowers/` | Brainstorming and planning artifacts from agent sessions. |

## Calcite (sibling repo)

| Path | For |
|---|---|
| `../calcite/CLAUDE.md` | Calcite's architecture and cardinal rule. |
| `../calcite/docs/debugger.md` | HTTP debug server API. |
| `../calcite/docs/conformance-testing.md` | `fulldiff.mjs`, `diagnose.mjs`, `ref-dos.mjs`. |
| `../calcite/docs/codebug.md` | Co-execution debugger for side-by-side JS/calcite comparison. |
| `../calcite/docs/benchmarking.md` | Performance numbers, Chrome comparison. |
