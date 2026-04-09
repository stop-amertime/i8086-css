; Test WAIT, LOCK, and ESC instructions (should be no-ops)
org 0x100

; Simple register setup to verify state is preserved
mov ax, 0x1234
mov bx, 0x5678
mov cx, 0xABCD

; WAIT — should be a no-op (1 byte)
db 0x9B            ; WAIT

; Verify AX preserved
nop

; LOCK — should be a no-op (1 byte)
db 0xF0            ; LOCK
nop                ; (LOCK as standalone no-op, not prefix)

; ESC 0 with register operand (mod=11, 2 bytes total)
; ESC 0, AX = 0xD8 0xC0
db 0xD8, 0xC0

; ESC 3 with register operand
; ESC 3, BX = 0xDB 0xC3
db 0xDB, 0xC3

; Verify all registers still intact
mov dx, ax         ; DX should be 0x1234

; Exit
int 0x20
