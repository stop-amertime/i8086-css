; mode13_gradient.asm — VGA Mode 13h smoke test
;
; Sets video mode 13h (320x200x256), fills the framebuffer at
; 0xA0000 with a diagonal gradient (byte = (x+y) & 15), then exits.
; All 16 palette colors should appear as diagonal bands.
;
; BIOS constraints (from CLAUDE.md / bios/gossamer.asm):
; - No 0x0F-prefixed opcodes (near Jcc)
; - No segment override prefixes
; - All memory access uses DS (not ES)
;
; Build:
;   nasm -f bin -o tests/mode13_gradient.com tests/mode13_gradient.asm
; Generate CSS:
;   node transpiler/generate-hacky.mjs tests/mode13_gradient.com --graphics -o tests/mode13_gradient.css
; Render framebuffer:
;   calcite --input tests/mode13_gradient.css --ticks 200000 \
;           --halt 0x2110 --framebuffer 0xA0000 320x200 out.ppm

[bits 16]
[org 0x100]

start:
    ; Set video mode 13h
    mov ax, 0x0013
    int 0x10

    ; DS = 0xA000 (framebuffer segment)
    mov ax, 0xA000
    mov ds, ax

    ; Fill 320x200 = 64000 bytes with (x+y) & 15
    ; We iterate by linear offset and derive (x,y) via div/mod,
    ; but that's slow. Instead: nested loops.
    xor di, di              ; DI = linear offset into framebuffer
    xor dx, dx              ; DX = row (y), 0..199
.row_loop:
    xor cx, cx              ; CX = column (x), 0..319
.col_loop:
    mov ax, dx
    add ax, cx              ; AX = x + y
    and al, 0x0F            ; palette index 0..15
    mov [di], al            ; write pixel
    inc di
    inc cx
    cmp cx, 320
    jb .col_loop
    inc dx
    cmp dx, 200
    jb .row_loop

    ; Exit
    int 0x20
