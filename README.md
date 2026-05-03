# CSS-DOS

**CSS-DOS** is a platform for running DOS programs as pure CSS — an Intel
8086 PC implemented entirely in CSS custom properties and `calc()`. The
CSS runs in Chrome. No JavaScript, no WebAssembly — just a stylesheet
executing machine code.

[Calcite](https://github.com/stop-amertime/calcite) is the sibling JIT
compiler that makes cabinets fast enough to actually use.

## The 30-second version

A **cart** (folder or zip) contains a DOS program. The **builder** takes
a cart, picks a **BIOS**, assembles a **floppy**, feeds it to **Kiln**
(the transpiler), and produces a **cabinet** — a self-contained `.css`
file. You play a cabinet in Chrome via the **player**, or fast via
Calcite.

```
$ node builder/build.mjs carts/rogue -o rogue.css
$ node web/scripts/dev.mjs                 # serves on :5173
$ open http://localhost:5173/build.html    # build/load the cabinet, then play
```

Or run it fast through Calcite:

```
$ ../calcite/target/release/calcite-cli -i rogue.css
```

## Vocabulary

| Word | Meaning |
|---|---|
| **cart** | Input folder or zip: a program, any data files, optional `program.json`. |
| **floppy** | FAT12 disk image the builder assembles from a cart. Internal. |
| **cabinet** | The built artifact — a single `.css` file, runnable. |
| **Kiln** | The transpiler. Turns an 8086 memory image into CSS. |
| **builder** | Orchestrator. Wires up BIOS → floppy → Kiln. |
| **BIOSes** | Three flavors: **Gossamer** (hack-path shim), **Muslin** (assembly DOS BIOS), **Corduroy** (structured C DOS BIOS, default). |
| **player** | Static HTML at `web/player/calcite.html`; loads `/cabinet.css` (served from the SW cache via `build.html`). |
| **Calcite** | Sibling repo: the JIT that runs cabinets fast. |

## Start here

- New to the project? → [`docs/architecture.md`](docs/architecture.md)
- Making a cart? → [`docs/cart-format.md`](docs/cart-format.md) + [`docs/building.md`](docs/building.md)
- Hacking on the codebase? → [`CLAUDE.md`](CLAUDE.md) + [`docs/INDEX.md`](docs/INDEX.md)

## Repo layout

```
builder/         Orchestrator CLI and stages
kiln/            The transpiler (née transpiler/src)
bios/
  gossamer/      Hack BIOS
  muslin/        Assembly DOS BIOS
  corduroy/      Structured C DOS BIOS (default)
web/             Front-end: player (calcite.html, raw.html, bench.html), shim, dev server, prebake bins
                 Build/load page: web/site/build.html. Service worker: web/site/sw.js
conformance/     Reference emulators for diff testing
carts/           Example carts
dos/             DOS kernel + COMMAND.COM
tools/           Build utilities (mkfat12, image converters, js8086)
tests/           Conformance test programs
docs/            Full documentation
legacy/          Archived earlier approaches
```

## Status

See [`docs/logbook/STATUS.md`](docs/logbook/STATUS.md) for the live
project status. Current default cabinet path boots DOS + the cart's
program end-to-end. Rom-disk mechanism exposes disks outside 8086
memory, so cabinet size is no longer bounded by a floppy size.

## Credits

- [rebane2001](https://github.com/rebane2001) — the original
  [x86css](https://github.com/rebane2001/x86css).
- Jane Ori — the [CPU Hack](https://dev.to/janeori/expert-css-the-cpu-hack-4ddj).
- [emu8](https://github.com/nicknisi/emu8) — the reference 8086 emulator.

## License

GNU GPLv3.
