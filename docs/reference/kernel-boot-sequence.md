# EDR-DOS Kernel Boot Sequence

Reference documentation for CSS-DOS: what the EDR-DOS kernel does during boot,
what BIOS services it calls, and what our CSS-BIOS must provide.

Sources:
- `../edrdos/drbio/init.asm` — early BIOS init, device driver chain, IVT save
- `../edrdos/drbio/biosinit.asm` — main BIOS init sequence, DOS data setup, CONFIG.SYS
- `../edrdos/drbio/config.asm` — CONFIG.SYS processing, DDSC/LDT setup
- `../edrdos/drbio/genercfg.asm` — CONFIG.SYS file reading and command dispatch
- `../edrdos/drdos/header.asm` — DOS (PCMODE) data segment, List of Lists, NUL device
- `../edrdos/drbio/f52data.def` — List of Lists field offsets
- `../edrdos/drbio/fdos.equ` — DDSC (DPB), BCB, directory entry structures
- `../edrdos/drbio/udsc.equ` — Unit Descriptor (physical drive info)
- Ralf Brown's Interrupt List (canonical reference for INT interfaces)

---

## 1. Overview: Boot Phases

The kernel boot has five distinct phases. In CSS-DOS, phase 0 (CSS-BIOS init)
replaces the hardware POST and ROM BIOS init that would exist on a real PC.

| Phase | Code | Description |
|-------|------|-------------|
| 0 | `bios/init.asm` | CSS-BIOS init stub: IVT, BDA, splash, jump to kernel |
| 1 | `init.asm:init0→init1` | Kernel decompress/relocate, BIOS INT calls, device chain |
| 2 | `biosinit.asm:biosinit` | BIOS-layer init: relocate code, init device drivers, load BDOS |
| 3 | `biosinit.asm:relocated_init` | DOS init call, CONFIG.SYS processing, COMMAND.COM exec |
| 4 | `header.asm:pcmode_init` | FDOS layer init: INT vectors, data fixups, MCB chain |

---

## 2. Phase 0: CSS-BIOS Init Stub

File: `bios/init.asm` (assembled, placed at F000:0000)

This replaces the entire hardware POST. On a real PC, the BIOS would do memory
tests, device enumeration, and dozens of hardware init steps. We skip all of
that and directly set up the minimum state the kernel needs.

**Steps (in order):**

1. **CLI** — disable interrupts
2. **Stack setup** — SS:SP = 0030:0100 (linear 0x400, just below BDA)
3. **Clear VGA text screen** — 2000 words of 0x0720 to B800:0000
4. **Default all 256 IVT entries** — point to `dummy_iret` in BIOS ROM
5. **Override 11 IVT entries** — point to D6 microcode stubs:
   - INT 08h (timer), INT 09h (keyboard IRQ), INT 10h (video)
   - INT 11h (equipment), INT 12h (memory size), INT 13h (disk)
   - INT 15h (system services), INT 16h (keyboard input)
   - INT 19h (bootstrap), INT 1Ah (time of day), INT 20h (terminate)
6. **Initialize BDA** at 0040:0000 (256 bytes):
   - Equipment word `[0x10]` = 0x0021 (floppy present, 80x25 color)
   - Memory size `[0x13]` = 640 (KB)
   - Keyboard buffer head/tail `[0x1A-0x1D]` = 0x001E (empty)
   - Keyboard buffer limits `[0x80-0x83]` = 0x001E..0x003E
   - Video mode `[0x49]` = 0x03, columns `[0x4A]` = 80
   - Page size `[0x4C]` = 0x1000, page offset `[0x4E]` = 0
   - Cursor shape `[0x60]` = 0x0607
   - CRT port `[0x63]` = 0x03D4
   - Rows-1 `[0x84]` = 24, char height `[0x85]` = 16
7. **Write boot splash** — direct VGA text writes (no INT 10h calls)
8. **Set cursor** — BDA `[0x50]` = (col=0, row=8)
9. **Jump to kernel** — `jmp 0060:0000` with BL=0 (boot drive A:), DS=0

**Critical: the kernel entry contract:**
- CS:IP = 0060:0000
- DL = physical boot drive (0 for floppy A:, 0x80 for hard disk)
- DS:BP → boot sector BPB (for hidden sectors detection)
  - **Gap**: our init stub sets DS=0 and doesn't provide a BPB. The kernel's
    `init0` pushes `ds:1eh[bp]` and `ds:1ch[bp]` (BPB hidden sectors). With
    DS=0 and BP undefined, this reads garbage from the IVT — but since we
    only boot from floppy (DL=0), the `detect_boot_drv` code path that uses
    `part_off` is skipped for floppies.

---

## 3. Phase 1: Kernel Early Init (`init.asm`)

### 3.1 `init0` — Decompression and Relocation

