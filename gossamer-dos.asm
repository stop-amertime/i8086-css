; gossamer-dos.asm — Gossamer BIOS (DOS variant) for CSS-DOS
; Loaded at F000:0000 (linear 0xF0000)
;
; Mirrors the 8088_bios reference layout:
;   - IVT setup via interrupt_table array (32 standard vectors + fill rest)
;   - Full BDA initialization matching IBM PC BIOS
;   - INT handlers follow reference contracts
;
; Backend is memory-mapped (no port I/O):
;   - VGA text buffer at B800:0000
;   - Disk image at D000:0000
;   - Keyboard input via polling 0000:0500
;
; DOS kernel (KERNEL.SYS) is pre-loaded at 0060:0000 (linear 0x600)
; by the transpiler. The BIOS init code sets up the IVT and jumps to it.
;
; CONSTRAINTS (CSS transpiler limitations):
; - No 0x0F-prefixed opcodes (near Jcc)
; - Must compile with NASM: [bits 16] [org 0]

[bits 16]
[org 0]

; ============================================================
; Constants
; ============================================================
DISK_SEG    equ 0xD000          ; Disk image loaded here (linear 0xD0000)
BDA_SEG     equ 0x0040          ; BIOS Data Area segment
BIOS_SEG    equ 0xF000          ; BIOS code segment
VGA_SEG     equ 0xB800          ; VGA text mode segment
KERNEL_SEG  equ 0x0060          ; DOS kernel load segment
SECTOR_SIZE equ 512
HALT_ADDR   equ 0x0504          ; Halt flag address (seg 0)

; Disk geometry for a 1.44MB floppy
DISK_SPT    equ 18              ; sectors per track
DISK_HEADS  equ 2               ; heads
DISK_CYLS   equ 80              ; cylinders

; BDA offsets (matching reference 8088_bios exactly)
equip_serial        equ 0x00    ; word[4] - serial port addresses
equip_parallel      equ 0x08   ; word[3] - parallel port addresses
equipment_list      equ 0x10    ; word - equipment list
memory_size         equ 0x13    ; word - memory size in KiB
kbd_flags_1         equ 0x17    ; byte - keyboard shift flags 1
kbd_flags_2         equ 0x18    ; byte - keyboard shift flags 2
kbd_alt_keypad      equ 0x19    ; byte - Alt+Numpad work area
kbd_buffer_head     equ 0x1A    ; word - keyboard buffer head offset
kbd_buffer_tail     equ 0x1C    ; word - keyboard buffer tail offset
kbd_buffer          equ 0x1E    ; byte[32] - keyboard buffer
fdc_calib_state     equ 0x3E    ; byte - floppy recalibration status
fdc_motor_state     equ 0x3F    ; byte - floppy motor status
fdc_motor_tout      equ 0x40    ; byte - floppy motor off timeout
fdc_last_error      equ 0x41    ; byte - last diskette op status
video_mode          equ 0x49    ; byte - active video mode
video_columns       equ 0x4A    ; word - text columns
video_page_size     equ 0x4C    ; word - video page size in bytes
video_page_offt     equ 0x4E    ; word - active video page offset
video_cur_pos       equ 0x50    ; byte[16] - cursor pos per page
video_cur_shape     equ 0x60    ; word - cursor shape
video_page          equ 0x62    ; byte - active video page
video_port          equ 0x63    ; word - CRT controller port
ticks_lo            equ 0x6C    ; word - timer ticks low
ticks_hi            equ 0x6E    ; word - timer ticks high
new_day             equ 0x70    ; byte - midnight flag
break_flag          equ 0x71    ; byte - Ctrl-Break flag
warm_boot           equ 0x72    ; word - warm boot flag (1234h)
kbd_buffer_start    equ 0x80    ; word - keyboard buffer start
kbd_buffer_end      equ 0x82    ; word - keyboard buffer end
video_rows          equ 0x84    ; byte - text rows minus 1
video_char_height   equ 0x85    ; word - character height (points)

; ============================================================
; INT 10h — Video Services
; ============================================================
int10h_handler:
    push ds
    push es
    push bp
    cmp ah, 0x0E
    je .teletype
    jmp .dispatch_other

