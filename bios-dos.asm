; bios-dos.asm — Minimal BIOS for booting DOS on CSS-DOS
; Loaded at F000:0000 (linear 0xF0000)
;
; Provides the BIOS services the DOS kernel needs to boot:
;   INT 10h — Video (teletype, cursor, scroll, set mode)
;   INT 11h — Equipment list (returns 0)
;   INT 12h — Conventional memory size (returns 640 KB)
;   INT 13h — Disk services (reads from memory-resident FAT12 image)
;   INT 16h — Keyboard
;   INT 1Ah — Timer
;   INT 19h — Bootstrap loader
;   INT 20h — Halt
;
; DOS kernel (KERNEL.SYS) is pre-loaded at 0060:0000 (linear 0x600)
; by the transpiler. The BIOS init code sets up the IVT and jumps to it.
;
; Disk image is embedded at DISK_SEG:0000 by the transpiler.
; INT 13h reads sectors from this memory region.
;
; CONSTRAINTS (CSS transpiler limitations):
; - No 0x0F-prefixed opcodes (near Jcc)
; - Segment override prefixes may not work in all contexts
; - All memory access via DS segment where possible

[bits 16]
[org 0]

; ============================================================
; Constants
; ============================================================
DISK_SEG    equ 0xD000          ; Disk image loaded here (linear 0xD0000)
BDA_SEG     equ 0x0040          ; BIOS Data Area segment
VGA_SEG     equ 0xB800          ; VGA text mode segment
KERNEL_SEG  equ 0x0060          ; DOS kernel load segment
SECTOR_SIZE equ 512
HALT_ADDR   equ 0x0504          ; Halt flag address (seg 0, in BDA area, below kernel)

; Disk geometry for a 1.44MB floppy (we only use part of it)
DISK_SPT    equ 18              ; sectors per track
DISK_HEADS  equ 2               ; heads
DISK_CYLS   equ 80              ; cylinders

; ============================================================
; INT 10h — Video Services  (offset 0)
; ============================================================
int10h_handler:
    cmp ah, 0x0E
    je .teletype
    jmp .dispatch_other

; --- AH=0Eh: Teletype output ---
; AL = character to display
.teletype:
    push ds
    push di
    push bx
    push cx
    push dx
    push ax                ; save character in AL

    ; Read cursor from BDA (DS=0x0040)
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [0x0050]       ; column
    mov dh, [0x0051]       ; row

    pop ax                 ; AX restored (AL = character)
    push ax                ; save again

    cmp al, 13
    je .tty_cr
    cmp al, 10
    je .tty_lf
    cmp al, 8
    je .tty_bs
    cmp al, 7
    je .tty_done

    ; Compute VGA offset = (row*80+col)*2
    push ax                ; save char
    push dx                ; save cursor
    mov al, dh
    mov bl, 80
    mul bl                 ; AX = row*80
    xor bh, bh
    mov bl, dl
    add ax, bx             ; AX = row*80+col
    shl ax, 1              ; AX = (row*80+col)*2
    mov di, ax
    pop dx                 ; restore cursor
    pop ax                 ; restore char

    ; Switch DS to VGA segment and write
    push ds                ; save BDA segment
    mov bx, VGA_SEG
    mov ds, bx
    mov [di], al           ; write character (DS:DI = B800:offset)
    mov byte [di+1], 0x07  ; write attribute
    pop ds                 ; restore BDA segment

    ; Advance cursor
    inc dl                 ; col++
    cmp dl, 80
    jb .tty_save
    xor dl, dl             ; col = 0
    inc dh                 ; row++
    cmp dh, 25
    jb .tty_save
    dec dh                 ; row = 24
    call scroll_up_one
    jmp short .tty_save

.tty_cr:
    xor dl, dl
    jmp short .tty_save

.tty_lf:
    inc dh
    cmp dh, 25
    jb .tty_save
    dec dh
    call scroll_up_one
    jmp short .tty_save

