# CSS-DOS Logbook

Last updated: 2026-04-26

## Current status

Zork, Montezuma's Revenge, and sokoban boot and run under dos-corduroy
with autofit memory. zork-big (2.88 MB disk variant) now boots too
after the FAT12 cluster-boundary fix. Doom8088 clears its previous
14.6M-cycle CS=0:IP=4C IVT-jump hang after the SP-wrap fix and now
runs into Doom's WAD/sound init (fails W_GetNumForName: DPPISTOL).

Non-planar video modes should be working following the recent
video-modes work.

## In flight

- **Disk geometry is now builder-driven.** 2026-04-24: disk.size
  defaults to `"autofit"` in both DOS presets. The builder picks CHS
  from content size (standard preset if content fits, fabricated
  geometry up to ~32 MB otherwise) and patches the same values into
  the BIOS at build time via ASCII sentinels (`DGSP`/`DGHD`/`DGCY`)
  plus a `0xD4` sentinel in `disk_param_table`. Both corduroy and
  muslin support it. Web builder (`web/browser-builder/*`) is plumbed
  through too — `buildFloppyInBrowser` now takes a `sizeRequest` and
  returns geometry, so web carts get the same behavior as Node.
  Smoke: zork + montezuma still pass. Does NOT unblock Doom8088 —
  same hang — or the Sokoban/LZEXE "Packed file is corrupt" (both
  are unrelated bugs).
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
- **FAT12/FAT16 cluster-boundary fix (mkfat12).** 2026-04-24: any cart
  whose disk had more than 4085 data clusters (i.e. > ~2.05 MB at
  SPC=1) would hang boot at CS:IP=0x105:0x1730 partway through loading
  ANSI.SYS — DOS auto-detects FAT16 when `dataClusters > 4085`, reads
  our 12-bit FAT entries as 16-bit garbage, walks the wrong cluster
  chain, and fails any read past sector 1 of a multi-cluster file.
  `tools/mkfat12.mjs` now picks `sectorsPerCluster` (doubling from 1)
  so `floor((totalSectors - dataStart) / SPC) <= 4084` always. zork1
  default is unchanged (SPC=1, 703 clusters); 2.88 MB disks now use
  SPC=2 (~2866 clusters). Threshold was pinpointed by binary search:
  4102 total sectors (= 4085 data clusters) boots, 4103 (= 4086 data
  clusters) hangs. File writer uses `clusterOffset(c) = dataStart +
  (c-2)*SPC` and allocates in `CLUSTER_BYTES = SECTOR_SIZE * SPC`
  units. User-verified: zork1 + sokoban still boot; zork-big (2.88 MB)
  now boots; doom8088 clears its old stage-2→3 hang and now hits a
  separate stage-3→4 hang instead.
- **Doom8088:** stage-3→4 hang. 2026-04-24: after the FAT12 fix, doom
  now displays the mode-13h splash and the kernel/ANSI text output
  (stages 1–3) but freezes before the game starts. calcite cycleCount
  stops advancing (~14.6M) while tick counter continues — true CPU
  halt, not an idle loop. CS=0 IP=0x4C when stuck, which is inside the
  IVT. Needs investigation. Previous stage-2→3 hang is fixed.
- **SP 16-bit wrap fix in kiln.** 2026-04-26: identified and fixed the
  14.6M-cycle "CS=0 IP=0x4C IVT-jump" hang. Root cause: kiln's emitted
  CSS computed stack memory addresses as `SS*16 + SP - N` with SP and
  the offset evaluated as i32, no 16-bit wrap. When DOOM's Watcom
  trampoline set SP=0 and INT 21h fired, the CPU push wrote IP/CS/FLAGS
  at linear `SS*16 - 6 .. SS*16 - 1` (negative offsets, *below* the
  segment base) instead of the spec-correct `SS*16 + 0xFFFA .. SS*16 +
  0xFFFF`. Then DOS's INT 21h handler restored SS:SP from a
  16-bit-truncated saved value (so SP came back as 0xFFE8, positive),
  the POPs and IRET read from `SS*16 + 0xFFE8 ..` which was zero memory,
  IRET popped (IP=0,CS=0,FLAGS=0), CPU jumped to 0:0 and walked the IVT.
  Fix: wrap every `var(--__1SP) ± N` used as a memory-address offset
  with `--lowerBytes(..., 16)`, and mask every SP register store with
  the same. Touched `kiln/{patterns/{stack,control,misc,group,
  extended186}.mjs, decode.mjs, emit-css.mjs}`. After rebuild Doom
  advances past 14.6M cycles cleanly: tested to 30M cycles, CPU stays
  in mode 0x03 running DOS / DOOM init code. Zork still boots fine.
  Doom now reaches its own startup, prints `Z_Init`/`W_Init` etc, then
  fails on `W_GetNumForName: DPPISTOL not found` and exits — separate
  issue, probably -nosound not skipping the lump cache, or a memory-
  layout mismatch reading WAD lumps.
- **walk_doom probe.** 2026-04-26: new
  `calcite/crates/calcite-cli/src/bin/walk_doom.rs` runs a cabinet in
  fast batches (~220k ticks/s), dumps reg+memory snapshots per chunk,
  optional code/stack peek + per-chunk PNG/TXT screenshots. Used to
  pinpoint the SP-wrap bug between ticks 838,520-838,525 and confirm
  the fix. Build with `cargo build --release -p calcite-cli --bin
  walk_doom`. Useful flags: `--chunk N`, `--fine-after T --fine-chunk M`
  for two-stage zoom-in, `--dump-code`, `--screenshot`,
  `--find-string DPPISTOL`, `--find-word 0x3D7`, `--dump-at 0x41C20
  --dump-len 256`.
- **Doom8088: DPPISTOL not-found follow-up.** After SP-wrap fix, doom
  reaches its own startup, prints
  `Z_Init`/`W_Init`/`Not enough XMS available`, then hits
  `W_GetNumForName: DPPISTOL not found` and `I_Error`s. Diagnosis so
  far: the lump directory (`fileinfo`, allocated by `Z_MallocStatic`)
  IS loaded correctly at linear ~0x41DB0, with DPPISTOL at lump 96
  exactly where it should be (`fileinfo[96].offset = 0x95BD9, size =
  0x38, name = "DPPISTOL"`). Doom8088's global `numlumps` (next to
  fileinfo at ~0x41C3E) holds 0x03D7 = 983, the correct count. So the
  loop bound and the data are both fine — yet `W_GetNumForName` walks
  the array and fails to match. Hypotheses still open: (a) the
  far-pointer Doom uses for `fileinfo` is wrong (segment computed via
  16-bit truncation of a >0xFFFFF linear address — but 0x41DB0 / 16 =
  0x41DB, well below the truncation threshold, so unlikely); (b) the
  Watcom `_fmemcmp` intrinsic is hitting a calcite bug for some
  specific pattern; (c) Doom8088 actually wants a `D8_DOOM1.WAD` or
  preprocessed shareware WAD with different lump names (the
  hardcoded query strings live in DOOM.EXE near linear 0x39603 —
  "DPPISTOL\\0TITLEPIC\\0HELP2\\0FLOOR4_8\\0WIMAP0\\0..." — and the
  shareware WAD on the cart does contain DPPISTOL, so this is also
  unlikely). Not yet investigated; the SP-wrap fix is the stable
  improvement.

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