; --- AH=0Eh: Teletype output ---
.teletype:
    push di
    push bx
    push cx
    push dx
    push ax                ; save character in AL

    ; Read cursor from BDA
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [video_cur_pos]     ; column
    mov dh, [video_cur_pos+1]   ; row

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

    ; Write to VGA
    push ds
    mov bx, VGA_SEG
    mov ds, bx
    mov [di], al           ; character
    mov byte [di+1], 0x07  ; attribute
    pop ds

    ; Advance cursor
    inc dl
    cmp dl, 80
    jb .tty_save
    xor dl, dl
    inc dh
    cmp dh, 25
    jb .tty_save
    dec dh
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
    je .tty_save
    dec dl
    jmp short .tty_save

.tty_save:
    mov [video_cur_pos], dl
    mov [video_cur_pos+1], dh

.tty_done:
    pop ax
    pop dx
    pop cx
    pop bx
    pop di
    pop bp
    pop es
    pop ds
    iret

; --- INT 10h dispatch for non-teletype ---
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
    cmp ah, 0x0A
    jne .not_write_char_only
    jmp .write_char_only
.not_write_char_only:
    pop bp
    pop es
    pop ds
    iret

.set_cursor:
    mov bx, BDA_SEG
    mov ds, bx
    mov [video_cur_pos], dl
    mov [video_cur_pos+1], dh
    pop bp
    pop es
    pop ds
    iret

.get_cursor:
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [video_cur_pos]
    mov dh, [video_cur_pos+1]
    mov cx, [video_cur_shape]
    pop bp
    pop es
    pop ds
    iret

.get_mode:
    push bx
    mov bx, BDA_SEG
    mov ds, bx
    mov al, [video_mode]
    mov ah, [video_columns]
    mov bh, [video_page]
    ; BH is return value, but we pushed original BX
    ; Need to fix this: pop old BX but keep BH
    mov bl, bh              ; save page in BL
    pop bx                  ; restore original BX
    mov bh, bl              ; but no, that clobbers... let's just not push BX
    ; Actually simpler approach: just return hardcoded for mode 3
    pop bp
    pop es
    pop ds
    mov al, 0x03
    mov ah, 80
    mov bh, 0
    iret

.set_mode:
    push di
    push cx
    push ax
    mov ax, BDA_SEG
    mov ds, ax
    mov byte [video_cur_pos], 0
    mov byte [video_cur_pos+1], 0
    mov byte [video_mode], 0x03
    ; Clear screen
    mov ax, VGA_SEG
    mov ds, ax
    xor di, di
    mov cx, 2000
    mov ax, 0x0720
.clr_loop:
    mov [di], ax
    add di, 2
    dec cx
    jnz .clr_loop
    pop ax
    mov al, 0x30           ; return prior mode info
    pop cx
    pop di
    pop bp
    pop es
    pop ds
    iret

.scroll_up:
    cmp al, 0
    jne .su_lines
    ; AL=0: Clear window
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
    pop bp
    pop es
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
    pop bp
    pop es
    pop ds
    iret

.scroll_down:
    cmp al, 0
    jne .sd_ret
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
.sd_ret:
    pop bp
    pop es
    pop ds
    iret

.read_char:
    ; AH=08h: Read char+attr at cursor
    push bx
    push di
    mov bx, BDA_SEG
    mov ds, bx
    mov al, [video_cur_pos]     ; col
    mov ah, [video_cur_pos+1]   ; row
    push dx
    xor dh, dh
    mov dl, ah
    mov ah, 80
    xchg al, dl
    mul ah
    xor dh, dh
    add ax, dx
    shl ax, 1
    mov di, ax
    pop dx
    mov bx, VGA_SEG
    mov ds, bx
    mov al, [di]           ; character
    mov ah, [di+1]         ; attribute
    pop di
    pop bx
    pop bp
    pop es
    pop ds
    iret

.write_char_attr:
    ; AH=09h: Write char+attr at cursor, CX times
    ; AL=char, BL=attr, CX=count
    push di
    push dx
    push cx
    push bx
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [video_cur_pos]
    mov dh, [video_cur_pos+1]
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
    mov bx, VGA_SEG
    mov ds, bx
    pop bx                 ; restore original BX (BL=attr)
    push bx
.wca_loop:
    mov [di], al
    mov [di+1], bl
    add di, 2
    dec cx
    jnz .wca_loop
    pop bx
    pop cx
    pop dx
    pop di
    pop bp
    pop es
    pop ds
    iret