.tty_bs:
    cmp dl, 0
    je .tty_save           ; can't go back past column 0
    dec dl
    jmp short .tty_save

.tty_save:
    ; Write cursor back to BDA (DS already = 0x0040)
    mov [0x0050], dl
    mov [0x0051], dh

.tty_done:
    pop ax                 ; restore original AX
    pop dx
    pop cx
    pop bx
    pop di
    pop ds
    iret

; --- INT 10h dispatch for non-teletype ---
; Use jmp instead of je for targets >127 bytes away to avoid 0x0F prefix
.dispatch_other:
    cmp ah, 0x02
    je .set_cursor
    cmp ah, 0x03
    je .get_cursor
    cmp ah, 0x00
    je .set_mode
    cmp ah, 0x0F
    je .get_mode
    cmp ah, 0x06
    jne .not_scroll_up
    jmp .scroll_up
.not_scroll_up:
    cmp ah, 0x07
    jne .not_scroll_down
    jmp .scroll_down
.not_scroll_down:
    cmp ah, 0x08
    jne .not_read_char
    jmp .read_char
.not_read_char:
    cmp ah, 0x09
    jne .not_write_char
    jmp .write_char_attr
.not_write_char:
    iret

.set_cursor:
    push ds
    push bx
    mov bx, BDA_SEG
    mov ds, bx
    mov [0x0050], dl
    mov [0x0051], dh
    pop bx
    pop ds
    iret

.get_cursor:
    push ds
    push bx
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [0x0050]
    mov dh, [0x0051]
    mov cx, 0x0607         ; cursor shape: start=6, end=7
    pop bx
    pop ds
    iret

.get_mode:
    mov al, 0x03           ; mode 3 = 80x25 text
    mov ah, 80             ; columns
    mov bh, 0              ; active page
    iret

.set_mode:
    push ds
    push di
    push cx
    push ax
    ; Clear cursor
    mov ax, BDA_SEG
    mov ds, ax
    mov byte [0x0050], 0
    mov byte [0x0051], 0
    ; Store video mode
    mov byte [0x0049], 0x03 ; mode 3
    ; Clear screen: DS=VGA, fill with spaces
    mov ax, VGA_SEG
    mov ds, ax
    xor di, di
    mov cx, 2000
    mov ax, 0x0720         ; space + light gray on black
.clr_loop:
    mov [di], ax
    add di, 2
    dec cx
    jnz .clr_loop
    pop ax
    mov al, 0x30           ; return prior mode info
    pop cx
    pop di
    pop ds
    iret

.scroll_up:
    cmp al, 0
    jne .su_lines
    ; AL=0: Clear window (most common usage)
    push ds
    push di
    push cx
    mov cx, VGA_SEG
    mov ds, cx
    xor di, di
    mov cx, 2000
    mov ax, 0x0720
.su_clr:
    mov [di], ax
    add di, 2
    dec cx
    jnz .su_clr
    pop cx
    pop di
    pop ds
    iret
.su_lines:
    push cx
    mov cl, al
    xor ch, ch
.su_loop:
    call scroll_up_one
    dec cl
    jnz .su_loop
    pop cx
    iret

.scroll_down:
    ; Minimal: just clear screen if AL=0
    cmp al, 0
    jne .sd_ret
    push ds
    push di
    push cx
    mov cx, VGA_SEG
    mov ds, cx
    xor di, di
    mov cx, 2000
    mov ax, 0x0720
.sd_clr:
    mov [di], ax
    add di, 2
    dec cx
    jnz .sd_clr
    pop cx
    pop di
    pop ds
.sd_ret:
    iret

.read_char:
    ; AH=08h: Read char+attr at cursor
    push ds
    push bx
    push di
    mov bx, BDA_SEG
    mov ds, bx
    mov al, [0x0050]       ; col
    mov ah, [0x0051]       ; row
    ; Compute offset = (row*80+col)*2
    push dx
    xor dh, dh
    mov dl, ah             ; DL = row
    mov ah, 80
    xchg al, dl            ; AL = row, DL = col
    mul ah                 ; AX = row * 80
    xor dh, dh             ; DX = col (DH already 0)
    add ax, dx             ; AX = row*80+col
    shl ax, 1
    mov di, ax
    pop dx
    mov bx, VGA_SEG
    mov ds, bx
    mov al, [di]           ; character
    mov ah, [di+1]         ; attribute
    pop di
    pop bx
    pop ds
    iret

