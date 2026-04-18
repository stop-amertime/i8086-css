# legacy

Archived code kept for historical reference. Nothing in here is used by
the current toolchain. Contents are not guaranteed to build.

## Contents

| Path | Archived | Superseded by | Notes |
|---|---|---|---|
| `v3/` | 2026-04-14 | V4 single-cycle architecture (current Kiln) | The μOp microcode rewrite that didn't boot DOS. Kept because it contains real lessons about multi-cycle instruction design in CSS. |
| `ref-emu-dos.mjs` | 2026-04-18 | `conformance/ref-muslin.mjs` | JS reference emulator for the microcode-BIOS DOS path; replaced when V4 went back to an assembly BIOS. |

## What used to live here

Several earlier experiments were deleted during the big rename:

- `build_c.py` / `build_css.py` — the v1 Python transpiler (parallel dispatch tables; too fragile).
- `base_template.css` / `base_template.html` — the v1 CSS skeleton.
- `x86-instructions-rebane.json` — the v1 hand-rolled opcode database.
- `extra/` — the v1 JSON-database generator toolchain.
- `web/` — a TypeScript port of the v1 transpiler.
- `gossamer-dos.asm`/`.bin`/`.lst` — superseded by `bios/muslin/muslin.asm`.

Git history preserves all of them under commit 8c40b86 and earlier.
