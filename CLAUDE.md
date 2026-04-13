# CSS-DOS (formerly i8086-css)

A complete Intel 8086 PC implemented in pure CSS. The CSS runs in Chrome —
no JavaScript, no WebAssembly. [Calcite](../calcite) is a JIT compiler that
makes it fast enough to be usable.

IMPORTANT: WHEN DEBUGGING, DO NOT RUSH TO CONCLUSIONS. Take a measured approach, gather information, and don't apply speculative fixes. Your biggest failure mode in debugging is jumping to conclusions and making assumptions. Prefer to create good debugging infrastructure so you can inspect what is happening clearly, rather than chasing individual bugs around.

IMPORTANT: DO NOT GUESS OR ASSUME. Before doing anything, look for existing
documentation. The calcite repo (`../calcite/docs/`) has critical docs:
- `debugger.md` — the HTTP debug server endpoints and workflows
- `conformance-testing.md` — the full testing toolkit (`fulldiff.mjs`,
  `diagnose.mjs`, `ref-dos.mjs`) and how to use them for DOS boot debugging
- The debugger is the primary debugging tool. Use it. Don't reinvent it.

For anything about DOS, the 8086, BIOS interrupts, FAT12, or the DOS kernel:
look it up. We don't write the DOS kernel (it's EDR-DOS). We don't write the
8086 ISA. These are decades-old standards with extensive public documentation.
Search the web or download a reference before guessing at how something works.

## Current status

**Architecture pivot in progress.** We are replacing the v1 JSON instruction
database approach with a JS→CSS transpiler. See GitHub issue #49 for the full
plan.

- `legacy/` — the old approach (preserved for reference, not actively developed)
- `transpiler/` — the new approach
- `tools/` — conformance testing infrastructure (reference emulator + comparison tools)
- `bios/` — Gossamer BIOS source (gossamer.asm, gossamer-dos.asm)
- `build/` — compiled BIOS binaries and listings (generated from bios/)
- `tests/` — test assembly sources (.asm) and compiled binaries (.com)

## Project layout

```
transpiler/          JS→CSS transpiler
  README.md          Architecture doc
  generate-hacky.mjs Generate CSS from a .COM binary (hack path, non-canonical layout)
  generate-dos.mjs   Generate CSS via DOS boot (full DOS mode)
  src/               Transpiler source modules
bios/                Gossamer BIOS source
  gossamer.asm       Simple BIOS: INT 10h, 16h, 1Ah, 20h, 21h
  gossamer-dos.asm   DOS boot BIOS: disk I/O, kernel loading
build/               Compiled BIOS outputs (gitignored except .bin)
  gossamer.bin       Compiled simple BIOS (loaded at F000:0000)
  gossamer-dos.bin   Compiled DOS BIOS
  gossamer.lst       NASM listing
  gossamer-dos.lst   NASM listing
tools/               Conformance testing
  js8086.js          Vendored reference 8086 emulator (~2700 lines JS)
  ref-emu.mjs        Runs reference emulator, outputs register trace
  compare.mjs        Tick-by-tick comparison against calcite output
tests/               Test assembly sources and binaries
dos/                 DOS kernel and system files
  bin/               kernel.sys, command.com, etc.
legacy/              OLD approach — see legacy/README.md
  base_template.css  CSS skeleton with @function definitions (USEFUL REFERENCE)
  base_template.html HTML wrapper with visualization
```

## The cardinal rule

The CSS is a working program that runs in Chrome on its own. It is the source
of truth. Calcite is a JIT compiler for CSS — it must produce the same results
Chrome would, just faster. Calcite has zero x86 knowledge.

This means:
- **The CSS must work in Chrome.** If Chrome can't evaluate it, it's wrong.
- **Calcite can't change the CSS.** It can only find faster ways to evaluate
  the same expressions.
- **Never suggest CSS changes to help calcite.** That's backwards.
- **If calcite disagrees with Chrome, calcite is wrong.**

### When Chrome stops being a practical source of truth

Chrome has limitations that make it impractical as the sole test oracle at
scale:

- **Speed:** Chrome evaluates ~200 ticks in ~78 seconds. Calcite does 3500
  ticks in ~0.15 seconds (~500x faster). Testing programs that need thousands
  of ticks is only feasible through Calcite.
- **@function nesting depth:** Chrome silently fails when `@function` calls
  are nested too deeply (e.g., a function whose body calls `--xor` which
  decomposes into 33 local variables). There is no error — the property
  just evaluates to the initial value. This was hit with OF flag helpers
  that called `--xor` internally.
- **@function local variable limit:** Chrome silently fails with >7 local
  variables in a single `@function`. Again, no error, just wrong values.
- **Argument restrictions:** Chrome `@function` arguments cannot themselves
  be `@function` calls (e.g., `--foo(--bar(x))` fails). Native CSS math
  functions like `calc()`, `mod()`, `min()`, `max()`, `round()`, `pow()`
  are fine as arguments since they are part of the CSS math grammar.

In practice, this means:
- **Simple instructions** (MOV, ADD, JMP, etc.) can be validated in Chrome.
- **Complex instructions** (IMUL with signed conversion, multi-step flag
  computations) may exceed Chrome's nesting/complexity limits and can only
  be validated through Calcite + reference emulator comparison.
- **The reference JS emulator (`tools/js8086.js`) becomes the primary source
  of truth** for instruction correctness, with Calcite as the execution
  engine. Chrome remains the source of truth for CSS *semantics* (how
  `calc()`, `mod()`, `if()`, `@function` etc. should behave) but not for
  whether a particular deeply-nested expression actually evaluates in
  Chrome's implementation.

## What CSS-DOS is (and isn't)

**CSS-DOS is a DOS/PC emulator, not a bespoke 8086 sandbox.** The machine we
present to programs must look like a real PC-compatible machine, because the
entire point is that unmodified DOS programs can run on it. If we take
shortcuts that diverge from real hardware, we build a thing that only runs
*our* programs — which is not the goal.

### The canonical machine

The memory map, BIOS entry points, BDA layout, IVT, and hardware regions must
match what a real PC looks like. Programs assume this layout and we do not
get to move things around for convenience:

| Region           | Address         | Purpose                            |
|------------------|-----------------|------------------------------------|
| IVT              | 0x00000–0x003FF | Interrupt vector table             |
| BDA              | 0x00400–0x004FF | BIOS Data Area (video mode, etc.)  |
| Conventional RAM | 0x00500–0x9FFFF | Program + stack + DOS              |
| VGA graphics     | 0xA0000–0xAFFFF | Mode 13h framebuffer (64000 bytes) |
| VGA text         | 0xB8000–0xB8FFF | 80x25 color text (4000 bytes)      |
| BIOS ROM shadow  | 0xF0000–0xFFFFF | Gossamer BIOS code                 |

### Rules that follow from this

- **No flags that programs can't see.** A program that does `MOV AX, 0x13; INT 10h`
  expects Mode 13h regardless of how the CSS was baked. Transpiler flags must
  never change semantics that a running program could observe.
- **BDA state must be real.** Fields like `video_mode` at 0x0449 must reflect
  actual state. Never hardcode values in INT 10h handlers and hope.
- **INT 10h handlers must actually do the thing.** `AH=00h` writes mode to BDA
  and clears the framebuffer. `AH=0Fh` reads BDA. `AH=1Ah` reports the real
  display adapter. A program that calls these and gets lies breaks in ways
  that are nearly impossible to debug.
- **The runner trusts the machine.** When deciding whether to show text or
  graphics output, the runner reads BDA 0x0449 — it does not guess from CSS
  content or UI toggles. That's what a real monitor does.
- **The raw `.COM` path in `generate-hacky.mjs` is the "hack path".** It explicitly
  does not try to be a DOS machine and is fine to have a simpler layout.
  Everything above applies to `generate-dos.mjs` (the DOS boot path).

### Bake-time memory pruning

Because CSS can't load files at runtime — all memory is serialized as CSS
properties up front — *unused* memory regions cost real bytes in the output
file. This gives us one legitimate form of optimization: **prune-only flags**
that omit regions we know the program can't touch.

The rules:

- **Default = full canonical layout.** `generate-dos.mjs` with no flags emits
  every region above. A program that never touches 0xA0000 still has it; the
  region is just zeros and costs ~1 MB in the CSS. This is the correct default
  because *we don't know* what a program will touch.
- **Pruning is opt-in and prune-only.** Flags like `--no-gfx` or `--no-text-vga`
  *remove* regions from the output. They never relocate, substitute, or fake
  anything. A pruned CSS file is a strict subset of the canonical CSS file.
- **Pruning is an author's promise.** If you pass `--no-gfx`, you are asserting
  this program does not write to 0xA0000. If it does, it silently writes into
  nothing and the failure mode is weird. Only prune when you know.
- **Pruning does not change BIOS behavior.** INT 10h still tracks mode in BDA
  even if the framebuffer region is pruned — because we might still care about
  the mode byte for display routing. Handlers never branch on "is this region
  present".

### The disk problem and the ROM disk plan (planned, not yet implemented)

The DOS boot path bakes the FAT12 disk image into 8086 real-mode memory at
`0xD0000`. The 8086 can only address 1 MB (`0x00000`–`0xFFFFF`) and the BIOS
ROM lives at `0xF0000`–`0xFFFFF`, so the disk has at most ~128 KB of space
between `0xD0000` and `0xEFFFF`. That's enough for tiny test programs but
nowhere near enough for real software like Doom8088 (whose preprocessed text
WAD `DOOM16DT.WAD` alone is 1.3 MB, never mind the EXE).

#### How a real DOS computer reads from disk

Before describing the fix, it's worth understanding what we're emulating,
because the layering matters. On any DOS PC ever built, an application's
`fread()` call goes through four cleanly separated layers:

```
Application:      fread(buf, 1, 512, fp)
                       ↓
C runtime:        _read(fd, buf, 512)
                       ↓
DOS kernel:       INT 21h AH=3Fh "read from file handle"
                       ↓
DOS file system:  walks FAT chain, computes (drive, LBA, count)
                       ↓
BIOS:             INT 13h AH=02h "read sectors from disk"
                       ↓
BIOS sector driver: talks to disk controller hardware
                       ↓
Hardware:         IDE/floppy controller actually moves bytes
```

Each layer has a clean interface and the layer above does not know how the
layer below works. This is why a DOS program written for an IBM XT in 1985
runs unchanged on a 2024 PC with NVMe storage — every layer is replaceable.

- **Application + C runtime** live inside the program binary. They think in
  files and bytes. They never change.
- **The DOS kernel** is the only layer that knows what a "file" is. It owns
  the FAT, the directory tree, the per-process file handle table, the file
  position. It translates "give me bytes 500–600 of MYFILE.TXT" into "read
  sector 47 from drive A, copy bytes 88–187 from that sector into the
  destination". For us this is **EDR-DOS** sitting in `dos/bin/kernel.sys`,
  ~58 KB of code we did not write.
- **The BIOS** has no idea what a file is. It only knows sectors. `INT 13h
  AH=02h` says "read N sectors starting at LBA L into ES:BX" and that is the
  whole interface. The implementation can be anything: a real floppy
  controller, an IDE bus, a USB MSC bridge, a RAM disk, **or a CSS dispatch
  table**. The DOS kernel cannot tell the difference and does not care.

The key insight: **the BIOS↔hardware boundary is the only place where "how
bytes physically come off a disk" lives.** Everything above that boundary is
the same on every PC ever made. A 1985 floppy and a 2024 NVMe SSD both run
the same DOS programs because both end up satisfying `INT 13h AH=02h` with
the right bytes — and that's the only thing the layer above asks of them.

So **the ROM disk plan only changes Layer 4** (the BIOS sector driver).
Everything above — application, libc, EDR-DOS kernel, FAT walker, file
handle table — is untouched. This is exactly the layering that lets the same
DOS code run on different storage backends.

#### Why "outside the address space" is even meaningful in CSS-DOS

CSS-DOS doesn't have physical RAM. Memory is a sparse map of integer
addresses to bytes, expressed as `@property --m{N}` declarations and a
`--readMem(--at: N)` dispatch function. Address numbers are unbounded — we
could have `@property --m17000000` and Chrome would handle it. The 1 MB
limit is purely a property of the **8086 CPU's segment:offset addressing**:
`mov al, [si]` with `DS:SI` resolves to `linear = DS*16 + SI`, and both are
16-bit, so the linear result tops out at `0x10FFEF` (and is masked to
`0xFFFFF` by A20 wrap). The CPU literally cannot generate a `mov` instruction
whose target byte is at linear address `0x100000` or higher.

So we can put the disk's bytes in CSS at any address we want. The 8086 just
can't `mov` to them directly. The BIOS has to bridge the gap — and the
bridge is exactly the BIOS sector driver from Layer 4 above. We're swapping
out the equivalent of "the floppy controller" with "the CSS dispatch table",
and just like swapping floppy for IDE, the layers above don't notice.

#### The bridge: memory-mapped window with an LBA register

We carve a small region of normal 8086 RAM into a **disk window**:

| Address       | Size      | Purpose                                       |
|---------------|-----------|-----------------------------------------------|
| `0x004F0`     | 2 bytes   | Disk LBA register (BDA, current sector)       |
| `0xD0000`     | 512 bytes | Disk window (one sector visible to the CPU)   |

The LBA register lives **inside the BIOS Data Area** at `0x004F0`. The BDA
spans `0x400`–`0x4FF` and the `0x4F0`–`0x4FF` range is the canonical
"intra-application communications area" — reserved for vendor / app use,
with no standard meaning that EDR-DOS or any well-behaved DOS program
touches. That's the right home for a BIOS-private control register: it's
BDA-owned (matches what the LBA represents conceptually), it survives across
DOS calls without interference, and it stays inside the canonical PC memory
layout the rest of the docs already commit to.

(We deliberately do *not* use `0x500`. That address is the "magic keyboard
byte" in `gossamer.asm` (the simple BIOS, not the DOS one). The simple BIOS
gets away with it because its memory map is flat and `0x500` is otherwise
meaningless there. In the DOS path, `0x500` is inside the application
workspace EDR-DOS hands out, and a stray write from any program would
corrupt the disk register. The BDA is the safe place.)

The LBA register is a normal writable word — the CPU writes it like any
other memory. The disk window is **also** addressable like normal memory,
but the values it returns aren't stored bytes — they're computed by
`--readMem` from the current LBA value plus the byte offset within the
window. Conceptually:

```css
@function --readMem(--at <integer>) returns <integer> {
  result: if(
    /* normal RAM */
    ...
    /* disk window: 512 cases that dispatch on the LBA register at 0x4F0 */
    style(--at: 851968): --readDiskByte(var(--__1m1264), 0);   /* 0xD0000 → LBA word + offset 0 */
    style(--at: 851969): --readDiskByte(var(--__1m1264), 1);   /* 0xD0001 → LBA word + offset 1 */
    ...
    style(--at: 852479): --readDiskByte(var(--__1m1264), 511); /* 0xD01FF → LBA word + offset 511 */
  else: 0);
}

@function --readDiskByte(--lba <integer>, --off <integer>) returns <integer> {
  result: if(
    style(--lba: 0, --off: 0): 235;       /* sector 0, byte 0 = MZ signature 'M' */
    style(--lba: 0, --off: 1): 60;
    /* ... one branch per disk byte ... */
  else: 0);
}
```

(`var(--__1m1264)` reads the previous-tick value of `--m1264` — the byte at
linear address `0x4F0`. The actual emission probably reads the full word as
two bytes combined, but the principle is the same.)

The BIOS's `INT 13h` handler (read sectors from disk) becomes:

```asm
; AH=02h: read CX sectors from disk to ES:BX, starting at LBA in (CH/CL/DH)
;   For each requested sector:
;     1. Compute LBA from (cyl, head, sector) and store in [0040:00F0]  (BDA + 0xF0)
;     2. Copy 512 bytes from 0xD0000 to ES:BX using a normal mov-loop
;     3. ES:BX += 512
```

That's it. The CPU does normal byte-by-byte (or word-by-word) memory copies.
The CSS engine, every time the CPU reads a byte from the window, satisfies
the read by dispatching into the disk-data table keyed by the current LBA.

#### Why this generalises to any DOS program

The whole point of preserving the `INT 13h` interface is that **we don't
have to know anything about the program above us**. Any DOS program that
uses normal file I/O hits this code path automatically:

1. Program calls `fread()` or `open()`/`read()` (or whichever libc the
   program was linked with — Watcom, Microsoft C, gcc-ia16/newlib, etc.).
2. libc issues `INT 21h AH=3Dh / 3Fh / 42h / 3Eh` (open, read, lseek,
   close).
3. EDR-DOS receives these, walks its file table, walks the FAT, and issues
   `INT 13h AH=02h` for the sectors it needs.
4. Our BIOS handler (the new one) services the read from the ROM disk.
5. EDR-DOS hands the bytes back up, libc returns from `fread()`, the
   program gets its data and never knows the storage was a CSS function.

This is exactly how a real `IO.SYS` shim worked when DOS booted from a CD
through MSCDEX, or from a network share through LANtastic, or from a
SCSI disk through an ASPI driver. New backend, same interface above. **The
only programs that won't work are ones that bypass `INT 13h` and talk to a
specific disk controller's I/O ports directly** — copy-protected games doing
weak-bit checks, disk utilities like Norton Disk Doctor, etc. Those are rare
and not interesting targets.

So the answer to "will this generalise to new games?" is: yes, automatically,
for every DOS program that uses files the normal way. Doom is just the first
one we'll test against because its WAD makes the size pressure obvious.

#### What changes in the codebase

- **`bios/gossamer-dos.asm`** — rewrite `INT 13h AH=02h` to use the LBA
  register + window pattern instead of computing a source segment from LBA.
  Remove the `DISK_SEG = 0xD000` constant. Add an `lba_register` BDA offset
  at `0xF0`. The DOS kernel and any program doing `INT 13h` continues to
  work unchanged.
- **`transpiler/src/memory.mjs`** — add a "ROM disk" zone that is *not*
  treated as normal `@property --m{N}` writable memory. Instead it emits a
  `--readDiskByte` dispatch function. The disk window addresses
  (`0xD0000`–`0xD01FF`) get special-cased in the `--readMem` dispatch to
  call `--readDiskByte` instead of returning a stored byte.
- **`transpiler/src/emit-css.mjs`** — wire the new dispatch function into the
  emitted CSS.
- **`transpiler/generate-dos.mjs`** — read the disk image as a byte blob and
  pass it to the ROM disk emitter instead of putting it in `embeddedData` at
  `0xD0000`.
- **`tools/mkfat12.mjs`** — no change. It produces a byte blob; where that
  blob goes is the transpiler's concern.

#### Constraints this respects

- **Pure CSS, works in Chrome.** The dispatch function is plain `if(style())`
  branches like everything else. No port I/O, no new opcodes, no JS bridge.
- **The 8086 sees normal memory.** The CPU uses ordinary `mov` instructions
  to read the window. From the running program's perspective the disk just
  works the way memory-mapped I/O always does on PCs.
- **The DOS kernel is unchanged.** EDR-DOS sees the same `INT 13h` it would
  see on a real PC. We are not patching the kernel and not pretending to be
  a different DOS.
- **Calcite-friendly.** The dispatch is one big `if(style())` chain — Calcite
  already pattern-matches these into dispatch tables.
- **Disk size is unbounded.** A 1.3 MB WAD becomes ~1.3 million dispatch
  branches in `--readDiskByte`, which produces ~30–50 MB of CSS source. That
  is large but valid. Chrome won't realistically *evaluate* a Doom-sized CSS
  file at any usable speed (per the limits documented above), but the file is
  still well-formed CSS, and Calcite reads the source and JIT-compiles the
  dispatch into a flat byte array — fast and memory-efficient.
- **The cardinal rule still holds.** Calcite is not getting a special back
  channel; it's reading the same CSS Chrome would.

#### What it unlocks

The first target is Doom8088 (text mode 40x25, `-DC_ONLY`, `i8088`,
`-noems -noxms`). The pre-built EXE is ~180 KB and the WAD is ~1.3 MB.
Together with the EDR-DOS kernel and CONFIG.SYS on the FAT12 image, the
total is ~1.5 MB — well under any reasonable disk size cap. Once it boots
to title screen we'll have validated the entire stack: EDR-DOS EXE loader,
multi-segment program with relocations, INT 21h file I/O serving from the
ROM disk, Mode 13h (or text mode) display, keyboard input.

After Doom, the same plumbing makes any DOS program with significant data
files runnable: Wolfenstein 3D, Commander Keen, Sierra adventure games,
infocom interpreters, etc. Anything that fits in 640 KB conventional + a
WAD/data file on disk, and uses `INT 21h` for file I/O (which is everything
written with a normal C compiler or assembler that linked against MS-DOS or
Borland or Watcom libc).

