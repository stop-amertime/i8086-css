; IDIV test: positive dividend only
org 0x100
    ; Test: 10000 / 300 = 33 remainder 100
    xor dx, dx
    mov ax, 10000
    mov bx, 300
    idiv bx              ; AX=33 (0x21), DX=100 (0x64)
    int 0x20
