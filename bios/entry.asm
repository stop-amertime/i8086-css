; entry.asm — CSS-BIOS entry point at F000:0000
;
; Layout: this file is first in the linker output so its start lands at
; F000:0000 (matching [org 0] convention of current asm BIOS).
;
; NASM with [bits 16] [org 0]. Produces a COFF/OMF object for wlink.

[bits 16]

global _start
global bios_halt

extern bios_init_         ; OpenWatcom C ABI: leading underscore, cdecl

; Declare the data segments OpenWatcom's C compiler emits, and group
; them into DGROUP so `seg DGROUP` resolves to DGROUP's runtime
; paragraph. Order matches wlink's default ordering.
segment CONST   class=DATA align=1
segment CONST2  class=DATA align=1
segment _DATA   class=DATA align=1
group DGROUP CONST CONST2 _DATA

section _TEXT public align=1 class=CODE use16

_start:
    cli
    cld

    ; Stack at 0x9000:0xFFFE (top of ~576 KB conventional RAM, linear
    ; 0x9FFFE). Above IVT/BDA/kernel-load so install_ivt's IVT fill cannot
    ; stomp our own stack. The old asm BIOS could safely use 0x0030:0x0100
    ; because its init code did not push/pop during the IVT write loop;
    ; our C-based install_ivt has caller-save pushes whose stack slots live
    ; inside the IVT being written, which corrupts the return address.
    mov ax, 0x9000
    mov ss, ax
    mov sp, 0xFFFE

    ; DS must equal CS + DGROUP paragraph offset so small-model C code
    ; can read its CONST / CONST2 / _DATA segments (logo_bin, font
    ; glyphs, cga_dac). OpenWatcom's linker places DGROUP at some
    ; nonzero paragraph within the module; `seg DGROUP` resolves to
    ; that paragraph. Adding CS gives the absolute runtime segment.
    ;
    ; ES=0 as a sensible default for string-op targets.
    mov ax, cs
    mov bx, DGROUP      ; DGROUP paragraph offset (link-time constant)
    add ax, bx
    mov ds, ax
    xor ax, ax
    mov es, ax

    ; Call into C. Small model near call — bios_init lives in the same
    ; code segment (F000) as this stub.
    call bios_init_

    ; Hand off to kernel. Transpiler pre-loads KERNEL.SYS at 0060:0000.
    sti
    xor ax, ax
    mov ds, ax
    mov bl, 0x00              ; boot drive A:
    jmp 0x0060:0x0000

; Halt routine — unreachable under normal operation, present for debugger
; visibility if bios_init ever returns unexpectedly.
bios_halt:
    cli
    hlt
    jmp bios_halt
