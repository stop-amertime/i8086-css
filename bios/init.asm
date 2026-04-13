; ==========================================================================
; CSS-BIOS init stub — lives at F000:0000 in the BIOS ROM
;
; Assembled with: nasm -f bin -o bios/init.bin bios/init.asm
;
; After this binary, generate-dos.mjs appends the D6 microcode stubs
; (each 3 bytes: [0xD6, routineID, 0xCF]).  STUB_BASE marks the offset
; where those stubs begin.
; ==========================================================================

[BITS 16]
[ORG 0]

; ---- Segments we reference ----
BDA_SEG     equ 0x0040
VGA_SEG     equ 0xB800
BIOS_SEG    equ 0xF000
KERNEL_SEG  equ 0x0060

; ---- BDA field offsets (relative to 0x0040:0000 = linear 0x0400) ----
BDA_EQUIP   equ 0x10    ; equipment word (2 bytes)
BDA_MEMSZ   equ 0x13    ; memory size in KB (2 bytes)
BDA_KBD_FLG equ 0x17    ; keyboard flags (3 bytes)
BDA_KBD_HD  equ 0x1A    ; keyboard buffer head (2 bytes)
BDA_KBD_TL  equ 0x1C    ; keyboard buffer tail (2 bytes)
BDA_FLOPPY  equ 0x3E    ; floppy state (4 bytes)
BDA_VMODE   equ 0x49    ; video mode (1 byte)
BDA_VCOLS   equ 0x4A    ; video columns (2 bytes)
BDA_PGSZ    equ 0x4C    ; page size (2 bytes)
BDA_PGOFF   equ 0x4E    ; page offset (2 bytes)
BDA_CURSOR  equ 0x50    ; cursor positions (8 words = 16 bytes, pages 0-7)
BDA_CURSHP  equ 0x60    ; cursor shape (2 bytes)
BDA_ACTPG   equ 0x62    ; active page (1 byte)
BDA_CRTPORT equ 0x63    ; CRT port (2 bytes)
BDA_TIMER   equ 0x6C    ; timer tick count (4 bytes)
BDA_TMROVF  equ 0x70    ; timer overflow (1 byte)
BDA_WARM    equ 0x72    ; warm boot flag (2 bytes)
BDA_KBBST   equ 0x80    ; keyboard buffer start (2 bytes)
BDA_KBBEND  equ 0x82    ; keyboard buffer end (2 bytes)
BDA_ROWS    equ 0x84    ; rows minus 1 (1 byte)
BDA_CHARHT  equ 0x85    ; character height (2 bytes)

; ---- Macro: set one IVT entry ----
; %1 = IVT byte offset (int_num * 4)
; %2 = stub index (0-based, each stub is 3 bytes)
%macro set_ivt 2
    mov  word [es:%1],   STUB_BASE + (%2 * 3)
    mov  word [es:%1+2], BIOS_SEG
%endmacro

; ==========================================================================
; Entry point — CPU starts executing here (F000:0000)
; ==========================================================================
start:
    cli

    ; ------------------------------------------------------------------
    ; Step 1: Set up stack  SS:SP = 0030:0100  (linear 0x400, below BDA)
    ; ------------------------------------------------------------------
    mov  ax, 0x0030
    mov  ss, ax
    mov  sp, 0x0100

    ; ------------------------------------------------------------------
    ; Step 2: Clear VGA text screen — 2000 words of 0x0720
    ; ------------------------------------------------------------------
    mov  ax, VGA_SEG
    mov  es, ax
    xor  di, di
    mov  ax, 0x0720         ; space + gray-on-black
    mov  cx, 2000
    cld
    rep  stosw

    ; ------------------------------------------------------------------
    ; Step 3: Default all 256 IVT entries to dummy_iret (F000:offset)
    ; ------------------------------------------------------------------
    xor  ax, ax
    mov  es, ax             ; ES = 0 → IVT at 0000:0000
    mov  di, 0              ; start at IVT[0]
    mov  cx, 256
