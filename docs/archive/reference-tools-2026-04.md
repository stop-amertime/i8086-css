# Tools Reference

## NASM (assembler)

Installed at `C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe`.
Not in PATH. Used to assemble test `.asm` files and the BIOS init stub.

## Transpiler entry points

| Script | Purpose |
|--------|---------|
| `transpiler/generate-hacky.mjs` | Hack path: binary -> CSS. Non-canonical layout. One positional arg (the .com file). |
| `transpiler/generate-dos.mjs` | DOS path: .com/.exe -> CSS via DOS boot. Full canonical PC layout. |

## Playwright MCP

Available for browser automation to run generated HTML/CSS in Chrome and
extract register state. Prefer Calcite traces and reference emulator
comparison — Playwright is slow and a last resort.

## Calcite tools

| Tool | Purpose |
|------|---------|
| `calcite-cli` | Run CSS programs, produce traces |
| `calcite-debugger` | HTTP debug server (see `../calcite/docs/debugger.md`) |
| `fulldiff.mjs` | Primary divergence finder |
| `diagnose.mjs` | Property-level root cause analysis |
| `ref-dos.mjs` | Standalone DOS reference emulator |
| `codebug.mjs` | Co-execution debugger (side-by-side JS/calcite) |
