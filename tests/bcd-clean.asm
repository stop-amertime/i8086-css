; BCD instruction test — avoids logic-op AF dependencies
; Uses ADD/SUB (which set AF correctly) before BCD adjustments
org 0x100

; ---- DAA tests ----
; Test 1: 0x15 + 0x27 = 0x3C, DAA → 0x42
mov al, 0x15
add al, 0x27      ; AL=0x3C, AF=0 (5+7=12, carry from nibble)
daa               ; lowNib=0xC>9 → AL=0x42

; Test 2: 0x99 + 0x01 = 0x9A, DAA → 0x00, CF=1
mov al, 0x99
add al, 0x01      ; AL=0x9A, AF=1
daa               ; phase1: +6→0xA0, phase2: +0x60→0x00, CF=1

; Test 3: 0x09 + 0x08 = 0x11, AF=1, DAA → 0x17
mov al, 0x09
add al, 0x08      ; AL=0x11, AF=1 (9+8=17 carry from low nibble)
daa               ; AF triggers: +6→0x17

; Test 4: 0x50 + 0x50 = 0xA0, DAA → 0x00 with CF=1 (via phase2)
mov al, 0x50
add al, 0x50      ; AL=0xA0, no AF
daa               ; lowNib=0 not>9, AF=0→no phase1. oldAL=0xA0>0x99→phase2: +0x60→0x00, CF=1

; ---- DAS tests ----
; Test 5: 0x42 - 0x15 = 0x2D, DAS → 0x27
mov al, 0x42
sub al, 0x15      ; AL=0x2D, AF=1 (2-5 borrows)
das               ; AF→phase1: -6→0x27

; Test 6: 0x00 - 0x01 = 0xFF, CF=1, DAS → 0x99, CF=1
mov al, 0x00
sub al, 0x01      ; AL=0xFF, CF=1, AF=1
das               ; phase1: 0xFF-6=0xF9, phase2: 0xF9-0x60=0x99, CF=1

; Test 7: 0x83 - 0x15 = 0x6E, DAS → 0x68
mov al, 0x83
sub al, 0x15      ; AL=0x6E, AF=1 (3-5 borrows)
das               ; AF→phase1: -6→0x68

; ---- AAA tests ----
; Test 8: low nibble > 9 triggers AAA
mov ax, 0
add al, 0x0C      ; AL=0x0C, AF=1
aaa               ; lowNib=0xC>9: AL=(0x0C+6)&0xF=2, AH=1

; Test 9: no adjust needed
mov ax, 0
add al, 0x05      ; AL=0x05, AF=0
aaa               ; lowNib=5 not>9, AF=0: no change, AL=5, AH=0

; ---- AAS tests ----
; Test 10: borrow triggers AAS
mov ax, 0x0100    ; AH=1, AL=0
sub al, 0x05      ; AL=0xFB, AF=1
aas               ; AF→ (0xFB-6)&0xF = 5, AH=0

; Test 11: no adjust
mov ax, 0x0009
sub al, 0x03      ; AL=0x06, AF=0
aas               ; no adjust, AL=6, AH=0

; ---- Cross-check: BCD addition then subtraction ----
; 29 + 43 = 72 (BCD), then 72 - 29 = 43 (BCD)
mov al, 0x29
add al, 0x43      ; AL=0x6C
daa               ; AL=0x72

mov bl, al        ; save BL=0x72
sub al, 0x29      ; AL=0x49
das               ; AL=0x43

; Exit
int 0x20