.write_char_attr:
    ; AH=09h: Write char+attr at cursor, CX times
    ; AL=char, BL=attr, CX=count
    push ds
    push di
    push dx
    push cx
    push bx
    ; Get cursor position
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [0x0050]
    mov dh, [0x0051]
    ; Compute VGA offset
    push ax
    mov al, dh
    mov bl, 80
    mul bl
    xor bh, bh
    mov bl, dl
    add ax, bx
    shl ax, 1
    mov di, ax
    pop ax
    ; Write to VGA
    mov bx, VGA_SEG
    mov ds, bx
    pop bx                 ; restore original BX (BL=attr)
    push bx
.wca_loop:
    mov [di], al
    mov [di+1], bl         ; attribute from BL
    add di, 2
    dec cx
    jnz .wca_loop
    pop bx
    pop cx
    pop dx
    pop di
    pop ds
    iret

; ============================================================
; scroll_up_one — all VGA access via DS=VGA_SEG
; ============================================================
scroll_up_one:
    push ds
    push si
    push di
    push cx
    push ax
    mov ax, VGA_SEG
    mov ds, ax
    ; Copy rows 1-24 up to rows 0-23
    mov si, 160            ; source = start of row 1
    xor di, di             ; dest = start of row 0
    mov cx, 1920           ; 24 rows * 80 cols = 1920 words
.scopy:
    mov ax, [si]
    mov [di], ax
    add si, 2
    add di, 2
    dec cx
    jnz .scopy
    ; Clear last row
    mov cx, 80
    mov ax, 0x0720
.sclear:
    mov [di], ax
    add di, 2
    dec cx
    jnz .sclear
    pop ax
    pop cx
    pop di
    pop si
    pop ds
    ret

; ============================================================
; INT 11h — Equipment List
; ============================================================
int11h_handler:
    mov ax, 0x0021         ; bit 0=floppy present, bit 5=initial video mode 80x25
    iret

; ============================================================
; INT 12h — Conventional Memory Size
; ============================================================
int12h_handler:
    mov ax, 640            ; 640 KB
    iret

; ============================================================
; INT 13h — Disk Services (memory-resident disk image)
; ============================================================
; The disk image is at DISK_SEG:0000.
; We support a FAT12 1.44MB floppy geometry:
;   18 sectors/track, 2 heads, 80 cylinders
;   LBA = (C * HEADS + H) * SPT + (S - 1)
;   Byte offset = LBA * 512
;
; We implement:
;   AH=00h — Reset disk
;   AH=02h — Read sectors
;   AH=08h — Get drive parameters
;   AH=15h — Get disk type
; ============================================================
int13h_handler:
    cmp ah, 0x00
    je .disk_reset
    cmp ah, 0x02
    je .disk_read_v2
    cmp ah, 0x08
    je .disk_params
    cmp ah, 0x15
    je .disk_type
    ; Unknown function — return error
    mov ah, 0x01           ; invalid function
    stc
    iret

.disk_reset:
    xor ah, ah             ; success
    clc
    iret

.disk_params:
    ; Return drive parameters for 1.44MB floppy
    ; DL=drive, returns:
    ;   AH=0, BL=04 (1.44M), CH=max cyl low, CL=max sect | cyl high
    ;   DH=max head, DL=num drives
    mov ah, 0
    mov bl, 0x04           ; drive type: 1.44MB
    mov ch, DISK_CYLS - 1  ; max cylinder (79)
    mov cl, DISK_SPT       ; max sector (18)
    mov dh, DISK_HEADS - 1 ; max head (1)
    mov dl, 1              ; 1 floppy drive
    ; DI:ES should point to disk parameter table, but we skip that
    clc
    iret

