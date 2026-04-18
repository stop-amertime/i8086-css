# builder

The CSS-DOS **builder** turns a cart (folder or zip) into a cabinet (`.css`
file). It's a thin orchestrator — the real work happens in `stages/`, which
it wires together in sequence.

```
cart → resolveCart → resolveManifest → buildBios → buildFloppy → runKiln → cabinet
```

## Usage

```
node builder/build.mjs <cart> [-o output.css]
```

See `docs/cart-format.md` for the cart schema and `docs/building.md` for a
walkthrough.

## Layout

```
builder/
  build.mjs            — orchestrator CLI
  stages/
    bios.mjs           — stage 1: build BIOS bytes (Gossamer/Muslin/Corduroy)
    floppy.mjs         — stage 2: build FAT12 image (DOS carts only)
    kiln.mjs           — stage 3: invoke Kiln to emit CSS
  presets/
    dos-muslin.json    — default DOS preset
    dos-corduroy.json  — experimental C-BIOS variant
    hack.json          — raw-.COM preset
  lib/
    cart.mjs           — cart resolution (folder/zip → canonical shape)
    config.mjs         — manifest + preset merge + validation
    sizes.mjs          — size preset parsing ("640K", "1440K", "autofit")
```
