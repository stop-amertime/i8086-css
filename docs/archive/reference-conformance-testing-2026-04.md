# Conformance Testing

## Quick start

### Hack path (.COM programs, no DOS kernel)

```sh
# 1. Assemble test program
C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe -f bin -o tests/prog.com tests/prog.asm

# 2. Generate CSS (one positional arg: the .com file)
node transpiler/generate-hacky.mjs tests/prog.com --mem 1536 -o tests/prog.css

# 3. Run comparison (three positional args: .com, gossamer.bin, .css)
node tools/compare.mjs tests/prog.com legacy/gossamer.bin tests/prog.css --ticks=500
```

### DOS boot path

```sh
# 1. Generate CSS
node transpiler/generate-dos.mjs ../calcite/programs/bootle.com -o ../calcite/output/bootle.css

# 2. Start calcite debugger
cd ../calcite
target/release/calcite-debugger.exe -i output/bootle.css &

# 3. Find first divergence
node tools/fulldiff.mjs --ticks=5000
```

Or use `run.bat diagnose` from calcite for an interactive menu.

## Tool reference

All tools are documented in detail in `../calcite/docs/conformance-testing.md`.
The key tools:

| Tool | Purpose | Location |
|------|---------|----------|
| `fulldiff.mjs` | Primary divergence finder (REP-aware, full FLAGS) | `../calcite/tools/` |
| `diagnose.mjs` | Property-level root cause analysis | `../calcite/tools/` |
| `ref-dos.mjs` | Standalone DOS reference emulator | `../calcite/tools/` |
| `compare.mjs` | Tick-by-tick comparison for .COM programs | `tools/` |
| `compare-dos.mjs` | DOS boot comparison (older, slower) | `tools/` |

## Debugging workflow

Standard process: find divergence -> diagnose -> fix -> verify.
See `docs/debugging/workflow.md` for the full workflow.
