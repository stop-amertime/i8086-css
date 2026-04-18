# Conformance

JS reference emulators used to diff calcite's output against a known-good
run of the same cart. Each reference emulator mirrors one BIOS flavor.

| File | BIOS flavor | Used for |
|---|---|---|
| `ref-hack.mjs`    | Gossamer | .COM programs via the hack path. No DOS. |
| `ref-muslin.mjs`  | Muslin   | Full DOS boot with the current Muslin BIOS. |
| `ref-corduroy.mjs`| Corduroy | (Future — will land when Corduroy stabilizes.) |

All three share the same JS 8086 core (`tools/js8086.js`) and the
peripheral/BIOS-handler shims in `tools/lib/`.

## Running

Each ref emulator is a standalone node script. See the file header for
flags. In general:

```
node conformance/ref-muslin.mjs <cabinet-or-cart> [--ticks N] [--trace]
```

## Relationship to calcite's diff tools

Calcite's `tools/` directory has a separate, ad-hoc collection of
divergence-finding utilities (`fulldiff.mjs`, `diagnose.mjs`,
`boot-trace.mjs`, `codebug.mjs`, `compare.mjs`). Those consume traces
produced by the ref emulators here. The long-term plan is to collapse
them into `calcite-debugger` subcommands; for now they stay as-is.
