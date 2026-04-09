; Test CALL FAR indirect and JMP FAR indirect (0xFF /3 and /5)
org 0x100

; Set up a far pointer in memory at a known location
; We'll put it at DS:0x200 (absolute 0x300 since DS=0 for .COM, but actually
; for .COM DS=CS=PSP segment. Let's use a simpler approach.)

; Setup: store target address at [0x180] (within our data area)
; JMP FAR indirect target: seg=CS, offset=target1
mov word [0x180], target1  ; offset
mov word [0x182], cs       ; segment

; CALL FAR indirect target: seg=CS, offset=target2
mov word [0x184], target2  ; offset
mov word [0x186], cs       ; segment

; ---- Test JMP FAR indirect ----
mov ax, 0x1111             ; marker
jmp far [0x180]            ; JMP FAR indirect → target1

; Should not reach here
mov ax, 0xDEAD
int 0x20

target1:
mov bx, 0x2222             ; verify we got here

; ---- Test CALL FAR indirect ----
call far [0x184]           ; CALL FAR indirect → target2

; Return here after target2 does RETF
mov dx, 0x4444             ; verify return worked
int 0x20

target2:
mov cx, 0x3333             ; verify we got here
retf                       ; return to caller