Entry: the kernel file is loaded at some segment (60h or 70h depending on
loader protocol). `init0` runs from within the deblocking buffer area (first
512 bytes of the CODE segment) — this area is reused later.

Steps:
1. Fix up A20Enable to a RET instruction
2. Set stack below TEMP_RELOC_SEG
3. Push boot sector BPB hidden sectors to stack
4. Copy diskette parameters (11 bytes from INT 1Eh vector) to 0000:0522
   and redirect INT 1Eh vector there
5. Determine boot drive protocol (EDR: CS=70h DL=unit; FreeDOS: CS=60h BL=unit)
6. Copy kernel to TEMP_RELOC_SEG, decompress if compressed
7. Far jump to `init1` at BIO_SEG (70h)

### 3.2 `init1` — Hardware Queries

This is where the kernel makes its first BIOS INT calls. Entry state: DS=CS=70h,
DL=physical boot drive.

**BIOS INT calls made during init1:**

| Step | INT | AH | Registers | Purpose | Expected Return |
|------|-----|----|-----------|---------|-----------------|
| 1 | INT 15h | 88h | — | Get extended memory size | AX=KB of extended mem; CF=1 if unsupported |
| 2 | INT 12h | — | — | Get conventional memory size | AX=KB (e.g. 640) |
| 3 | INT 10h | 0Eh | AL=char, BX=7 | TTY output (version string) | (display only) |
| 4 | INT 15h | 41h,00h | BX=0 | Check BIOS resume mode support | CF=1 → not supported |

**Detail on each:**

**INT 15h AH=88h** (Extended Memory Size):
```
Entry: AH=88h
Exit:  AX = extended memory in KB above 1MB
       CF = 1 if function not supported
```
The kernel stores the result in `ext_mem_size`. Our BIOS returns AX=0, CF=0
(no extended memory). ✅ Implemented.

**INT 12h** (Conventional Memory Size):
```
Entry: (none)
Exit:  AX = memory size in KB (typically 640)
```
The kernel converts this to paragraphs (`shl ax, 6`) and stores in `mem_size`.
This becomes the total conventional memory pool. Our BIOS reads BDA 0x0413. ✅ Implemented.

**INT 10h AH=0Eh** (Teletype Output):
```
Entry: AH=0Eh, AL=character, BH=page, BL=foreground color (graphics modes)
Exit:  (none)
```
Used to display the kernel version string. Our BIOS handles this. ✅ Implemented.

**INT 15h AH=41h** (Resume Mode Check):
```
Entry: AH=41h, BX=0000h
Exit:  CF=1 if not supported
```
If supported, the kernel hooks INT 6Ch for resume handling. We return CF=1
(default behavior for unrecognized AH values). ✅ Works via default path.

### 3.3 `init1` — Device Driver Chain Setup

After BIOS queries, `init1` sets up the resident device driver chain:

1. Sets `device_root` = CS:offset `con_drvr` (the first driver in the chain)
2. Walks the chain fixing up segment fields in driver headers
3. Chain order: CON → AUX → PRN → CLOCK$ → DISK → COM1 → LPT1 → LPT2 → LPT3 → COM2 → COM3 → COM4
4. Saves IVT vectors for INT 10h, 13h, 15h, 19h, 1Bh at fixed offset 0x100

Then jumps to `biosinit` (Phase 2).

---

## 4. Phase 2: BIOS Init (`biosinit.asm`)

### 4.1 Entry and Memory Layout

Entry to `biosinit`:
- `MEM_SIZE` = memory in paragraphs (from INT 12h)
- `DEVICE_ROOT` = first resident device driver
- `INIT_DRV` = boot drive (0=A:, 1=B:, 2=C:)
- `INIT_BUF` = 3 (if mem ≤ 128K) or 5 (if mem > 128K)
- `CURRENT_DOS` = segment of BDOS (if already loaded)
- `INIT_FLAGS` = control flags

Steps:
1. Set up stack at CS:stack
2. Save bios_seg = CS
3. **RPL (Remote Program Loader) check** — reads INT 2Fh vector, calls AX=4A06h
   if "RPL" signature found. This is irrelevant for CSS-DOS.
4. Calculate `mem_max` = mem_size - MOVE_DOWN
5. **Relocate BIOS code** — copy RCODE/ICODE segments to high memory
6. **Move BDOS** — if single-file kernel, copy BDOS to `dos_cseg`
7. **Relocate biosinit itself** to top of memory, far-return to `relocated_init`

### 4.2 `relocated_init` — Main Sequence

After relocation, the main sequence is:

```
call config_init            ; (no-op in current code)
call dd_fixup               ; fix up relocatable device driver segments
les  di, device_root
call resident_device_init   ; send INIT command to all resident device drivers
call detect_boot_drv        ; match partition offset to determine boot drive
call read_dos               ; load BDOS from disk (if not single-file)
```

