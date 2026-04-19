; int-heavy: tight loop firing INT 1Ah AH=1.
;
; Purpose: stresses the INT push path. Gossamer's INT 1Ah handler for
; AH!=0 is just `xor ax, ax; iret` — so each iteration is:
;   INT 1Ah    (6 memory writes: push FLAGS, CS, IP)
;   xor ax,ax  (1 instruction in handler)
;   iret       (6 memory reads: pop IP, CS, FLAGS)
; plus the outer loop's MOV AH,1 and JMP.
;
; Gating memory-write slots 2-5 behind an INT-class predicate should
; make this workload measurably faster if the gating optimization works.

org 0x100

start:
    mov ah, 0x01      ; AH!=0 so handler takes the short path
    int 0x1a
    jmp start
