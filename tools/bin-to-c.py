#!/usr/bin/env python3
"""bin-to-c -- convert a raw .bin file to a C byte array.

Usage:
    python tools/bin-to-c.py <input.bin> <output.c> <array_name>

Emits:
    #include <stddef.h>
    const unsigned char <array_name>[<size>] = {
        0xNN, 0xNN, ...
    };
    const size_t <array_name>_len = <size>;
"""
import sys

def main():
    if len(sys.argv) != 4:
        print("Usage: bin-to-c.py <input.bin> <output.c> <array_name>", file=sys.stderr)
        sys.exit(1)
    in_path, out_path, name = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(in_path, "rb") as f:
        data = f.read()
    lines = []
    lines.append(f"/* Generated from {in_path} by tools/bin-to-c.py -- do not edit by hand */")
    lines.append(f"#include <stddef.h>")
    lines.append(f"")
    lines.append(f"const unsigned char {name}[{len(data)}] = {{")
    for i in range(0, len(data), 12):
        row = ", ".join(f"0x{b:02X}" for b in data[i:i+12])
        lines.append(f"    {row},")
    lines.append(f"}};")
    lines.append(f"")
    lines.append(f"const size_t {name}_len = {len(data)};")
    with open(out_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {out_path} ({len(data)} bytes)")

if __name__ == "__main__":
    main()
