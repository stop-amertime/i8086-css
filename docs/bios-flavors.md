# BIOS flavors

Three BIOSes exist side-by-side. They're not competing implementations
— each targets a different level of faithfulness to a real IBM-PC BIOS.

| Flavor | Role | Language | Status | When to pick |
|---|---|---|---|---|
| **Gossamer** | Hack-path shim | 16-bit asm | Stable, minimal | Running a `.COM` raw, no DOS |
| **Muslin**   | Current real BIOS | 16-bit asm | Boot-proven | Default for DOS carts |
| **Corduroy** | Structured successor | C + asm glue | Experimental | Hacking on the BIOS, want the splash |

Short version for each:

- **Gossamer** — doesn't pretend to be a PC, just implements the
  handful of INT handlers a `.COM` typically calls. Ships pre-built.
- **Muslin** — real IVT + BDA init, real `INT 13h`/`16h`/`10h`/`1Ah`
  implementations. Boots EDR-DOS. Hand-written asm. This is the default.
- **Corduroy** — same contract as Muslin plus a Mode 13h splash,
  rewritten modularly in C so future work (PIT, PIC, real IRQs) can
  land without touching monolithic assembly.

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
{ "preset": "dos-muslin" }     // most common
{ "preset": "dos-corduroy" }   // experimental
{ "preset": "hack" }           // forces gossamer
```

Or override the preset's default:

```json
{ "preset": "dos-muslin", "bios": "corduroy" }
```

The only invalid combination the builder rejects is `preset: "hack"`
with `bios: "muslin"|"corduroy"` — the hack path boots without DOS and
expects Gossamer's handler layout.
