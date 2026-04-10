#!/usr/bin/env python3
"""png-to-vga — quantize a PNG to the CGA-16 palette and emit a raw .bin.

Each output byte is a palette index (0-15) for one pixel, row by row.
Matches CGA_PALETTE in calcite-core/src/state.rs.

Usage:
    python tools/png-to-vga.py <input.png> <output.bin>
"""
import sys
from PIL import Image

# Must match CGA_PALETTE in calcite-core/src/state.rs
PALETTE = [
    (0x00, 0x00, 0x00),  # 0  black
    (0x00, 0x00, 0xAA),  # 1  blue
    (0x00, 0xAA, 0x00),  # 2  green
    (0x00, 0xAA, 0xAA),  # 3  cyan
    (0xAA, 0x00, 0x00),  # 4  red
    (0xAA, 0x00, 0xAA),  # 5  magenta
    (0xAA, 0x55, 0x00),  # 6  brown
    (0xAA, 0xAA, 0xAA),  # 7  light gray
    (0x55, 0x55, 0x55),  # 8  dark gray
    (0x55, 0x55, 0xFF),  # 9  light blue
    (0x55, 0xFF, 0x55),  # 10 light green
    (0x55, 0xFF, 0xFF),  # 11 light cyan
    (0xFF, 0x55, 0x55),  # 12 light red
    (0xFF, 0x55, 0xFF),  # 13 light magenta
    (0xFF, 0xFF, 0x55),  # 14 yellow
    (0xFF, 0xFF, 0xFF),  # 15 white
]


def nearest_palette_index(r: int, g: int, b: int) -> int:
    """Return palette index closest to (r,g,b) in RGB distance."""
    best_i = 0
    best_d = 1 << 30
    for i, (pr, pg, pb) in enumerate(PALETTE):
        dr = r - pr
        dg = g - pg
        db = b - pb
        d = dr * dr + dg * dg + db * db
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def main():
    if len(sys.argv) != 3:
        print("Usage: png-to-vga.py <input.png> <output.bin>", file=sys.stderr)
        sys.exit(1)

    in_path, out_path = sys.argv[1], sys.argv[2]
    img = Image.open(in_path).convert("RGBA")
    w, h = img.size
    pixels = img.load()

    out = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            # Treat fully-transparent pixels as black background
            if a < 128:
                out[y * w + x] = 0
            else:
                out[y * w + x] = nearest_palette_index(r, g, b)

    with open(out_path, "wb") as f:
        f.write(out)

    print(f"Wrote {len(out)} bytes ({w}x{h}) to {out_path}")

    # Print a tiny histogram so we can sanity-check the quantization
    hist = [0] * 16
    for b in out:
        hist[b] += 1
    total = sum(hist)
    print("Palette histogram (non-zero):")
    for i, c in enumerate(hist):
        if c > 0:
            pct = 100 * c / total
            print(f"  {i:2d}: {c:5d}  {pct:5.1f}%")


if __name__ == "__main__":
    main()
