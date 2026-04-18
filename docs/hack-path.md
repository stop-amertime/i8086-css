# The hack path

The hack path is the "raw `.COM` at `0x100`, no DOS" mode. It exists
for:

- Conformance testing individual instruction patterns.
- Tiny demos that don't need a full DOS environment.
- Investigation / debugging where booting the kernel would drown out
  the signal you care about.

Use it by setting `"preset": "hack"` in `program.json`.

## What a hack cart looks like

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

The `.COM` loads at `0000:0100`. Execution starts there. The IVT is
pre-seeded with Gossamer's handler vectors for `INT 10h`, `INT 16h`,
`INT 1Ah`, `INT 20h`, `INT 21h`. The BIOS lives at `F000:0000` as
always.

## What a hack cart *can't* do

- **No disk.** `INT 13h` isn't wired up. The schema rejects a `disk`
  field on hack carts.
- **No kernel.** `INT 21h` only implements the essentials (put-char,
  get-char, exit). Don't assume anything more sophisticated works.
- **No Mode 13h.** Today the gfx memory zone isn't included on hack
  carts. The `memory.gfx` field is accepted but not wired through.

## "Just ram the disk into RAM"

The documented hacky workaround if you really want a disk in a hack
cart (or a very small disk on a DOS cart): set `disk.mode:
"embedded"`. This bakes disk bytes into 8086 memory as a flat zone.

Works for tiny disks. Doesn't work for anything real because the
bytes live inside conventional RAM and fight the kernel for space.
The proper path is `disk.mode: "rom"` (the default), which puts disk
bytes outside the 8086 address space entirely. See
[`memory-layout.md`](memory-layout.md) for the rom-disk mechanism.

## Example: conformance test cart

Most `tests/*.asm` programs are hack carts in spirit. They're not
wrapped as carts today (`tests/` sits outside the big rename), but
they demonstrate the shape: one small `.COM`, no DOS, run against
Gossamer.
