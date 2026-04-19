; mov-heavy: tight loop of reg-reg MOVs.
;
; Purpose: control benchmark. Gating memory-write slots should NOT
; change the speed of this workload — every instruction is a register
; move, no memory writes. If this cart gets faster after the gating
; change, something unrelated is going on.
;
; Loop body is 16 reg-reg MOVs + a JMP back to the top. Each MOV is
; 2 bytes, JMP is 2 bytes (short). The loop never exits — the
; benchmark runs a fixed number of ticks.

org 0x100

start:
    mov ax, bx
    mov bx, cx
    mov cx, dx
    mov dx, si
    mov si, di
    mov di, bp
    mov bp, ax
    mov ax, cx
    mov bx, dx
    mov cx, si
    mov dx, di
    mov si, bp
    mov di, ax
    mov bp, bx
    mov ax, si
    mov bx, di
    jmp start
