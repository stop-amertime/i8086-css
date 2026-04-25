# Doom8088 hang — what we actually know

Session notes. No theories, no plans — just what sampling and reading
source established. Written for the agent who picks this up next.

## The observed symptom

- Build: `node builder/build.mjs carts/doom8088 -o /tmp/doom.css`
- User runs it in the web player. Expected: mode 13h splash → text-mode
  kernel banner → ANSI.SYS banner → DOOM8088 banner → game.
- Actual: kernel banner prints, then nothing. No ANSI.SYS banner. Cursor
  stops blinking.
- Confirmed by user: the ANSI banner never appears. (Earlier sessions
  may have mis-described this; that description was wrong.)
- User report: the hang predates the recent disk-geometry work. Before
  and after, same place.

## What execution does in calcite (from `calcite-cli` sampling)

1. Splash completes by ~tick 100k.
2. At ~tick 397947 a `REP STOSB` at kernel linear 0x0A5A zeros linear
   0xD6C..0x2782 (5126 bytes). This is part of kernel decompression —
   zork hits the same STOSB at a similar tick. Not the bug.
3. CPU continues, eventually lands at CS=0x0105:IP=0x0115 (linear
   0x1165) at tick ~513108.
4. IP then progresses 0x0115 → 0x011A → 0x011F → 0x0124 → 0x0136 →
   0x014D → 0x0BBC → ... → 0x1710 → 0x1730 (linear 0x2780).
5. At tick 514616+ IP is pinned at 0x1730. All registers identical
   tick-to-tick. Zero state changes. `cycleCount` stuck at 9,813,024.
6. Bytes at linear 0x2780 in the running memory are `C0 11 70 00 FC 83 EC 16 55 ...`.
   0xC0 is not a valid 8086 opcode — calcite sits on it producing no
   state change, forever.

## How we got to `CS=0x0105:0x1730`

- At tick 513107 the last "real" instruction before the jump was at
  CS=0x9675:IP=0x603F (linear 0x9C78F).
- Bytes there: `2E FF 1E 53 88` = `CALL FAR CS:[0x8853]`.
- The far pointer at linear 0x9EFA3 (= CS*16 + 0x8853) reads
  `15 01 05 01` → `0105:0115`.
- That target matches a DOS device-driver entry. The loaded driver at
  linear 0x1050 has header `FF FF FF FF 13 80 15 01 20 01 'CON     '` —
  ANSI.SYS's header, with strategy=0x0115 and interrupt=0x0120.
- So the call is the kernel dispatching into ANSI.SYS's strategy entry.
  Normal kernel code, not runaway. Same mechanism zork uses.

## What's actually wrong with ANSI.SYS's body

- ANSI.SYS is 4933 bytes (10 sectors) in the cart. Correct on disk.
- In memory at linear 0x1050..0x124F (~0x200 bytes = 1 sector) the
  bytes match the file byte-for-byte.
- From linear 0x1250 to 0x277F (sectors 2..10 of the file), memory
  is **all zero**.
- Runtime memory at 0x2780 (first byte "past" ANSI.SYS in the load
  region) has `C0 11 70 00 FC 83 EC ...` — the prologue of some
  other function loaded there, not ANSI.SYS.
- The driver's jump table at file offset 0xF3 maps command 0 (INIT)
  to offset 0x0BAE. That offset = linear 0x1050 + 0x0BAE = 0x1BFE,
  which is inside the zero region.
- The kernel's CONFIG.SYS processing calls `device_init` on the
  loaded driver, which dispatches to the command-0 handler at 0x1BFE.
  That's where execution walks into zeros.

## The kernel only reads sector 1 of ANSI.SYS

Instrumented calcite-cli with `--watch-cell=632` (cell 632 is the LBA
register at linear 0x4F0, PACK_SIZE=2). Tick-by-tick log of every
change to that cell over 550k ticks:

```
tick      0: LBA = 0    (initial)
tick 454278: LBA = 23   (root directory — dataStart=37 on doom; 23 for zork)
tick 473536: LBA = 163  (CONFIG.SYS, cluster 128 → sector 163)
tick 508355: LBA = 153  (ANSI.SYS, cluster 118 → sector 153)
tick 510835: LBA = 1    (FAT sector 1)
tick 511652: LBA = 153  (ANSI.SYS sector 1 re-read)
```

LBA never takes values 154..162 (ANSI.SYS sectors 2..10). The rest
of the file is never asked for.

## The FAT cache in memory is also partial

- DOS's FAT cache sits at linear 0x8AC74 (found by searching for
  `F0 FF FF` signature).
- `secPerFat = 11` on doom's disk.
- Compared 11 * 512 bytes of the cache against disk sectors 1..11:
  - FAT sector 0 (at 0x8AC74): all 512 bytes match disk.
  - FAT sectors 1..10: 480..512/512 bytes differ from disk — mostly
    not loaded.

