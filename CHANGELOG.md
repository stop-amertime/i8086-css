# CSS-DOS changelog

## 2026-04-18 — The big rename

Repo restructured for clarity and release readiness. Every top-level path
changed. This was a pre-release tidy: no deprecation shims, no
transitional state. See [`docs/architecture.md`](docs/architecture.md)
for the new vocabulary.

### New vocabulary

- **cart** — input folder or zip containing a program and (optional) `program.json`.
- **floppy** — FAT12 disk image the builder assembles internally.
- **cabinet** — built `.css` artifact.
- **Kiln** — the CSS transpiler.
- **builder** — orchestrator script.
- **BIOSes** — Gossamer (hack), Muslin (current), Corduroy (experimental).
- **player** — static HTML shell for running cabinets in Chrome.

### Renamed

- `transpiler/src/` → `kiln/`
- `transpiler/generate-dos.mjs` / `generate-dos-c.mjs` / `generate-hacky.mjs`
   → **deleted** — replaced by `builder/build.mjs` with cart-driven config.
- `bios/css-emu-bios.asm` → `bios/muslin/muslin.asm`
- `bios/entry.asm` / `handlers.asm` / `*.c` / `build.mjs` → `bios/corduroy/`
- `legacy/gossamer.asm` / `.bin` / `.lst` → `bios/gossamer/` (not legacy — active on the hack path)
- `tools/ref-emu.mjs` → `conformance/ref-hack.mjs`
- `tools/ref-asm-bios.mjs` → `conformance/ref-muslin.mjs`
- `tools/ref-emu-dos.mjs` → `legacy/ref-emu-dos.mjs` (V3 microcode-BIOS era, superseded)

### Added

- [`program.schema.json`](program.schema.json) — canonical cart manifest schema.
- [`docs/cart-format.md`](docs/cart-format.md) — cart format reference (every
  field tagged implemented / partial / aspirational).
- [`docs/architecture.md`](docs/architecture.md) — one-page architecture overview.
- [`docs/memory-layout.md`](docs/memory-layout.md) — memory zones, rom-disk
  mechanics, the 0x4F0 pitfall.
- [`docs/bios-flavors.md`](docs/bios-flavors.md) — BIOS flavors overview.
- [`docs/hack-path.md`](docs/hack-path.md) — the raw-.COM sidepath.
- [`docs/building.md`](docs/building.md) — end-to-end build walkthrough.
- `builder/` — orchestrator + four stages + presets + lib.
- `player/index.html` — static HTML shell; replaces the old `--html` mode.
- `conformance/` — reference emulators, co-located.
- `carts/` — maintained example carts; seeded with the Rogue cart.
- Per-folder READMEs: `builder/`, `kiln/`, `player/`, `conformance/`,
  `carts/`, `dos/`, each `bios/*/`.

### Deleted

- `dos/disk.img`, `dos/config.sys`, `dos/boot-test.img`, `dos/test-rogue.img`,
  `dos/ke2044_86f16.zip`, `dos/svardos-20250427-floppy-1.44M (1)/`,
  `dos/docs/`, `dos/bin/autoexec.bat`, `dos/bin/country.sys`,
  `dos/bin/install.bat`, `dos/bin/kernel-edrdos.sys`,
  `dos/bin/kernel-freedos.sys`, `dos/bin/kernel-svardos.sys`,
  `dos/bin/kwc8616.map`, `dos/bin/setver.sys`, `dos/bin/sys.com`.
  (`dos/` now contains only `bin/kernel.sys` and `bin/command.com`.)
- Repo-root debris: `gossamer-dos.{asm,bin,lst}`, `rogue-dos.css`,
  `rogue.zip`, `test-shell.css`, `ref-trace*.json`, `state.json`,
  `V3-PLAN-1.md`, `nul`, `results/`.
- `legacy/build_c.py`, `build_css.py`, `base_template.{css,html}`,
  `x86-instructions-rebane.json`, `extra/`, `web/`,
  `gossamer-dos.{asm,bin,lst}`.
- `docs/architecture/*.md` (consolidated into `docs/architecture.md`;
  originals moved to `docs/archive/`).
- `docs/reference/project-layout.md`, `tools.md`, `conformance-testing.md`
  (moved to `docs/archive/`).
- HTML wrapping path in `kiln/template.mjs` (`emitHTMLHeader` /
  `emitHTMLFooter` removed; the player replaces them).

### Changed

- `kiln/emit-css.mjs` no longer accepts `htmlMode`. Emits pure CSS. Accepts a
  new optional `header` string (the cabinet header comment) prepended verbatim.
- `.gitignore` rewritten for the new layout.
- `CLAUDE.md` and `docs/INDEX.md` rewritten for the new layout.
- `legacy/README.md` rewritten to describe the pruned contents.

### Deferred (known follow-ups)

- Update `calcite/run.bat`, `run-web.bat`, `run-js.bat`, `calcite/serve.mjs`
  — these still reference old generator paths and are massive refactors in
  their own right.
- `disk.size` plumbing — schema accepts it, `tools/mkfat12.mjs` still has a
  hard-coded size.
- `disk.writable` — schema accepts it, INT 13h has no write path yet.
- `memory.gfx` / `memory.textVga` knobs for hack carts.
- Making `memory.conventional < 640K` actually boot on DOS carts.
- Consolidation of `calcite/tools/*.mjs` diff tools into `calcite-debugger`
  subcommands.
- A `ref-corduroy.mjs` reference emulator once Corduroy stabilizes.

### Unaffected

- `tests/` — conformance test programs, untouched by the rename.
- `docs/logbook/*`, `docs/plans/*`, `docs/superpowers/*` — preserved as-is.
- `icons/` — CSS-DOS asset directory, preserved.
- Calcite repo — unchanged; follow-up refactor tracked above.
