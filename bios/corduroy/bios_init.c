/* bios_init.c -- CSS-BIOS init. IVT + BDA + splash. */
#include "bios_init.h"
#include "splash.h"

/* BDA offsets -- mirror css-emu-bios.asm:40-72 exactly. */
#define BDA_EQUIPMENT_LIST    0x10
#define BDA_MEMORY_SIZE       0x13
#define BDA_KBD_FLAGS_1       0x17
#define BDA_KBD_ALT_KEYPAD    0x19
#define BDA_KBD_BUFFER_HEAD   0x1A
#define BDA_KBD_BUFFER_TAIL   0x1C
#define BDA_KBD_BUFFER        0x1E
#define BDA_FDC_CALIB_STATE   0x3E
#define BDA_FDC_MOTOR_STATE   0x3F
#define BDA_FDC_MOTOR_TOUT    0x40
#define BDA_FDC_LAST_ERROR    0x41
#define BDA_VIDEO_MODE        0x49
#define BDA_VIDEO_COLUMNS     0x4A
#define BDA_VIDEO_PAGE_SIZE   0x4C
#define BDA_VIDEO_PAGE_OFFT   0x4E
#define BDA_VIDEO_CUR_POS     0x50
#define BDA_VIDEO_CUR_SHAPE   0x60
#define BDA_VIDEO_PAGE        0x62
#define BDA_VIDEO_PORT        0x63
#define BDA_TICKS_LO          0x6C
#define BDA_TICKS_HI          0x6E
#define BDA_NEW_DAY           0x70
#define BDA_WARM_BOOT         0x72
#define BDA_KBD_BUFFER_START  0x80
#define BDA_KBD_BUFFER_END    0x82
#define BDA_VIDEO_ROWS        0x84
#define BDA_VIDEO_CHAR_HEIGHT 0x85

/* Handlers exported from handlers.asm. The #pragma aux forces the exact
   linker-visible symbol name (no leading/trailing underscore). */
extern void int_dummy(void);
extern void int01h_handler(void);
extern void int08h_handler(void);
extern void int09h_handler(void);
extern void int10h_handler(void);
extern void int11h_handler(void);
extern void int12h_handler(void);
extern void int13h_handler(void);
extern void int15h_handler(void);
extern void int16h_handler(void);
extern void int19h_handler(void);
extern void int1ah_handler(void);
extern void int20h_handler(void);
extern void default_handler(void);

#pragma aux int_dummy       "*"
#pragma aux int01h_handler  "*"
#pragma aux int08h_handler  "*"
#pragma aux int09h_handler  "*"
#pragma aux int10h_handler  "*"
#pragma aux int11h_handler  "*"
#pragma aux int12h_handler  "*"
#pragma aux int13h_handler  "*"
#pragma aux int15h_handler  "*"
#pragma aux int16h_handler  "*"
#pragma aux int19h_handler  "*"
#pragma aux int1ah_handler  "*"
#pragma aux int20h_handler  "*"
#pragma aux default_handler "*"

#define HANDLER_OFF(fn) ((unsigned int)(void __near *)(fn))

static void install_ivt(void) {
    /* Use a single far pointer to the IVT and write entries with a direct
       loop — no function calls. The BIOS stack lives at 0x30:0x100 (linear
       0x400), overlapping the tail of the IVT. If we called poke_w() here,
       its pushed return address at linear 0x3FE-0x3FF would collide with
       the IVT entry 0xFF we are writing. Inline writes avoid any push/pop
       during the fill. */
    unsigned int __far *ivt = (unsigned int __far *)0x00000000UL;
    unsigned int i;
    unsigned int dummy_off = HANDLER_OFF(int_dummy);

    for (i = 0; i < 256; i++) {
        ivt[i * 2 + 0] = dummy_off;
        ivt[i * 2 + 1] = BIOS_SEG;
    }

    ivt[0x01 * 2] = HANDLER_OFF(int01h_handler);
    ivt[0x08 * 2] = HANDLER_OFF(int08h_handler);
    ivt[0x09 * 2] = HANDLER_OFF(int09h_handler);
    ivt[0x10 * 2] = HANDLER_OFF(int10h_handler);
    ivt[0x11 * 2] = HANDLER_OFF(int11h_handler);
    ivt[0x12 * 2] = HANDLER_OFF(int12h_handler);
    ivt[0x13 * 2] = HANDLER_OFF(int13h_handler);
    ivt[0x15 * 2] = HANDLER_OFF(int15h_handler);
    ivt[0x16 * 2] = HANDLER_OFF(int16h_handler);
    ivt[0x19 * 2] = HANDLER_OFF(int19h_handler);
    ivt[0x1A * 2] = HANDLER_OFF(int1ah_handler);
    ivt[0x20 * 2] = HANDLER_OFF(int20h_handler);
    ivt[0x21 * 2] = HANDLER_OFF(default_handler);
}