.write_char_only:
    ; AH=0Ah: Write char at cursor, CX times (keep existing attr)
    ; AL=char, CX=count
    push di
    push dx
    push cx
    push bx
    mov bx, BDA_SEG
    mov ds, bx
    mov dl, [video_cur_pos]
    mov dh, [video_cur_pos+1]
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
    mov bx, VGA_SEG
    mov ds, bx
.wco_loop:
    mov [di], al           ; write char only, keep attribute
    add di, 2
    dec cx
    jnz .wco_loop
    pop bx
    pop cx
    pop dx
    pop di
    pop bp
    pop es
    pop ds
    iret

; ============================================================
; scroll_up_one — scroll VGA text up by one line
; ============================================================
scroll_up_one:
    push ds
    push si
    push di
    push cx
    push ax
    mov ax, VGA_SEG
    mov ds, ax
    mov si, 160            ; source = row 1
    xor di, di             ; dest = row 0
    mov cx, 1920           ; 24 rows * 80 cols
.scopy:
    mov ax, [si]
    mov [di], ax
    add si, 2
    add di, 2
    dec cx
    jnz .scopy
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
; INT 11h — Equipment List (read from BDA, like reference BIOS)
; ============================================================
int11h_handler:
    sti
    push ds
    mov ax, BDA_SEG
    mov ds, ax
    mov ax, [equipment_list]
    pop ds
    iret

; ============================================================
; INT 12h — Memory Size (read from BDA, like reference BIOS)
; ============================================================
int12h_handler:
    sti
    push ds
    mov ax, BDA_SEG
    mov ds, ax
    mov ax, [memory_size]
    pop ds
    iret

; ============================================================
; INT 13h — Disk Services (memory-resident disk image)
; ============================================================
int13h_handler:
    cmp ah, 0x00
    je .disk_reset
    cmp ah, 0x02
    je .disk_read
    cmp ah, 0x08
    je .disk_params
    cmp ah, 0x15
    je .disk_type
    ; Unknown function — return error
    mov ah, 0x01           ; invalid function
    stc
    iret

.disk_reset:
    xor ah, ah
    clc
    iret

.disk_params:
    ; Return drive parameters for 1.44MB floppy
    mov ah, 0
    mov bl, 0x04           ; drive type: 1.44MB
    mov ch, DISK_CYLS - 1  ; max cylinder (79)
    mov cl, DISK_SPT       ; max sector (18)
    mov dh, DISK_HEADS - 1 ; max head (1)
    mov dl, 1              ; 1 floppy drive
    ; ES:DI = disk parameter table
    push bx
    mov bx, BIOS_SEG
    mov es, bx
    mov di, disk_param_table
    pop bx
    clc
    iret

.disk_type:
    ; AH=15h: Get disk type — floppy without change detection
    mov ah, 0x01
    clc
    iret

.disk_read:
    ; AH=02h: Read sectors
    ; AL=count, CH=cylinder, CL=sector(1-based), DH=head, DL=drive, ES:BX=dest
    push bp
    mov bp, sp
    push ds
    push si
    push di
    push ax
    push dx
    push cx

    ; Reload from stack since we need all values
    pop cx
    pop dx
    push dx
    push cx

    ; Compute LBA = (CH * 2 + DH) * 18 + (CL - 1)
    mov al, ch
    xor ah, ah
    shl ax, 1              ; AX = cyl * 2
    mov si, ax
    xor ah, ah
    mov al, dh
    add ax, si             ; AX = cyl*2 + head
    mov si, DISK_SPT
    push dx
    mul si                 ; AX = (cyl*2+head) * 18
    pop dx
    mov si, ax
    xor ch, ch
    dec cl                 ; sector is 1-based
    add si, cx             ; SI = LBA

    ; Source segment = DISK_SEG + LBA * 32
    mov ax, si
    mov cl, 5
    shl ax, cl
    add ax, DISK_SEG
    mov ds, ax
    xor si, si

    ; Destination = ES:BX
    mov di, bx

    ; Count
    pop cx
    pop dx
    pop ax
    xor ah, ah
    mov cx, ax
    push cx

    ; Copy CX sectors * 512 bytes
.read_sector_loop:
    push cx
    mov cx, 256
.read_word_loop:
    mov ax, [si]
    push ds
    push bx
    mov bx, es
    mov ds, bx
    mov [di], ax
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
    xor ah, ah
    clc
    pop di
    pop si
    pop ds
    pop bp
    iret

