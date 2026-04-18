# Gossamer BIOS

The **hack-path BIOS**: the minimum possible shim that lets a single DOS
`.COM` program think it's running on a PC. No DOS, no full IVT, no
disk, no faithful IBM-PC contract — just enough INT handlers to make a
toy demo or test program run.

## When to pick it

Set `"preset": "hack"` or `"bios": "gossamer"` in `program.json`. Used
by:

- Conformance testing for raw `.COM` programs (`conformance/ref-hack.mjs`).
- Tiny demos that don't want the weight of a real DOS boot.

See `docs/hack-path.md` for the end-to-end story.

## What it implements

Stubs for the handful of INTs a `.COM` typically calls:

- `INT 10h` — video services (a subset).
- `INT 16h` — keyboard (polling via a fixed memory location).
- `INT 1Ah` — timer.
- `INT 20h` — program terminate.
- `INT 21h` — DOS services (the essentials: put-char, get-char, exit).

## What it does **not** implement

- Full IBM-PC BIOS contract (no real BDA init, no proper IVT layout).
- `INT 13h` disk services.
- A boot-to-DOS init sequence.

## Build

Pre-built. `gossamer.bin` is checked in. To rebuild:

```
nasm -f bin -o gossamer.bin gossamer.asm -l gossamer.lst
```
