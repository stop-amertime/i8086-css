# Building a cabinet

Walkthrough: cart → cabinet, end to end.

## The 30-second version

```
$ ls mycart/
GAME.EXE

$ node builder/build.mjs mycart -o mycart.css
[cart]   resolving mycart
[cart]   "mycart" (1 file)
[cart]   preset: dos-corduroy, bios: corduroy
[bios]   building corduroy...
[bios]   4096 bytes (bios/corduroy/)
[floppy] assembling FAT12 image...
[floppy] 1474560 bytes, 3 files
[kiln]   emitting CSS to mycart.css...
[done]   mycart.css (227.3 MB)

$ node web/scripts/dev.mjs                 # serves on :5173
$ open http://localhost:5173/build.html    # load mycart.css, then play
```

No `program.json`, no flags. Defaults: Corduroy BIOS, 640K, 1.44 MB
floppy, autorun the single `.EXE`.

## The five stages

The builder (`builder/build.mjs`) orchestrates five stages. Each
lives in its own file so the pipeline is readable end-to-end:

### 1. `resolveCart` → `builder/lib/cart.mjs`

Takes a path (folder or `.zip`). If a zip, unzips to a temp dir
transparently. Parses `program.json` if present (otherwise `{}`).
Discovers files in the cart folder (flat; subfolders ignored).
Returns `{ root, name, files, manifest }`.

### 2. `resolveManifest` → `builder/lib/config.mjs`

Merges the named preset (`dos-muslin` / `dos-corduroy` / `hack`)
under the cart's own fields. Fills in defaults:

- Disk contents: every non-`program.json` file in the cart.
- Autorun: the single `.COM`/`.EXE`, or `null` (drop to prompt) if
  there are multiple.

Validates. Rejects on first error, listing every error it found.

### 3. `buildBios` → `builder/stages/bios.mjs`

Dispatches on `manifest.bios`:

- **gossamer** — reads the pre-built `bios/gossamer/gossamer.bin`.
- **muslin** — invokes NASM on `bios/muslin/muslin.asm`, parses the
  listing for `bios_init`'s offset.
- **corduroy** — invokes `bios/corduroy/build.mjs`, which runs
  NASM + Watcom (`wcc`) + `wlink` to produce `bios.bin`.

Returns `{ bytes, entrySegment, entryOffset, meta }`.

### 4. `buildFloppy` → `builder/stages/floppy.mjs`

DOS carts only (skipped for hack).

- Synthesizes `CONFIG.SYS` from `boot.autorun` + `boot.args`.
- Collects `KERNEL.SYS`, `ANSI.SYS`, `COMMAND.COM`, the synthesized
  `CONFIG.SYS`, and each cart file. COMMAND.COM is always included so
  autorun programs can shell out / EXIT back to a prompt and so
  `boot.autorun: "COMMAND.COM"` works as a way to drop to DOS.
- Shells out to `tools/mkfat12.mjs` to lay out the FAT12 image.
- Returns `{ bytes, layout }`.

**FAT12 cluster cap.** `mkfat12` picks `sectorsPerCluster` based on
total disk size so data clusters stay ≤ 4084 — above 4085, DOS
auto-detects FAT16 and misreads our 12-bit FAT entries. SPC doubles
from 1 until the constraint holds (hard cap 128). 1.44 MB and smaller
disks get SPC=1; 2.88 MB disks get SPC=2. See
`docs/debugging/known-bugs.md` for the hang symptoms (CS:IP=0x105:0x1730
stuck loading ANSI.SYS) if SPC is wrong.

### 5. `runKiln` → `builder/stages/kiln.mjs`

Resolves memory zones. Invokes `emitCSS()` from `kiln/emit-css.mjs`
with:

- The kernel bytes to pre-load (DOS) or the `.COM` bytes (hack).
- The BIOS bytes.
- The floppy bytes (DOS, routed through `--readDiskByte`).
- Memory zones.
- Entry `(CS, IP, SP)`.
- The cabinet header comment.

Kiln streams CSS to the output.

## Cabinet output

Every cabinet starts with a header comment describing exactly what
went into it — the resolved manifest, the disk layout, the BIOS
source, the build time. See the [cart format](cart-format.md#the-cabinet-header)
for the exact shape.

## Running a cabinet

Three options:

- **Chrome via the player:** start the dev server
  (`node web/scripts/dev.mjs`), open `http://localhost:5173/build.html`,
  load your cabinet (it goes into the SW cache as `/cabinet.css`),
  then click through to `calcite.html`. Pure CSS. Slow. The
  source-of-truth run.
- **Calcite CLI:** `calcite-cli -i cabinet.css` in the sibling repo.
  Fast. See `../calcite/CLAUDE.md` for flags.
- **Calcite web:** the calcite-wasm page can load cabinets and run
  them in a Web Worker.

## Toolchain requirements

- **Node.js** — the builder, Kiln, mkfat12, ref emulators.
- **NASM** — for the Muslin and Corduroy BIOSes. Override the path
  via `NASM=` env var.
- **OpenWatcom** — for the Corduroy BIOS only. See
  `bios/corduroy/toolchain.env`.

Gossamer ships pre-built, so a hack-cart build needs only Node.

## Where intermediate artifacts go

By default the builder writes intermediates to
`<tmpdir>/cssdos-build-<pid>/`. Override with `--cache-dir`.

Intermediates:

- The generated `CONFIG.SYS`.
- The FAT12 image (`disk.img`).
- The BIOS `.bin` / `.lst` (if rebuilt).

The output cabinet goes to `-o <path>` (default: `<cartname>.css` in
the current directory).