; ============================================================
; INT 16h — Keyboard Services (matches reference BIOS contracts)
; ============================================================
int16h_handler:
    sti
    push bx
    push ds
    mov bx, BDA_SEG
    mov ds, bx
    cmp ah, 0x00
    je .read_key
    cmp ah, 0x01
    je .check_key
    cmp ah, 0x02
    je .shift_flags
    cmp ah, 0x10
    je .read_key           ; enhanced = same for us
    cmp ah, 0x11
    je .check_key          ; enhanced = same for us
    cmp ah, 0x12
    je .ext_shift_flags
    ; Unknown function
    pop ds
    pop bx
    iret

.read_key:
    ; Busy-wait on keyboard buffer at 0000:0500
    pop ds
    pop bx
    push ds
    push bx
    xor bx, bx
    mov ds, bx
.key_wait:
    mov ax, [0x0500]
    test ax, ax
    jz .key_wait
    mov word [0x0500], 0
    pop bx
    pop ds
    iret

.check_key:
    ; Check if key is available (non-destructive)
    pop ds
    pop bx
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

.shift_flags:
    ; AH=02h: Return shift flags from BDA
    mov al, [kbd_flags_1]
    pop ds
    pop bx
    iret

.ext_shift_flags:
    ; AH=12h: Return extended shift flags
    mov al, [kbd_flags_1]
    mov ah, [kbd_flags_2]
    pop ds
    pop bx
    iret

; ============================================================
; INT 1Ah — Timer Services (matches reference BIOS contract)
; ============================================================
int1ah_handler:
    sti
    push bx
    push ds
    mov bx, BDA_SEG
    mov ds, bx
    cmp ah, 0x00
    je .timer_read
    cmp ah, 0x01
    je .timer_set
    ; Unknown function
    pop ds
    pop bx
    iret

.timer_read:
    ; AH=00h: Read tick count
    ; Returns: CX=high, DX=low, AL=midnight flag
    ; Reference: reads ticks, clears midnight flag via XOR
    mov dx, [ticks_lo]
    mov cx, [ticks_hi]
    mov al, [new_day]
    xor byte [new_day], al  ; clear midnight flag (reference method)
    ; Auto-increment workaround since we have no timer IRQ
    add word [ticks_lo], 1
    adc word [ticks_hi], 0
    pop ds
    pop bx
    iret

.timer_set:
    ; AH=01h: Set tick count
    mov [ticks_lo], dx
    mov [ticks_hi], cx
    mov byte [new_day], 0
    pop ds
    pop bx
    iret

; ============================================================
; INT 08h — Timer Tick (IRQ0)
; Increments BDA tick count, checks for midnight, calls INT 1Ch.
; We don't have a real PIT, so this won't fire automatically,
; but having the handler means any code that triggers INT 08h
; will work correctly.
; ============================================================
int08h_handler:
    push ax
    push dx
    push ds
    mov ax, BDA_SEG
    mov ds, ax
    ; Increment tick counter
    inc word [ticks_lo]
    jnz .no_overflow
    inc word [ticks_hi]
.no_overflow:
    ; Check for midnight rollover (1573042 = 0x18:0x00B2 ticks/day)
    cmp word [ticks_hi], 0x18
    jnz .no_midnight
    cmp word [ticks_lo], 0x00B2
    jnz .no_midnight
    mov word [ticks_hi], 0
    mov word [ticks_lo], 0
    mov byte [new_day], 1
.no_midnight:
    int 0x1C               ; User timer tick hook
    pop ds
    pop dx
    pop ax
    iret

; ============================================================
; INT 15h — Miscellaneous System Services (matches reference)
; ============================================================
int15h_handler:
    sti
    cmp ah, 0x4F
    je .kbd_intercept
    cmp ah, 0xC0
    je .sys_config
    cmp ah, 0x88
    je .ext_mem_size
    ; AH=90h/91h: OS hooks — return success
    cmp ah, 0x90
    je .os_hook
    cmp ah, 0x91
    je .os_hook
    ; Unknown function — CF set, AH=86h (like reference)
    mov ah, 0x86
    push bp
    mov bp, sp
    or byte [bp+6], 0x01   ; set CF in stacked FLAGS
    pop bp
    iret

.kbd_intercept:
    ; AH=4Fh: Keyboard intercept — just IRET (pass through)
    iret

