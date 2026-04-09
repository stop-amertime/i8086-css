; BCD instruction test: DAA, DAS, AAA, AAS
; Tests decimal adjust instructions with various inputs.
org 0x100

; ---- DAA tests ----
; DAA adjusts AL after BCD addition

; Test 1: 0x15 + 0x27 = 0x3C, DAA → 0x42 (BCD 42)
mov al, 0x15
add al, 0x27      ; AL = 0x3C
daa               ; AL should become 0x42

; Test 2: 0x99 + 0x01 = 0x9A, DAA → 0x00 with CF=1
mov al, 0x99
add al, 0x01      ; AL = 0x9A
daa               ; AL should become 0x00, CF=1

; Test 3: 0x09 + 0x08 = 0x11, DAA → 0x17
mov al, 0x09
add al, 0x08      ; AL = 0x11, AF=1 (carry out of low nibble)
daa               ; AL should become 0x17

; ---- DAS tests ----
; DAS adjusts AL after BCD subtraction

; Test 4: 0x42 - 0x15 = 0x2D, DAS → 0x27
mov al, 0x42
sub al, 0x15      ; AL = 0x2D
das               ; AL should become 0x27

; Test 5: 0x00 - 0x01 = 0xFF, DAS → 0x99 with CF=1
mov al, 0x00
sub al, 0x01      ; AL = 0xFF, CF=1
das               ; AL should become 0x99, CF=1

; ---- AAA tests ----
; AAA adjusts after ASCII/unpacked BCD addition

; Test 6: '5' + '7' = 0x6C in binary, AAA → AL=0x02, AH+=1
mov ax, 0x0035    ; AH=0, AL='5'
add al, 0x37      ; AL = 0x6C (overflow past 9 in low nibble)
aaa               ; AL = 0x02, AH = 0x01

; Test 7: simple add with no adjust needed
mov ax, 0x0003
add al, 0x04      ; AL = 0x07 (low nibble <= 9, no AF)
aaa               ; AL = 0x07, AH = 0x00 (no adjust)

; ---- AAS tests ----
; AAS adjusts after ASCII/unpacked BCD subtraction

; Test 8: '5' - '7', AAS adjusts
mov ax, 0x0035    ; AH=0, AL='5'
sub al, 0x37      ; AL = 0xFE (borrow), AF set
aas               ; AL = 0x08, AH = 0xFF

; Test 9: simple sub no adjust
mov ax, 0x0007
sub al, 0x03      ; AL = 0x04 (low nibble ok)
aas               ; AL = 0x04, AH = 0x00

; Exit
int 0x20
