/* font.h -- 8x8 bitmap font for BIOS splash.
   Glyphs: A-Z, 0-9, space, dash, period, colon, slash.
   Byte layout: 8 bytes per glyph, one per row, MSB = leftmost pixel. */
#ifndef FONT_H
#define FONT_H

/* Look up 8 bytes for an ASCII character. Returns pointer to glyph data.
   Unknown chars return the '?' glyph for visibility. */
const unsigned char *font_glyph(char c);

#define FONT_WIDTH  8
#define FONT_HEIGHT 8

#endif
