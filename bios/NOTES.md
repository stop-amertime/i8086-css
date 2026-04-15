# bios/ build notes

## Assembler choice: NASM, not wasm

OpenWatcom `wasm` cannot assemble the NASM-style syntax used in `entry.asm`
(`[bits 16]`, `global`, `extern`, `section _TEXT public 'CODE'`). Attempting
it yields errors E214 / E306 / E225 / E085 starting at line 10.

If wasm cannot assemble NASM-style syntax, use:
  nasm -f obj bios/entry.asm -o /tmp/entry.obj

Use NASM for `entry.asm` / `handlers.asm` throughout. The Windows path is:
  C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe
