# Memory layout

A cabinet's "memory" is a sparse set of **zones**. Only addresses
inside a zone get a backing CSS property; reads outside zones return
0, writes are silently dropped.

## The zones, by default

For a DOS cart with all defaults (`"preset": "dos-corduroy"`):

| Zone | Linear range | Purpose | Controlled by |
|---|---|---|---|
| Conventional RAM | `0x00000–0xA0000` (640K) | IVT, BDA, kernel, program, stack | `memory.conventional` |
| VGA Mode 13h | `0xA0000–0xAFA00` (64000 B) | 320×200×256 framebuffer | `memory.gfx` |
| VGA text | `0xB8000–0xB8FA0` (4000 B) | 80×25 text buffer | `memory.textVga` |
| Rom-disk window | `0xD0000–0xD01FF` (512 B) | Dispatches to `--readDiskByte(idx)` | `disk.mode = "rom"` |
| BIOS ROM | `0xF0000+` | Read-only BIOS bytes | Always included |

For a hack cart (`"preset": "hack"`):

| Zone | Linear range | Purpose |
|---|---|---|
| Conventional RAM | `0x0000–<memory.conventional>` | IVT, BDA, .COM at `0x100`, stack |
| VGA text | `0xB8000–0xB8FA0` | Always included today (no knob yet — follow-up) |
| BIOS ROM | `0xF0000+` | Always included |

## The rom-disk window

Pre-rom-disk, a DOS cart's floppy was baked into 8086 memory as an
`embeddedData` zone. That put a hard ceiling on disk size (it had to
fit in 640K minus the kernel, ~200K in practice).

The rom-disk window breaks that ceiling. The disk bytes live **outside
the 8086 address space**. Reads to `0xD0000–0xD01FF` are dispatched to
a `@function --readDiskByte(--idx)` whose entries are indexed by a
linearised key `lba * 512 + offset`. The LBA register lives at linear
`0x04F0` (inside the BDA intra-application area 0x4F0–0x4FF, which no
real DOS component uses).

Muslin's `INT 13h` handler:
1. Writes the requested LBA word to linear `0x4F0`.
2. `REP MOVSW` 256 words from `D000:0000` to `ES:DI`.
3. LBA++, sector count--, loop.

Because reads all live on a single-parameter, dense, literal-only
dispatch, Calcite compiles it to a single `Vec<i32>` lookup via its
`DispatchFlatArray` op. The limit is Calcite's 10 M-entry span — about
10 MB of rom-disk. Bootle (tiny) and Zork+FROTZ (~284 KB) are well
within.

## The 0x4F0 pitfall

Old drafts described the LBA register as "BDA offset 0x4F0". That can
be misread as `BDA_SEG(0x40) * 16 + 0x4F0 = 0x8F0`, which lands inside
the kernel's code segment and would corrupt it.

The correct location is **linear 0x4F0**, reached as `0000:04F0`. It's
inside the BDA intra-application area (BDA 0x0F0–0x0FF when
segment-relative), which sits at absolute 0x4F0–0x4FF.

Future BIOS work touching INT 13h: use `xor ax, ax; mov ds, ax`
before addressing the LBA register. Don't use `BDA_SEG`.

## Writable disk (aspirational)

Session-writable disk is designed but not yet implemented. When it
lands, INT 13h write calls will go to a RAM shadow sized by
`disk.size`. Writes live for the lifetime of the tab; reloading the
player resets to the factory floppy. No cross-session persistence —
that's a deliberate v1 decision.

See `docs/cart-format.md` for the schema field (`disk.writable`) and
the aspirational tag.

## Conventional RAM sizing caveat

The schema accepts `memory.conventional` values below 640K on DOS
carts. In practice the EDR-DOS kernel relocates code to the top of
conventional memory, and values below 640K can stall or crash the boot
depending on where the kernel ends up. The builder warns, proceeds,
and lets you experiment. The safe value is 640K.

## What Kiln does with all this

Zones are built by `comMemoryZones` (hack) or `dosMemoryZones` (DOS)
in `kiln/memory.mjs`. They produce a sorted array of linear
addresses. For each address, Kiln emits:

- A `@property --m<addr>` declaration with its initial byte.
- A `style(--at: <addr>): var(--__1m<addr>)` branch in `--readMem`.
- A double-buffer read `--__1m<addr>: var(--__2m<addr>, <init>)`.
- A write rule `--m<addr>: if(... else: var(--__1m<addr>))` that
  checks the 6 parallel write slots. Each slot is nested behind a
  `style(--_slotNLive: 1)` gate so that on ticks where slot N is idle,
  none of its per-byte `style(--memAddrN: addr)` branches are
  evaluated. Non-writing instructions (NOP, MOV reg,reg, jumps, most
  ALU reg-reg, flag ops) short-circuit at slot 0 with zero address
  lookups anywhere.
- Store and execute keyframe entries that double-buffer the byte.

That pattern — per-byte property + dispatch branches — is why
cabinets are hundreds of megabytes of CSS. The size is the price of
modeling 640K of RAM as 640K of CSS properties.
