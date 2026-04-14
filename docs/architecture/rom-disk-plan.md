# ROM Disk Plan

**Status: Implemented on `feature/rom-disk` (commit 1f21f76+). Calcite
flat-array dispatch optimization landed (compile time for bootle:
frozen → 29s). Boot-level runtime verification next.**

The DOS boot path used to bake the FAT12 disk image into 8086 memory at
0xD0000. This limited disk size to ~128 KB (space between 0xD0000 and 0xEFFFF).
Real software (Doom8088 WAD = 1.3 MB) doesn't fit.

## The solution

Move disk bytes outside the 8086's 1MB address space and access them through
a memory-mapped window controlled by an LBA register.

| Linear    | Size      | Purpose                              |
|-----------|-----------|--------------------------------------|
| 0x004F0   | 2 bytes   | Disk LBA register                    |
| 0xD0000   | 512 bytes | Disk window (one sector at a time)   |

The LBA register lives at **linear 0x4F0** (reachable as segment:offset
`0x0000:0x04F0`). This is inside the standard BDA "intra-application
communications area" (0x4F0–0x4FF). Note: accessing it as
`0x0040:0x04F0` (BDA_SEG base) would be WRONG — that resolves to linear
0x8F0, which lives inside the loaded kernel and would corrupt it. Use
`xor ax,ax; mov ds,ax; mov [0x4F0], ...` in the BIOS handler.

The disk window reads are computed by `--readMem` dispatch based on the
current LBA value + byte offset within the sector.

## How reads work

INT 13h AH=02h handler:
1. Compute LBA from CHS parameters
2. Write LBA to 0x004F0
3. Copy 512 bytes from 0xD0000 to ES:BX using normal MOV loop
4. Advance to next sector, repeat

The CSS engine satisfies each window read by dispatching into a disk-data
table keyed on the current LBA. Programs using normal file I/O (INT 21h)
work automatically — DOS calls INT 13h, which uses the window.

## What changes in the codebase

Implemented on `feature/rom-disk`:

- `bios/css-emu-bios.asm` — `DISK_SEG = 0xD000`, `disk_lba equ 0x4F0`,
  `.disk_read` rewritten: per-sector, writes LBA word to physical [0x4F0]
  then `REP MOVSW` 256 words from `0xD000:0000` to `ES:DI`, LBA++.
- `transpiler/src/emit-css.mjs` — emits `@function --readDiskByte(--idx)`
  with one `style(--idx: N): byte;` branch per non-zero disk byte; the
  window addresses 0xD0000–0xD01FF dispatch to
  `--readDiskByte(calc((m1264 + m1265*256) * 512 + off))`.
- `transpiler/src/memory.mjs` — disk window excluded from stored memory
  (dispatch-only, no `--mN` properties for those addresses).
- `transpiler/generate-dos.mjs` — disk bytes threaded through `opts.diskBytes`
  instead of `embData`; `DISK_LINEAR = 0xD0000`.

Note: the original plan sketched a two-parameter `--readDiskByte(--lba, --off)`.
The actual implementation uses a single `--idx` parameter (linear byte
index = `lba*512 + off`) because calcite's dispatch flattener cross-products
parameter domains, which OOM'd on the two-parameter form.

## What it unlocks

Doom8088 (~1.5 MB total), Wolfenstein 3D, Commander Keen, Sierra adventure
games — anything that uses normal INT 21h file I/O.

## Key design insight

CSS-DOS doesn't have physical RAM. Memory is a sparse map of integer addresses
to bytes. The 1MB limit is purely a property of the 8086's segment:offset
addressing (tops out at 0xFFFFF). We can put disk bytes at any CSS address
(e.g., 0x100000+) — the 8086 can't `mov` to them directly, but the BIOS
handler (which is emitted by the generator and knows where the data lives)
bridges the gap by copying through the window.

This is exactly how a real PC works: the BIOS sector driver is the only layer
that knows about the physical storage. Everything above (DOS kernel, libc,
application) uses INT 13h and doesn't care what's behind it.

## CSS implementation (actual)

```css
@function --readDiskByte(--idx <integer>) returns <integer> {
  result: if(
    style(--idx: 0): 235;    /* disk byte 0 */
    style(--idx: 1): 60;
    style(--idx: 2): 144;
    /* ... one branch per non-zero disk byte ... */
    else: 0);
}
```

The disk window addresses (0xD0000–0xD01FF) dispatch in `--readMem` as:

```css
style(--at: 851968):
  --readDiskByte(calc((var(--__1m1264) + var(--__1m1265) * 256) * 512 + 0));
```

where `m1264` / `m1265` are the low and high bytes of the LBA register at
linear 0x4F0 / 0x4F1.

## Size considerations & calcite prerequisite

A 1.3 MB WAD = ~1.3 million dispatch branches. Valid CSS, but:

- Chrome can't evaluate it at usable speed.
- **Calcite's existing dispatch compiler doesn't flatten this case** —
  it compiles each branch as a full expression with its own `Vec<Op>`,
  which freezes compile for ~68K+ branches (bootle) and is projected to
  be unusable for Zork (284 KB → ~280K branches) or Doom (~1.5M).

The plan calls for calcite to detect the pattern "single-parameter dispatch
where every entry is an integer literal" and compile to a flat `Vec<i32>`
with a single `DispatchFlatArray` op. This is generic CSS optimization
(no x86 knowledge), consistent with the cardinal rule. Work in
progress — `feature/rom-disk` is blocked on this.