.disk_type:
    ; AH=15h: Get disk type
    ; Returns AH=01 for floppy without change detection
    mov ah, 0x01
    clc
    iret

.disk_read_v2:
    ; AH=02h: Read sectors
    ; AL=count, CH=cylinder, CL=sector(1-based), DH=head, DL=drive, ES:BX=dest
    push bp
    mov bp, sp
    push ds
    push si
    push di
    push ax                ; [bp-10] = count in AL
    push dx                ; [bp-12] = head in DH
    push cx                ; [bp-14] = cyl in CH, sect in CL

    ; Compute LBA = (CH * 2 + DH) * 18 + (CL - 1)
    mov al, ch             ; AL = cylinder
    xor ah, ah
    shl ax, 1              ; AX = cyl * 2
    xor dh, dh             ; (reuse DH=0 after saving)
    ; Wait, DH has the head. Let me reload.
    pop cx                 ; restore CX (CH=cyl, CL=sect)
    pop dx                 ; restore DX (DH=head)
    push dx
    push cx

    mov al, ch             ; AL = cylinder
    xor ah, ah
    shl ax, 1              ; AX = cyl * 2
    mov si, ax             ; save
    xor ah, ah
    mov al, dh             ; AL = head
    add ax, si             ; AX = cyl*2 + head
    mov si, DISK_SPT
    push dx
    mul si                 ; AX = (cyl*2+head) * 18
    pop dx
    mov si, ax             ; SI = partial LBA
    xor ch, ch             ; CX = sector (CL already has it)
    dec cl                 ; sector is 1-based
    add si, cx             ; SI = LBA

    ; Source segment = DISK_SEG + LBA * 32
    mov ax, si
    mov cl, 5
    shl ax, cl             ; AX = LBA * 32
    add ax, DISK_SEG       ; AX = source segment
    mov ds, ax
    xor si, si             ; DS:SI = start of sector in disk image

    ; Destination = ES:BX
    mov di, bx             ; DI = destination offset in ES

    ; Count
    pop cx                 ; restore saved CX
    pop dx                 ; restore saved DX
    pop ax                 ; restore saved AX (AL=count)
    xor ah, ah
    mov cx, ax             ; CX = sector count
    push cx                ; save count for return value

    ; Copy CX sectors * 512 bytes = CX * 256 words
.read_sector_loop:
    push cx
    mov cx, 256            ; 256 words = 512 bytes
.read_word_loop:
    mov ax, [si]           ; read from disk image (DS:SI)
    ; Write to ES:DI — but we can't use ES: prefix easily.
    ; Swap DS and ES, write, swap back.
    push ds
    push bx
    mov bx, es
    mov ds, bx
    mov [di], ax           ; write to dest (now DS:DI = original ES:DI)
    pop bx
    pop ds
    add si, 2
    add di, 2
    dec cx
    jnz .read_word_loop
    pop cx
    dec cx
    jnz .read_sector_loop

    ; Success
    pop ax                 ; AL = sectors read
    xor ah, ah             ; AH = 0 (success)
    clc

    pop di
    pop si
    pop ds
    pop bp
    iret

; ============================================================
; INT 16h — Keyboard
; ============================================================
int16h_handler:
    cmp ah, 0x00
    je .read_key
    cmp ah, 0x01
    je .check_key
    xor al, al
    iret

.read_key:
    ; Busy-wait on keyboard buffer at 0000:0500
    push ds
    push bx
    xor bx, bx
    mov ds, bx
.key_wait:
    mov ax, [0x0500]
    test ax, ax
    jz .key_wait
    ; Clear the buffer after reading
    mov word [0x0500], 0
    pop bx
    pop ds
    iret

.check_key:
    ; Check if key is available (non-destructive)
    push ds
    push bx
    xor bx, bx
    mov ds, bx
    mov ax, [0x0500]
    pop bx
    pop ds
    test ax, ax
    push bp
    mov bp, sp
    jz .ck_none
    ; Key available: clear ZF
    and word [bp+6], 0xFFBF
    jmp short .ck_ret
