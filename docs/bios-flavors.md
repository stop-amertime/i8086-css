# BIOS flavors

Three BIOSes exist side-by-side. They're not competing implementations
— each targets a different level of faithfulness to a real IBM-PC BIOS.

| Flavor | Role | Language | When to pick |
|---|---|---|---|
| **Gossamer** | Hack-path shim | 16-bit asm | Running a `.COM` raw, no DOS |
| **Muslin**   | Assembly DOS BIOS | 16-bit asm | Fallback if Corduroy misbehaves |
| **Corduroy** | Structured DOS BIOS | C + asm glue | **Default for DOS carts** |

Short version for each:

- **Gossamer** — doesn't pretend to be a PC, just implements the
  handful of INT handlers a `.COM` typically calls. Ships pre-built.
- **Muslin** — real IVT + BDA init, real `INT 13h`/`16h`/`10h`/`1Ah`
  implementations. Boots EDR-DOS. Hand-written asm. Stubbed INT 09h,
  no EOI on INT 08h — games that rely on BIOS keyboard IRQ don't work
  under Muslin.
- **Corduroy** — same contract as Muslin plus a Mode 13h splash and a
  real INT 09h handler (port 0x60 read, scancode → BDA ring buffer,
  EOI). Rewritten modularly in C so future work (PIT, PIC, real IRQs)
  lands without touching monolithic assembly. The current default.

Both DOS BIOSes boot EDR-DOS but neither can run COMMAND.COM usefully,
so carts must set `boot.autorun`. This is why the builder auto-detects
a single `.com`/`.exe` in the cart and runs it directly.

## Why fabric names

The progression is faithfulness, not language — Gossamer → Muslin →
Corduroy maps to "shim → real BIOS → structured BIOS". Calling them
by version numbers or language tags obscured what was actually
different.

## Each BIOS in depth

Each BIOS has its own README with the handler list, build steps, and
known gaps:

- [`bios/gossamer/README.md`](../bios/gossamer/README.md)
- [`bios/muslin/README.md`](../bios/muslin/README.md)
- [`bios/corduroy/README.md`](../bios/corduroy/README.md)

## Picking one in a cart

```json
{ "preset": "dos-corduroy" }   // default for DOS carts
{ "preset": "dos-muslin" }     // assembly-BIOS fallback
{ "preset": "hack" }           // forces gossamer
```

Or override the preset's default:

```json
{ "preset": "dos-corduroy", "bios": "muslin" }
```

The only invalid combination the builder rejects is `preset: "hack"`
with `bios: "muslin"|"corduroy"` — the hack path boots without DOS and
expects Gossamer's handler layout.
