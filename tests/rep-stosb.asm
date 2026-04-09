; Test: REP STOSB prefix
; Fill 5 bytes at 0x200 with 0x42 using REP STOSB, then read back.
org 0x100

    ; Setup ES:DI destination
    mov ax, 0
    mov es, ax
    mov di, 0x200
    mov cx, 5
    mov al, 0x42

    ; REP STOSB: fill [ES:DI] with AL, CX times
    rep stosb

    ; After: CX=0, DI=0x205
    mov si, di          ; SI = 0x205 (save DI)

    ; Read back first word: should be 0x4242
    mov bx, [0x200]

    ; Read back last byte area: [0x204]=0x42, [0x205]=0x00 → DX=0x0042
    mov dx, [0x204]

    int 0x20