**`resident_device_init`** sends a device driver INIT request to each driver.
The disk driver init calls **INT 13h** (via its `Int13Trap` wrapper) to probe
drives:

| INT | AH | Registers | Purpose | Expected Return |
|-----|----|-----------|---------|-----------------|
| INT 13h | 08h | DL=drive | Get floppy drive parameters | CH=maxCyl, CL=maxSec, DH=maxHead, DL=numDrives, BL=type |
| INT 13h | 15h | DL=drive | Get disk type | AH=type (01=floppy, 02=floppy+changeline, 03=hard) |
| INT 13h | 08h | DL=80h+ | Get hard disk parameters | DL=numHardDrives; CF=1 if none |
| INT 13h | 41h | DL=80h+, BX=55AAh | Check LBA extensions | CF=1 if not supported |
| INT 13h | 48h | DL=80h+ | Extended drive parameters | CF=1 if not supported |
| INT 13h | 02h | DL=drive, ES:BX=buf, CX/DH=CHS, AL=count | Read sectors | CF=0 on success |
| INT 13h | 16h | DL=drive | Disk change status | AH=0 CF=0 (not changed) |
| INT 13h | 00h | DL=drive | Reset disk system | AH=0 CF=0 |

### 4.3 DOS Data Relocation

After loading BDOS:
1. Copy DOS data segment to low memory at `mem_max - dosdata_size`
2. Set `INT31_SEGMENT` at 0000:00C6 to point to DOS data segment
3. Allocate space for resident DDSCs
4. Allocate space for interrupt stubs

### 4.4 First DOS Init Call

```asm
call dword ptr cs:dos_init      ; → pcmode_init in header.asm
```

This is the **first call into the FDOS layer** (Phase 4). Parameters:
- AX = mem_size (top of memory in paragraphs)
- BX = free_seg (first free segment)
- DL = init_drv (boot drive, 0-based)
- DS = dos_dseg (DOS data segment)
- ES = int_stubs_seg

After pcmode_init returns, biosinit continues to Phase 3.

---

## 5. Phase 3: CONFIG.SYS and Shell Exec

### 5.1 `config_start` — Pre-CONFIG Setup

This is where the kernel starts making INT 21h calls. The DOS is now alive.

**INT 21h calls in `config_start`:**

| Step | INT 21h AH | Registers | Purpose |
|------|------------|-----------|---------|
| 1 | 50h (Set PSP) | BX=PSP seg | Tell DOS where our PSP is. **Must be first INT 21h call.** |
| 2 | 3306h (Get True Version) | — | Get DOS version number |
| 3 | 4458h (DRDOS internal) | — | Get DRDOS internal data pointer |
| 4 | 5200h (Get List of Lists) | — | Get pointer to internal DOS data in ES:BX |
| 5 | 48h (Allocate Memory) | BX=FFFFh | Get max available block size |
| 6 | 48h (Allocate Memory) | BX=max | Allocate all available memory |
| 7 | 0Eh (Select Drive) | DL=init_drv | Set default drive to boot drive |
| 8 | 1Ah (Set DTA) | DS:DX=buffer | Set DMA/DTA address |
| 9 | 3Dh (Open File) | DS:DX="AUX",AL=2 | Open AUX device |
| 10 | 3Dh (Open File) | DS:DX="CON",AL=2 | Open CON device (→ STDIN/STDOUT/STDERR) |
| 11 | 46h (Force Dup) | BX=handle,CX=target | Duplicate to STDOUT, STDERR |
| 12 | 3Eh (Close File) | BX=handle | Close AUX initial handle |

### 5.2 `config` — CONFIG.SYS Processing

**INT 21h calls during CONFIG.SYS:**

| INT 21h AH | Registers | Purpose |
|------------|-----------|---------|
| 6507h | BX=FFFFh, CX=5, DX=FFFFh | Get DBCS lead byte table pointer |
| 3800h | DS:DX=buffer | Get current country information |
| 0Dh | — | Disk reset (before bus master checks) |
| 0Eh | DL=drive | Get current drive |
| 32h | DL=3 | Get DPB for drive C: |
| 3Dh+80h | DS:DX="DCONFIG.SYS" | Open DCONFIG.SYS (try first) |
| 3Dh+80h | DS:DX="CONFIG.SYS" | Open CONFIG.SYS (fallback) |
| 3Eh | BX=handle | Close config file handle |
| 53h | DS:SI→BPB, ES:BP→DDSC | Build DDSC from BPB (per drive) |
| 48h | BX=size | Allocate memory for drivers/buffers |
| 49h | ES=segment | Free memory |
| 4Ah | ES=segment, BX=size | Resize memory block |
| 58h,01 | BL=strategy | Set memory allocation strategy |
| 09h | DS:DX=string | Display string (status messages) |
| 01h/08h | — | Read character (for F5/F8 prompts) |
| 02h | DL=char | Write character (echo) |

