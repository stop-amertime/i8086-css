; test_phase3.asm — Exercise Phase 3 instructions for conformance testing
; Assemble: nasm -f bin -o test_phase3.com test_phase3.asm
; Expected output: ABCDEFGHIJKLMNOPQRSTUVWXY
;
; Each test prints a letter if it passes. '!' = fail.

[bits 16]
[cpu 8086]
[org 0x100]

%macro PRINT 1
    mov dl, %1
    mov ah, 0x02
    int 0x21
%endmacro

%macro FAIL_IF_NE 0
    je %%ok
    jmp fail
%%ok:
%endmacro

%macro FAIL_IF_EQ 0
    jne %%ok
    jmp fail
%%ok:
%endmacro

%macro FAIL_IF_NC 0
    jc %%ok
    jmp fail
%%ok:
%endmacro

start:
    cld

    ; --- A: MOVSB ---
    mov si, src_data
    mov di, dst_buf
    movsb
    movsb
    movsb
    cmp byte [dst_buf], 'X'
    FAIL_IF_NE
    cmp byte [dst_buf+2], 'Z'
    FAIL_IF_NE
    PRINT 'A'

    ; --- B: MOVSW ---
    mov si, src_data
    mov di, dst_buf
    movsw
    cmp word [dst_buf], 0x5958  ; 'XY' little-endian
    FAIL_IF_NE
    PRINT 'B'

    ; --- C: CMPSB match ---
    mov si, cmp_s1
    mov di, cmp_s2
    cmpsb
    FAIL_IF_NE
    PRINT 'C'

    ; --- D: CMPSB mismatch ---
    mov si, cmp_s1
    mov di, cmp_s3
    cmpsb
    FAIL_IF_EQ
    PRINT 'D'

    ; --- E: SCASB ---
    mov di, cmp_s1
    mov al, 'H'
    scasb
    FAIL_IF_NE
    PRINT 'E'

    ; --- F: LAHF/SAHF ---
    xor ax, ax              ; ZF=1
    lahf
    test ah, 0x40           ; ZF bit in AH?
    jnz .f_ok
    jmp fail
.f_ok:
    or ah, 0x01             ; set CF in AH
    sahf
    FAIL_IF_NC
    PRINT 'F'

    ; --- G: XCHG reg,reg (0x87) ---
    mov bx, 0x1234
    mov cx, 0x5678
    xchg bx, cx
    cmp bx, 0x5678
    FAIL_IF_NE
    cmp cx, 0x1234
    FAIL_IF_NE
    PRINT 'G'

    ; --- H: IMUL byte ---
    mov al, 0xFD            ; -3
    mov cl, 7
    imul cl                 ; AX = -21 = 0xFFEB
    cmp ax, 0xFFEB
    FAIL_IF_NE
    PRINT 'H'

    ; --- I: IMUL word ---
    mov ax, 0xFFF6          ; -10
    mov bx, 100
    imul bx                 ; DX:AX = -1000
    cmp ax, 0xFC18
    FAIL_IF_NE
    cmp dx, 0xFFFF
    FAIL_IF_NE
    PRINT 'I'

    ; --- J: XLAT ---
    mov bx, xlat_tbl
    mov al, 2
    xlatb                   ; AL = [BX+2] = 'r'
    cmp al, 'r'
    FAIL_IF_NE
    PRINT 'J'

    ; --- K: Group FF INC [mem] ---
    mov word [dst_buf], 0x00FF
    inc word [dst_buf]
    cmp word [dst_buf], 0x0100
    FAIL_IF_NE
    PRINT 'K'

    ; --- L: Group FF DEC [mem] ---
    mov word [dst_buf], 0x0100
    dec word [dst_buf]
    cmp word [dst_buf], 0x00FF
    FAIL_IF_NE
    PRINT 'L'

    ; --- M: Group FF PUSH [mem] ---
    mov word [dst_buf], 0xBEEF
    push word [dst_buf]
    pop ax
    cmp ax, 0xBEEF
    FAIL_IF_NE
    PRINT 'M'

    ; --- N: Group FF CALL [mem] ---
    mov word [dst_buf], ret_n
    call [dst_buf]
    PRINT 'N'
    jmp short past_n
ret_n:
    ret
past_n:

    ; --- O: POP r/m16 (0x8F) ---
    mov ax, 0x4321
    push ax
    pop word [dst_buf]
    cmp word [dst_buf], 0x4321
    FAIL_IF_NE
    PRINT 'O'

    ; --- P: RCL by 1 ---
    stc
    mov al, 0x80
    rcl al, 1               ; CF->bit0, bit7->CF: AL=01, CF=1
    FAIL_IF_NC              ; check CF first (before CMP clobbers it)
    cmp al, 0x01
    FAIL_IF_NE
    PRINT 'P'

    ; --- Q: RCR by 1 ---
    stc
    mov al, 0x01
    rcr al, 1               ; CF->bit7, bit0->CF: AL=80, CF=1
    FAIL_IF_NC              ; check CF first
    cmp al, 0x80
    FAIL_IF_NE
    PRINT 'Q'

    ; --- R: AAM ---
    mov ax, 0x0039          ; AL=57
    aam                     ; AH=5, AL=7
    cmp ah, 5
    FAIL_IF_NE
    cmp al, 7
    FAIL_IF_NE
    PRINT 'R'

    ; --- S: AAD ---
    mov ax, 0x0307          ; AH=3, AL=7
    aad                     ; AL=37, AH=0
    cmp al, 37
    FAIL_IF_NE
    cmp ah, 0
    FAIL_IF_NE
    PRINT 'S'

    ; --- T: SHL by CL ---
    mov al, 0x03
    mov cl, 4
    shl al, cl
    cmp al, 0x30
    FAIL_IF_NE
    PRINT 'T'

    ; --- U: SHR by CL ---
    mov al, 0xF0
    mov cl, 4
    shr al, cl
    cmp al, 0x0F
    FAIL_IF_NE
    PRINT 'U'

    ; --- V: SAR by CL ---
    mov al, 0x80
    mov cl, 2
    sar al, cl
    cmp al, 0xE0
    FAIL_IF_NE
    PRINT 'V'

    ; --- W: IN/OUT stubs ---
    in al, 0x60
    out 0x20, al
    PRINT 'W'

    ; --- X: CMPSW ---
    mov si, cmp_s1
    mov di, cmp_s2
    cmpsw
    FAIL_IF_NE
    PRINT 'X'

    ; --- Y: SCASW ---
    mov di, scas_w
    mov ax, 0xDEAD
    scasw
    FAIL_IF_NE
    PRINT 'Y'

    ; Done
    PRINT 10
    hlt

fail:
    PRINT '!'
    hlt

; Data (keep small, fits in default memory model)
src_data:   db 'X', 'Y', 'Z'
cmp_s1:     db 'Hi'
cmp_s2:     db 'Hi'
cmp_s3:     db 'Xq'
xlat_tbl:   db 'p', 'q', 'r', 's'
scas_w:     dw 0xDEAD
dst_buf:    times 8 db 0
