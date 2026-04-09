# CSS-DOS

An Intel 8086 PC implemented entirely in CSS custom properties and `calc()`.
The CSS runs in Chrome — no JavaScript, no WebAssembly, just a stylesheet
executing machine code. The goal: boot DOS from a CSS file.

[Calcite](https://github.com/stop-amertime/calcite) is a JIT compiler that
makes the CSS fast enough to actually use (~200K+ ticks/sec vs Chrome's
~1 tick/sec).

## How it works

A transpiler converts a reference JavaScript 8086 emulator into equivalent CSS.
Every register, flag, and memory byte is a CSS custom property. Every instruction
is a CSS expression. Each "tick" of CSS evaluation executes one instruction.

The output is a self-contained `.css` file (or `.html` with visualization) that
can be:
- Opened in Chrome (works, but slowly — one frame per year)
- Run through calcite for real-time execution

## Status

**Architecture pivot in progress.** The transpiler is not yet built.
See [issue #49](https://github.com/stop-amertime/calcite/issues/49) for the
full roadmap.

What exists today:
- Reference 8086 emulator (`tools/js8086.js`) — the source of truth
- Conformance testing tools (`tools/`) — tick-by-tick comparison infrastructure
- Gossamer BIOS (`gossamer.asm`) — INT 10h/16h/1Ah/20h/21h handlers
- Test programs (`examples/fib.asm`)
- Legacy v1 transpiler (`legacy/`) — works but has synchronization bugs

What's next:
- Build the JS→CSS transpiler (`transpiler/`)
- Conformance test until simple programs match tick-for-tick
- Add BIOS extensions for disk I/O (INT 13h)
- Boot DOS

## Quick start

The transpiler doesn't exist yet. To run existing test programs using the
legacy approach:

```sh
# Build CSS from a binary (legacy approach)
cd legacy && python build_css.py ../examples/fib.com --mem 0x600

# Run with calcite
cargo run -p calcite-cli -- fib.css --ticks 10000

# Generate reference trace for conformance testing
node tools/ref-emu.mjs examples/fib.com > ref-trace.json
```

## Project layout

```
transpiler/     JS→CSS transpiler (not yet built — the main work item)
tools/          Conformance testing (reference emulator + comparison)
gossamer.asm    Gossamer BIOS (NASM source)
examples/       Test programs (.asm, .com)
legacy/         v1 approach (JSON database → parallel dispatch CSS)
```

See `CLAUDE.md` for detailed architecture and contributor guide.

## 8086 ISA

The reference emulator (`tools/js8086.js`) implements the full 8086 instruction
set. The transpiler will convert all ~200 opcode cases to CSS.

## Credits

- [rebane2001](https://github.com/rebane2001) for the original
  [x86css](https://github.com/rebane2001/x86css)
- Jane Ori for the
  [CPU Hack](https://dev.to/janeori/expert-css-the-cpu-hack-4ddj)
- [emu8](https://github.com/nicknisi/emu8) for the reference 8086 emulator

## License

GNU GPLv3