**BIOS INT calls during CONFIG.SYS:**

| INT | AH | Purpose |
|-----|----|----|
| INT 16h | 01h | Check keyboard for key (F5/F8 detection) |
| INT 16h | 00h | Read key from keyboard |
| INT 16h | 02h | Get shift flags |
| INT 1Ah | 00h | Get timer ticks (for keyboard polling timeout) |
| INT 10h | 0Eh | TTY output (status messages via FastConsole INT 29h) |
| INT 10h | 09h | Write char with attribute (COLOUR mode) |
| INT 10h | 03h | Get cursor position (COLOUR mode) |
| INT 10h | 02h | Set cursor position (COLOUR mode, backspace) |
| INT 2Fh | varies | Multiplex (STACKER, DBLSPACE, MemMAX checks) |

### 5.3 `config_end` — Post-CONFIG Cleanup

| INT 21h AH | Registers | Purpose |
|------------|-----------|---------|
| 4Ah | ES=mem_base, BX=used | Shrink memory allocation |
| 62h (Get PSP) | — | Get current PSP |
| 3Eh (Close) | BX=0..N | Close all inherited handles |
| 3Dh (Open) | DS:DX="AUX" | Re-open standard devices |
| 3Dh (Open) | DS:DX="CON" | Re-open CON (STDIN/STDOUT/STDERR) |
| 46h (Dup2) | various | Force dup to standard handles |
| 3Dh (Open) | DS:DX="PRN" | Open PRN device (STDPRN) |

### 5.4 `dos_r70` — Final Steps and EXEC

| INT 21h AH | Registers | Purpose |
|------------|-----------|---------|
| 3Dh+02h | DS:DX="$IDLE$" | Open IDLE device |
| 4458h | — | Get DRDOS internal data |
| 4403h | BX=handle | IOCTL write to IDLE device |
| 3Eh | BX=handle | Close IDLE device |
| 58h,01 | BL=03h,BH=0 | Set memory strategy (unlink UMBs) |
| 60h (Expand Path) | DS:SI=shell name | Expand SHELL= filename to absolute path |
| 4Bh,00h (EXEC) | DS:DX=shell, ES:BX=params | **EXEC COMMAND.COM** — this is where the boot completes |

If EXEC fails:
| INT 21h AH | Registers | Purpose |
|------------|-----------|---------|
| 09h | DS:DX="Bad..." | Display error message |
| 0Ah | DS:DX=buffer | Read string (new COMMAND path) |

---

## 6. Phase 4: FDOS Layer Init (`header.asm`)

### 6.1 DOS Data Segment Layout (List of Lists)

The FDOS data segment starts at `dos_dseg` (set during Phase 2). The "List of
Lists" is at offset 0x26 within this segment (returned by INT 21h AH=52h in
ES:BX).

**List of Lists layout** (offsets from ES:BX returned by INT 21h AH=52h):

| Offset | Size | Field | Initial Value | Purpose |
|--------|------|-------|---------------|---------|
| -0Ch | WORD | net_retry | 3 | Network retry count |
| -0Ah | WORD | net_delay | 1 | Network delay count |
| -08h | DWORD | bcb_root | FFFF:FFFF | Current disk buffer pointer |
| -04h | WORD | — | 0 | Unread CON input |
| -02h | WORD | dmd_root | 0 | Root of MCB chain (segment) |
| +00h | DWORD | ddsc_ptr | FFFF:FFFF | First DDSC (DPB) in chain |
| +04h | DWORD | file_ptr | → msdos_file_tbl | System File Table head |
| +08h | DWORD | clk_device | FFFF:FFFF | CLOCK$ device header |
| +0Ch | DWORD | con_device | FFFF:FFFF | CON device header |
| +10h | WORD | sector_size | 128 | Max sector size |
| +12h | DWORD | buf_ptr | → buf_info | Disk buffer info |
| +16h | DWORD | ldt_ptr | 0:0 | LDT (CDS) array |
| +1Ah | DWORD | fcb_ptr | → dummy_fcbs | FCB table |
| +1Eh | WORD | — | 0 | Unknown |
| +20h | BYTE | phys_drv | 0 | Number of physical drives |
| +21h | BYTE | last_drv | 0 | LASTDRIVE |
| +22h | DWORD | dev_root → nul_device | | Device driver chain head (NUL device) |
| +34h | BYTE | join_drv | 0 | Number of JOINed drives |
| +37h | DWORD | setverPtr | 0:0 | SETVER table |
| +3Fh | WORD | — | 1 | Number of disk buffers |
| +41h | WORD | — | 1 | Read-ahead buffer size |
| +43h | BYTE | bootDrv | 0 | Boot drive (1=A:, 2=B:, 3=C:) |
| +44h | BYTE | cpu_type | 0 | 1 if >= 386 |
| +45h | WORD | ext_mem | 0 | Extended memory (from INT 15h AH=88h) |
| +63h | BYTE | dmd_upper_link | 0 | Upper memory link flag |
| +66h | WORD | dmd_upper_root | FFFFh | Upper memory MCB chain |

