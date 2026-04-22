; mode13_plasma.asm — VGA Mode 13h plasma animation stress test
;
; Full-frame animated plasma. Every pixel changes every frame,
; giving us worst-case paint load for the div-per-pixel grid.
;
; Formula per pixel: color = (x + y + frame) & 255
; That's a trivial additive pattern — not a real plasma — but the
; important property is ALL 64000 pixels write and ALL change every
; frame, exercising the full paint path.
;
; After filling the framebuffer we loop back to do it again with
; frame+=1. Runs forever.
;
; BIOS constraints:
;   - No 0x0F-prefixed opcodes (near Jcc)
;   - No segment override prefixes
;   - All memory access uses DS
;
; Build:
;   nasm -f bin -o tests/mode13_plasma.com tests/mode13_plasma.asm

[bits 16]
[org 0x100]

start:
    ; Set video mode 13h
    mov ax, 0x0013
    int 0x10

    ; DS = 0xA000 (framebuffer segment)
    mov ax, 0xA000
    mov ds, ax

    xor bp, bp              ; BP = frame counter

.frame:
    xor di, di              ; DI = linear offset
    xor dx, dx              ; DX = y (0..199)

.row_loop:
    xor cx, cx              ; CX = x (0..319)
.col_loop:
    mov ax, dx
    add ax, cx
    add ax, bp              ; AX = x + y + frame
    mov [di], al            ; byte truncation gives 0..255
    inc di
    inc cx
    cmp cx, 320
    jb .col_loop
    inc dx
    cmp dx, 200
    jb .row_loop

    inc bp                  ; next frame
    jmp .frame
