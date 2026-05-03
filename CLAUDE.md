# CSS-DOS

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome (in theory - in practise it crashes it)

[Calcite](../calcite) is a JIT compiler that
makes it fast enough to be usable.

## Before starting. 

1. Read STATUS and the doc index (auto-loaded below via @ links)
2. Understand current state, sentinel addresses, gotchas, open work
3. Read the docs relevant to your specific task (the index tells you which)
4. For history of past work, see `docs/logbook/LOGBOOK.md`

@docs/logbook/STATUS.md
@docs/INDEX.md

## Mandatory rules

### The checkpoint system

If your task and success criteria are clear, try to be autonomous and not stop working unless you either reach a checkpoint or have a
blocking question for the user. 

A checkpoint requires ALL of:

- [x] Task complete and tested *properly* from a user perspective via web, end-to-end (or user confirmed they tested it)
- [x] Logbook updated (status, entry, what's next)
- [x] New code/features documented in the appropriate docs/ file
- [x] No leftover debris (debug logging, temp files, unclear names)
- [x] GitHub issues updated if relevant

Only then may you stop looping - your task is not finished unless these things are done, just because the code works. 

### Coding Guidelines

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them - don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.

2. Simplicity First
Minimum code that solves the problem. 
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

3. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
"Add validation" → "Write tests for invalid inputs, then make them pass"
"Fix the bug" → "Write a test that reproduces it, then make it pass"
"Refactor X" → "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

4. - **DO NOT GUESS OR ASSUME FUNCTIONALITY, or unnecessarily reverse-engineer** We have the source code for DOS, 8086 manual, BIOS interrupts,
  FAT12, or kernel behavior in documentation, Doom8088 itself, and so on. Consult the right documentation. Try NOT to reverse-engineer assembly for debugging Use the kernel map file, edrdos source (`../edrdos/`), and Ralf Brown's Interrupt List.

### Git and collaborative coding rules

**Commit and push frequently — it's encouraged.** Plain
`git commit` and `git push` of your own changes don't disturb other
agents' working trees, and stacking up uncommitted work just makes
merge conflicts and lost-work scenarios more likely. Always push to
origin once you've committed.

What requires explicit permission, especially when running
autonomously, is anything that mutates shared state another agent
might be in the middle of using. These commands can wipe their
uncommitted work, rewrite history they've built on, or pollute the
shared index:

- `git stash` (their uncommitted changes vanish into your stash)
- `git add` of files you didn't author / didn't intend
- `git rebase`, `git reset --hard`, `git checkout --` / `git restore`
- `git clean -f`, `git branch -D`
- `git push --force` (especially to main/master — never)
- Any `--no-verify`, `--no-gpg-sign`, or other safety-bypass flag

If you find yourself wanting one of these as a shortcut around an
obstacle, stop and ask — the obstacle is usually a sign of state you
should investigate, not bulldoze.

### Documentation rules
- **Log findings and progress concisely** in the logbook for future agents.
Documentation is incredibly important and an unspoken part of working in this repo. This project is particularly silly and dense, across two repos. Documentation must be automatic, without the user asking specifically for it. Documentation must be epistemically honest. Documentation must be frequent and concise - tokens add up if you waffle.

### Logbook discipline (which logbook for what)

- **Calcite engine work** (anything in `../calcite/crates/`) → log in
  `../calcite/docs/log.md`.
- **CSS-DOS platform / harness / bench / kiln / builder / BIOS work** →
  log in `docs/logbook/LOGBOOK.md`.
- **Cross-cutting** work that touches both repos → log in both, with a
  cross-link from each to the other.

The natural default for an agent is to write back to the logbook
auto-loaded by CLAUDE.md (this one). Resist that for calcite work —
the calcite repo has its own log that the calcite cardinal-rule check
relies on.

### Debugging rules

Your biggest failure mode is coming up with individual candidates for where the bug is, saying 'That's it!' then realising you were wrong, then repeating this multiple timmes. In this particular repo, that is a horrible idea. Checking 5000 places in a few seconds is longer than taking a minute to think deeply in advance about how to isolate the bug holistically, seeing the forest for the trees. 

When debugging, take a second to think what you would advise a senior engineer to do to find the bug. 

- **DO NOT chase bugs speculatively.** Use the debug infrastructure. Add features to the debugger
  if what you need doesn't exist.
- **DO NOT take shortcuts** that accrue tech debt or leave debris in the repo.
- **PREFER creating or updating debugging infrastructure** over speculative individual fixes.
- **Every command needs an explicit ≤2-minute wall-clock cap.** Boot reaches the
  A:\> prompt around tick 2-4M; the slow `pipeline.mjs shoot` path does
  ~1500 ticks/s and will not terminate inside that budget. Use `fast-shoot`
  (calcite-cli, ~375K ticks/s) for late-tick screenshots, or pick a tick
  count the chosen path can reach. Never fire-and-forget a tool hoping it'll
  come back — if there's no path that fits the budget, build one (that's
  how `fast-shoot` and `--dump-mem-range` came to exist).

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

### Calcite knows nothing above the CSS layer

Calcite reasons about CSS structural shape and nothing else. The
moment a recogniser, rewrite rule, codegen path, or optimisation knows
about something *above* the CSS — x86, BIOS, DOS, Doom, a specific
cabinet's addresses, Kiln's current emit choices, what `program.json`
says, what the cart is *trying to do* — it has crossed the line.