### 6.2 `pcmode_init` — What It Does

Called from `biosinit` via `call dword ptr cs:dos_init`.

Entry: AX=mem_size, BX=free_seg, DL=init_drv, DS=dos_dseg, ES=int_stubs_seg

1. Fix up segment pointers in DOS data: buf_ptr, file_ptr, fcb_ptr, fdos_stub
2. Fix up country table segments
3. Fix up interrupt stub entries (INT 2Ah-3Fh → dummy IRET stubs)
4. Fix up DOS data segment vectors (INT 20h-29h handler pointers)
5. Fix up INT 30h (CALL 5 entry point) as a JMP FAR
6. Save BIOS INT 2Fh handler address
7. Fix up instance data segment pointers
8. Call `pcmode_reinit` — sets up codeSeg, hash tables, internal variable fixups
9. Set up first MCB: `dmd_root` = free_seg, DMD_ID='Z' (last), DMD_PSP=0 (free),
   DMD_LEN = mem_size - free_seg - 1

### 6.3 NUL Device

The NUL device is embedded in the List of Lists at offset +22h. It is always
the first device in the chain. Its header:
- Link: FFFF:FFFF (end of chain, updated when BIOS inserts devices)
- Attributes: DA_CHARDEV + DA_ISNUL (0x8004)
- Strategy/Interrupt: point to nul_strat / nul_int
- Name: "NUL     "

The BIOS's `config_finish` walks the device chain from the NUL device to
insert the BIOS device drivers (CON, AUX, PRN, CLOCK$, DISK, COMx, LPTx).

---

## 7. Key Data Structures

### 7.1 DDSC (DOS Drive Parameter Block / DPB)

Each logical drive has a DDSC. Structure (from `fdos.equ`):

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | BYTE | DDSC_UNIT | Absolute drive number (0=A:) |
| 1 | BYTE | DDSC_RUNIT | Relative unit (within driver) |
| 2 | WORD | DDSC_SECSIZE | Sector size in bytes |
| 4 | BYTE | DDSC_CLMSK | Sectors/cluster - 1 |
| 5 | BYTE | DDSC_CLSHF | Log2(sectors/cluster) |
| 6 | WORD | DDSC_FATADDR | Sector address of first FAT |
| 8 | BYTE | DDSC_NFATS | Number of FAT copies |
| 9 | WORD | DDSC_DIRENT | Root directory entries |
| 11 | WORD | DDSC_DATADDR | Sector address of cluster 2 |
| 13 | WORD | DDSC_NCLSTRS | Number of clusters on disk |
| 15 | WORD | DDSC_NFATRECS | Sectors per FAT |
| 17 | WORD | DDSC_DIRADDR | Sector address of root dir |
| 19 | DWORD | DDSC_DEVHEAD | Pointer to device driver header |
| 23 | BYTE | DDSC_MEDIA | Current media byte |
| 24 | BYTE | DDSC_FIRST | "Drive never accessed" flag (FFh) |
| 25 | DWORD | DDSC_LINK | Link to next DDSC |
| 29 | WORD | DDSC_BLOCK | Next block to allocate |
| 31 | WORD | DDSC_FREE | Free clusters |
| Total: 65 bytes (DDSC_LEN) |

**Initialization**: `setup_ddsc` in config.asm calls **INT 21h AH=53h**
(Translate BPB to DPB) with DS:SI→BPB and ES:BP→DDSC, then sets DDSC_UNIT,
DDSC_RUNIT, DDSC_DEVHEAD, DDSC_FIRST=FFh, DDSC_LINK=FFFF:FFFF.

**Chain**: starts at List of Lists offset +00h (ddsc_ptr), initially FFFF:FFFF.
Each new DDSC is linked to the end of the chain. The BIOS creates one DDSC per
drive unit returned by the disk device driver INIT call.

### 7.2 LDT (Logical Drive Table / CDS)

One per logical drive (up to LASTDRIVE). Each is LDT_LEN bytes. Key fields:

