; mode13_logo.asm — CSS-DOS boot splash in VGA Mode 13h.
;
; Sets video mode 13h, blits the 32x32 CSS-DOS logo (embedded via
; incbin) into the framebuffer at 4x nearest-neighbor scale, centered.
;
; BIOS constraints: no 0x0F-prefixed Jcc, no segment override prefixes,
; all memory access via DS. So we can't use ES for the framebuffer —
; we push DS, swap to 0xA000, write, pop DS back, for each source pixel.
;
; Layout:
;   source: 32x32 palette indexes at label `logo` (DS=0)
;   dest  : 128x128 block, top-left at (96, 36), centered in 320x200
;
; Build:
;   nasm -f bin -o tests/mode13_logo.com tests/mode13_logo.asm
; Generate CSS:
;   node transpiler/generate-hacky.mjs tests/mode13_logo.com --graphics -o tests/mode13_logo.css
; Render:
;   calcite --input tests/mode13_logo.css --ticks 5000000 --halt 0x2110 \
;           --framebuffer 0xA0000 320x200 tests/mode13_logo.ppm

[bits 16]
[org 0x100]

%define LOGO_W   32
%define LOGO_H   32
%define SCALE    4
%define DEST_W   (LOGO_W * SCALE)        ; 128
%define DEST_H   (LOGO_H * SCALE)        ; 128
%define SCR_W    320
%define DEST_X   ((320 - DEST_W) / 2)    ; 96
%define DEST_Y   ((200 - DEST_H) / 2)    ; 36
%define DEST_OFF (DEST_Y * SCR_W + DEST_X)  ; top-left linear offset

start:
    ; --- Set video mode 13h ---
    mov ax, 0x0013
    int 0x10

    ; --- Blit loop ---
    ; DI = destination linear offset within framebuffer (relative to 0xA000:0)
    ; SI = source pointer into `logo` (relative to DS=0)
    ; BP = source row counter (0..LOGO_H-1)
    ; CX = source column counter (0..LOGO_W-1)
    ;
    ; At the start of each source row, DI is set to the top-left of that
    ; row's scaled output band: DI = DEST_OFF + sy * SCALE * SCR_W.
    ;
    ; For each source pixel:
    ;   Read pixel AL (DS=0)
    ;   Swap DS to 0xA000
    ;   Write SCALE pixels horizontally on SCALE consecutive rows
    ;   Swap DS back to 0
    ;   Advance DI by SCALE, advance SI by 1
    ; After a full source row, advance DI by (SCALE-1) * SCR_W so that
    ; the next source row's first pixel lands SCALE rows below.

    mov si, logo
    mov di, DEST_OFF
    xor bp, bp                     ; sy = 0
.row_loop:
    mov cx, LOGO_W
.pixel_loop:
    mov al, [si]                   ; read source pixel (DS=0, AL = palette index)
    inc si

    ; --- Framebuffer write: push DS, swap to VGA, write 4x4 block ---
    push ds
    push bx
    mov bx, 0xA000
    mov ds, bx
    ; Four rows of four pixels each:
    ; Row 0:
    mov [di],       al
    mov [di + 1],   al
    mov [di + 2],   al
    mov [di + 3],   al
    ; Row 1 (+320):
    mov [di + 320], al
    mov [di + 321], al
    mov [di + 322], al
    mov [di + 323], al
    ; Row 2 (+640):
    mov [di + 640], al
    mov [di + 641], al
    mov [di + 642], al
    mov [di + 643], al
    ; Row 3 (+960):
    mov [di + 960], al
    mov [di + 961], al
    mov [di + 962], al
    mov [di + 963], al
    pop bx
    pop ds

    add di, SCALE                  ; next source-pixel column slot (4 px right)
    dec cx
    jnz .pixel_loop

    ; End of source row: DI is currently at (sy_band_start + LOGO_W*SCALE),
    ; i.e. DEST_X+DEST_W on the *first* row of the band. The next source
    ; row needs DI = start of the next band = sy_band_start + SCALE*SCR_W.
    ; So: drop SCALE rows (+SCALE*SCR_W) and rewind DEST_W columns.
    add di, SCALE * SCR_W          ; drop SCALE rows
    sub di, DEST_W                 ; rewind to column DEST_X

    inc bp
    cmp bp, LOGO_H
    jb .row_loop

    ; --- Halt ---
    int 0x20

align 2
logo:
    incbin "tests/logo.bin"
