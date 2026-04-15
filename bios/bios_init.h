/* bios_init.h -- CSS-BIOS init entry point and helpers. */
#ifndef BIOS_INIT_H
#define BIOS_INIT_H

#define BIOS_SEG   0xF000u
#define BDA_SEG    0x0040u
#define KERNEL_SEG 0x0060u

static void poke_b(unsigned int seg, unsigned int off, unsigned char v) {
    unsigned char __far *p = (unsigned char __far *)(((unsigned long)seg << 16) | off);
    *p = v;
}
static void poke_w(unsigned int seg, unsigned int off, unsigned int v) {
    unsigned int __far *p = (unsigned int __far *)(((unsigned long)seg << 16) | off);
    *p = v;
}
static unsigned int peek_w(unsigned int seg, unsigned int off) {
    unsigned int __far *p = (unsigned int __far *)(((unsigned long)seg << 16) | off);
    return *p;
}

void bios_init(void);

#endif