.ck_none:
    ; No key: set ZF
    or word [bp+6], 0x0040
.ck_ret:
    pop bp
    iret

; ============================================================
; INT 1Ah — Timer
; ============================================================
int1ah_handler:
    cmp ah, 0x00
    jne .timer_set
    ; AH=00h: Get tick count
    ; Auto-increment on each read since we have no hardware timer.
    ; This ensures timeout loops that compare consecutive INT 1Ah
    ; results will eventually expire.
    push ds
    push bx
    xor bx, bx
    mov ds, bx
    mov dx, [0x046C]       ; low word of tick count (BDA 40:6C)
    mov cx, [0x046E]       ; high word of tick count (BDA 40:6E)
    ; Increment tick counter
    add word [0x046C], 1
    adc word [0x046E], 0
    xor al, al             ; midnight flag
    pop bx
    pop ds
    iret
.timer_set:
    cmp ah, 0x01
    jne .timer_ret
    ; AH=01h: Set tick count
    push ds
    push bx
    xor bx, bx
    mov ds, bx
    mov [0x046C], dx
    mov [0x046E], cx
    pop bx
    pop ds
    iret
.timer_ret:
    iret

; ============================================================
; INT 19h — Bootstrap
; ============================================================
int19h_handler:
    ; In our system, INT 19h halts (no disk to reboot from)
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [HALT_ADDR], 1
    pop ds
    jmp int19h_handler

; ============================================================
; INT 20h — Halt / Program terminate
; ============================================================
int20h_handler:
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [HALT_ADDR], 1
    pop ds
    jmp int20h_handler

; ============================================================
; INT 15h — Extended Services
; ============================================================
int15h_handler:
    cmp ah, 0x88
    je .ext_mem_size
    cmp ah, 0xC0
    je .sys_config
    ; Unknown function — return CF set
    push bp
    mov bp, sp
    or word [bp+6], 0x0001
    pop bp
    mov ah, 0x86           ; function not supported
    iret

.ext_mem_size:
    ; AH=88h: Get extended memory size (above 1MB)
    ; We have no extended memory
    xor ax, ax
    ; Clear CF
    push bp
    mov bp, sp
    and word [bp+6], 0xFFFE
    pop bp
    iret

.sys_config:
    ; AH=C0h: Get system configuration
    ; Return CF set — not supported
    push bp
    mov bp, sp
    or word [bp+6], 0x0001
    pop bp
    mov ah, 0x86
    iret

; ============================================================
; Default handler — catch-all for unhandled INTs
; INT 1 — Single-step trap handler
; Clears TF from stacked FLAGS so execution resumes normally.
; Without this, TF stays set and triggers infinite INT 1 loop.
; ============================================================
int01h_handler:
    push bp
    mov bp, sp
    and word [bp+6], 0xFEFF    ; clear TF (bit 8) in stacked FLAGS
    pop bp
    iret

; ============================================================
; Default handler for unimplemented INTs
; Returns with carry flag set (function not supported) and IRETs.
; ============================================================
default_handler:
    ; Set carry flag in the FLAGS on the stack to signal "not supported"
    push bp
    mov bp, sp
    or word [bp+6], 0x0001    ; set CF in stacked FLAGS
    pop bp
    iret

; ============================================================
; INT 21h — DOS services
; Handled by the kernel itself — just needs an IVT entry
; pointing somewhere safe until the kernel installs its own.
; We point it to default_handler; the kernel replaces it.
; ============================================================

