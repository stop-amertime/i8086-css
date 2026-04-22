# Cart format reference

A **cart** is the input to the CSS-DOS builder. It's either a folder or a zip
file containing a DOS program (plus optional data files and an optional
`program.json` manifest). The builder reads the cart and produces a
**cabinet** — a single `.css` file that, opened in Chrome or run through
Calcite, behaves like a tiny PC with the cart's program already booted.

This document is the canonical reference for what goes in a cart.

- Schema file: [`program.schema.json`](../program.schema.json) at repo root.
- Minimum viable cart: a single `.COM` file, or a folder with one `.COM`
  file and no `program.json`.
- The builder will infer defaults for everything unstated.

## The 30-second path

```
$ ls mycart/
BOOTLE.COM
$ node builder/build.mjs mycart/
Generated mycart.css (227.3 MB)
```

That's it. No `program.json` needed. You dropped one program, so the builder
autoruns it. You didn't specify a BIOS, so the builder picked the Corduroy
BIOS (the current default). You didn't specify memory, so the builder gave
you 640K.

If you need to change any of that, add a `program.json`.

### Even shorter: a bare `.com` is a cart

You don't need a folder at all. A single `.com` (or `.exe`) file path
is a complete cart on its own. The builder wraps it in a synthetic
one-file cart directory behind the scenes, applies the default preset
(`dos-corduroy`), and autoruns the program.

```
$ node builder/build.mjs ../calcite/programs/fire/fire.com -o fire.css
Generated fire.css
```

Useful for trying a random .COM without committing to a folder/manifest.
If you need any non-default — a different BIOS, extra data files on the
floppy, a specific memory size — you'll have to promote it to a folder
cart with a `program.json`. See [`builder/lib/cart.mjs`](../builder/lib/cart.mjs)
`wrapBareProgram` for the implementation.

## Cart structure

A cart is a flat folder (or a zip with contents at root). Files are
referenced by name, relative to the cart root. Escaping via `..` is
rejected.

```
mycart/
  program.json          (optional — everything defaults)
  BOOTLE.COM            (the program to run)
  README.TXT            (data file, goes on the floppy)
```

Zip carts look the same once unzipped:

```
mycart.zip
  ├─ program.json
  ├─ BOOTLE.COM
  └─ README.TXT
```

### Inferred defaults

When `program.json` is missing or sparse, the builder fills in:

| Field | Default |
|---|---|
| `preset` | `dos-corduroy` |
| `bios` | derived from preset (`corduroy`) |
| `memory.conventional` | `640K` for DOS carts; `autofit` for hack carts |
| `memory.gfx` | `true` |
| `memory.textVga` | `true` |
| `disk.mode` | `rom` |
| `disk.size` | `1440K` |
| `disk.writable` | `true` |
| `disk.files` | every non-`program.json` file in the cart folder |
| `boot.autorun` | the single `.COM`/`.EXE` in the cart, or `null` (drop to prompt) if there are multiple |

## The manifest

```json
{
  "$schema": "../program.schema.json",

  "name": "Bootle",
  "version": "1.0.0",
  "author": "",
  "description": "Tiny heart-drawing demo",

  "preset": "dos-muslin",
  "bios": "muslin",

  "memory": {
    "conventional": "640K",
    "gfx": true,
    "textVga": true
  },

  "disk": {
    "mode": "rom",
    "size": "1440K",
    "writable": true,
    "files": [
      { "name": "BOOTLE.COM", "source": "bootle.com" }
    ]
  },

  "boot": {
    "autorun": "BOOTLE.COM",
    "args": ""
  }
}
```

Every field is optional. A `program.json` that is just `{}` is valid and
equivalent to no `program.json` at all.

## Field reference

Each field is tagged with its **implementation state**:

- **implemented** — works today.
- **partial** — works in some configurations; the builder warns or errors
  clearly on unsupported combinations.
- **aspirational** — schema accepts it; the builder validates the shape
  but may error at build time until the feature lands.

### `name` · implemented

Human-readable cart title. Defaults to the cart folder (or zip) basename.
Used only in the cabinet's header comment.

### `version` · implemented

Semver string. Optional. Validated against `\d+\.\d+\.\d+` if present.

### `author` · implemented

Cart author. Unused by the builder. Preserved in the cabinet header.

### `description` · implemented

One-line cart description. Unused by the builder. Preserved in the cabinet
header.

### `preset` · implemented

One of `dos-corduroy` (default), `dos-muslin`, or `hack`. A preset is a
partial manifest checked into `builder/presets/` that the cart's own
fields override selectively. Presets exist so the common case is a
one-line manifest or no manifest at all.

### `bios` · implemented

Which BIOS to boot. One of:

