; Minimal IDIV word test: -10000 / 300
org 0x100
    mov dx, 0xFFFF
    mov ax, 0xD8F0
    mov bx, 300
    idiv bx              ; AX=-33 (0xFFDF), DX=-100 (0xFF9C)
    int 0x20