; ============================================================
; BIOS Init — runs once at startup
; Sets up IVT, BDA, then jumps to DOS kernel
; This must be at a known offset — the transpiler sets the
; initial IP to point here.
; ============================================================
bios_init:
    cli

    ; Set up stack
    xor ax, ax
    mov ss, ax
    mov sp, 0x7C00         ; Traditional BIOS stack location

    ; DS = 0 for IVT setup
    mov ds, ax

    ; --- Set up IVT ---
    ; INT 01h — Single-step trap (clears TF)
    mov word [0x01*4], int01h_handler
    mov word [0x01*4+2], 0xF000

    ; INT 10h — Video
    mov word [0x10*4], int10h_handler
    mov word [0x10*4+2], 0xF000

    ; INT 11h — Equipment
    mov word [0x11*4], int11h_handler
    mov word [0x11*4+2], 0xF000

    ; INT 12h — Memory size
    mov word [0x12*4], int12h_handler
    mov word [0x12*4+2], 0xF000

    ; INT 13h — Disk
    mov word [0x13*4], int13h_handler
    mov word [0x13*4+2], 0xF000

    ; INT 15h — Extended services
    mov word [0x15*4], int15h_handler
    mov word [0x15*4+2], 0xF000

    ; INT 16h — Keyboard
    mov word [0x16*4], int16h_handler
    mov word [0x16*4+2], 0xF000

    ; INT 19h — Bootstrap
    mov word [0x19*4], int19h_handler
    mov word [0x19*4+2], 0xF000

    ; INT 1Ah — Timer
    mov word [0x1A*4], int1ah_handler
    mov word [0x1A*4+2], 0xF000

    ; INT 20h — Halt
    mov word [0x20*4], int20h_handler
    mov word [0x20*4+2], 0xF000

    ; --- Fill ALL other IVT entries with default_handler ---
    ; This prevents wild jumps to 0000:0000 on unhandled INTs.
    ; We fill 0x00-0xFF, then the specific handlers above overwrite their slots.
    ; But we already set the specific ones, so just fill the gaps.
    ; Key missing ones: INT 14h (serial), INT 15h (extended), INT 17h (printer),
    ; INT 21h (DOS — kernel installs its own), INT 08h (timer tick), etc.
    mov cx, 256          ; all 256 INT vectors
    xor di, di           ; start at IVT[0]