.fill_ivt:
    mov  word [es:di],   dummy_iret
    mov  word [es:di+2], BIOS_SEG
    add  di, 4
    loop .fill_ivt

    ; ------------------------------------------------------------------
    ; Step 4: Override 11 IVT entries with D6 microcode stub pointers
    ; ------------------------------------------------------------------
    ; Stubs are appended by generate-dos.mjs at offset STUB_BASE.
    ; Each stub is 3 bytes: [0xD6, routineID, 0xCF].
    ; Order matches IVT_ENTRIES iteration in bios.mjs.
    set_ivt 0x20, 0        ; INT 08h: timer
    set_ivt 0x24, 1        ; INT 09h: keyboard IRQ
    set_ivt 0x40, 2        ; INT 10h: video
    set_ivt 0x44, 3        ; INT 11h: equipment
    set_ivt 0x48, 4        ; INT 12h: memory size
    set_ivt 0x4C, 5        ; INT 13h: disk
    set_ivt 0x54, 6        ; INT 15h: system services
    set_ivt 0x58, 7        ; INT 16h: keyboard input
    set_ivt 0x64, 8        ; INT 19h: bootstrap
    set_ivt 0x68, 9        ; INT 1Ah: time of day
    set_ivt 0x80, 10       ; INT 20h: program terminate

    ; ------------------------------------------------------------------
    ; Step 5: Initialize BDA at 0040:0000
    ; ------------------------------------------------------------------
    mov  ax, BDA_SEG
    mov  es, ax

    ; First zero the entire BDA (256 bytes)
    xor  di, di
    xor  ax, ax
    mov  cx, 128            ; 128 words = 256 bytes
    rep  stosw

    ; Equipment word: 0x0021 (floppy + 80x25 color)
    mov  word [es:BDA_EQUIP], 0x0021

    ; Memory size: 640 KB
    mov  word [es:BDA_MEMSZ], 640

    ; Keyboard flags: all zero (already zeroed)

    ; Keyboard buffer head/tail
    mov  word [es:BDA_KBD_HD], 0x001E
    mov  word [es:BDA_KBD_TL], 0x001E
    mov  word [es:BDA_KBBST],  0x001E
    mov  word [es:BDA_KBBEND], 0x003E

    ; Floppy state: all zeros (already zeroed)

    ; Video mode and parameters
    mov  byte [es:BDA_VMODE], 0x03      ; mode 3 = 80x25 text
    mov  word [es:BDA_VCOLS], 80
    mov  word [es:BDA_PGSZ],  0x1000
    mov  word [es:BDA_PGOFF], 0x0000

    ; Cursor positions pages 0-3: all zero (already zeroed)

    ; Cursor shape: start=6, end=7  (stored as [end, start] = [0x07, 0x06])
    mov  word [es:BDA_CURSHP], 0x0607

    ; Active page: 0 (already zeroed)

    ; CRT port: 0x03D4
    mov  word [es:BDA_CRTPORT], 0x03D4

    ; Rows minus 1: 24
    mov  byte [es:BDA_ROWS], 24

    ; Character height: 16
    mov  word [es:BDA_CHARHT], 16

    ; Timer: all zeros (already zeroed)
    ; Warm boot flag: 0 (already zeroed)

    ; ------------------------------------------------------------------
    ; Step 6: Write boot splash to VGA text memory
    ; ------------------------------------------------------------------
    ; DS = BIOS_SEG (F000) so we can read strings from ROM
    ; ES = VGA_SEG  (B800) for writing
    mov  ax, BIOS_SEG
    mov  ds, ax
    mov  ax, VGA_SEG
    mov  es, ax
    cld

    ; Row 0, col 0, attr 0x0F: "CSS-BIOS v0.3"
    mov  si, str_bios
    mov  di, 0 * 160 + 0 * 2   ; row 0, col 0
    mov  ah, 0x0F
    call .write_str

    ; Row 1, col 0, attr 0x07: "640K conventional memory"
    mov  si, str_mem
    mov  di, 1 * 160 + 0 * 2
    mov  ah, 0x07
    call .write_str

    ; Row 2, col 0, attr 0x07: "IVT: 256 vectors"
    mov  si, str_ivt
    mov  di, 2 * 160 + 0 * 2
    mov  ah, 0x07
    call .write_str

    ; Row 3, col 0, attr 0x07: "BDA: initialized"
    mov  si, str_bda
    mov  di, 3 * 160 + 0 * 2
    mov  ah, 0x07
    call .write_str

    ; Row 4, col 0, attr 0x07: "Disk: FAT12 image"
    mov  si, str_disk
    mov  di, 4 * 160 + 0 * 2
    mov  ah, 0x07
    call .write_str

    ; Row 5, col 0, attr 0x07: "Kernel: at 0060:0000"
    mov  si, str_kernel
    mov  di, 5 * 160 + 0 * 2
    mov  ah, 0x07
    call .write_str

    ; Row 6, col 0, attr 0x0F: "Booting DOS..."
    mov  si, str_boot
    mov  di, 6 * 160 + 0 * 2
    mov  ah, 0x0F
    call .write_str

    ; ------------------------------------------------------------------
    ; Step 7: Set cursor position in BDA: col=0, row=8
    ; ------------------------------------------------------------------
    mov  ax, BDA_SEG
    mov  es, ax
    mov  byte [es:BDA_CURSOR],   0    ; col = 0
    mov  byte [es:BDA_CURSOR+1], 8    ; row = 8

    ; ------------------------------------------------------------------
    ; Step 8: Jump to DOS kernel at 0060:0000
    ; ------------------------------------------------------------------
    xor  bx, bx             ; BL=0 → boot drive A:
    xor  ax, ax
    mov  ds, ax              ; DS=0
    jmp  KERNEL_SEG:0x0000


; ==========================================================================
; Subroutine: write null-terminated string to VGA
;   DS:SI = string source (in BIOS ROM)
;   ES:DI = VGA destination
;   AH    = attribute byte
; ==========================================================================
.write_str:
    lodsb
    or   al, al
    jz   .write_done
    stosw                    ; write char (AL) + attr (AH)
    jmp  .write_str
.write_done:
    ret


; ==========================================================================
; String data
; ==========================================================================
str_bios:    db 'CSS-BIOS v0.3', 0
str_mem:     db '640K conventional memory', 0
str_ivt:     db 'IVT: 256 vectors', 0
str_bda:     db 'BDA: initialized', 0
str_disk:    db 'Disk: FAT12 image', 0
str_kernel:  db 'Kernel: at 0060:0000', 0
str_boot:    db 'Booting DOS...', 0


; ==========================================================================
; Dummy IRET — default handler for all unused interrupt vectors
; ==========================================================================
dummy_iret:
    iret


; ==========================================================================
; STUB_BASE — D6 microcode stubs are appended here by generate-dos.mjs
; ==========================================================================
STUB_BASE equ ($ - $$)
