; IDIV test: -1 / 1 (simplest negative case)
org 0x100
    mov dx, 0xFFFF     ; DX:AX = -1
    mov ax, 0xFFFF
    mov bx, 1
    idiv bx            ; AX=-1 (0xFFFF), DX=0
    int 0x20
