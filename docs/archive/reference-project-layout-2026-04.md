# Project Layout

```
CSS-DOS/
  CLAUDE.md              Agent instructions + project rules
  README.md              Public-facing project description
  V3-PLAN-1.md           Full v3 architecture specification

  transpiler/            JS->CSS transpiler (the active codebase)
    README.md              Transpiler-specific architecture doc
    AGENT-GUIDE.md         How to add/modify instructions
    generate-hacky.mjs     Entry point: .com binary -> CSS (hack path)
    generate-dos.mjs       Entry point: .com/.exe -> CSS via DOS boot
    src/
      emit-css.mjs           Top-level CSS generation orchestrator
      decode.mjs             Instruction fetch, ModR/M, effective address
      memory.mjs             Memory layout, segments, zones
      template.mjs           Execution engine (clock, double-buffer, write-back)
      patterns/
        bios.mjs               CSS-BIOS microcode handlers (INT 10h, 13h, etc.)
        alu.mjs                ADD/SUB/AND/OR/XOR/CMP/TEST/ADC/SBB/NEG
        mov.mjs                MOV/XCHG/LEA/LDS/LES
        control.mjs            JMP/CALL/RET/INT/IRET/conditional jumps/LOOP
        stack.mjs              PUSH/POP/PUSHF/POPF
        string.mjs             MOVS/CMPS/STOS/LODS/SCAS + REP
        shift.mjs              SHL/SHR/SAR/ROL/ROR/RCL/RCR
        group.mjs              Group opcode dispatch (80-83, D0-D3, F6-F7, FE-FF)
        flags.mjs              Flag computation @functions
        misc.mjs               CBW/CWD/XLAT/AAA/AAS/DAA/DAS/AAM/AAD/IO/NOP
        irq.mjs                IRQ delivery sentinel (opcode 0xF1)
      css-lib.mjs            Utility @functions (bitwise, shifts, sign extension)

  tools/                 Conformance testing
    js8086.js              Vendored reference 8086 emulator (~2700 lines)
    ref-emu.mjs            Standalone reference emulator (simple BIOS programs)
    ref-emu-dos.mjs        DOS reference emulator runner
    compare.mjs            Tick-by-tick comparison
    compare-dos.mjs        DOS boot comparison (older, slower)
    lib/
      bios-handlers.mjs      JS reference BIOS handlers
      peripherals.mjs        PIT, PIC, keyboard controller (JS)

  tests/                 Test assembly sources and binaries
    *.asm                  Test sources
    *.com                  Compiled test binaries

  bios/                  BIOS init stub
    init.asm               Real x86: IVT setup, BDA init, VGA splash, JMP to kernel

  dos/                   DOS kernel and system files
    bin/                   kernel.sys, command.com, etc.
    config.sys             DOS configuration
    docs/                  FreeDOS/EDR-DOS documentation

  legacy/                Retired code
    gossamer.asm           Old BIOS assembly source (v1/v2)
    gossamer.bin           Compiled old BIOS
    build_css.py           v1 transpiler (Python)
    base_template.css      v1 CSS skeleton

  docs/                  Documentation
    INDEX.md               Start here — doc map with "when to read" guidance
    architecture/          How things work (overview, v3 model, BIOS, calcite)
    reference/             How to do things (testing, debugging, tools, layout)
    debugging/             Bug investigation (workflow, known bugs, debugger API)
    logbook/               Project coordination (status, entries, protocol)
    plans/                 Active implementation plans with checkboxes
    archive/               Completed specs, old plans, session notes
```

## Sibling repos

```
../calcite/            JIT compiler for CSS (Rust)
  CLAUDE.md              Calcite architecture + rules
  docs/
    debugger.md            HTTP debug server API
    conformance-testing.md Full tool reference + workflows
    codebug.md             Co-execution debugger
    benchmarking.md        Performance numbers

../edrdos/             EDR-DOS kernel source (for debugging reference)
  drdos/                 fdos (file system, process management)
  drbio/                 hardware abstraction layer
```
