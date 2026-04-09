; Test: REP prefix with all string operations
; Validates REP STOSB, REP MOVSB, REP LODSB, REPE CMPSB, REPNE SCASB
org 0x100

    ; === Setup: ES=DS=0 ===
    xor ax, ax
    mov es, ax

    ; === Test 1: REP STOSB — fill 4 bytes at 0x300 with 0xAA ===
    mov di, 0x300
    mov cx, 4
    mov al, 0xAA
    cld                    ; DF=0, forward direction
    rep stosb
    ; Expected: CX=0, DI=0x304, mem[0x300..0x303]=0xAA
    mov bx, cx             ; BX = 0 (CX after REP)
    mov si, di             ; SI = 0x304 (DI after REP)

    ; === Test 2: REP STOSW — fill 3 words at 0x310 with 0xBBCC ===
    mov di, 0x310
    mov cx, 3
    mov ax, 0xBBCC
    rep stosw
    ; Expected: CX=0, DI=0x316
    mov bp, di             ; BP = 0x316

    ; === Test 3: REP MOVSB — copy 4 bytes from 0x300 to 0x320 ===
    mov si, 0x300
    mov di, 0x320
    mov cx, 4
    rep movsb
    ; Expected: CX=0, SI=0x304, DI=0x324, mem[0x320..0x323]=0xAA
    ; Verify by reading back
    mov ax, [0x320]        ; AX = 0xAAAA (first two copied bytes)
    mov dx, ax             ; DX = 0xAAAA (save)

    ; === Test 4: REP LODSB — load 3 bytes from 0x300, AL gets last ===
    mov si, 0x300
    mov cx, 3
    rep lodsb
    ; Expected: CX=0, SI=0x303, AL=0xAA (all bytes are 0xAA)
    ; AX high byte is from the STOSW value, low byte = 0xAA
    mov bx, ax             ; BX = AX after LODSB (AL=0xAA)

    ; === Test 5: REP with CX=0 — should skip entirely ===
    mov cx, 0
    mov di, 0x330
    mov al, 0xFF
    rep stosb
    ; Expected: CX=0, DI=0x330 (unchanged), no memory writes
    ; DI should still be 0x330
    mov si, di             ; SI = 0x330

    ; === Test 6: REPE CMPSB — compare matching then mismatching ===
    ; Set up: 0x340 = "ABCD", 0x350 = "ABXD"
    mov byte [0x340], 'A'
    mov byte [0x341], 'B'
    mov byte [0x342], 'C'
    mov byte [0x343], 'D'
    mov byte [0x350], 'A'
    mov byte [0x351], 'B'
    mov byte [0x352], 'X'   ; mismatch at byte 3
    mov byte [0x353], 'D'

    mov si, 0x340
    mov di, 0x350
    mov cx, 4
    repe cmpsb
    ; Expected: stops at mismatch (byte 3: 'C' vs 'X')
    ; CX=1 (decremented from 4 to 1 before stopping), SI=0x343, DI=0x353

    ; Store results for trace inspection
    mov dx, cx             ; DX = 1 (remaining CX)

    ; === Test 7: REPNE SCASB — scan for 'C' in "ABCD" at 0x340 ===
    mov di, 0x340
    mov cx, 4
    mov al, 'C'
    repne scasb
    ; Expected: finds 'C' at offset 2, CX=1, DI=0x343
    mov bx, cx             ; BX = 1 (remaining CX)
    mov bp, di             ; BP = 0x343

    int 0x20
