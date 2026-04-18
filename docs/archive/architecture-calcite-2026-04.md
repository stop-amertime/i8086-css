# Calcite Relationship

Calcite is a sibling repo at `../calcite`. This repo produces CSS; calcite
runs it fast. There is no code dependency — calcite reads whatever CSS file
it's given and evaluates it. The only shared interface is the CSS format.

## The cardinal rule (both sides)

- **CSS-DOS side:** The CSS must work in Chrome. Never change CSS to help calcite.
- **Calcite side:** Calcite must NEVER have x86 knowledge. It evaluates CSS
  expressions — it doesn't know or care what they compute.
- **If calcite disagrees with Chrome, calcite is wrong.**

## Chrome limitations

Chrome silently fails in several cases:
- **@function nesting depth:** Too-deep nesting (e.g., function calling `--xor`
  with 33 local variables) — property evaluates to initial value, no error
- **@function local variable limit:** >7 local variables in one @function
- **Argument restrictions:** @function args can't be @function calls
  (`--foo(--bar(x))` fails). CSS math functions (`calc`, `mod`, `min`, etc.)
  are fine as arguments.

In practice: simple instructions validate in Chrome, complex instructions
(IMUL, multi-step flag computations) validate via Calcite + reference emulator.

## Pattern recognition

Calcite recognizes and optimizes:
- **Dispatch tables:** `if(style(--prop: N))` chains -> HashMap lookup
- **Broadcast writes:** `if(style(--dest: N): val; else: keep)` -> direct store
- **Bitwise operations:** Recognized function body patterns

The transpiler should emit CSS that naturally falls into these patterns.

## Working in calcite

If you need to make changes in calcite, **read `../calcite/CLAUDE.md` first**.
It has the architecture, the cardinal rule from calcite's perspective, and the
conformance testing workflow.

Key calcite docs:
- `../calcite/docs/debugger.md` — HTTP debug server API
- `../calcite/docs/conformance-testing.md` — fulldiff.mjs, diagnose.mjs, ref-dos.mjs
- `../calcite/docs/codebug.md` — co-execution debugger (side-by-side JS/calcite)