.os_hook:
    ; AH=90h/91h: Device busy/interrupt complete — AH=0, IRET
    mov ah, 0x00
    iret

.ext_mem_size:
    ; AH=88h: Extended memory size (above 1MB) — none
    xor ax, ax
    push bp
    mov bp, sp
    and byte [bp+6], 0xFE  ; clear CF
    pop bp
    iret

.sys_config:
    ; AH=C0h: Get system configuration table
    mov ah, 0x00
    mov bx, BIOS_SEG
    mov es, bx
    mov bx, config_table
    push bp
    mov bp, sp
    and byte [bp+6], 0xFE  ; clear CF
    pop bp
    iret

; ============================================================
; INT 19h — Bootstrap (halt in our system)
; ============================================================
int19h_handler:
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [HALT_ADDR], 1
    pop ds
    jmp int19h_handler

; ============================================================
; INT 20h — Program Terminate (halt)
; ============================================================
int20h_handler:
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [HALT_ADDR], 1
    pop ds
    jmp int20h_handler

; ============================================================
; INT 01h — Single-step trap handler
; Clears TF from stacked FLAGS so execution resumes normally.
; ============================================================
int01h_handler:
    push bp
    mov bp, sp
    and word [bp+6], 0xFEFF    ; clear TF (bit 8) in stacked FLAGS
    pop bp
    iret

; ============================================================
; int_dummy — Dummy interrupt handler (IRET only)
; Matches reference BIOS int_dummy at FF53h.
; ============================================================
int_dummy:
    iret

; ============================================================
; default_handler — For unimplemented INTs
; Returns with CF set to signal "not supported".
; ============================================================
default_handler:
    push bp
    mov bp, sp
    or word [bp+6], 0x0001     ; set CF in stacked FLAGS
    pop bp
    iret

; ============================================================
; Interrupt vector table — offsets only (segment always F000h)
; Matches reference 8088_bios interrupt_table layout exactly.
; 32 entries: INT 00h through INT 1Fh.
; ============================================================
interrupt_table:
    dw int_dummy            ; INT 00 - Divide by zero
    dw int01h_handler       ; INT 01 - Single step (clears TF)
    dw int_dummy            ; INT 02 - NMI (no-op for us)
    dw int_dummy            ; INT 03 - Breakpoint
    dw int_dummy            ; INT 04 - Overflow (INTO)
    dw int_dummy            ; INT 05 - Print Screen (stub)
    dw int_dummy            ; INT 06 - Invalid opcode
    dw int_dummy            ; INT 07 - Coprocessor N/A
    dw int08h_handler       ; INT 08 - IRQ0 Timer
    dw int_dummy            ; INT 09 - IRQ1 Keyboard (no hw kbd)
    dw int_dummy            ; INT 0A - IRQ2
    dw int_dummy            ; INT 0B - IRQ3
    dw int_dummy            ; INT 0C - IRQ4
    dw int_dummy            ; INT 0D - IRQ5
    dw int_dummy            ; INT 0E - IRQ6 Floppy
    dw int_dummy            ; INT 0F - IRQ7
    dw int10h_handler       ; INT 10 - Video Services
    dw int11h_handler       ; INT 11 - Equipment List
    dw int12h_handler       ; INT 12 - Memory Size
    dw int13h_handler       ; INT 13 - Disk Services
    dw default_handler      ; INT 14 - Serial (stub)
    dw int15h_handler       ; INT 15 - Misc System Services
    dw int16h_handler       ; INT 16 - Keyboard Services
    dw default_handler      ; INT 17 - Printer (stub)
    dw int_dummy            ; INT 18 - ROM BASIC (stub)
    dw int19h_handler       ; INT 19 - Bootstrap
    dw int1ah_handler       ; INT 1A - Timer Services
    dw int_dummy            ; INT 1B - Keyboard Break
    dw int_dummy            ; INT 1C - User Timer Tick (IRET hook)
    dw int_dummy            ; INT 1D - Video Parameters (stub)
    dw disk_param_table     ; INT 1E - Floppy Parameters (data ptr)
    dw int_dummy            ; INT 1F - Font (stub)

