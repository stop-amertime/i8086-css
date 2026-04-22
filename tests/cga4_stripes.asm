; cga4_stripes.asm — CGA mode 0x04 (320x200x4) smoke test
;
; Sets video mode 0x04, selects palette 1 intensified (cyan/magenta/white)
; with black background via port 0x3D9, then paints four horizontal bands
; using colour indices 0, 1, 2, 3. A working CGA 0x04 decoder renders:
;   rows   0.. 49 black        (colour 0 = bg from palette reg)
;   rows  50.. 99 bright cyan  (colour 1)
;   rows 100..149 bright magenta (colour 2)
;   rows 150..199 white        (colour 3)
;
; Framebuffer layout: 2 bpp scanline-interleaved at 0xB8000:
;   B800:0000  even scanlines (0, 2, 4, ..., 198)
;   B800:2000  odd  scanlines (1, 3, 5, ..., 199)
;   80 bytes per scanline (320 px / 4 px per byte).
;   byte layout: bits 7..6 = px0, 5..4 = px1, 3..2 = px2, 1..0 = px3
;
; Build:
;   nasm -f bin -o tests/cga4_stripes.com tests/cga4_stripes.asm

[bits 16]
[cpu 8086]
[org 0x100]

start:
    mov ax, 0x0004         ; set CGA mode 0x04
    int 0x10

    ; CGA palette register: palette 1 + intensity + bg=black.
    ;   bit 5 = palette set (1 → cyan/magenta/white)
    ;   bit 4 = intensity   (1 → bright bank)
    ;   bits 3..0 = colour 0 (background) — 0 = black
    mov dx, 0x3D9
    mov al, 0x30
    out dx, al

    mov ax, 0xB800
    mov es, ax

    ; SI = row counter 0..199. DX/AX/CX are used for maths inside the loop.
    xor si, si
.row_loop:
    ; --- choose colour (SI / 50) via compare chain ---
    xor bl, bl             ; BL = colour
    cmp si, 50
    jb .have_colour
    mov bl, 1
    cmp si, 100
    jb .have_colour
    mov bl, 2
    cmp si, 150
    jb .have_colour
    mov bl, 3
.have_colour:
    ; --- build fill word: colour replicated to every 2 bits of each byte ---
    ; colour c → byte c*0x55 (c | c<<2 | c<<4 | c<<6), word = that byte twice.
    mov al, bl
    mov bh, 0x55
    mul bh                 ; AX = c * 0x55 (AH = 0 since c ≤ 3 → product < 256)
    mov ah, al             ; word = byte:byte so STOSW paints 4 px per byte

    ; --- compute DI = (y>>1) * 80 + (y & 1) * 0x2000 ---
    mov bx, si
    shr bx, 1              ; BX = y >> 1 (scanline inside its plane)
    ; DI = BX * 80 (use shift-and-add, avoids clobbering DX with MUL)
    mov di, bx
    shl di, 1              ; *2
    shl di, 1              ; *4
    shl di, 1              ; *8
    shl di, 1              ; *16
    mov cx, bx
    shl cx, 1              ; *2
    shl cx, 1              ; *4
    shl cx, 1              ; *8
    shl cx, 1              ; *16
    shl cx, 1              ; *32
    shl cx, 1              ; *64
    add di, cx             ; DI = BX*16 + BX*64 = BX*80
    mov bx, si
    and bx, 1
    jz .even_plane
    add di, 0x2000
.even_plane:

    mov cx, 40             ; 40 words = 80 bytes = one scanline
    cld
    rep stosw

    inc si
    cmp si, 200
    jb .row_loop

.halt:
    hlt
    jmp .halt