| Value | Which BIOS | Source |
|---|---|---|
| `gossamer` | The hack-path shim BIOS — minimal handlers for running a lone `.COM`. | `bios/gossamer/` |
| `muslin` | The current real BIOS — faithfully implements the IBM PC BIOS contract well enough to boot DOS. | `bios/muslin/` |
| `corduroy` | The structured C BIOS — same contract as Muslin, built modularly in C. Experimental. | `bios/corduroy/` |

See [`docs/bios-flavors.md`](bios-flavors.md) for details on each.

Combining `bios` with `preset`: the preset's BIOS is used unless the cart
overrides it. The only invalid combination the builder rejects is
`preset: "hack"` + `bios: "muslin"|"corduroy"` — the hack path boots
without DOS and expects Gossamer's handler layout.

### `memory.conventional` · partial

Size of conventional RAM, in bytes.

- Integer → exact bytes (minimum 1024).
- String → preset (`"4K"`, `"64K"`, `"128K"`, `"256K"`, `"512K"`, `"640K"`)
  or `"autofit"`.
- `"autofit"` means "smallest safe size for the program". On hack carts
  it sizes just big enough for the `.COM` plus stack headroom. On DOS
  carts it resolves to `DOS_TPA_BASE + programSize + stack + kernel high
  area` aligned up to 16 KB, clamped to [128 KB, 640 KB] — typically
  272–480 KB for small programs, `"640K"` for anything large.
- Note: the Corduroy BIOS places its init stack in a 64 KB window ending
  just below this value (see `patchBiosStackSeg` in `kiln.mjs`), so the
  minimum usable size is 128 KB.

### `memory.gfx` · implemented (DOS) · aspirational (hack)

Include the VGA Mode 13h framebuffer at linear `0xA0000–0xAFA00` (64 KB).
Default `true`. Set to `false` to shrink the cabinet if the program never
enters Mode 13h.

On hack carts the field is accepted but not wired through today. Follow-up.

### `memory.textVga` · implemented (DOS) · aspirational (hack)

Include the VGA text buffer at `0xB8000–0xB8FA0` (4000 bytes). Default
`true`.

On hack carts the field is accepted; hack carts always get the text
buffer today, regardless of the value. Follow-up.

### `disk` · implemented

DOS carts have a `disk` object. Hack carts must set `disk: null` or omit
it entirely.

#### `disk.mode` · implemented

- `"rom"` (default) — disk bytes live outside 8086 memory, exposed through
  a 512-byte window at `0xD0000` dispatched by `--readDiskByte`. This is
  the path for everything except very small experiments.
- `"embedded"` — disk bytes baked into 8086 memory as a flat zone. Only
  works for tiny disks (must fit inside conventional memory without
  colliding with the kernel). See [`docs/hack-path.md`](hack-path.md) for
  details and why you'd almost never want this.

#### `disk.size` · aspirational

Floppy size.

