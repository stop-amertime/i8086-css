; Test: Segment override prefixes
; Validates ES:, CS:, SS:, DS: overrides on various addressing modes
org 0x100

    ; === Setup: set ES to a different segment ===
    ; DS=0, we'll set ES=0x0050 (physical 0x500) to distinguish segments
    mov ax, 0x0050
    mov es, ax

    ; === Test 1: MOV [mem], AL with ES: override (0xA2) ===
    ; Write 0x42 to ES:0x0000 = physical 0x500
    mov al, 0x42
    es mov [0x0000], al       ; should write to 0x500, not 0x000
    ; Read it back via DS (should be at DS:0x500 = 0x500)
    mov bl, [0x500]           ; BL = 0x42 if override worked

    ; === Test 2: MOV AL, [mem] with ES: override (0xA0) ===
    ; First write a known value at ES:0x0010 = physical 0x510
    mov byte [0x510], 0xAB   ; write via DS:0x510
    es mov al, [0x0010]       ; read via ES:0x0010 = physical 0x510
    mov cl, al                ; CL = 0xAB if override worked

    ; === Test 3: MOV AX, [mem] with ES: override (0xA1) ===
    mov word [0x520], 0xBEEF ; write via DS:0x520
    es mov ax, [0x0020]       ; read via ES:0x0020 = physical 0x520
    mov dx, ax                ; DX = 0xBEEF if override worked

    ; === Test 4: ModR/M with ES: override ===
    ; MOV reg, [BX+disp] with ES: prefix
    mov bx, 0x0030
    mov word [0x530], 0xCAFE ; write via DS:0x530
    es mov si, [bx]           ; read via ES:BX = ES:0x0030 = physical 0x530
    ; SI = 0xCAFE if override worked

    ; === Test 5: SS: override on non-BP addressing ===
    ; Normally [BX] uses DS, SS: override forces SS segment
    ; SS=0 same as DS=0 here, so we change SS
    mov ax, 0x0050
    mov ss, ax                ; SS = 0x0050 (same as ES for simplicity)
    ; Now SS:0x0040 = physical 0x540
    mov word [0x540], 0xD00D ; write via DS:0x540
    mov bx, 0x0040
    ss mov bp, [bx]           ; read via SS:BX = SS:0x0040 = physical 0x540
    ; BP = 0xD00D if override worked

    ; Restore SS to 0 for clean exit
    xor ax, ax
    mov ss, ax

    ; === Test 6: Store results for trace ===
    ; BL=0x42, CL=0xAB, DX=0xBEEF, SI=0xCAFE, BP=0xD00D
    ; AX was clobbered, reconstruct for trace visibility
    mov ax, bx                ; AX = BX (0x0040, but BL=0x42)

    int 0x20
