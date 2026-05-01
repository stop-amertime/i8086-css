# Player fonts

`vga-8x16.bin` — the standard IBM VGA 8×16 ROM font (codepage 437).
4096 bytes: 256 glyphs × 16 rows, each row is one byte, bit 7 = leftmost
pixel. Fetched from <https://github.com/spacerace/romfont> which collects
public-domain VGA BIOS ROM fonts. No transformation applied — this is
the raw bitmap the real BIOS would expose.

Loaded once by the player at startup and rasterised into a pixel canvas
for text modes 0x01 and 0x03.