- Integer → exact bytes.
- String → `"360K"` (5.25" DD), `"720K"` (3.5" DD), `"1200K"` (5.25" HD),
  `"1440K"` (3.5" HD, default), `"2880K"` (3.5" ED), or `"autofit"`.
- `"autofit"` rounds up to the smallest preset that fits the cart's files.

**Not yet implemented:** today the floppy size is hard-coded in
`tools/mkfat12.mjs`. The schema accepts the field; the builder plumbing
is a follow-up.

#### `disk.writable` · aspirational

When `true`, INT 13h accepts writes. Writes go to a RAM shadow; nothing
persists across cabinet reloads. Default `true`.

**Not yet implemented:** today INT 13h is read-only in all three BIOSes.
The schema accepts the field; the write path is a follow-up.

#### `disk.files` · implemented

Explicit disk contents. Each entry is `{ name, source }`:

- `name` — the 8.3 filename as it appears on the floppy (uppercased).
- `source` — path relative to the cart root.

If omitted, the builder auto-discovers: every file in the cart folder
except `program.json` is added, uppercased.

`KERNEL.SYS` and `CONFIG.SYS` are always added by the builder (sourced
from `dos/bin/` and synthesized from `boot.autorun`, respectively).
`COMMAND.COM` is added when `boot.autorun` is `null`. You don't list
these yourself.

### `boot.autorun` · implemented

DOS carts only. Either a filename on the floppy or `null`.

- Filename → `CONFIG.SYS` gets `SHELL=\<FILENAME> <args>`. The program
  runs on boot.
- `null` → `CONFIG.SYS` gets `SHELL=\COMMAND.COM`. The cabinet drops to
  the DOS prompt.

Default: filename if the cart has exactly one `.COM`/`.EXE`; `null`
otherwise.

### `boot.args` · implemented

DOS carts only. String appended to the `SHELL=` line. Example: `"ZORK1.Z3"`
for a cart with `FROTZ.EXE` becomes `SHELL=\FROTZ.EXE ZORK1.Z3`.

### `boot.raw` · implemented

Hack carts only. Filename of the `.COM` to load raw at `0x100`. Mutually
exclusive with `boot.autorun`. Required on hack carts.

### `display.vsyncMode` · aspirational

Which paint cadence the player should use when running this cart. One of:

- `"sim"` (default) — paint on the simulated 70 Hz vertical-retrace edge
  derived from the CPU cycle counter. This is the same clock the guest
  program sees when it polls port `0x3DA`, so tearing behaves like real
  hardware: a program that waits for retrace gets tear-free frames, a
  program that doesn't tears.
- `"wall"` — paint on wall-clock 70 Hz regardless of how fast the CPU is
  running. Smooth to the viewer but decoupled from the emulated beam.
- `"turbo"` — paint every eval batch, no throttling. For debugging.

The CPU-side decode of port `0x3DA` is always live (independent of this
field); the field only affects how often the canvas is repainted.

**Not yet plumbed.** Today the mode is picked by `?vsync=...` on the
player URL or the status-bar dropdown; this field records the cart's
preferred default so future builder/player wiring can pick it up.

## Presets in full

### `dos-corduroy` (default)

```json
{
  "bios": "corduroy",
  "memory":  { "conventional": "640K", "gfx": true, "textVga": true },
  "disk":    { "mode": "rom", "size": "1440K", "writable": true },
  "boot":    { "args": "" }
}
```

### `dos-muslin`

As `dos-corduroy`, but `bios: "muslin"`.

### `hack`

```json
{
  "bios":   "gossamer",
  "memory": { "conventional": "autofit", "gfx": false, "textVga": true },
  "disk":   null,
  "boot":   {}
}
```

## Examples

### Zero-config cart

```
bootle/
  BOOTLE.COM
```

No `program.json`. The builder infers everything. Equivalent to writing:

```json
{
  "preset": "dos-muslin",
  "disk":   { "files": [{ "name": "BOOTLE.COM", "source": "BOOTLE.COM" }] },
  "boot":   { "autorun": "BOOTLE.COM" }
}
```

### Cart with a data file

```
zork/
  program.json
  FROTZ.EXE
  ZORK1.Z3
```

```json
{
  "preset": "dos-muslin",
  "boot":   { "autorun": "FROTZ.EXE", "args": "ZORK1.Z3" }
}
```

### Multi-program cart (drop to prompt)

```
shareware-pack/
  program.json
  GAME1.COM
  GAME2.COM
  GAME3.COM
```

```json
{
  "preset": "dos-muslin"
}
```

With multiple programs and no `boot.autorun`, the builder sets
`boot.autorun: null` and adds `COMMAND.COM` to the floppy.

### Small hack cart

```
hello/
  program.json
  HELLO.COM
```

```json
{
  "preset": "hack",
  "boot":   { "raw": "HELLO.COM" }
}
```

### Explicit, over-specified cart

```json
{
  "$schema": "https://css-dos.dev/program.schema.json",

  "name":        "Bootle",
  "version":     "1.0.0",
  "author":      "Example",
  "description": "Heart-drawing demo",

  "preset": "dos-muslin",
  "bios":   "muslin",

  "memory": {
    "conventional": "640K",
    "gfx":          true,
    "textVga":      true
  },

  "disk": {
    "mode":     "rom",
    "size":     "360K",
    "writable": true,
    "files": [
      { "name": "BOOTLE.COM", "source": "BOOTLE.COM" }
    ]
  },

  "boot": {
    "autorun": "BOOTLE.COM",
    "args":    ""
  }
}
```

## Validation

The builder rejects on first validation error after printing every error
it finds. Specifically rejects:

- Unknown top-level or nested fields.
- `source` paths that escape the cart root.
- `preset: "hack"` combined with `bios: "muslin"|"corduroy"`.
- `preset: "hack"` with a non-null `disk`.
- `boot.raw` and `boot.autorun` both set.
- `boot.raw` on a non-hack preset.
- `version` not matching semver.
- Aspirational fields with specific unsupported values (with a message
  pointing at the follow-up issue).

## The cabinet header

Every built cabinet's `.css` file starts with a comment block:

```
/* CSS-DOS cabinet
 *
 * Built from: bootle/
 * Built at:   2026-04-18T15:47:00Z
 *
 * Resolved manifest:
 *   { "preset": "dos-muslin", "bios": "muslin", ... }
 *
 * Disk layout:
 *   KERNEL.SYS   102400 bytes  (dos/bin/kernel.sys)
 *   CONFIG.SYS       17 bytes  (synthesized: SHELL=\BOOTLE.COM)
 *   BOOTLE.COM     2048 bytes  (bootle/BOOTLE.COM)
 *
 * BIOS: Muslin BIOS, 1520 bytes
 * Memory zones: 0x00000–0xA0000 (640K), 0xA0000–0xAFA00 (gfx),
 *               0xB8000–0xB8FA0 (text)
 * Kiln:    <git sha>
 * Builder: <git sha>
 */
```

The header is always the resolved manifest after defaults are filled in,
not the original `program.json`. This means a zero-config cart still
produces a cabinet you can diagnose from its header alone.
