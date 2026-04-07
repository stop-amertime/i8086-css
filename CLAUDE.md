# i8086-css

A static binary translator: Intel 8086 machine code to CSS.

## Project Layout

```
build_css.py              Main transpiler (8086 binary → CSS)
build_c.py                C compiler bridge (gcc-ia16 → binary → CSS)
base_template.html        HTML template for output
x86-instructions-rebane.json  8086 opcode reference table
c/                        Example C programs
extra/                    Instruction generation tools
static/                   Font and image assets
```

## Building

```sh
# From a raw 8086 binary
python3 build_css.py

# From C source (requires gcc-ia16)
python3 build_c.py
python3 build_css.py
```

Output: `x86css.html` — a self-contained HTML file with embedded CSS.

## Relationship to calcite

This repo produces the CSS. [calcite](../calcite) is the JIT compiler that
runs it fast. The two repos are siblings — calcite has no 8086 knowledge,
it just evaluates whatever CSS it's given.
