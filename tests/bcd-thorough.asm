; Thorough BCD instruction tests — edge cases and flag verification
org 0x100

; ---- DAA edge cases ----
; Case: AL=0x00 after add (no adjust)
xor ax, ax
daa                     ; AL=0, no change

; Case: low nibble exactly 0x0A
mov al, 0x0A
clc
daa                     ; AL should become 0x10

; Case: AL=0x9A (both adjusts fire)
mov al, 0x9A
clc
daa                     ; phase1: AL=0xA0, phase2: AL=0x00, CF=1

; Case: AL=0xFF with CF=1
mov al, 0xFF
stc                     ; set CF
daa                     ; AL=0x65, CF=1

; Case: AF set from previous add
mov al, 0x06
add al, 0x0A           ; AL=0x10, AF=1
daa                     ; AF triggers phase1: AL=0x16

; ---- DAS edge cases ----
; Case: AL=0x00 (no adjust)
xor ax, ax
das                     ; AL=0, no change

; Case: low nibble = 0x0A
mov al, 0x0A
clc
das                     ; phase1: AL=0x04, AF=1

; Case: AL=0xFF, CF=1
mov al, 0xFF
stc
das                     ; phase1: AL-6=0xF9, phase2: 0xF9-0x60=0x99, CF=1

; ---- AAA edge cases ----
; Case: no adjust needed
mov ax, 0x0005
aaa                     ; AL=5, AH=0

; Case: low nibble > 9
mov ax, 0x000B         ; AL=0x0B
aaa                     ; AL=1, AH=1

; Case: AF set
mov al, 0x0A
add al, 0x06           ; AL=0x10, AF=1
mov ah, 0x02
aaa                     ; AF triggers: AL=(0x10+6)&F=6, AH=3

; ---- AAS edge cases ----
; Case: no adjust needed
mov ax, 0x0005
aas                     ; AL=5, AH=0

; Case: low nibble > 9
mov ax, 0x010B         ; AH=1, AL=0x0B
aas                     ; AL=5, AH=0

; Case: borrow from subtraction
mov ax, 0x0200
sub al, 0x05           ; AL=0xFB, AF set (borrow from low nibble)
aas                     ; AL=(0xFB-6)&F=5, AH=1

; ---- Mixed sequences ----
; BCD addition: 29 + 43 = 72
mov al, 0x29
add al, 0x43           ; AL=0x6C
daa                     ; AL=0x72

; BCD subtraction: 72 - 29 = 43
mov al, 0x72
sub al, 0x29           ; AL=0x49, AF=1 (9-2=no borrow, but 2-9 borrows)
das                     ; AL=0x43

; Exit
int 0x20
