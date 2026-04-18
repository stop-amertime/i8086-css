# CSS-DOS

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome —
no JavaScript, no WebAssembly. [Calcite](../calcite) is a JIT compiler that
makes it fast enough to be usable.

## Before you do ANYTHING

1. Read the logbook and doc index (auto-loaded below via @ links)
2. Understand the current status, active blocker, and priority list
3. If your task isn't in "What's next", ask the user why before proceeding
4. Read only the docs relevant to your specific task (the index tells you which)

@docs/logbook/LOGBOOK.md
@docs/INDEX.md

## Mandatory rules

### The checkpoint system

You may NOT stop working unless you either reach a checkpoint or have a
blocking question for the user. A checkpoint requires ALL of:

- [x] Task complete and tested (or user confirmed they tested it)
- [x] Logbook updated (status, entry, what's next)
- [x] New code/features documented in the appropriate docs/ file
- [x] No leftover debris (debug logging, temp files, unclear names)
- [x] GitHub issues updated if relevant

Only then may you commit and push.

### Git rules

Do not interact with Git unless explicitly allowed. No stashing, no looking
at previous commits, no rollbacks — even in bypass permissions mode.

### Documentation rules

- **DO NOT GUESS OR ASSUME FUNCTIONALITY.** Look up DOS, 8086, BIOS interrupts,
  FAT12, or kernel behavior in documentation before acting.
- **DO NOT reverse-engineer assembly.** Use the kernel map file, edrdos source
  (`../edrdos/`), and Ralf Brown's Interrupt List.
- **Log ALL findings and progress** in the logbook for future agents.

### Debugging rules

- **DO NOT RUSH TO CONCLUSIONS.** Gather information first.
- **DO NOT chase bugs blindly.** Use the debugger. Add features to the debugger
  if what you need doesn't exist.
- **DO NOT take shortcuts** that accrue tech debt or leave debris in the repo.
- **PREFER debugging infrastructure** over speculative individual fixes.

## The cardinal rule

The CSS is a working program that runs in Chrome. It is the source of truth.
Calcite must produce the same results Chrome would, just faster. Calcite has
zero x86 knowledge.

- **The CSS must work in Chrome.** If Chrome can't evaluate it, it's wrong.
- **Calcite can't change the CSS.** Only faster evaluation of the same expressions.
- **You may restructure CSS to be easier to JIT-optimise**, as long as
  Chrome still evaluates it the same way and produces the same results.
  Expressing the same computation in a different, more
  pattern-recognisable shape is fine. What is NOT fine: dummy code,
  metadata properties, or side-channels whose only purpose is to sneak
  information to calcite. The CSS must pay for itself in Chrome.
- **If calcite disagrees with Chrome, calcite is wrong.**

## Vocabulary

See [`docs/architecture.md`](docs/architecture.md#vocabulary). In short:

- **cart** — input folder or zip (program + data + optional `program.json`).
- **floppy** — FAT12 disk image the builder assembles internally.
- **cabinet** — output `.css` file, runnable in Chrome/Calcite.
- **Kiln** — the CSS transpiler (`kiln/`).
- **builder** — the orchestrator (`builder/`).
- **BIOSes** — Gossamer (hack), Muslin (current), Corduroy (experimental).
- **player** — static HTML shell for running cabinets in Chrome.

## Quick orientation

- **Current architecture:** V4 single-cycle. Every instruction completes
  in one CSS tick with 8 parallel memory write slots.
- **Default BIOS:** Muslin (`bios/muslin/muslin.asm`).
- **Build entry:** `node builder/build.mjs <cart>`.
- **Transpiler:** [`kiln/`](kiln/) — see [`kiln/README.md`](kiln/README.md).
- **How to add instructions:** [`kiln/AGENT-GUIDE.md`](kiln/AGENT-GUIDE.md).
- **Cart format:** [`docs/cart-format.md`](docs/cart-format.md).
- **Architecture overview:** [`docs/architecture.md`](docs/architecture.md).
- **Memory layout:** [`docs/memory-layout.md`](docs/memory-layout.md).
- **BIOS details:** [`docs/bios-flavors.md`](docs/bios-flavors.md).
- **Debugging workflow:** [`docs/debugging/workflow.md`](docs/debugging/workflow.md).

## Tools

**NASM** (assembler): `C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe`.
Not in PATH. Override via `NASM=` env var.

**Calcite debugger:** See `../calcite/docs/debugger.md` and
[`docs/debugging/calcite-debugger.md`](docs/debugging/calcite-debugger.md).

**Conformance testing:** See [`conformance/README.md`](conformance/README.md)
and `../calcite/docs/conformance-testing.md`.

## Build quick start

```sh
# Build a cabinet from a cart
node builder/build.mjs carts/rogue -o rogue.css

# Play it in Chrome
open player/index.html?cabinet=../rogue.css

# Play it fast via Calcite
cd ../calcite && target/release/calcite-cli.exe -i ../CSS-DOS/rogue.css
```

## Calcite

Sibling repo at `../calcite`. Read `../calcite/CLAUDE.md` before making
changes there. See [`docs/architecture.md`](docs/architecture.md#relationship-to-calcite)
for the relationship.
