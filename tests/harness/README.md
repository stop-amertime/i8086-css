# tests/harness — agentic testing infrastructure for CSS-DOS + Calcite

If you're an agent trying to "run the tests" or "figure out why the game
doesn't work" — you're in the right place. **Start with `node tests/harness/run.mjs smoke`**
for a quick sanity check, then read below for the specific tool that matches
your question.

## The one sentence

Every cabinet this repo produces can be driven through a JS + Rust pipeline
that runs it, screenshots it, compares it against a reference 8086 emulator,
and compares it against its own prior build — all from one CLI entrypoint,
all with time budgets that actually terminate.

## Two commands that cover 80% of tasks

```sh
# Full smoke test — build every reference cart, run 15s each, check it's alive.
node tests/harness/run.mjs smoke

# Is calcite correctly emulating x86? First-divergence finder vs JS reference.
node tests/harness/pipeline.mjs fulldiff tests/harness/cache/<cart>.css --max-ticks=10000
```

## Common workflows

### I changed kiln and want to check if anything broke

```sh
# Build a cabinet with your change.
node tests/harness/pipeline.mjs build carts/dos-smoke

# Compare state at sample ticks against a reference cabinet you saved earlier.
node tests/harness/pipeline.mjs cabinet-diff \
    tests/harness/cache/dos-smoke-before.css \
    tests/harness/cache/dos-smoke.css \
    --ticks=0,10000,50000,100000
```

### I want to see what's on screen at tick N

```sh
# Build + screenshot at tick N. PNG goes to the configured --out path.
node tests/harness/pipeline.mjs shoot cabinet.css --tick=100000 --out=shot.png
```

### The game says it's running but the video is garbled

```sh
# Triage — runs the full diff vs JS reference and points you at the
# first diverging tick with actionable next steps.
node tests/harness/pipeline.mjs triage cabinet.css --max-ticks=20000
```

### I want to know when a specific BDA byte changes

Use the debugger's `watchpoint` tool directly — the harness doesn't add a
wrapper because the debugger's native version is already good.

### I need to wait for the program to actually start running

```sh
# Runs until CS leaves the BIOS region (program has entered), or wall-clock
# hits the budget. Prints ticks/sec progress.
node tests/harness/pipeline.mjs run cabinet.css \
    --until-program-entered --wall-ms=60000
```

### I want a baseline to compare future builds against

```sh
# Record
node tests/harness/pipeline.mjs baseline-record cabinet.css \
    --ticks=0,10000,50000,100000,500000

# Later, verify — exit code 0 = all ticks match, 3 = mismatch
node tests/harness/pipeline.mjs baseline-verify cabinet.css
```

Baselines live in `tests/harness/baselines/<cart>/` and include PNGs,
register hashes, and text-buffer hashes per-tick. Check in the PNGs —
they're the visual oracle for future agents.

## What each tool does

| Tool | Question it answers |
|---|---|
| `pipeline.mjs build <cart>` | "Can this cart build?" Prints timings + meta. |
| `pipeline.mjs inspect <cabinet>` | "What's inside this cabinet?" No daemon needed. |
| `pipeline.mjs run <cabinet>` | "Can it run N seconds without hanging?" Wall-clock + stall-rate budgets. |
| `pipeline.mjs shoot <cabinet>` | "What's on screen at tick X?" PNG + phash. |
| `pipeline.mjs full <cart>` | build → load → run → shoot, all in one. |
| `pipeline.mjs fulldiff <cabinet>` | "Where does calcite first disagree with the JS reference emulator?" |
| `pipeline.mjs triage <cabinet>` | Same as fulldiff but wraps the result with "what to do next." |
| `pipeline.mjs cabinet-diff A B` | "Do these two cabinets behave identically at the sample ticks?" |
| `pipeline.mjs baseline-record` | Freeze a cart's current state at chosen ticks. |
| `pipeline.mjs baseline-verify` | Compare current cart state to its frozen baseline. |
| `pipeline.mjs consistency <cabinet> --tick=N` | Run compare-paths (compiled vs interpreter) at a tick. *Note: limited after seek — see "compare_paths caveat" below.* |
| `run.mjs <preset>` | Run one of smoke/conformance/visual/full. Report at `tests/harness/results/latest.json`. |

## Budgets, not hopes

Every long-running subcommand accepts `--wall-ms=N` (wall-clock ceiling),
`--max-ticks=N` (tick count), and `--stall-rate=F --stall-seconds=N` (ticks/s
floor and for how long). Runs that don't terminate on their own get killed
with a `reason` field on the JSON result so you know why. Don't set
ambitious limits and walk away hoping — the harness will tell you what
actually happened.

The debugger's native `run_until` has a tick ceiling but **no wall-clock
ceiling and no stall detection**. If you find yourself reaching for
`run_until`, use `pipeline.mjs run` or the `timedRun` helper instead.
`run_until` is only useful when you know the condition will hit quickly
(e.g. "seek to the first keyboard interrupt").

## How the pieces fit together

