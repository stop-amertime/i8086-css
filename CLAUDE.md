# CSS-DOS

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome (in theory - in practise it crashes it)

[Calcite](../calcite) is a JIT compiler that
makes it fast enough to be usable.

## Before you do ANYTHING

1. Read the logbook and doc index (auto-loaded below via @ links)
2. Understand the current status, active blocker, and priority list
3. Read the docs relevant to your specific task (the index tells you which)

@docs/logbook/LOGBOOK.md
@docs/INDEX.md

## Mandatory rules

### The checkpoint system

Try to be autonomous and not stop working unless you either reach a checkpoint or have a
blocking question for the user. 

Trust the user in general - they are highly technical. 

A checkpoint requires ALL of:

- [x] Task complete and tested (or user confirmed they tested it)
- [x] Logbook updated (status, entry, what's next)
- [x] New code/features documented in the appropriate docs/ file
- [x] No leftover debris (debug logging, temp files, unclear names)
- [x] GitHub issues updated if relevant

Only then may you commit and push.

### Git and collaborative coding rules

You should commit frequently, committing is cheap and non-destructive. Leaving commits to stack up makes merge conflicts and issues more likely. 

But, actions that interfere with other agents working on the same repo should be done with great care, often requiring explicit permission. Often, other agents will be working in the same repo at the same time. 

This includes stashing, git -add, rebase/checkout, etc.

### Documentation rules

- **DO NOT GUESS OR ASSUME FUNCTIONALITY.** Look up DOS, 8086, BIOS interrupts,
  FAT12, or kernel behavior in documentation before acting.
- **Try NOT to reverse-engineer assembly for debugging** Use the kernel map file, edrdos source
  (`../edrdos/`), and Ralf Brown's Interrupt List.
- **Log ALL findings and progress** in the logbook for future agents.

### Debugging rules

Your biggest failure mode is fixating on an individual finding and saying 'That's it!' then realising you were wrong. 

This often comes from chasing issues around blindly. When debugging, take a second to think what you would advise a senior engineer to do to find the bug. Speed is NOT the best approach. There will always be actions you can quickly check in a few seconds in this repo. But, checking 5000 places in a few seconds is longer than taking a minute to think deeply in advance about how to isolate the bug holistically, seeing the forest for the trees. 

Another huge failure mode is rushing to conclusions or unchecked assumptions, or making logical leaps that don't make sense. An example of this is deciding that calcite needs to be rebuilt to pick up a change, when the user is debugging with you in real time and obviously knows to do that. This isn't a race. 

- **DO NOT chase bugs blindly.** Use the debugger. Add features to the debugger
  if what you need doesn't exist.
- **DO NOT take shortcuts** that accrue tech debt or leave debris in the repo.
- **PREFER creating or updating debugging infrastructure** over speculative individual fixes.

## The cardinal rule

The CSS is a working program that theoretically runs in Chrome - at least, it's CSS spec-compliant (in reality it crashes Chrome, but that's because it wasn't designed to handle massive CSS files). 

The fun of the project comes from doing it in a full-CSS source code. Therefore, Calcite must produce the same results Chrome would (or a theoretically spec-compliant CSS evaluator), just faster. 

This means that 

- **The CSS must work in Chrome.** If Chrome can't evaluate it, it's wrong.
- **Calcite can't change the CSS.** Only faster evaluation of the same expressions.
- **You may restructure CSS to be easier to JIT-optimise**, as long as
  Chrome still evaluates it the same way and produces the same results.
  Expressing the same computation in a different, more
  pattern-recognisable shape is fine. What is NOT fine: dummy code,
  metadata properties, or side-channels whose only purpose is to 'signal' to calcite or sneak
  information to calcite. The CSS must pay for itself in Chrome.
- **If calcite runs CSS differently to a reference interpreter e.g. Chrome, calcite is wrong.**

## Vocabulary

See [`docs/architecture.md`](docs/architecture.md#vocabulary). In short:

- **cart** — input folder or zip (program + data + optional `program.json`).
- **floppy** — FAT12 disk image the builder assembles internally.
- **cabinet** — output `.css` file, runnable in Chrome/Calcite.
- **Kiln** — the CSS transpiler (`kiln/`).
- **builder** — the orchestrator (`builder/`).
- **BIOSes** — Gossamer (hack), Muslin (assembly DOS BIOS), Corduroy (default C DOS BIOS).
- **player** — static HTML shell for running cabinets in Chrome. 

## Quick orientation

- **Current architecture:** V4 single-cycle. Every instruction completes
  in one CSS tick with a configurable number of memory write slots (minimum 6)
- **Default BIOS:** Corduroy (`bios/corduroy/`). Muslin (`bios/muslin/muslin.asm`) still available.  
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
Or use Playwright! 

# Play it fast via Calcite
cd ../calcite && target/release/calcite-cli.exe -i ../CSS-DOS/rogue.css

# Debug it - use the Calcite MCP server 
```

## Calcite

Sibling repo at `../calcite`. Read `../calcite/CLAUDE.md` before making
changes there. See [`docs/architecture.md`](docs/architecture.md#relationship-to-calcite)
for the relationship.