; ============================================================
; BIOS Init — POST entry point
; Sets up IVT from interrupt_table, initializes BDA, boots DOS.
; ============================================================
bios_init:
    cli
    cld

    ; Set up stack at 0030:0100 (reference uses upper IVT area)
    ; This is 0x0400 linear, well below kernel at 0x600.
    mov ax, 0x0030
    mov ss, ax
    mov sp, 0x0100

    ; --- Initialize interrupt table ---
    ; Copy 32 vectors from interrupt_table (like reference BIOS).
    ; Reference uses movsw+stosw with DS=CS, ES=0. We can't use
    ; string ops easily, so we use a manual loop.
    ; First, set DS=0 for IVT writes.
    xor ax, ax
    mov ds, ax

    ; Fill ALL 256 IVT entries with int_dummy:F000 first
    ; (like reference fills remaining with int_dummy after the table)
    xor di, di
    mov cx, 256
    mov ax, BIOS_SEG
.fill_all:
    mov word [di], int_dummy
    mov word [di+2], ax        ; segment = F000h
    add di, 4
    dec cx
    jnz .fill_all

    ; Now overwrite INT 00-1F from the interrupt_table
    ; We need to read from CS:interrupt_table. Set up BX as table pointer
    ; and use DS=CS temporarily to read, then DS=0 to write.
    mov si, interrupt_table
    xor di, di             ; IVT offset 0
    mov cx, 32
.ivt_copy:
    ; Read offset from CS:SI
    push ds
    push cs
    pop ds
    mov bx, [si]           ; BX = handler offset from table
    pop ds                 ; DS = 0 again
    ; Write to IVT
    mov [di], bx           ; offset
    mov word [di+2], BIOS_SEG  ; segment
    add si, 2
    add di, 4
    dec cx
    jnz .ivt_copy

    ; Overwrite INT 20h with int20h_handler
    mov word [0x20*4], int20h_handler
    mov word [0x20*4+2], BIOS_SEG

    ; INT 21h: default_handler (kernel installs its own)
    mov word [0x21*4], default_handler
    mov word [0x21*4+2], BIOS_SEG

    ; --- Initialize BDA ---
    ; (Reference: kbd_buffer_init + individual field setup)
    mov ax, BDA_SEG
    mov ds, ax

    ; Equipment list: floppy present + 80x25 color = 0x0021
    mov word [equipment_list], 0x0021

    ; Memory size: 640 KiB
    mov word [memory_size], 640

    ; Keyboard buffer initialization (matches kbd_buffer_init)
    mov word [kbd_buffer_head], kbd_buffer   ; 0x001E
    mov word [kbd_buffer_tail], kbd_buffer   ; 0x001E (empty)
    mov word [kbd_buffer_start], kbd_buffer  ; 0x001E
    mov ax, kbd_buffer
    add ax, 0x20                             ; buffer size = 32 bytes
    mov word [kbd_buffer_end], ax            ; 0x003E

    ; Clear keyboard flags
    mov word [kbd_flags_1], 0       ; flags 1 + flags 2
    mov byte [kbd_alt_keypad], 0

    ; Video mode and parameters
    mov byte [video_mode], 0x03             ; mode 3 = 80x25 text
    mov word [video_columns], 80            ; 80 columns
    mov word [video_page_size], 0x1000      ; 4096 bytes per page
    mov word [video_page_offt], 0x0000      ; page 0 offset
    mov word [video_cur_pos], 0x0000        ; cursor at (0,0)
    mov word [video_cur_pos+2], 0x0000      ; page 1 cursor
    mov word [video_cur_pos+4], 0x0000      ; page 2 cursor
    mov word [video_cur_pos+6], 0x0000      ; page 3 cursor
    mov word [video_cur_shape], 0x0607      ; cursor shape start=6 end=7
    mov byte [video_page], 0x00             ; active page 0
    mov word [video_port], 0x03D4           ; CRT controller port (color)
    mov byte [video_rows], 24               ; rows minus 1
    mov word [video_char_height], 16        ; character height

    ; Timer ticks (start at zero)
    mov word [ticks_lo], 0
    mov word [ticks_hi], 0
    mov byte [new_day], 0

    ; Floppy state
    mov byte [fdc_calib_state], 0
    mov byte [fdc_motor_state], 0
    mov byte [fdc_motor_tout], 0
    mov byte [fdc_last_error], 0

    ; Clear warm boot flag
    mov word [warm_boot], 0

    ; --- BIOS splash screen ---
    ; Write directly to VGA memory at B800:0000
    mov ax, VGA_SEG
    mov ds, ax

    ; Clear screen
    xor di, di
    mov cx, 2000
    mov ax, 0x0720