/* Conventional memory size in KB, written into BDA so INT 12h and any
   kernel that asks (EDR-DOS calls INT 12h, then uses the result to
   relocate itself to the top of memory) get the real number. The
   builder patches this to `memBytes / 1024` after link time by scanning
   bios.bin for the 16-bit signature 0xBEEF; the initial value must not
   appear anywhere else in the binary. 0xBEEF is 48879 decimal, a value
   no realistic machine has (and not a round KB number), which avoids
   collision with legitimate constants. */
static volatile unsigned int conventional_mem_kb = 0xBEEF;

static void install_bda(void) {
    poke_w(BDA_SEG, BDA_EQUIPMENT_LIST, 0x0021);
    poke_w(BDA_SEG, BDA_MEMORY_SIZE, conventional_mem_kb);

    poke_w(BDA_SEG, BDA_KBD_BUFFER_HEAD, BDA_KBD_BUFFER);
    poke_w(BDA_SEG, BDA_KBD_BUFFER_TAIL, BDA_KBD_BUFFER);
    poke_w(BDA_SEG, BDA_KBD_BUFFER_START, BDA_KBD_BUFFER);
    poke_w(BDA_SEG, BDA_KBD_BUFFER_END, BDA_KBD_BUFFER + 0x20);
    poke_w(BDA_SEG, BDA_KBD_FLAGS_1, 0);
    poke_b(BDA_SEG, BDA_KBD_ALT_KEYPAD, 0);

    poke_b(BDA_SEG, BDA_VIDEO_MODE, 0x03);
    poke_w(BDA_SEG, BDA_VIDEO_COLUMNS, 80);
    poke_w(BDA_SEG, BDA_VIDEO_PAGE_SIZE, 0x1000);
    poke_w(BDA_SEG, BDA_VIDEO_PAGE_OFFT, 0x0000);
    poke_w(BDA_SEG, BDA_VIDEO_CUR_POS + 0, 0x0000);
    poke_w(BDA_SEG, BDA_VIDEO_CUR_POS + 2, 0x0000);
    poke_w(BDA_SEG, BDA_VIDEO_CUR_POS + 4, 0x0000);
    poke_w(BDA_SEG, BDA_VIDEO_CUR_POS + 6, 0x0000);
    poke_w(BDA_SEG, BDA_VIDEO_CUR_SHAPE, 0x0607);
    poke_b(BDA_SEG, BDA_VIDEO_PAGE, 0x00);
    poke_w(BDA_SEG, BDA_VIDEO_PORT, 0x03D4);
    poke_b(BDA_SEG, BDA_VIDEO_ROWS, 24);
    poke_w(BDA_SEG, BDA_VIDEO_CHAR_HEIGHT, 16);

    poke_w(BDA_SEG, BDA_TICKS_LO, 0);
    poke_w(BDA_SEG, BDA_TICKS_HI, 0);
    poke_b(BDA_SEG, BDA_NEW_DAY, 0);

    poke_b(BDA_SEG, BDA_FDC_CALIB_STATE, 0);
    poke_b(BDA_SEG, BDA_FDC_MOTOR_STATE, 0);
    poke_b(BDA_SEG, BDA_FDC_MOTOR_TOUT, 0);
    poke_b(BDA_SEG, BDA_FDC_LAST_ERROR, 0);

    poke_w(BDA_SEG, BDA_WARM_BOOT, 0);
}

void bios_init(void) {
    install_ivt();
    install_bda();
    splash_show();
}