Operational test: could a calcite engineer who has never seen a CPU
emulator, never read Kiln's source, and doesn't know what a cabinet
contains, derive this rule / recogniser / pass by staring at CSS shape
alone? If yes, fair. If no, it's overfit and one-way-doors the engine
toward Doom. Pattern recognition is welcome — pattern recognition over
*shapes CSS forces emitters into* generalises across cabinets.
Recognition tied to *what those shapes mean upstream* does not.

Genericity probe: would the same rule fire on a 6502 cabinet, a
brainfuck cabinet, a non-emulator cabinet whose CSS happens to share
the structural shape? If no on all three, you've encoded a specific
program into calcite, and every future cabinet will have to fight that
bias.

This is a sharpening of "calcite can't know about x86", not a
replacement. x86 is one example of an upstream layer; the rule covers
all of them.

### The workflow is sacred: load-time compilation only

Calcite must accept any spec-compliant `.css` cabinet at load time and
make it fast — in the browser, on the user's machine, with no build
step on the cabinet author's side, no pre-baked artifact, no allowlist,
no asset pipeline. "Open a `.css` URL, it runs" is the contract.

Compile-once-per-load, run-many is allowed (and is how calcite gets
fast). Distributing pre-compiled cabinets is not — that breaks the
contract. The compile budget is bounded by user patience (a cold open
that takes minutes loses the user) and by the runtime floor it has to
unlock (steady-state must clear playability). Within those, the
compile/run tradeoff is a knob.

## Vocabulary

See [`docs/architecture.md`](docs/architecture.md#vocabulary). In short:

- **cart** — input folder or zip (program + data + optional `program.json`).
- **floppy** — FAT12 disk image the builder assembles internally.
- **cabinet** — output `.css` file, runnable in Chrome/Calcite.
- **Kiln** — the CSS transpiler (`kiln/`).
- **builder** — the orchestrator (`builder/`).
- **BIOSes** — Gossamer (hack), Muslin (assembly DOS BIOS), Corduroy (default C DOS BIOS).
- **player** — static HTML shell for running cabinets in Chrome. 

## Testing and debugging infrastructure

Two peer entrypoints:

- **Correctness** — `tests/harness/`. Start with
  `node tests/harness/run.mjs smoke`. Smoke, conformance, fulldiff vs
  the JS reference 8086, screenshots, baselines.
- **Performance** — `tests/bench/`. Start with
  `node tests/bench/driver/run.mjs compile-only`. Timed profiles, web
  + native targets, ensureFresh-driven artifact rebuild.

See [`docs/TESTING.md`](docs/TESTING.md) for the full split and
[`docs/script-primitives.md`](docs/script-primitives.md) for the
watch-spec grammar bench profiles use to compose stage detectors.

For "what's on screen at tick N?" against a fresh cabinet, use
`pipeline.mjs fast-shoot <cabinet> --tick=N` — drives `calcite-cli`
directly, ~375K ticks/s, fits boot-completion ticks (2-4M) inside a
~10s budget. The older `pipeline.mjs shoot` path goes through
`calcite-debugger` at ~1500 ticks/s and only terminates for early
ticks. For raw byte dumps without rendering,
`calcite-cli --dump-mem-range=ADDR:LEN:PATH` writes guest memory to a
file at end-of-run (repeatable for multiple regions).

The legacy `fulldiff.mjs` / `ref-dos.mjs` / `compare-dos.mjs` scripts
under `tools/` and `../calcite/tools/` import a deleted `transpiler/`
directory and don't work. The replacement is
`node tests/harness/pipeline.mjs fulldiff <cabinet>.css`.

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

# Play it in Chrome (start the dev server first: node web/scripts/dev.mjs)
# then open: http://localhost:5173/player/calcite.html?cabinet=/rogue.css
# Or drive it with Playwright.

# Play it fast via Calcite
cd ../calcite && target/release/calcite-cli.exe -i ../CSS-DOS/rogue.css

# Debug it — use the Calcite MCP server
```

## Calcite

Sibling repo at `../calcite`. Read `../calcite/CLAUDE.md` before making
changes there. See [`docs/architecture.md`](docs/architecture.md#relationship-to-calcite)
for the relationship.

### Working in a git worktree

When you check CSS-DOS out into a worktree (e.g.
`.claude/worktrees/foo/`), the `../calcite` sibling-repo assumption no
longer holds — relative path resolution from inside the worktree won't
find calcite. Set the `CALCITE_REPO` environment variable to the calcite
repo (or worktree) you want to use:

```sh
# From a CSS-DOS worktree, point at a matching calcite worktree
export CALCITE_REPO=/abs/path/to/calcite/.claude/worktrees/foo
```

`CALCITE_REPO` is honoured by:

- `web/scripts/dev.mjs` — vite aliases (`/calcite/`, `/bench-assets/`)
  and the `_reset` step that rebuilds the calcite WASM.
- `tests/bench/lib/artifacts.mjs` — locating `calcite-cli` and the
  WASM bundle for ensureFresh rebuilds.
- `tests/harness/lib/fast-shoot.mjs`, `lib/debugger-client.mjs` —
  locate the `calcite-cli` / `calcite-debugger` binaries.

`CALCITE_CLI_BIN` and `CALCITE_DEBUGGER_BIN` still take precedence over
`CALCITE_REPO` if you need to point at a specific binary directly
(useful when the binary's been pre-built somewhere outside the worktree).
