; gossamer.asm — Gossamer BIOS for CSS-DOS
; Loaded at F000:0000 (linear 0xF0000)
;
; CONSTRAINTS:
; - No 0x0F-prefixed opcodes (near Jcc) — CSS emulator doesn't support them
; - No segment override prefixes (0x26 ES:, 0x2E CS:, etc.) — treated as no-ops
; - All memory access uses DS segment (the default)
; - For VGA access: set DS=0xB800, use [DI] addressing

[bits 16]
[org 0]

; ============================================================
; INT 10h — Video Services  (offset 0)
; ============================================================
int10h_handler:
    cmp ah, 0x0E
    jne .dispatch_other
    ; Fall through to teletype (most common)

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
    mov bx, 0x0040
    mov ds, bx
    mov dl, [0x0050]       ; column
    mov dh, [0x0051]       ; row

    ; Character is still in saved AX on stack; pop to get it back
    pop ax                 ; AX restored (AL = character)
    push ax                ; save again

    cmp al, 13
    je .tty_cr
    cmp al, 10
    je .tty_lf
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
    mov bx, 0xB800
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
.dispatch_other:
    cmp ah, 0x02
    je .set_cursor
    cmp ah, 0x03
    je .get_cursor
    cmp ah, 0x00
    je .set_mode
    cmp ah, 0x06
    je .scroll_up
    cmp ah, 0x0F
    je .get_mode
    iret

.set_cursor:
    push ds
    push bx
    mov bx, 0x0040
    mov ds, bx
    mov [0x0050], dl
    mov [0x0051], dh
    pop bx
    pop ds
    iret

.get_cursor:
    push ds
    push bx
    mov bx, 0x0040
    mov ds, bx
    mov dl, [0x0050]
    mov dh, [0x0051]
    mov cx, 0x0607
    pop bx
    pop ds
    iret

.get_mode:
    mov al, 0x03
    mov ah, 80
    mov bh, 0
    iret

.set_mode:
    push ds
    push di
    push cx
    push ax
    ; Clear cursor (always — both text and graphics modes reset it)
    mov ax, 0x0040
    mov ds, ax
    mov byte [0x0050], 0
    mov byte [0x0051], 0
    ; Branch on requested mode: AL=0x13 → Mode 13h (320x200x256),
    ; everything else treated as text mode (80x25).
    pop ax                 ; AL = original mode byte
    push ax                ; save it again for the final pop
    cmp al, 0x13
    je .set_mode_13h
    ; --- Text mode clear: 2000 words of space+attr at 0xB8000 ---
    mov ax, 0xB800
    mov ds, ax
    xor di, di
    mov cx, 2000
    mov ax, 0x0720
.clr_loop:
    mov [di], ax           ; DS:DI = B800:offset
    add di, 2
    dec cx
    jnz .clr_loop
    jmp short .set_mode_done
.set_mode_13h:
    ; --- Mode 13h clear: 64000 bytes of 0 at 0xA0000 ---
    ; Write as 32000 words for speed (still single-byte opcodes).
    mov ax, 0xA000
    mov ds, ax
    xor di, di
    mov cx, 32000
    xor ax, ax
.clr13_loop:
    mov [di], ax           ; DS:DI = A000:offset, word write
    add di, 2
    dec cx
    jnz .clr13_loop
.set_mode_done:
    pop ax
    mov al, 0x30
    pop cx
    pop di
    pop ds
    iret

.scroll_up:
    cmp al, 0
    jne .su_lines
    ; Clear entire screen
    push ds
    push di
    push cx
    mov cx, 0xB800
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

; ============================================================
; scroll_up_one — all VGA access via DS=0xB800
; ============================================================
scroll_up_one:
    push ds
    push si
    push di
    push cx
    push ax
    mov ax, 0xB800
    mov ds, ax
    ; Copy rows 1-24 up to rows 0-23
    mov si, 160            ; source = start of row 1
    xor di, di             ; dest = start of row 0
    mov cx, 1920           ; 24 rows * 80 cols = 1920 words
.scopy:
    mov ax, [si]           ; read char+attr from source
    mov [di], ax           ; write to dest
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
    push ds
    push bx
    xor bx, bx
    mov ds, bx
.key_wait:
    mov ax, [0x0500]
    test ax, ax
    jz .key_wait
    pop bx
    pop ds
    iret

.check_key:
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
    and word [bp+6], 0xFFBF
    jmp short .ck_ret
.ck_none:
    or word [bp+6], 0x0040
.ck_ret:
    pop bp
    iret

; ============================================================
; INT 1Ah — Timer
; ============================================================
int1ah_handler:
    cmp ah, 0x00
    jne .timer_ret
    push ds
    push bx
    xor bx, bx
    mov ds, bx
    mov dx, [0x0502]
    xor cx, cx
    xor al, al
    pop bx
    pop ds
    iret
.timer_ret:
    xor ax, ax
    iret

; ============================================================
; INT 21h — DOS
; ============================================================
int21h_handler:
    cmp ah, 0x02
    je .write_char
    cmp ah, 0x06
    je .direct_io
    cmp ah, 0x09
    je .write_string
    cmp ah, 0x01
    je .read_echo
    cmp ah, 0x07
    je .read_noecho
    cmp ah, 0x08
    je .read_noecho
    cmp ah, 0x4C
    je .exit
    cmp ah, 0x0E
    je .select_disk
    cmp ah, 0x19
    je .get_disk
    cmp ah, 0x30
    je .get_version
    cmp ah, 0x2C
    je .get_time_dos
    iret

.write_char:
    push ax
    mov al, dl
    mov ah, 0x0E
    int 0x10
    pop ax
    iret

.direct_io:
    cmp dl, 0xFF
    je .dio_read
    push ax
    mov al, dl
    mov ah, 0x0E
    int 0x10
    pop ax
    iret
.dio_read:
    xor al, al
    iret

.write_string:
    push si
    push ax
    mov si, dx
.ws_loop:
    mov al, [si]
    cmp al, '$'
    je .ws_end
    push si
    mov ah, 0x0E
    int 0x10
    pop si
    inc si
    jmp short .ws_loop
.ws_end:
    pop ax
    pop si
    iret

.read_echo:
    mov ah, 0x00
    int 0x16
    push ax
    mov ah, 0x0E
    int 0x10
    pop ax
    iret

.read_noecho:
    mov ah, 0x00
    int 0x16
    iret

.exit:
    ; Signal halt: write 1 to halt flag at DS:0x2110
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [0x2110], 1
    pop ds
    jmp .exit

.select_disk:
    mov al, 1
    iret

.get_disk:
    xor al, al
    iret

.get_version:
    mov ax, 0x0005
    iret

.get_time_dos:
    xor cx, cx
    xor dx, dx
    iret

; ============================================================
; INT 20h — Halt
; ============================================================
int20h_handler:
    ; Signal halt: write 1 to halt flag at DS:0x2110
    push ds
    xor ax, ax
    mov ds, ax
    mov byte [0x2110], 1
    pop ds
    jmp int20h_handler

bios_end:
