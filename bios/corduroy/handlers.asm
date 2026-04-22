; bios/handlers.asm — Interrupt handlers extracted from css-emu-bios.asm
; Linked with C BIOS init (not a standalone flat binary — no [org 0]).
; All handler labels are exported as globals so C code can reference them.

[bits 16]
[cpu 8086]      ; refuse to emit 186+ instructions — this BIOS runs on a pure 8086 core

global int01h_handler
global int08h_handler
global int09h_handler
global int10h_handler
global int11h_handler
global int12h_handler
global int13h_handler
global int15h_handler
global int16h_handler
global int19h_handler
global int1ah_handler
global int20h_handler
global int_dummy
global default_handler
global interrupt_table
global config_table
global disk_param_table

section _TEXT public align=1 class=CODE use16

; ============================================================
; Constants
; ============================================================
DISK_SEG    equ 0xD000          ; Disk window (linear 0xD0000, 512 bytes, dispatched by CSS)
disk_lba    equ 0x4F0           ; LBA register, linear 0x4F0 via 0x0000:0x04F0 (BDA intra-app area)
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

    ; Compute VGA offset = (row*cols+col)*2 where cols = 80 (mode 03h) or 40 (mode 01h).
    push ax                ; save char
    push dx                ; save cursor
    mov bl, 80             ; default: mode 03h = 80 columns
    cmp byte [video_mode], 0x01
    jne .tty_cols_set
    mov bl, 40             ; mode 01h = 40 columns
.tty_cols_set:
    push bx                ; save cols for wrap check
    mov al, dh
    mul bl                 ; AX = row*cols
    xor bh, bh
    mov bl, dl
    add ax, bx             ; AX = row*cols+col
    shl ax, 1              ; AX = (row*cols+col)*2
    mov di, ax
    pop bx                 ; restore cols in BL
    pop dx                 ; restore cursor
    pop ax                 ; restore char

    ; Write to VGA
    push ds
    push bx                ; save cols across ds reload
    mov bx, VGA_SEG
    mov ds, bx
    mov [di], al           ; character
    mov byte [di+1], 0x07  ; attribute
    pop bx                 ; restore cols
    pop ds

    ; Advance cursor (BL = column count for this mode)
    inc dl
    cmp dl, bl
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
    cmp ah, 0x1A
    jne .int10_done
    jmp .get_display_combo
.int10_done:
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
    mov bx, BDA_SEG
    mov ds, bx
    mov al, [video_mode]
    mov ah, [video_columns]
    mov bh, [video_page]
    pop bp
    pop es
    pop ds
    iret

.set_mode:
    ; Store requested mode in BDA and reset cursor.
    ; Shadow the raw requested mode to linear 0x04F2 (BDA intra-app area)
    ; so the player can diagnose "program asked for a mode we remapped".
    ; Calcite's get_requested_video_mode() reads this byte.
    push di
    push cx
    xor cx, cx
    mov ds, cx
    mov [0x04F2], al
    mov cx, BDA_SEG
    mov ds, cx
    mov byte [video_cur_pos], 0
    mov byte [video_cur_pos+1], 0
    ; Only store modes we actually support; map anything else to 0x03.
    cmp al, 0x13
    je .set_mode_store
    cmp al, 0x04           ; CGA 320x200x4 — 2bpp packed scanline-interleaved
    je .set_mode_store     ; framebuffer at B8000 (16 KB aperture).
    cmp al, 0x01           ; CGA 40x25 color text — same buffer at B8000,
    je .set_mode_store     ; just a different column stride.
    cmp al, 0x00           ; CGA 40x25 mono text — same layout as 0x01;
    jne .set_mode_force03  ; mono vs colour is an attribute-byte distinction
    mov al, 0x01           ; we ignore, so normalise to 0x01.
    jmp short .set_mode_store
.set_mode_force03:
    mov al, 0x03
.set_mode_store:
    mov [video_mode], al
    cmp al, 0x13
    je .set_mode_13h
    cmp al, 0x04
    je .set_mode_04h
    ; --- Text mode: clear 80x25 text buffer at 0xB8000 ---
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
    jmp short .set_mode_done
.set_mode_04h:
    ; --- CGA Mode 04h: clear the 16 KB aperture at 0xB8000 ---
    ; 320x200 at 2bpp = 16000 bytes of pixels, plus CGA hardware maps the
    ; full 16 KB window (8000 bytes even scanlines at B8000, 8000 bytes odd
    ; scanlines at BA000). Zero fills 8 KB words = 8192 iterations.
    mov ax, VGA_SEG
    mov es, ax
    xor di, di
    mov cx, 8192
    xor ax, ax
    cld
    rep stosw
    jmp short .set_mode_done
.set_mode_13h:
    ; --- Mode 13h: clear 320x200 framebuffer at 0xA0000 ---
    ; Uses REP STOSW so calcite can batch the 32000 iterations into one tick.
    ; The hand-rolled `mov [di],ax; add di,2; dec cx; jnz` form took ~120 ticks
    ; per word = ~3.8M ticks per mode-13 set, which dominated boot time and
    ; made every program that called INT 10h Mode 13h appear to "stall."
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov cx, 32000
    xor ax, ax
    cld
    rep stosw
.set_mode_done:
    pop cx
    pop di
    mov al, 0x30
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

.get_display_combo:
    ; AH=1Ah: Get/Set Display Combination Code
    ; Return VGA color (0x08) — programs use this to detect VGA.
    cmp bl, 0
    jne .dcc_set
    ; BL=00h: Get DCC
    mov bl, 0x08            ; active display: VGA color
    mov bh, 0x00            ; inactive: none
    pop bp
    pop es
    pop ds
    mov al, 0x1A            ; confirm function supported
    iret
.dcc_set:
    ; BL!=0: Set DCC — ignore but confirm
    pop bp
    pop es
    pop ds
    mov al, 0x1A
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
    ; AH=02h: Read sectors via rom-disk window.
    ; AL=count, CH=cylinder, CL=sector(1-based), DH=head, DL=drive, ES:BX=dest
    ;
    ; Protocol: for each sector, write current LBA word to physical [0x4F0]
    ; (linear, via segment 0). CSS dispatches reads to 0xD0000..0xD01FF by
    ; looking up that LBA word, so a REP MOVSW from DS=0xD000 SI=0 produces
    ; the sector bytes. Then LBA++, DI advances by 512, loop.
    push bp
    mov bp, sp
    push ds
    push si
    push di
    push ax
    push dx
    push cx

    ; Reload to get dx/cx values
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
    add si, cx             ; SI = LBA (starting)

    ; Reclaim original count (AL) from stack
    pop cx                 ; cx (saved)
    pop dx                 ; dx (saved)
    pop ax                 ; ax (saved) — AL = sector count
    xor ah, ah
    mov cx, ax             ; CX = sector count
    push cx                ; preserve original count for return (AL)

    ; Destination offset = BX (segment already in ES)
    mov di, bx

    ; SI currently = starting LBA. We'll keep LBA in BX across the loop
    ; because SI needs to be 0 for MOVSW from the disk window.
    mov bx, si

.read_sector_loop:
    ; Write BX (LBA) to linear [0x4F0] as a word via segment 0.
    push ds
    push ax
    xor ax, ax
    mov ds, ax
    mov [disk_lba], bx     ; word write: low at 0x4F0, high at 0x4F1
    pop ax
    pop ds

    ; Copy 256 words from DS=DISK_SEG:SI=0 to ES:DI
    push cx                ; save outer sector count
    push ds
    mov si, DISK_SEG
    mov ds, si
    xor si, si
    mov cx, 256
    cld
    rep movsw
    pop ds
    pop cx                 ; restore sector count

    ; Next sector: LBA++, DI already advanced by 512 by REP MOVSW
    inc bx
    dec cx
    jnz .read_sector_loop

    ; Success
    pop ax                 ; AL = sectors read (original count)
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
    ; AH=00h/10h: Block until a key is in the BDA ring buffer, then pop it.
    ; DS is already BDA_SEG from handler entry.
.key_wait:
    mov bx, [kbd_buffer_head]
    cmp bx, [kbd_buffer_tail]
    je .key_wait                ; buffer empty — spin
    mov ax, [bx]                ; read (scancode<<8 | ascii) word
    add bx, 2
    cmp bx, [kbd_buffer_end]    ; wrap around ring buffer
    jb .rk_nowrap
    mov bx, [kbd_buffer_start]
.rk_nowrap:
    mov [kbd_buffer_head], bx   ; advance head (consumes the entry)
    pop ds
    pop bx
    iret                        ; AX = key word

.check_key:
    ; AH=01h/11h: Non-destructive peek. Set ZF if buffer empty, clear if key.
    ; DS is already BDA_SEG from handler entry.
    mov bx, [kbd_buffer_head]
    cmp bx, [kbd_buffer_tail]
    je .ck_empty
    mov ax, [bx]                ; peek at next key (don't consume)
    pop ds
    pop bx
    push bp
    mov bp, sp
    and word [bp+6], 0xFFBF     ; clear ZF — key available
    pop bp
    iret
.ck_empty:
    pop ds
    pop bx
    push bp
    mov bp, sp
    or word [bp+6], 0x0040      ; set ZF — no key
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
    ; EOI to PIC (IRQ 0) — must be last so a nested exception during INT 1Ch
    ; still sees picInService set and clears its own bit cleanly.
    mov al, 0x20
    out 0x20, al
    pop ds
    pop dx
    pop ax
    iret

; ============================================================
; INT 09h — Keyboard IRQ (IRQ1)
; Reads scancode from port 0x60, pushes (scancode<<8 | ascii) into the BDA
; ring buffer so INT 16h works, toggles port 0x61 bit 7 to ack the keyboard
; controller, then EOIs the PIC. The --keyboard CSS property already packs
; (scancode<<8 | ascii) into the low word: port 0x60 IN returns the scancode
; (high byte), and we look up ASCII via scancode2ascii[] since we can't read
; the low byte directly from the port.
; ============================================================
int09h_handler:
    push ax
    push bx
    push cx
    push ds
    mov ax, BDA_SEG
    mov ds, ax

    ; Read scancode from keyboard port.
    in al, 0x60            ; AL = scancode
    mov ah, al             ; keep a copy in AH for BDA word high byte
    xor bh, bh
    mov bl, al             ; BX = scancode (for ASCII LUT)
    cmp bl, 0x80
    jae .ack               ; break code (high bit set) — don't buffer

    ; Look up ASCII in table; entries are 1 byte each, indexed by scancode.
    mov al, [cs:scancode2ascii + bx]
    ; AH = scancode, AL = ASCII → AX = BIOS key word.

    ; Append to BDA ring buffer if there's space.
    mov bx, [kbd_buffer_tail]
    mov cx, bx
    add cx, 2
    cmp cx, [kbd_buffer_end]
    jb .no_wrap
    mov cx, [kbd_buffer_start]
.no_wrap:
    cmp cx, [kbd_buffer_head]
    je .ack                ; buffer full — drop the key
    mov [bx], ax
    mov [kbd_buffer_tail], cx

.ack:
    ; Ack keyboard controller: pulse port 0x61 bit 7 high then low. Real PCs
    ; need this; in CSS it's a harmless OUT to an unhandled port.
    in al, 0x61
    mov ah, al
    or al, 0x80
    out 0x61, al
    mov al, ah
    out 0x61, al

    ; EOI to PIC (IRQ 1) — last, as with INT 08h.
    mov al, 0x20
    out 0x20, al

    pop ds
    pop cx
    pop bx
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
    dw int09h_handler       ; INT 09 - IRQ1 Keyboard
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

; ============================================================
; Scancode → ASCII lookup for INT 09h.
; 128 entries, indexed by make-code (0x00-0x7F). Unassigned = 0.
; Matches the (scancode, ascii) pairs in kiln/template.mjs KEYBOARD_KEYS —
; only keys the CSS :active keyboard can produce are mapped; everything
; else is 0 (a non-character scancode that INT 16h callers treat as "no
; ASCII", e.g. arrow keys).
; ============================================================
scancode2ascii:
    db 0x00, 0x1B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00   ; 00 Esc
    db 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x09   ; 0E Bksp, 0F Tab
    db 0x71, 0x77, 0x65, 0x72, 0x74, 0x79, 0x75, 0x69   ; 10-17 QWERTYUI
    db 0x6F, 0x70, 0x00, 0x00, 0x0D, 0x00, 0x61, 0x73   ; 18 O, 19 P, 1C Enter, 1E A, 1F S
    db 0x64, 0x66, 0x67, 0x68, 0x6A, 0x6B, 0x6C, 0x00   ; 20-27 DFGHJKL
    db 0x00, 0x00, 0x00, 0x00, 0x7A, 0x78, 0x63, 0x76   ; 2C-2F ZXCV
    db 0x62, 0x6E, 0x6D, 0x00, 0x00, 0x00, 0x00, 0x00   ; 30-32 BNM
    db 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00   ; 39 Space
    db 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00   ; 40-47
    db 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00   ; 48 Up, 4B Left, 4D Right (all ASCII=0)
    db 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00   ; 50 Down
    times 0x80 - ($ - scancode2ascii) db 0x00