.fill_ivt:
    ; Only write if currently zero (don't overwrite handlers we just set)
    cmp word [di], 0
    jne .skip_ivt
    cmp word [di+2], 0
    jne .skip_ivt
    mov word [di], default_handler
    mov word [di+2], 0xF000
.skip_ivt:
    add di, 4
    loop .fill_ivt

    ; --- Initialize BDA ---
    mov ax, BDA_SEG
    mov ds, ax
    mov byte [0x0049], 0x03     ; video mode = 3 (80x25 text)
    mov word [0x004A], 80       ; columns per row
    mov byte [0x0050], 0        ; cursor col
    mov byte [0x0051], 0        ; cursor row
    mov word [0x0013], 640      ; memory size in KB (also at 40:13)
    ; --- Additional BDA fields the kernel needs ---
    mov word [0x0010], 0x0021   ; equipment flags: floppy + 80x25 color
    mov word [0x004C], 0x1000   ; regen buffer size (4096 for 80x25)
    mov word [0x0063], 0x03D4   ; CRT controller base port (color)
    mov byte [0x0084], 24       ; screen rows - 1
    mov word [0x0085], 16       ; character matrix height (points)

    ; --- BIOS splash screen ---
    ; Write directly to VGA memory at B800:0000
    mov ax, VGA_SEG
    mov ds, ax
    ; First clear screen
    xor di, di
    mov cx, 2000
    mov ax, 0x0720         ; space + gray on black
.splash_clr:
    mov [di], ax
    add di, 2
    dec cx
    jnz .splash_clr

    ; Write "Gossamer BIOS v1.0" at row 1, col 30 (centered-ish)
    ; Offset = (1*80+30)*2 = 220
    mov di, 220
    mov ah, 0x0F           ; white on black attribute
    mov al, 'G'
    mov [di], ax
    add di, 2
    mov al, 'o'
    mov [di], ax
    add di, 2
    mov al, 's'
    mov [di], ax
    add di, 2
    mov al, 's'
    mov [di], ax
    add di, 2
    mov al, 'a'
    mov [di], ax
    add di, 2
    mov al, 'm'
    mov [di], ax
    add di, 2
    mov al, 'e'
    mov [di], ax
    add di, 2
    mov al, 'r'
    mov [di], ax
    add di, 2
    mov al, ' '
    mov [di], ax
    add di, 2
    mov al, 'B'
    mov [di], ax
    add di, 2
    mov al, 'I'
    mov [di], ax
    add di, 2
    mov al, 'O'
    mov [di], ax
    add di, 2
    mov al, 'S'
    mov [di], ax
    add di, 2
    mov al, ' '
    mov [di], ax
    add di, 2
    mov al, 'v'
    mov [di], ax
    add di, 2
    mov al, '1'
    mov [di], ax
    add di, 2
    mov al, '.'
    mov [di], ax
    add di, 2
    mov al, '0'
    mov [di], ax

    ; "640K conventional memory" at row 3, col 28
    mov di, 536            ; (3*80+28)*2
    mov al, '6'
    mov [di], ax
    add di, 2
    mov al, '4'
    mov [di], ax
    add di, 2
    mov al, '0'
    mov [di], ax
    add di, 2
    mov al, 'K'
    mov [di], ax
    add di, 2
    mov al, ' '
    mov [di], ax
    add di, 2
    mov al, 'c'
    mov [di], ax
    add di, 2
    mov al, 'o'
    mov [di], ax
    add di, 2
    mov al, 'n'
    mov [di], ax
    add di, 2
    mov al, 'v'
    mov [di], ax
    add di, 2
    mov al, 'e'
    mov [di], ax
    add di, 2
    mov al, 'n'
    mov [di], ax
    add di, 2
    mov al, 't'
    mov [di], ax
    add di, 2
    mov al, 'i'
    mov [di], ax
    add di, 2
    mov al, 'o'
    mov [di], ax
    add di, 2
    mov al, 'n'
    mov [di], ax
    add di, 2
    mov al, 'a'
    mov [di], ax
    add di, 2
    mov al, 'l'
    mov [di], ax
    add di, 2
    mov al, ' '
    mov [di], ax
    add di, 2
    mov al, 'm'
    mov [di], ax
    add di, 2
    mov al, 'e'
    mov [di], ax
    add di, 2
    mov al, 'm'
    mov [di], ax
    add di, 2
    mov al, 'o'
    mov [di], ax
    add di, 2
    mov al, 'r'
    mov [di], ax
    add di, 2
    mov al, 'y'
    mov [di], ax

    ; Update cursor position in BDA to row 5 (below splash)
    mov ax, BDA_SEG
    mov ds, ax
    mov byte [0x0050], 0   ; col
    mov byte [0x0051], 5   ; row

    ; --- Boot status messages via INT 10h ---
    sti                        ; enable interrupts for INT calls
    mov si, msg_ivt
    call bios_print
    mov si, msg_boot
    call bios_print

    ; --- Jump to DOS kernel ---
    ; KERNEL.SYS is pre-loaded at 0060:0000 by the transpiler.
    ; Kernel expects BL = boot drive (0x00 = A:)
    xor ax, ax
    mov ds, ax             ; DS = 0 (kernel expects this)
    mov bl, 0x00
    jmp 0x0060:0x0000

; --- BIOS print: print null-terminated string at CS:SI via INT 10h ---
bios_print:
    push ax
    push bx
.bp_loop:
    ; Read byte from CS:SI (BIOS ROM segment)
    ; We need CS: prefix but can't use segment overrides easily.
    ; Instead, set DS=CS temporarily.
    push ds
    push cs
    pop ds
    mov al, [si]
    pop ds
    test al, al
    jz .bp_done
    mov ah, 0x0E
    mov bx, 0x0007         ; page 0, light gray
    int 0x10
    inc si
    jmp short .bp_loop
.bp_done:
    pop bx
    pop ax
    ret

msg_ivt:    db 'IVT OK', 13, 10, 0
msg_boot:   db 'Booting DOS...', 13, 10, 0

bios_end:
