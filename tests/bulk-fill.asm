; tests/bulk-fill.asm — CSS bulk-fill semantics smoke test.
;
; Writes the bulk-op scratch region directly (as if an INT 2F handler
; had run). Then halts. The CSS memory-cell range-predicate clause should
; fire on the next tick and fill linear 0x2000..0x200F with 0x42.
;
; Request: fill 16 bytes at linear 0x2000 with byte 0x42.
;   0x510: kind = 1
;   0x511..0x513: dst = 0x002000 (little-endian, 3 bytes)
;   0x514..0x515: count = 16
;   0x516: value = 0x42
    org 0x100
    xor  ax, ax
    mov  ds, ax
    mov  byte [0x510], 1
    mov  byte [0x511], 0x00
    mov  byte [0x512], 0x20
    mov  byte [0x513], 0x00
    mov  byte [0x514], 16
    mov  byte [0x515], 0
    mov  byte [0x516], 0x42
.loop:
    hlt
    jmp  .loop
