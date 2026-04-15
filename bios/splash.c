/* splash.c -- mode 13h splash with CSS-DOS logo and POST lines. */
#include "splash.h"
#include "font.h"

#define VGA_SEG 0xA000u

extern const unsigned char logo_bin[1024];

/* CGA-16 palette matching tools/png-to-vga.py. VGA DAC uses 6-bit values
   (0-63), so each channel is the CGA byte >> 2. */
static const unsigned char cga_dac[16][3] = {
    { 0x00, 0x00, 0x00 }, /* 0  black */
    { 0x00, 0x00, 0x2A }, /* 1  blue */
    { 0x00, 0x2A, 0x00 }, /* 2  green */
    { 0x00, 0x2A, 0x2A }, /* 3  cyan */
    { 0x2A, 0x00, 0x00 }, /* 4  red */
    { 0x2A, 0x00, 0x2A }, /* 5  magenta */
    { 0x2A, 0x15, 0x00 }, /* 6  brown */
    { 0x2A, 0x2A, 0x2A }, /* 7  light gray */
    { 0x15, 0x15, 0x15 }, /* 8  dark gray */
    { 0x15, 0x15, 0x3F }, /* 9  light blue */
    { 0x15, 0x3F, 0x15 }, /* 10 light green */
    { 0x15, 0x3F, 0x3F }, /* 11 light cyan */
    { 0x3F, 0x15, 0x15 }, /* 12 light red */
    { 0x3F, 0x15, 0x3F }, /* 13 light magenta */
    { 0x3F, 0x3F, 0x15 }, /* 14 yellow */
    { 0x3F, 0x3F, 0x3F }, /* 15 white */
};

static void outb(unsigned int port, unsigned char val);
#pragma aux outb = "out dx, al" parm [dx] [al] modify exact [];

static void int10_ax(unsigned int ax);
#pragma aux int10_ax = "int 0x10" parm [ax] modify exact [ax bx cx dx];

static void set_mode_13h(void) {
    int10_ax(0x0013);
}

static void set_mode_text(void) {
    int10_ax(0x0003);
}

static void set_palette(void) {
    unsigned int i;
    outb(0x3C8, 0);
    for (i = 0; i < 16; i++) {
        outb(0x3C9, cga_dac[i][0]);
        outb(0x3C9, cga_dac[i][1]);
        outb(0x3C9, cga_dac[i][2]);
    }
}

static void vga_pixel(unsigned int x, unsigned int y, unsigned char color) {
    unsigned char __far *fb = (unsigned char __far *)((unsigned long)VGA_SEG << 16);
    fb[(unsigned long)y * 320u + x] = color;
}

static void blit_logo(unsigned int dest_x, unsigned int dest_y, unsigned int scale) {
    unsigned int src_x, src_y, dx, dy;
    for (src_y = 0; src_y < 32; src_y++) {
        for (src_x = 0; src_x < 32; src_x++) {
            unsigned char px = logo_bin[src_y * 32 + src_x];
            if (px == 0xFF) continue;  /* transparent sentinel */
            for (dy = 0; dy < scale; dy++) {
                for (dx = 0; dx < scale; dx++) {
                    vga_pixel(dest_x + src_x * scale + dx,
                              dest_y + src_y * scale + dy,
                              px);
                }
            }
        }
    }
}

static void draw_char(unsigned int x, unsigned int y, char c, unsigned char color) {
    const unsigned char *glyph = font_glyph(c);
    unsigned int row, col;
    for (row = 0; row < FONT_HEIGHT; row++) {
        unsigned char bits = glyph[row];
        for (col = 0; col < FONT_WIDTH; col++) {
            if (bits & (0x80u >> col)) {
                vga_pixel(x + col, y + row, color);
            }
        }
    }
}

static void draw_text(unsigned int x, unsigned int y, const char *s, unsigned char color) {
    unsigned int cx = x;
    while (*s) {
        draw_char(cx, y, *s, color);
        cx += FONT_WIDTH;
        s++;
    }
}

#define BDA_SEG_LOCAL   0x0040u
#define BDA_TICKS_LO    0x006Cu
#define BDA_MEMORY_SIZE 0x0013u

static unsigned long read_ticks(void) {
    unsigned char __far *p = (unsigned char __far *)((unsigned long)BDA_SEG_LOCAL << 16);
    unsigned int lo = *(unsigned int __far *)(p + BDA_TICKS_LO);
    unsigned int hi = *(unsigned int __far *)(p + BDA_TICKS_LO + 2);
    return ((unsigned long)hi << 16) | lo;
}

/* BDA ticks don't advance during splash because PIT/IRQ 0 aren't programmed
   yet (BIOS is still initialising). Use a raw busy loop instead — the goal
   is just visual pacing between POST lines. Nested 16-bit loops avoid
   pulling in OpenWatcom's __U4M 32-bit multiply helper. */
static void busy_delay_units(unsigned int units) {
    volatile unsigned int i, j;
    unsigned int u;
    for (u = 0; u < units; u++) {
        for (i = 0; i < 200; i++) {
            for (j = 0; j < 100; j++) { }
        }
    }
}

static void wait_ticks(unsigned int n) {
    busy_delay_units(n);
}

static void wait_until(unsigned long target_tick) {
    (void)target_tick;
    busy_delay_units(20);
}

static void draw_memory_line(unsigned int x, unsigned int y, unsigned char color) {
    unsigned char __far *p = (unsigned char __far *)((unsigned long)BDA_SEG_LOCAL << 16);
    unsigned int kb = *(unsigned int __far *)(p + BDA_MEMORY_SIZE);
    char buf[32];
    const char *prefix = "MEMORY ....... ";
    unsigned int i = 0, j;
    char digits[8];
    unsigned int dlen = 0;
    while (prefix[i]) { buf[i] = prefix[i]; i++; }
    if (kb == 0) {
        digits[dlen++] = '0';
    } else {
        while (kb > 0) {
            digits[dlen++] = (char)('0' + (kb % 10u));
            kb /= 10u;
        }
    }
    for (j = 0; j < dlen; j++) buf[i++] = digits[dlen - 1 - j];
    buf[i++] = 'K';
    buf[i] = 0;
    draw_text(x, y, buf, color);
}

void splash_show(void) {
    unsigned long start_tick;

    set_mode_13h();
    set_palette();

    /* Fill the screen with dark gray so the logo's black outline is
       visible. Doubles as a rough performance gate — until the engine
       is quick, watching this fill is the long pole of splash startup. */
    {
        unsigned int py, px;
        for (py = 0; py < 200; py++) {
            for (px = 0; px < 320; px++) vga_pixel(px, py, 8);
        }
    }

    blit_logo(20, 52, 3);
    draw_text(140, 52, "CSS-DOS",       15);
    draw_text(140, 64, "CSS-BIOS V0.1",  7);

    start_tick = read_ticks();

    draw_text(140,  80, "IVT ........... OK", 7);
    wait_ticks(5);
    draw_text(140,  88, "BDA ........... OK", 7);
    wait_ticks(5);
    draw_memory_line(140, 96, 7);
    wait_ticks(5);
    draw_text(140, 104, "KEYBOARD ...... OK", 7);
    wait_ticks(5);
    draw_text(140, 112, "VIDEO ......... OK", 7);
    wait_ticks(5);

    /* Enforce 2s minimum (36 ticks @ 18.2 Hz). */
    wait_until(start_tick + 36);

    set_mode_text();
}