| Offset | Field | Description |
|--------|-------|-------------|
| LDT_NAME | 67-byte ASCIIZ current path (e.g. "A:\") |
| LDT_FLAGS | Drive flags (physical, joined, subst, network) |
| LDT_PDT | DWORD pointer to this drive's DDSC |
| LDT_BLK | Current directory cluster (FFFFh = root) |
| LDT_ROOTLEN | Root path length (2 for "X:\") |

**Initialization**: `setup_ldt` in config.asm zeros all LDTs, then for each
drive A: through LASTDRIVE: sets LDT_NAME = "X:\0", LDT_BLK = FFFFh,
LDT_ROOTLEN = 2, and searches the DDSC chain to set LDT_PDT.

**Location**: pointed to by List of Lists offset +16h (ldt_ptr). During early
boot, a temporary LDT area in init data is used; after CONFIG.SYS, a permanent
allocation is made and the pointer updated.

### 7.3 MCB Chain (Memory Control Blocks)

| Offset | Size | Field | Values |
|--------|------|-------|--------|
| 0 | BYTE | DMD_ID | 'M' (more follow) or 'Z' (last) |
| 1 | WORD | DMD_PSP | Owner PSP segment (0=free, 8=system) |
| 3 | WORD | DMD_LEN | Size in paragraphs |
| 8 | 8 BYTES | DMD_NAME | Owner name (e.g. "SD\0") |

**Initialization**: `pcmode_init` creates the first MCB at `free_seg` with
DMD_ID='Z', DMD_PSP=0, DMD_LEN = mem_size - free_seg - 1. The chain root is
stored at List of Lists offset -02h (dmd_root).

### 7.4 System File Table (SFT)

Pointed to by List of Lists offset +04h (file_ptr). Each entry has a link to
the next SFT block and N file handle entries (DHNDL_LEN bytes each). Initially
contains 4 internal handles (or 8 with FATPLUS). The SFT is extended during
CONFIG.SYS processing via `setup_doshndl` based on FILES= setting.

### 7.5 Disk Buffers (BCB Chain)

Pointed to by List of Lists offset +12h → buf_info. Each Buffer Control Block:

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 00h | WORD | BCB_NEXT | Link to next buffer |
| 02h | WORD | BCB_PREV | Link to previous buffer |
| 04h | BYTE | BCB_DRV | Drive (FFh = free) |
| 05h | BYTE | BCB_FLAGS | FAT/DIR/DATA/DIRTY flags |
| 06h | DWORD | BCB_REC | Sector address |
| 0Dh | DWORD | BCB_DDSC | Pointer to drive's DDSC |
| 14h | ... | BCB_DATA | Sector data |

Allocated during `setup_buffers` based on BUFFERS= setting (default 3 or 5).

---

## 8. Memory Map at Each Stage

### 8.1 At CSS-BIOS Init Exit (Phase 0 Complete)

```
0x00000-0x003FF  IVT (256 entries, 11 point to BIOS microcode stubs)
0x00400-0x004FF  BDA (initialized: video mode 3, 640K, keyboard buffer empty)
0x00500-0x005FF  Available (DOS workspace)
0x00600-0x0XXXX  Kernel loaded here (KERNEL.SYS, ~58KB)
  ...
0x0A000-0x0AFFF  VGA graphics framebuffer (Mode 13h, may be pruned)
0xB8000-0xB8FA0  VGA text buffer (cleared, splash screen written)
0xD0000-0xDXXXX  Memory-mapped disk image (FAT12, baked by transpiler)
0xF0000-0xFXXXX  BIOS ROM (init stub + D6 microcode stubs)
```

### 8.2 After `biosinit` Relocations (Phase 2 Complete)

```
0x00000-0x003FF  IVT (updated: INT 19h → kernel trap, INT 2Fh hooked)
0x00400-0x004FF  BDA
0x00500-0x005FF  Diskette parameter table copy (at 0x0522)
0x00600-0x006FF  Resident BIOS code/data (low memory, device drivers)
  ... (resident drivers: CON, AUX, PRN, CLOCK$, DISK, COMx, LPTx)
  [mem_current]   Top of resident BIOS
  [int_stubs_seg]  Interrupt stub area (5 bytes each × ~22 vectors)
  [dos_dseg]       DOS data segment (List of Lists, SFT, NUL device)
  [res_ddsc_seg]   Resident DDSCs (one per floppy/hard drive found)
  [free_seg]       First free paragraph → MCB chain root
  ...
  [mem_max]        Top of available memory
  [relocated BIOS init code]
  [mem_size]       Hardware memory top (paragraph A000h for 640K)
```

### 8.3 After CONFIG.SYS (Phase 3 Complete)

```
0x00000-0x003FF  IVT (INT 20h-3Fh now point to DOS handlers)
0x00400-0x004FF  BDA
0x00600-0x0XXXX  Resident BIOS (may be relocated to HMA if HIDOS)
  [DOS data segment, possibly relocated]
  [DDSCs — possibly relocated to UMB/HMA]
  [LDT array — LASTDRIVE entries]
  [SFT — FILES= entries]
  [Disk buffers — BUFFERS= entries]
  [Stacks — STACKS= entries]
  [Loaded device drivers from CONFIG.SYS]
  [DOS code — relocated down or to HMA]
  [First free MCB]
  ... (free memory)
  [mem_size]       Top of conventional memory
```

---

## 9. What Our BIOS Must Provide — Gap Analysis

### 9.1 How the Kernel's Own BIOS Layer Helps

A critical insight for CSS-DOS: the EDR-DOS kernel includes its own BIOS
layer (drbio) that **intercepts and handles many calls internally**, reducing
what the external BIOS (our CSS microcode) must provide.

**Console output path**: DOS INT 21h AH=02h/09h → CON device driver → INT 29h
→ `FastConsole` (in init.asm). FastConsole checks `col_mode` byte 0:
- If non-zero (COLOUR active): uses INT 10h AH=09h, 03h, 02h, 06h
- If zero (default): falls through to `INT 10h AH=0Eh`

**`col_mode` defaults to `db 0, 7, 0`** — byte 0 is zero, so the COLOUR
code path is never taken unless the user adds `COLOUR=` to CONFIG.SYS.
This means **INT 10h AH=09h and AH=06h are never called during boot**.

**Disk I/O path**: INT 13h calls from the disk driver go through `Int13Trap`
(in init.asm), which saves AX, calls the actual BIOS INT 13h handler, and
handles DMA errors internally. The kernel never calls INT 13h directly for
file I/O — that goes through INT 21h → DOS → device driver → Int13Trap → BIOS.

**INT 2Fh**: The kernel hooks INT 2Fh early via `Int2FTrap`. All multiplex
calls (RPL, STACKER, DBLSPACE, MemMAX) are internal. Our dummy IRET handler
is sufficient — the kernel gracefully handles no response.

### 9.2 Complete BIOS INT Call Table

Every BIOS INT call the kernel makes during boot, with the actual code path
that triggers it:

| INT | AH | Caller | Input | Expected Output | Status |
|-----|----|--------|-------|-----------------|--------|
| **INT 10h** | 00h | (not called during boot) | — | — | N/A |
| | 02h | (COLOUR path only) | BH=page, DH=row, DL=col | BDA updated | ✅ but not reached |
| | 03h | (COLOUR path only) | BH=page | DH=row, DL=col, CX=shape | ✅ but not reached |
| | 06h | (COLOUR path only) | AL=lines, BH=attr, CX=UL, DX=LR | VGA scroll | ❌ but not reached |
| | 09h | (COLOUR path only) | AL=char, BH=page, BL=attr, CX=count | VGA write | ❌ but not reached |
| | 0Eh | init1:output_msg, FastConsole | AL=char, BH=page, BL=7 | VGA write, cursor advance | ✅ CR/LF/BS/BEL |
| | 0Fh | (not called during boot) | — | — | ✅ |
| **INT 11h** | — | init1 | — | AX=equipment word | ✅ |
| **INT 12h** | — | init1 | — | AX=KB (640) | ✅ |
| **INT 13h** | 00h | disk driver init | DL=drive | AH=0, CF=0 | ✅ |
| | 02h | disk driver (sector read) | DL,ES:BX,CX,DH,AL | CF=0, AL=count | ✅ |
| | 08h | disk driver init | DL=drive | CX,DX,BL geometry | ✅ (ES:DI not needed) |
| | 15h | disk driver init | DL=drive | AH=type | ✅ |
| | 16h | disk driver | DL=drive | AH=0 CF=0 | ✅ |
| | 41h | disk driver init | DL=80h+ | CF=1 | ✅ |
| | 48h | disk driver init | DL=80h+ | CF=1 | ✅ |
| **INT 15h** | 41h | init1 (resume check) | BX=0 | CF=1 | ✅ (default path) |
| | 88h | init1 | — | AX=0 | ✅ |
| | 4Fh | (not called during boot) | — | — | ✅ |
| | C0h | (not called during boot) | — | — | ✅ |
| **INT 16h** | 00h | option_key (F5/F8 read) | — | AH=scan, AL=ASCII | ✅ |
| | 01h | option_key (keyboard poll) | — | ZF=1 if empty | ✅ |
| | 02h | get_boot_options (shift check) | — | AL=shift flags | ✅ |
| **INT 1Ah** | 00h | option_key (timeout) | — | CX:DX=ticks | ✅ reads BDA |
| **INT 08h** | — | PIT IRQ (hardware) | — | BDA ticks++, EOI | ✅ |
| **INT 09h** | — | keyboard IRQ (hardware) | — | key→BDA buffer, EOI | ✅ |
| **INT 19h** | — | (not called during boot) | — | — | ✅ |
| **INT 20h** | — | (not called during boot) | — | — | ✅ |

### 9.3 Actual Gaps

**FIXED: INT 1Ah AH=00h** — now reads BDA tick counter (0x046C/0x046E).
However, the F5/F8 polling loop still blocks boot because the PIT is not
programmed and IRQ 0 is masked, so the BDA ticks never advance via INT 08h.
Fixing this requires: PIT programming in init.asm, pit.mjs reload=0→65536
handling, PIC unmasking, and INT 08h/09h IRET. See logbook for details on
a failed attempt at this.

**FIXED: INT 10h AH=0Eh** — now handles CR/LF/BS/BEL via `--biosAL` dispatch.
Control chars suppress VGA writes and update cursor position correctly.

**PREDICTED NEXT BLOCKER: PIT/PIC/IRET** — the F5/F8 key polling loop in
`biosinit.asm:option_key` polls INT 1Ah in a loop (not yet verified that
the kernel reaches this point without hitting other bugs first):

```asm
    xor  ax, ax
    int  1Ah          ; get ticks → DX
    mov  cx, dx       ; save initial ticks
option_key10:
    mov  ah, 1
    int  16h          ; check keyboard (ZF=1 if empty)
    jnz  option_key30 ; key found → exit
    int  1Ah          ; get ticks again → DX
    sub  dx, cx       ; elapsed = current - initial
    cmp  dx, 36       ; 2 seconds?
    jb   option_key10 ; no → keep polling
```

INT 1Ah now correctly reads BDA ticks, but the ticks will stay at 0 because:
1. PIT channel 0 is not programmed (no OUT to ports 0x43/0x40)
2. IRQ 0 is masked in the PIC (picMask=0xFF)
3. INT 08h/09h handlers don't IRET (observed during a failed PIT attempt —
   they skip the D6 sentinel but don't pop IP/CS/FLAGS from the stack)

Previously this section described the INT 10h CR/LF issue:
cursor past row 24, causing VGA writes to wrong addresses.

Fix: in bios.mjs, add special-case handling for AL=0Dh (set cursor col to 0,
no VGA write), AL=0Ah (increment cursor row, no VGA write), AL=08h (decrement
cursor col, no VGA write), AL=07h (no-op).

### 9.4 Gaps That Don't Matter

**INT 10h AH=09h, 06h, 02h, 03h (COLOUR path)**: Only reached when
`col_mode` byte 0 is non-zero. Default is 0. These are never called unless
a user adds `COLOUR=` to CONFIG.SYS. Not needed for boot.

**INT 10h AH=1Ah (display adapter code)**: Not called during boot. Only
relevant for programs that probe the display adapter.

**INT 13h AH=08h ES:DI return**: The diskette parameter table pointer. The
disk driver uses the register returns (CX, DX, BL) for geometry. The ES:DI
value is not used by the kernel's disk init code.

**INT 15h AH=C0h (system config table)**: Not called during boot. The resume
mode check uses AH=41h (which our default CF=1 handles).

**INT 2Fh**: The kernel hooks it internally. Our dummy IRET is sufficient.

**INT 10h AH=00h (set video mode)**: Not called during boot. The init stub
sets the BDA video mode directly.

---

## 10. Critical Boot Path Summary

The minimum viable boot path — what must work for CONFIG.SYS processing
to complete and COMMAND.COM to EXEC:

| Step | What happens | BIOS calls | Status |
|------|-------------|------------|--------|
| 1 | CSS-BIOS init: IVT + BDA | (direct memory writes) | ✅ |
| 2 | Kernel decompression | Pure CPU, no BIOS | ✅ |
| 3 | Extended memory query | INT 15h AH=88h → 0 | ✅ |
| 4 | Conventional memory query | INT 12h → 640 | ✅ |
| 5 | Version string display | INT 10h AH=0Eh (with CR/LF) | ✅ |
| 6 | Device driver INIT | INT 13h AH=08h/15h probes | ✅ |
| 7 | DOS init (pcmode_init) | Pure CPU | ✅ |
| 8 | INT 21h calls (PSP, drives, files) | DOS handles, not BIOS | ✅ |
| 9 | CONFIG.SYS read | INT 21h → DOS → device → INT 13h AH=02h | ✅ |
| 10 | F5/F8 key polling (2s timeout) | INT 1Ah AH=00h + INT 16h AH=01h | ❌ **PIT not firing** |
| 11 | COMMAND.COM EXEC | INT 21h AH=4Bh → DOS | ✅ |

**Bottom line: INT 1Ah and INT 10h are fixed. The predicted next blocker
is step 10 — the PIT must fire INT 08h to advance BDA ticks so the F5/F8
timeout loop exits. Not yet verified that the kernel reaches step 10
without hitting other bugs.**