```
         +-------------------+
         |     run.mjs       |  <- agent-facing presets
         +---------+---------+
                   |
                   v
         +---------+---------+
         |   pipeline.mjs    |  <- subcommands (build, run, shoot, ...)
         +---------+---------+
           |                 |
           v                 v
   +-------+-------+   +-----+------+
   |  fulldiff.mjs  |   |  lib/*.mjs |
   +-------+-------+   +-----+------+
           |                 |
           v                 v
    +------+------+    +-----+------+         +----------------+
    |  ref-machine |<--|  sidecars  |<-----+--| builder/build  |
    |  (js8086)    |   | (bios.bin, |      |  +----------------+
    +------+------+    |  disk.bin, |      |
           ^           |  meta.json)|      +-- emits sidecars +
           |           +------------+          /*!HARNESS*/ header block
           |
    +------+------+
    | MCP client  |  <- lib/mcp-client.mjs + lib/debugger-client.mjs
    |  (stdio or  |
    |   TCP)      |
    +------+------+
           |
           v
    +------+------+
    | calcite-    |  <- spawned as one-shot child per command,
    | debugger    |     OR a pre-running daemon on --port=PORT.
    +-------------+
```

## Key design decisions, and why

### Why spawn a fresh debugger per command?

The user's MCP client keeps one daemon resident across Claude Code
sessions. The harness doesn't touch that daemon — it spawns its own
child, does its work, and exits. Side effects on the user's daemon
would leak test state into interactive sessions. Use `--daemon
--port=PORT` when you explicitly want to share state.

### Why sidecar .bin files?

Old conformance tools imported `../CSS-DOS/transpiler/` to rebuild the
memory map. That directory was deleted. The sidecars (`.bios.bin`,
`.disk.bin`, `.kernel.bin`, `.meta.json`) are a simpler contract — the
ref emulator opens them, no symbolic knowledge of CSS-DOS internals
required.

### Why `seek` instead of `tick` for bulk advancement?

The debugger's `tick` tool returns a per-tick change log, which the
MCP transport caps around ~500 ticks per call. `seek` has no log — it
replays forward from the nearest checkpoint. Use `seek` for "land at
tick N"; use `tick` for "take one step and tell me what changed."

### The compare_paths caveat

`compare_paths` runs the compiled and interpreted paths from the same
in-memory snapshot and reports diffs. If you've called `seek` first,
the snapshot's intermediate-state properties (like `--_sAX`) reflect
the compiled path's history but the interp path derives them fresh,
so `property_diffs` produces architectural noise, not bugs. For a
clean compiled-vs-interp test, only trust differences in canonical
state-vars (AX, BX, IP, flags) — see `lib/oracles.mjs` filter.

### Font for text-mode screenshots

We render text mode using `bios/corduroy/cga-8x8.bin` (the same font the
corduroy splash uses). Screenshots are 8× pixel-scale (320×200 for 40-col,
640×200 for 80-col). Not VGA-accurate at 9×16 but good enough for perceptual
hashes and human sanity-checks.

## If something's broken

- **`pipeline.mjs build` fails** — usually a NASM/wlink problem. Check
  `NASM` env var and WATCOM toolchain env.
- **`pipeline.mjs full` hits wall-ms** — the cart isn't reaching program
  entry in the budget. Either the budget is too short for the cart
  (Montezuma + Doom need longer), or the cart is genuinely broken.
  Combine with `shoot` at various ticks to eyeball.
- **`fulldiff` shows divergence at tick 0** — register-alignment issue;
  ensure the cabinet was built with the current builder (it writes the
  harness header with the initial CS/IP values the ref emulator needs).
  Rebuild if uncertain.
- **`fulldiff` diverges within ~10 ticks** — often a kiln emit bug
  for a BIOS-init opcode. Binary-search the divergence with
  `pipeline.mjs shoot --tick=N` for visual sanity.

## Files

- `pipeline.mjs` — single-command entrypoint with subcommands
- `run.mjs` — preset-level runner (`smoke`, `conformance`, `visual`, `full`)
- `fulldiff.mjs` — streaming calcite-vs-ref divergence finder
- `lib/debugger-client.mjs` — harness-facing wrapper around the MCP debugger. See [Agent-oriented tooling](../../../calcite/docs/debugger.md#agent-oriented-tooling) in the calcite docs for the full tool surface (`inspect_packed_cell`, `compare_paths`, `watchpoint`, async `run_until`, multi-session diffs, `trace_property`, `execution_summary`, etc.).
- `lib/mcp-client.mjs` — raw MCP over child-stdio or TCP
- `lib/ref-machine.mjs` — JS reference 8086 set up from cabinet sidecars
- `lib/cabinet-header.mjs` — builder emits a `/*!HARNESS v1 ...!*/` JSON block; this reads it
- `lib/timed-run.mjs` — wall-clock + tick-count + stall-rate budgets
- `lib/shoot.mjs` — framebuffer → PNG for all video modes
- `lib/png.mjs` — pure-JS PNG encoder + perceptual hash
- `lib/baseline.mjs` — record + verify golden baselines
- `lib/cabinet-diff.mjs` — diff two cabinets at sample ticks
- `lib/oracles.mjs` — multi-backend register-snapshot interface
- `cache/` — intermediate cabinets (.gitignored)
- `baselines/` — per-cart frozen state (check in the PNGs)
- `results/` — JSON report output, includes `latest.json`