## The two approaches

### v1: JSON instruction database (legacy/)

A JSON database of all 8086 instructions drove code generation. Each instruction
was decomposed into ~10 parallel dispatch tables that each returned one aspect of
the instruction's behavior. The tables were reassembled via cross-property
references. **Problem:** when tables disagreed, subtle bugs appeared that were
extremely hard to trace.

### v2: JS→CSS transpiler (transpiler/) — THE ACTIVE APPROACH

Transliterate the reference emulator's decode/execute switch directly into CSS.
One dispatch on opcode, each branch computes everything inline. Fewer intermediate
properties, fewer bugs.

The reference emulator is `tools/js8086.js` (~2700 lines, clean ~200-case switch).
The transpiler reads its structure and emits equivalent CSS. Not a general JS→CSS
compiler — just handles the specific patterns in this emulator.

**Key challenge:** CSS evaluates all properties simultaneously. Sequential JS
(read → compute → write → flags) must be flattened into parallel expressions
that produce the same result in one evaluation pass.

Read `transpiler/README.md` for detailed architecture and implementation plan.

## Conformance testing workflow

```sh
# 1. Assemble test program (if .asm)
C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe -f bin -o tests/prog.com tests/prog.asm

# 2. Generate CSS — NOTE: only ONE positional arg (the .com file).
#    gossamer.bin is auto-loaded from build/. Do NOT pass gossamer.bin as an arg.
node transpiler/generate-hacky.mjs tests/prog.com --mem 1536 -o tests/prog.css

# 3. Run conformance comparison — takes THREE positional args: .com, gossamer.bin, .css
node tools/compare.mjs tests/prog.com build/gossamer.bin tests/prog.css --ticks=500
```

The compare tool runs both the reference JS emulator and calcite, then finds the
first tick where registers diverge. It handles REP-prefixed instructions
(which take 1 tick in the reference but N ticks in CSS) via IP-aligned comparison.

## Gossamer BIOS

`gossamer.asm` is the Gossamer BIOS, compiled with NASM. It provides:

| Interrupt | Function |
|-----------|----------|
| INT 10h | Video services (teletype output, cursor, scroll) |
| INT 16h | Keyboard input |
| INT 1Ah | Timer tick |
| INT 20h | Program exit (sets halt flag) |
| INT 21h | DOS services (AH=02h print char, AH=09h print string, AH=30h version, AH=4Ch exit) |

The BIOS is loaded at segment F000:0000 and the IVT (interrupt vector table)
at addresses 0x0000-0x03FF is pre-populated to point to these handlers.

To rebuild after editing:
```sh
nasm -f bin -o build/gossamer.bin bios/gossamer.asm -l build/gossamer.lst
nasm -f bin -o build/gossamer-dos.bin bios/gossamer-dos.asm -l build/gossamer-dos.lst
```

## Relationship to calcite

Calcite is a sibling repo at `../calcite`. This repo produces CSS; calcite
runs it fast. There is no code dependency between them — calcite reads whatever
CSS file it's given and evaluates it. The only shared interface is the CSS format.

Calcite has pattern recognition for dispatch tables, broadcast writes, and
bitwise operations. The transpiler should emit CSS that naturally falls into
these patterns (e.g., `if(style(--opcode: N))` chains become dispatch tables).

## Tools

**NASM** (assembler): installed at `C:\Users\AdmT9N0CX01V65438A\AppData\Local\bin\NASM\nasm.exe`.
Not in PATH — use the full path or set a variable. Used to assemble `.asm` files
(BIOS, test programs) into flat binaries.

**Playwright MCP**: available for browser automation if you need to run the
generated HTML/CSS in Chrome and extract register state. Prefer other approaches
(Calcite traces, reference emulator comparison) when possible — Playwright is
slow and should be a last resort for debugging CSS execution issues.

## Relationship to the original x86css

This project was forked from [rebane2001/x86css](https://github.com/rebane2001/x86css).
The original implemented a subset of 8086 in CSS as a proof of concept. We extended
it to full ISA coverage, then pivoted to the transpiler approach for correctness.