.splash_clr:
    mov [di], ax
    add di, 2
    dec cx
    jnz .splash_clr

    ; Write "Gossamer BIOS v1.0" at row 1, col 30 (offset = (1*80+30)*2 = 220)
    mov di, 220
    mov ah, 0x0F           ; white on black
    mov si, splash_title
    call .write_splash_str

    ; "640K conventional memory" at row 3, col 28 (offset = (3*80+28)*2 = 536)
    mov di, 536
    mov si, splash_mem
    call .write_splash_str

    ; Update cursor position in BDA to row 5 (below splash)
    mov ax, BDA_SEG
    mov ds, ax
    mov byte [video_cur_pos], 0     ; col
    mov byte [video_cur_pos+1], 5   ; row

    ; --- Boot status messages via INT 10h ---
    sti
    mov si, msg_ivt
    call bios_print
    mov si, msg_boot
    call bios_print

    ; --- Jump to DOS kernel ---
    ; KERNEL.SYS is pre-loaded at 0060:0000 by the transpiler.
    ; Kernel expects BL = boot drive (0x00 = A:)
    xor ax, ax
    mov ds, ax
    mov bl, 0x00
    jmp KERNEL_SEG:0x0000

; --- Write null-terminated string to VGA at DS:DI ---
; AH = attribute byte (preserved). DS=VGA_SEG on entry.
; SI points into BIOS ROM (CS segment). Swaps DS to read.
.write_splash_str:
    push bx
    mov bx, ds             ; save VGA segment in BX
.wss_loop:
    ; Read byte from CS:SI
    push cs
    pop ds
    mov al, [si]
    mov ds, bx             ; restore DS = VGA segment
    test al, al
    jz .wss_done
    mov [di], al
    mov [di+1], ah
    add di, 2
    inc si
    jmp short .wss_loop
.wss_done:
    pop bx
    ret

; --- BIOS print: print null-terminated string at CS:SI via INT 10h ---
bios_print:
    push ax
    push bx
.bp_loop:
    push ds
    push cs
    pop ds
    mov al, [si]
    pop ds
    test al, al
    jz .bp_done
    mov ah, 0x0E
    mov bx, 0x0007
    int 0x10
    inc si
    jmp short .bp_loop
.bp_done:
    pop bx
    pop ax
    ret

; ============================================================
; Data: strings
; ============================================================
splash_title: db 'Gossamer BIOS v1.0', 0
splash_mem:   db '640K conventional memory', 0
msg_ivt:      db 'IVT OK', 13, 10, 0
msg_boot:     db 'Booting DOS...', 13, 10, 0

; ============================================================
; System configuration table (returned by INT 15h AH=C0h)
; Matches reference 8088_bios config_table layout.
; ============================================================
config_table:
    dw .size               ; bytes 0-1: table size
.bytes:
    db 0xFE                ; byte 2: model byte (XT)
    db 0x00                ; byte 3: submodel
    db 0x00                ; byte 4: BIOS revision
    db 0x00                ; byte 5: feature byte 1 (no special hw)
;       |||||||`-- dual bus
;       ||||||`-- Micro Channel
;       |||||`-- EBDA allocated
;       ||||`-- wait for event supported
;       |||`-- INT 15h/4Fh called on INT 09h
;       ||`-- RTC installed
;       |`-- 2nd PIC installed
;       `-- DMA ch3 used by HDD
    db 0x00                ; byte 6: feature byte 2
    db 0x00                ; byte 7: feature byte 3
    db 0x00                ; byte 8: feature byte 4
    db 0x00                ; byte 9: feature byte 5
.size equ $ - .bytes

; ============================================================
; Diskette parameter table (INT 1Eh data, INT 13h AH=08h pointer)
; 11 bytes, matches reference 8088_bios int_1E at EFC7h.
; Standard values for 1.44MB 3.5" floppy.
; ============================================================
disk_param_table:
    db 0xAF                ; step rate / head unload time
    db 0x02                ; head load time / DMA mode
    db 0x25                ; motor off delay (ticks)
    db 0x02                ; bytes per sector (2 = 512)
    db DISK_SPT            ; sectors per track (18)
    db 0x1B                ; gap length
    db 0xFF                ; data length
    db 0x50                ; format gap length
    db 0xF6                ; fill byte for format
    db 0x0F                ; head settle time (ms)
    db 0x08                ; motor start time (1/8 sec units)

bios_end:
