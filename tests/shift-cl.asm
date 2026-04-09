; Test: Shift by CL (opcodes 0xD2/0xD3)
; Exercises SHL, SHR, SAR, ROL, ROR with variable CL counts.
; Results stored in registers for trace comparison.
org 0x100

    ; SHL AX, CL: 0x1234 << 4 = 0x2340
    mov ax, 0x1234
    mov cl, 4
    shl ax, cl
    mov bx, ax         ; BX = 0x2340

    ; SHR AX, CL: 0x8042 >> 3 = 0x1008
    mov ax, 0x8042
    mov cl, 3
    shr ax, cl
    mov dx, ax         ; DX = 0x1008

    ; SAR AX, CL: 0xFF80 >> 2 (arithmetic) = 0xFFE0
    mov ax, 0xFF80
    mov cl, 2
    sar ax, cl
    mov si, ax         ; SI = 0xFFE0

    ; ROL AX, CL: ROL(0x1234, 4) = 0x2341
    mov ax, 0x1234
    mov cl, 4
    rol ax, cl
    mov di, ax         ; DI = 0x2341

    ; ROR AX, CL: ROR(0x1234, 4) = 0x4123
    mov ax, 0x1234
    mov cl, 4
    ror ax, cl          ; AX = 0x4123

    ; 8-bit: SHL AL, CL: 0x0F << 2 = 0x3C
    mov al, 0x0F
    mov cl, 2
    shl al, cl          ; AL = 0x3C, AH still 0x41

    int 0x20
