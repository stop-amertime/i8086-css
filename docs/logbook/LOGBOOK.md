# CSS-DOS Logbook

Last updated: 2026-04-23

## Current status

Zork and Montezuma's Revenge both boot and run under dos-corduroy with
autofit memory — video is good and performance is good as of just
before the memory-packing merge attempt. These are the canonical
smoke tests; carts live in `carts/`.

Non-planar video modes should be working following the recent
video-modes work.

## In flight

- **Memory packing (2 bytes per property):** ongoing. 2026-04-23:
  found + fixed the "pack=2 freezes partway through zork boot with
  partial splash" regression. Root cause on the calcite side:
  `bulk_fill` / `bulk_copy` / `bulk_store_byte`, all three paths of
  `Op::MemoryFill`/`MemoryCopy`, and the affine projectors in
  `cycle_tracker.rs` + `tick_period.rs` all guarded writes on
  `state.memory.len()`. For packed cabinets the flat array stays at
  `DEFAULT_MEM_SIZE = 0x600` (real bytes live in packed cells), so every
  REP STOS/MOVS fast-forward and projector silently dropped writes above
  0x600. zork diverges at tick ~397k on a `REP MOVSW` that copies
  ~58k bytes to `ES:DI = 0x20000`. Fix: new
  `effective_guest_mem_end(state) = max(flat_len,
  packed_cell_table.len() * pack_size)`. Native probe converges pack=1
  vs pack=2 through ≥500k ticks post-fix, and pack=2 is now *slightly
  faster* than pack=1 (not slower, as the user expected). Browser
  verification pending.
- **Doom8088:** almost there. Boot splash (mode 13h) and text-mode
  kernel/ANSI output display correctly; hangs after the kernel DOS
  message where the game should start. Ticks continue, but execution
  has gone wrong.

## Boot sequence (dos-corduroy)

1. Mode 13h boot splash
2. Text mode — kernel message + ANSI message
3. Game starts

Full boot is typically 2–4 million ticks. "Ticks are running" is
NOT a pass — video must come out and be clearly recognisable as
the game.

## How to test

Default: dos-corduroy preset, autofit memory, via the web player.
**Ask the user how to test** for anything beyond the basic smoke test.
Log good methods here as you find them.

## Debugging and conformance infrastructure — now unified

As of 2026-04-23 the test harness lives in `tests/harness/`:

- `run.mjs smoke|conformance|visual|full` — preset-level runner, writes
  `tests/harness/results/latest.json` for agents to grep.
- `pipeline.mjs <subcommand>` — single-command entrypoint for `build`,
  `inspect`, `run`, `shoot`, `full`, `fulldiff`, `triage`, `cabinet-diff`,
  `baseline-record`, `baseline-verify`, `consistency`.
- Each command prints structured JSON to stdout + human progress to stderr.
- Every long-running command has wall-clock + tick + stall-rate budgets.

The old tools (`../calcite/tools/fulldiff.mjs`, `tools/compare-dos.mjs`,
etc) imported the deleted `transpiler/` and don't work — their headers
are marked as deprecated pointing at the new harness.

Key sidecar files: the builder now emits `<cabinet>.bios.bin / .kernel.bin
/ .disk.bin / .meta.json` alongside every `.css`. The JS reference
emulator uses these sidecars to stand up the exact same 1 MB memory image
calcite sees — no more "my ref setup doesn't match calcite" divergences.
The cabinet also carries a `/*!HARNESS v1 {json}!*/` header block with
all build meta.

See [`../TESTING.md`](../TESTING.md) (top-level doc) and
`../../tests/harness/README.md` (full workflows).

## Model gotchas

- Don't just run ticks and call it a pass — verify video.
- Ask the user how to test rather than guessing.
- Web player and MCP debugger are for different things — pick the
  right one for the task. Log which tool fits which job here as you
  learn it.
