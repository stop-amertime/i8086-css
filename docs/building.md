# Building a cabinet

Walkthrough: cart → cabinet, end to end.

## The 30-second version

```
$ ls mycart/
GAME.EXE

$ node builder/build.mjs mycart -o mycart.css
[cart]   resolving mycart
[cart]   "mycart" (1 file)
[cart]   preset: dos-muslin, bios: muslin
[bios]   building muslin...
[bios]   1520 bytes (bios/muslin/muslin.asm)
[floppy] assembling FAT12 image...
[floppy] 1474560 bytes, 3 files
[kiln]   emitting CSS to mycart.css...
[done]   mycart.css (227.3 MB)

$ open player/index.html?cabinet=../mycart.css
```

No `program.json`, no flags. Defaults: Muslin BIOS, 640K, 1.44 MB
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
- Collects `KERNEL.SYS`, the synthesized `CONFIG.SYS`, each cart
  file, and optionally `COMMAND.COM` (if `autorun` is `null`).
- Shells out to `tools/mkfat12.mjs` to lay out the FAT12 image.
- Returns `{ bytes, layout }`.

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

- **Chrome via the player:** open `player/index.html?cabinet=path/to/cabinet.css`.
  Pure CSS. Slow. The source-of-truth run.
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
