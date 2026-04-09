; Test: IDIV (signed division)
; Exercises IDIV byte and word with various sign combinations.
; Results stored in registers for trace comparison.
org 0x100

    ; === IDIV byte (F6 /7): AX / r/m8 → AL=quotient, AH=remainder ===

    ; Test 1: positive / positive: 100 / 7 = 14 remainder 2
    mov ax, 100
    mov bl, 7
    idiv bl              ; AL=14 (0x0E), AH=2 (0x02) → AX=0x020E
    mov cx, ax           ; CX = 0x020E

    ; Test 2: negative / positive: -100 / 7 = -14 remainder -2
    ; -100 = 0xFF9C as unsigned 16-bit
    mov ax, 0xFF9C
    mov bl, 7
    idiv bl              ; AL=-14 (0xF2), AH=-2 (0xFE) → AX=0xFEF2
    mov dx, ax           ; DX = 0xFEF2

    ; Test 3: positive / negative: 100 / -7 = -14 remainder 2
    ; -7 = 0xF9 as unsigned 8-bit
    mov ax, 100
    mov bl, 0xF9
    idiv bl              ; AL=-14 (0xF2), AH=2 (0x02) → AX=0x02F2
    mov si, ax           ; SI = 0x02F2

    ; Test 4: negative / negative: -100 / -7 = 14 remainder -2
    mov ax, 0xFF9C
    mov bl, 0xF9
    idiv bl              ; AL=14 (0x0E), AH=-2 (0xFE) → AX=0xFE0E
    mov di, ax           ; DI = 0xFE0E

    ; === IDIV word (F7 /7): DX:AX / r/m16 → AX=quotient, DX=remainder ===

    ; Test 5: positive / positive: 10000 / 300 = 33 remainder 100
    xor dx, dx
    mov ax, 10000
    mov bx, 300
    idiv bx              ; AX=33 (0x0021), DX=100 (0x0064)
    mov cx, ax           ; CX = 0x0021
    mov si, dx           ; SI = 0x0064

    ; Test 6: negative / positive: -10000 / 300 = -33 remainder -100
    ; -10000 as DX:AX = 0xFFFF:0xD8F0
    mov dx, 0xFFFF
    mov ax, 0xD8F0
    mov bx, 300
    idiv bx              ; AX=-33 (0xFFDF), DX=-100 (0xFF9C)
    mov cx, ax           ; CX = 0xFFDF
    mov si, dx           ; SI = 0xFF9C

    ; Test 7: positive / negative: 10000 / -300 = -33 remainder 100
    xor dx, dx
    mov ax, 10000
    mov bx, 0xFED4       ; -300 as unsigned 16-bit
    idiv bx              ; AX=-33 (0xFFDF), DX=100 (0x0064)
    mov di, ax           ; DI = 0xFFDF

    ; Test 8: small values: 1 / 1 = 1 remainder 0
    xor dx, dx
    mov ax, 1
    mov bx, 1
    idiv bx              ; AX=1, DX=0

    ; Test 9: -1 / 1 = -1 remainder 0
    mov dx, 0xFFFF
    mov ax, 0xFFFF
    mov bx, 1
    idiv bx              ; AX=0xFFFF (-1), DX=0

    int 0x20
