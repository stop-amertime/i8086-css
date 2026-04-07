# i8086-css

A static binary translator for the Intel 8086. Takes 8086 machine code and
produces CSS custom properties and `@function` definitions that, when evaluated,
reproduce the CPU's behavior — either in a browser or via
[calcite](https://github.com/nicholasgasior/calcite), a JIT compiler for
computational CSS.

Forked from [rebane2001/x86css](https://github.com/rebane2001/x86css) with
significant extensions: multi-write instructions, full 8086 ISA coverage,
segmented memory, and DOS service stubs.

## What it does

1. Reads an 8086 binary (`.com` file or raw machine code)
2. Decodes every instruction (opcode, ModR/M, immediates)
3. Emits CSS that encodes the entire CPU as custom properties
4. Each "tick" of CSS evaluation executes one instruction

The output is a self-contained HTML file with embedded CSS that runs the
original program. Think of it as [Rosetta](https://en.wikipedia.org/wiki/Rosetta_(software))
but the target architecture is CSS.

## 8086 ISA — complete

All 106 8086 instructions are implemented:

| Category | Instructions |
|----------|-------------|
| Arithmetic | ADD, ADC, SUB, SBB, INC, DEC, NEG, MUL, IMUL, DIV, IDIV, CBW, CWD |
| Logic | AND, OR, XOR, NOT, TEST, SHL, SHR, SAR, ROL, ROR, RCL, RCR |
| Data movement | MOV, XCHG, LEA, LES, LDS, XLAT, PUSH, POP |
| String ops | MOVSB/W, STOSB/W, LODSB/W, CMPSB/W, SCASB/W |
| Control flow | JMP, CALL, RET, RETF, IRET, INT, INTO, LOOP, LOOPZ, LOOPNZ, JCXZ |
| Conditional jumps | JZ, JNZ, JB, JNB, JBE, JA, JS, JNS, JL, JGE, JLE, JG, JO, JNO, JPE, JPO |
| Flags | CLC, STC, CMC, CLD, STD, CLI, STI, PUSHF, POPF, SAHF, LAHF |
| Prefixes | REP/REPZ, REPNZ, LOCK, segment overrides (ES:, CS:, SS:, DS:) |
| BCD | DAA, DAS, AAA, AAS, AAM, AAD |
| Far calls | CALL FAR, JMP FAR, RETF, IRET |
| I/O | IN, OUT, HLT, WAIT, NOP |

## Segmented memory

- ModR/M address calculation applies `segment * 16 + offset` with correct
  default segment selection (SS for BP-based, DS for others)
- String instructions use `DS:SI` and `ES:DI` per the 8086 spec
- LES/LDS load far pointers (offset + segment)
- Far CALL/JMP/RETF/IRET push/pop CS correctly

## Multi-write support

The original x86css could only write one value per tick. i8086-css supports
two write slots per tick (`addrDestA`/`addrDestB`), enabling instructions that
modify multiple destinations (e.g., XCHG, MUL/DIV writing DX:AX, string ops
updating both data and index registers).

Side channels handle additional implicit writes (SI/DI deltas for string ops,
SP for PUSH/POP, flags).

## DOS services (INT 21h)

Currently stubbed:

| AH | Function | Status |
|----|----------|--------|
| 30h | Get DOS version | Returns DOS 5.0 |
| 4Ch | Exit program | Halts (IP = IP) |

All other INT 21h functions return no-op.

## Building

### From assembly

Place your 8086 binary in `program.bin` and the `_start` offset in
`program.start` (as a decimal number). Then:

```sh
python3 build_css.py
# Output: x86css.html
```

### From C

Requires [gcc-ia16](https://gitlab.com/tkchia/build-ia16):

```sh
python3 build_c.py
python3 build_css.py
```

### Configuration

Edit the top of `build_css.py`:

```python
MEM_SIZE = 0x600       # Memory size in bytes (default 1.5KB)
PROG_OFFSET = 0x100    # Program load address (.COM convention)
```

Increase `MEM_SIZE` for larger programs. Each byte becomes a CSS custom
property, so large memory = large CSS output.

### Custom I/O

| Address | Function |
|---------|----------|
| 0x2000 | writeChar1 — write single byte to screen |
| 0x2002 | writeChar4 — write 4 bytes to screen |
| 0x2004 | writeChar8 — write 8 bytes to screen |
| 0x2006 | readInput — read keyboard input |
| 0x2100 | SHOW_KEYBOARD — toggle on-screen keyboard (0=off, 1=numeric, 2=alpha) |

## Running with calcite

The generated CSS can be executed directly by calcite for much higher
throughput than browser rendering:

```sh
cargo run -p calcite-cli -- path/to/x86css.html --ticks 1000000
```

calcite compiles the CSS expressions to bytecode, achieving ~230K ticks/sec
with pattern recognition for dispatch tables, broadcast writes, and bitwise
operations.

## Credits

- [rebane2001](https://github.com/rebane2001) for the original x86css
- Jane Ori for the original [CPU Hack](https://dev.to/janeori/expert-css-the-cpu-hack-4ddj)
- Soo-Young Lee for the [8086 instruction set reference](https://www.eng.auburn.edu/~sylee/ee2220/8086_instruction_set.html)
- mlsite.net for the [8086 opcode map](http://www.mlsite.net/8086/)
- crtc-demos && tkchia for [gcc-ia16](https://gitlab.com/tkchia/build-ia16)

## License

GNU GPLv3

_Originally Feb 2026 by rebane2001. Multi-write fork Apr 2026._
