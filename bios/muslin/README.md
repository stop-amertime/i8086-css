# Muslin BIOS

The **current real BIOS**. Hand-written 16-bit assembly that implements
enough of the IBM-PC BIOS contract to boot DOS (EDR-DOS / SvarDOS) and
run a fair chunk of real DOS software.

## When to pick it

Default for DOS carts. Set `"preset": "dos-muslin"` (the default) or
`"bios": "muslin"`.

## What it implements

- Full IVT + BDA initialization that drbio expects.
- `INT 10h` — text-mode teletype, cursor, Mode 13h set/clear, AH=1Ah
  display combination code.
- `INT 13h` — floppy read via the rom-disk window at `D000:0000`. Rejects
  hard-disk calls (DL ≥ 0x80) with CF=1.
- `INT 16h` — proper BDA ring buffer (head/tail at BDA 0x1A/0x1C).
- `INT 1Ah` — auto-incrementing tick counter (workaround for no PIT yet).
- `INT 08h`, `INT 09h`, `INT 11h`, `INT 12h`, `INT 15h`, `INT 19h` —
  stubs enough to satisfy the kernel's probes.

## Known gaps

- No PIT timer (tracked — needs `--cycleCount`-driven countdown).
- No PIC-driven hardware IRQs beyond the one-shot keyboard path.
- `INT 13h` is read-only (schema supports `disk.writable`, implementation
  doesn't yet).

See the logbook for current status.

## Build

Muslin is NASM-only, no linker needed:

```
nasm -f bin -o muslin.bin muslin.asm -l muslin.lst
```

The builder does this automatically; `muslin.bin` and `muslin.lst` are
gitignored.