The FAT entries for clusters 118..127 (ANSI.SYS's chain) all live in
FAT sector 0 and are correct in memory: 118→119→120→...→127→0xFFF.

So the kernel *can* walk the chain to find subsequent clusters. But
still never issues INT 13h for them.

## On zork the same file loads fine

- Same ANSI.SYS bytes on disk.
- Zork's disk: totalSec=720, secPerFat=1, heads=2, spt=9.
- ANSI.SYS on zork is at cluster 118, first sector LBA=133.
- Zork boots through, runs, shows game text. No hang.

## The disk-geometry we set up is internally consistent

- BPB on doom: spt=36, heads=2, totalSec=5760, secPerFat=11.
- BIOS was patched at build time to match (geometry anchors DGSP/DGHD/DGCY
  in bios.bin).
- CHS-to-LBA math: for sector 153 on doom, CHS = (2,0,10); handler
  computes (2*2+0)*36 + (10-1) = 153. Correct.

## `tools/mkfat12.mjs` had a `NUM_FATS` bug (found and fixed, not the hang)

- Original code wrote FAT2 header (`F0 FF FF`) unconditionally, even
  when the BPB advertised NUM_FATS=1.
- We flipped NUM_FATS from 2 to 1 during investigation. That exposed
  the bug: zork started printing "Bad or missing command interpreter"
  because the `F0 FF FF` bytes clobbered the first 3 bytes of the
  root directory.
- Fixed by gating all FAT2 writes with a loop over NUM_FATS.
- Doom still hangs the same way with either NUM_FATS=1 or 2. Not
  the cause.

## The source code for this path is small — we read it all

- `bios/corduroy/handlers.asm` `.disk_read` (INT 13h AH=02h): pushes
  regs, computes LBA = (cyl*heads + head)*spt + (sector-1), then loops
  `AL` times: write LBA to linear 0x4F0, REP MOVSW 256 words from
  DS=0xD000:SI=0 to ES:DI, inc LBA, dec count. **Code reads correct
  for both AL=1 and AL>1.**
- `kiln/emit-css.mjs` disk-window emit: for each byte in 0xD0000..0xD01FF,
  emits `style(--at: 0xD0000+i): --readDiskByte(calc((lba_low + lba_high*256)*512 + i))`
  where `lba_low/lba_high` read from `--__1mc632` (PACK_SIZE=2).
  `--readDiskByte` has a `style(--idx: N): byte` branch for every
  nonzero disk byte. **Correct.**
- Calcite's `rep_fast_forward` in `calcite-core/src/compile.rs`: bails
  out with "src-virtual-range" when REP MOVSW's source overlaps
  0xD0000..0xD0200, letting per-tick CSS evaluation handle the REP.
  **Guard works.**
- Calcite's `read_mem` in `state.rs`: for a positive address in the
  packed range, reads the packed cell and extracts the byte. Does
  *not* dispatch to `--readDiskByte` — the dispatch happens at CSS
  level. This is only relevant for helpers that bypass CSS
  (bulk_copy, debugger reads), not for normal CPU execution.

## Memory-write paths in calcite (three of them)

1. **Broadcast-write slots** (6 slots per tick): normal CPU MOV
   instructions. Goes through `--applySlot` cascade → `--mc632` →
   latched at end of tick into `--__2mc632`. Next tick reads see new
   value. Writes update both `state_vars[sidx]` and flat `memory[]`,
   and push a synthetic write_log entry.
2. **`write_mem` / `write_byte_packed_aware`**: called by runtime
   helpers (REP fast-forward, BDA keyboard push). Updates `state_vars`
   directly AND flat memory.
3. **`bulk_copy_bytes`**: uses `write_byte_packed_aware` per byte.
   Same visibility as path 2.

For `mov [disk_lba], bx` during normal CPU execution, path 1 applies.
Path 2/3 are for runtime helpers. All three update state_vars[632]
for the packed cell.

## What the double-buffer system does (for completeness)

Per-cell chain (PACK_SIZE=2):
- `--__0mc632` — execute keyframe: `var(--mc632)`
- `--__2mc632` — store keyframe: `var(--__0mc632, init)`
- `--__1mc632` — read buffer: `var(--__2mc632, init)`
- `--mc632` — cascade of 6 `--applySlot` calls over `--__1mc632`

Writes in tick N update `--mc632` via the cascade; latch through
store+execute keyframes; are visible to reads of `--__1mc632` in
tick N+1. One tick of delay, consistent.

## What we DON'T know

- Whether DOS-side code on doom's disk ever *computes* "next sector
  = 154" and issues an INT 13h for it. The LBA-watch tells us it
  never writes 154 to the register; it doesn't tell us whether DOS's
  filesystem code tried and failed somewhere earlier, or never tried.
- Whether iteration 2+ of our handler's outer loop ever executes.
  For a single INT 13h call with AL=10 the loop should run 10 times;
  we have no direct observation of CX or BX during the loop on the
  ANSI.SYS read.
- What CX (DOS-requested sector count) was when ANSI.SYS sector 1
  was read — i.e. whether DOS asked for 1 sector or more. Could be
  inferred from register state at tick 508355 (the AL at INT 13h
  entry).

## Tools added during this session

Three flags on `calcite-cli` (already built, in
`../calcite/target/release/calcite-cli.exe`):

- `--dump-ticks=T1,T2,...` — dump state at multiple ticks in one
  run (no re-parse per sample).
- `--sample-cells=IDX1,IDX2,...` — compact per-tick output: just
  core regs + listed cells. Combine with `--dump-ticks`.
- `--watch-cell=IDX1,IDX2,...` — tick-by-tick monitor; prints a
  line only when any watched cell changes. `# tick mcIDX... | CS IP`.

Single-cell sampling across 550k ticks runs in ~1–2 minutes.

## What we tried and ruled out

- Disk-geometry patch: `dos-corduroy` now defaults to autofit. Both
  corduroy and muslin get their geometry patched. BPB matches.
  Doom builds; zork/montezuma still work. Not the cause.
- `NUM_FATS` double-write bug in mkfat12: real bug, found and fixed.
  Not the hang.
- Calcite's REP fast-forward on virtual range: correctly bails.
- Kiln's disk-window dispatch: correct PACK_SIZE=2 LBA extraction.

## State at compaction

- Repo state: NUM_FATS fix committed? **Not yet — uncommitted as of
  this note.** The disk-geometry work is committed.
- Doom still hangs.
- Next promising thread (as of end-of-session): verify empirically
  whether DOS's filesystem code ever computes "next sector" for
  ANSI.SYS on doom's disk, and whether our handler's outer loop
  executes more than once per INT 13h call.
