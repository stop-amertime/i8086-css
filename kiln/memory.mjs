// Memory infrastructure: --readMem dispatch, per-byte write properties,
// memory layout with embedded program binary, BIOS, and IVT.
//
// Memory is sparse: only addresses in the provided address set are emitted.
// Reads to unmapped addresses return 0; writes are silently dropped.

const BIOS_LINEAR = 0xF0000; // F000:0000
const BIOS_SEG = 0xF000;

// VGA DAC palette: 256 entries × 3 bytes (R, G, B) = 768 bytes. Stored at
// a linear address outside the 1 MB 8086 space so no real program can read
// or write it by accident. Filled by OUT 0x3C9 in patterns/misc.mjs;
// consumed by calcite's framebuffer renderer. Initial values are 0 (black);
// the Corduroy splash writes the first 16 entries during BIOS init, and
// real Mode 13h programs program their own palette before drawing.
export const DAC_LINEAR = 0x100000;
export const DAC_BYTES  = 768;

// Number of parallel memory write slots.
// Each slot carries a width flag (1 or 2 bytes): width=2 packs an
// addr/addr+1 byte pair into one slot. The worst-case writer is INT
// (and HW IRQ entry / TF trap), which pushes FLAGS/CS/IP = 3 words =
// 3 width-2 slots. Every other writer fits in fewer slots. Halving the
// slot count from the legacy 6 byte-slots cuts the per-tick
// gate-evaluation cost in the packed-cell cascade and halves the
// @property bookkeeping.
//
// Slot shape per tick:
//   --memAddrN     byte address of the slot's first byte (or -1 if idle)
//   --memValN      byte (width=1) or 16-bit word (width=2, lo at addr,
//                  hi at addr+1)
//   --_slotNLive   1 if the slot fires this tick, 0 otherwise
// Plus a single global per-tick gate (not per-slot):
//   --_writeWidth  1 = all live slots are byte writes,
//                  2 = all live slots are 16-bit word writes
// In current x86 emitters every opcode that fires multiple slots in one
// tick uses a single width across all of them (INT pushes 3 words; STOSB
// writes 1 byte; etc.), so a global width fits.
export const NUM_WRITE_SLOTS = 3;

// Packed memory cells — pack PACK_SIZE bytes into a single @property.
// 1 = unpacked (one byte per property, the legacy shape).
// 2 = two bytes per cell (cell = b0 | b1<<8).  Max value 65535 — fits in i32
//     (and in CSS's ~30-bit <integer> safe range with lots of headroom).
// 4 = four bytes per cell is NOT safe: values with byte3 >= 0x80 exceed i32
//     max, which calcite truncates to a negative number, corrupting
//     byte-extraction via `mod/round(down, .../K)`.
//
// Reads: --readMem(addr) translates to inline byte extraction on
// --__1mc{cellIdx} where cellIdx = addr >> 1 and off = addr & 1.
// Writes: each cell's write rule is a 6-level cascade of --applySlot calls
// that splice each active slot's byte into the cell; slot 0 outermost so it
// wins on same-cell collisions (matching the old top-down byte-level
// dispatch semantics).
//
// Configurable via env var KILN_PACK (1 or 2). Default is 2.
export const PACK_SIZE = (() => {
  const raw = typeof process !== 'undefined' && process.env && process.env.KILN_PACK;
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  if (n === 1 || n === 2) return n;
  throw new Error(`KILN_PACK must be 1 or 2, got ${raw}`);
})();

export function cellIdxOf(addr) { return Math.floor(addr / PACK_SIZE); }
export function cellOffOf(addr) { return addr % PACK_SIZE; }
export function cellBase(cellIdx) { return cellIdx * PACK_SIZE; }

// Standard IVT entries for gossamer.asm (must match handler offsets in gossamer.lst / ref-emu.mjs)
const BIOS_IVT_HANDLERS = {
  0x10: 0x0000,  // INT 10h - Video services
  0x16: 0x0155,  // INT 16h - Keyboard
  0x1A: 0x0190,  // INT 1Ah - Timer
  0x20: 0x023D,  // INT 20h - Program terminate
  0x21: 0x01A9,  // INT 21h - DOS services
};

/**
 * Build IVT (Interrupt Vector Table) bytes for the standard BIOS handlers.
 * Returns {addr, bytes} suitable for embeddedData.
 * Each IVT entry is 4 bytes: IP_lo, IP_hi, CS_lo, CS_hi.
 */
export function buildIVTData() {
  const ivt = new Array(0x400).fill(0);
  for (const [intNum, handlerOff] of Object.entries(BIOS_IVT_HANDLERS)) {
    const addr = parseInt(intNum) * 4;
    ivt[addr]     = handlerOff & 0xFF;         // IP low
    ivt[addr + 1] = (handlerOff >> 8) & 0xFF;  // IP high
    ivt[addr + 2] = BIOS_SEG & 0xFF;           // CS low
    ivt[addr + 3] = (BIOS_SEG >> 8) & 0xFF;    // CS high
  }
  return { addr: 0, bytes: ivt };
}

/**
 * Build a sorted array of addresses to emit from a list of [start, end) ranges.
 * Deduplicates and sorts ascending.
 */
export function buildAddressSet(zones) {
  const set = new Set();
  for (const [start, end] of zones) {
    for (let addr = start; addr < end; addr++) {
      set.add(addr);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Standard memory zones for .COM programs.
 * --mem controls the conventional memory size (program + stack area).
 */
export function comMemoryZones(programBytes, programOffset, memBytes, prune = {}) {
  // memBytes = size of conventional memory area starting at 0
  // (includes IVT + BDA + program + stack).
  //
  // `prune` uses the same "skip this zone" sense as dosMemoryZones.
  // Hack carts are minimalist by default: only the text VGA buffer and
  // DAC shadow are included unconditionally. Graphics apertures are
  // opt-in via `manifest.memory.gfx` / `memory.cgaGfx` in the builder,
  // which translate to `prune.gfx === false` / `prune.cgaGfx === false`
  // here.
  const zones = [
    [0x0000, memBytes],                       // IVT + BDA + program + stack (contiguous)
    [0xB8000, 0xB8FA0],                       // VGA text mode (80x25x2 = 4000 bytes)
    [DAC_LINEAR, DAC_LINEAR + DAC_BYTES],     // VGA DAC palette (out-of-1MB shadow)
  ];
  if (prune.gfx === false) {
    // VGA Mode 13h framebuffer (320x200 palette-indexed).
    zones.push([0xA0000, 0xAFA00]);
  }
  if (prune.cgaGfx === false) {
    // CGA graphics aperture covers mode 0x04 (320x200x4) and 0x06
    // (640x200x2). Overlaps the text buffer; buildAddressSet dedupes.
    zones.push([0xB8000, 0xBC000]);
  }
  return zones;
}

/**
 * Standard memory zones for DOS boot mode.
 * memBytes = total conventional memory size (default 640KB = 0xA0000).
 *
 * The EDRDOS kernel always relocates its code and data structures to the
 * top ~160KB of conventional memory, regardless of what program runs.
 * The middle area (between the kernel image and DOS high area) is where
 * user programs load — its size depends on the program.
 *
 * Layout (640KB):
 *   0x00000-0x00600  IVT + BDA + free area (always needed)
 *   0x00600-0x1A000  Kernel binary + decompressed code/data (~105 KB)
 *   0x1A000-0x30000  Kernel init workspace + temp relocation (~88 KB)
 *   0x30000-0x86000  User program area (grows with program size)
 *   0x86000-0xA0000  DOS data/code segments, relocated BIOS, CONFIG,
 *                    COMMAND.COM, system MCBs (~104 KB, always needed)
 *
 * To reduce CSS size for small programs, pass a smaller --mem value.
 * The kernel high area (top 104KB) is always included regardless of --mem.
 */
export function dosMemoryZones(programBytes, programOffset, memBytes, embeddedData, prune = {}) {
  // Use one contiguous block for all conventional memory. The kernel
  // relocates itself to high memory and its code segment can span a wide
  // range of addresses, so splitting into low/high zones with a gap causes
  // the CPU to execute into unmapped memory.
  //
  // Note: the LBA register at linear 0x4F0-0x4F1 (BDA intra-app area) is
  // naturally inside [0x0000, memBytes] and therefore normal writable
  // memory — no special handling needed.
  // EDR-DOS's biosinit relocates itself to `mem_size - biosinit_paragraphs`
  // and copies `biosinit_end` bytes there. The copy's last byte lands at
  // roughly linear `mem_size * 1024 + (biosinit_end mod 16)`, i.e. a few
  // bytes PAST the nominal top of conventional memory (rounding plus the
  // `+32` scratch in biosinit.asm:275). At 640K this lands inside the VGA
  // zone and silently succeeds; at smaller sizes it lands in the unmapped
  // gap between the conventional zone and the framebuffer, the far-return
  // into the copy jumps into dead memory, and boot dies silently. Pad the
  // zone with 4 KB to absorb that overspill without growing the cabinet
  // noticeably. 4 KB is more than enough — biosinit is under 16 KB total,
  // so the overspill past mem_size*1024 is at most ~16 bytes.
  const DOS_BIOSINIT_PAD = 0x1000;
  const convEnd = Math.min(0xA0000, memBytes + DOS_BIOSINIT_PAD);
  const zones = [];
  zones.push([0x0000, convEnd]);
  if (!prune.gfx) {
    zones.push([0xA0000, 0xAFA00]);         // VGA Mode 13h framebuffer (320x200)
    zones.push([DAC_LINEAR, DAC_LINEAR + DAC_BYTES]); // VGA DAC palette (out-of-1MB shadow)
  }
  if (!prune.textVga) {
    zones.push([0xB8000, 0xB8FA0]);         // VGA text mode (80x25x2)
  }
  if (!prune.cgaGfx) {
    // CGA graphics aperture: 16 KB at 0xB8000-0xBC000. Covers modes 0x04
    // (320x200x4, 2 bpp, even/odd scanline interleave) and 0x06 (640x200x2).
    // Overlaps the 4 KB text buffer above; buildAddressSet dedupes so
    // enabling both is free — the bytes literally share storage, which is
    // also how real CGA hardware behaves.
    zones.push([0xB8000, 0xBC000]);
  }

  // Include embedded data regions (non-disk: e.g. data files placed in memory).
  // The rom-disk window at 0xD0000-0xD01FF is NOT a normal memory zone — it
  // is dispatched in emitReadMemStreaming to --readDiskByte keyed on the
  // current LBA. Disk bytes live outside the 8086 address space and must be
  // passed into emitCSS via opts.diskBytes, not embeddedData.
  for (const { addr, bytes } of (embeddedData || [])) {
    zones.push([addr, addr + bytes.length]);
  }
  return zones;
}

/**
 * Emit the --readMem @function.
 * Only addresses in the address set get writable property branches.
 * BIOS region is always included as read-only constants.
 */
export function emitReadMem(opts) {
  const { addresses, biosBytes } = opts;

  const lines = [];
  lines.push(`@function --readMem(--at <integer>) returns <integer> {`);
  lines.push(`  result: if(`);

  // Writable memory region: read from --__1mN (previous tick's value)
  for (const addr of addresses) {
    if (addr === 0x0500) {
      lines.push(`    style(--at: 1280): --lowerBytes(var(--__1keyboard), 8);`);
    } else if (addr === 0x0501) {
      lines.push(`    style(--at: 1281): --rightShift(var(--__1keyboard), 8);`);
    } else {
      lines.push(`    style(--at: ${addr}): var(--__1m${addr});`);
    }
  }

  // BIOS region (read-only constants) — always included
  if (biosBytes && biosBytes.length > 0) {
    for (let i = 0; i < biosBytes.length; i++) {
      if (biosBytes[i] !== 0) {
        lines.push(`    style(--at: ${BIOS_LINEAR + i}): ${biosBytes[i]};`);
      }
    }
  }

  lines.push(`  else: 0);`);
  lines.push(`}`);
  return lines.join('\n');
}

/**
 * Build the set of cell indices covering the writable address set.
 * Returns a sorted array of cell indices (each cell covers PACK_SIZE bytes
 * starting at cellIdx * PACK_SIZE).
 */
export function buildCellSet(addresses) {
  const cells = new Set();
  for (const addr of addresses) {
    cells.add(cellIdxOf(addr));
  }
  return [...cells].sort((a, b) => a - b);
}

/**
 * Pack initial-memory bytes into a Map<cellIdx, cellValue>.
 * Non-zero cells only. Values are <= 2^(8*PACK_SIZE) - 1.
 */
export function buildInitialMemoryPacked(opts) {
  const initMem = buildInitialMemory(opts);
  const cells = new Map();
  for (const [addr, byte] of initMem) {
    const idx = cellIdxOf(addr);
    const off = cellOffOf(addr);
    const prev = cells.get(idx) || 0;
    cells.set(idx, prev + byte * Math.pow(256, off));
  }
  return cells;
}

/**
 * Build the initial memory image for all writable bytes.
 * Returns a Map<address, byte> for non-zero initial values.
 * Only considers addresses in the address set.
 */
export function buildInitialMemory(opts) {
  const { addresses, programBytes, programOffset, biosBytes, embeddedData } = opts;
  const addrSet = new Set(addresses);
  const initMem = new Map();

  // Program binary
  for (let i = 0; i < programBytes.length; i++) {
    const addr = programOffset + i;
    if (addrSet.has(addr) && programBytes[i] !== 0) {
      initMem.set(addr, programBytes[i]);
    }
  }

  // BIOS at F000:0000 — only if those addresses are in the writable set
  // (usually they're not — BIOS is read-only constants in readMem)
  for (let i = 0; i < biosBytes.length; i++) {
    const addr = BIOS_LINEAR + i;
    if (addrSet.has(addr) && biosBytes[i] !== 0) {
      initMem.set(addr, biosBytes[i]);
    }
  }

  // Extra embedded data
  for (const { addr: base, bytes } of (embeddedData || [])) {
    for (let i = 0; i < bytes.length; i++) {
      const addr = base + i;
      if (addrSet.has(addr) && bytes[i] !== 0) {
        initMem.set(addr, bytes[i]);
      }
    }
  }

  return initMem;
}

/**
 * Emit @property declarations for writable memory bytes.
 */
export function emitMemoryProperties(opts) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];

  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    lines.push(`@property --m${addr} {
  syntax: '<integer>';
  inherits: true;
  initial-value: ${init};
}`);
  }

  return lines.join('\n\n');
}

/**
 * Emit the per-byte write rules for writable memory (inside .cpu) — the
 * unpacked (PACK_SIZE=1) path. Each byte tests all NUM_WRITE_SLOTS slots
 * twice: once as the slot's lo/byte half (matched at --memAddrN: addr),
 * once as the slot's hi half when the slot is width=2 (matched at
 * --memAddrN: addr-1). Width=2 means the slot writes 2 consecutive bytes
 * starting at --memAddrN; the slot's value is a 16-bit word with lo at
 * --memAddrN and hi at --memAddrN+1.
 *
 * Width=1 byte value: --memValN.
 * Width=2 lo half:    --lowerBytes(--memValN, 8).
 * Width=2 hi half:    --rightShift(--memValN, 8).
 */
export function emitMemoryWriteRules(opts) {
  const { addresses } = opts;
  const lines = [];
  for (const addr of addresses) {
    const slotLines = [];
    for (let i = 0; i < NUM_WRITE_SLOTS; i++) {
      // Slot's lo half lands at addr — value is byte (width=1) or low byte of word (width=2).
      slotLines.push(`    style(--memAddr${i}: ${addr}): if(style(--_writeWidth: 2): --lowerBytes(var(--memVal${i}), 8); else: var(--memVal${i}));`);
      // Slot's hi half lands at addr when memAddrN: addr-1 AND width=2.
      slotLines.push(`    style(--memAddr${i}: ${addr - 1}) and style(--_writeWidth: 2): --rightShift(var(--memVal${i}), 8);`);
    }
    lines.push(`  --m${addr}: if(\n${slotLines.join('\n')}\n  else: var(--__1m${addr}));`);
  }
  return lines.join('\n');
}

/**
 * Emit buffer reads for memory bytes (--__1mN: var(--__2mN, init))
 */
export function emitMemoryBufferReads(opts) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];
  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    lines.push(`  --__1m${addr}: var(--__2m${addr}, ${init});`);
  }
  return lines.join('\n');
}

/**
 * Emit store keyframe entries for memory bytes (--__2mN: var(--__0mN, init))
 */
export function emitMemoryStoreKeyframe(opts) {
  const { addresses } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];
  for (const addr of addresses) {
    const init = initMem.get(addr) || 0;
    lines.push(`    --__2m${addr}: var(--__0m${addr}, ${init});`);
  }
  return lines.join('\n');
}

/**
 * Emit execute keyframe entries for memory bytes (--__0mN: var(--mN))
 */
export function emitMemoryExecuteKeyframe(opts) {
  const { addresses } = opts;
  const lines = [];
  for (const addr of addresses) {
    lines.push(`    --__0m${addr}: var(--m${addr});`);
  }
  return lines.join('\n');
}

/**
 * Emit @property declarations for memory write slots.
 * Three properties per slot: address, value, width (1 or 2).
 * --_slotNLive shares semantics with --memAddrN/--memValN — set together by
 * emitMemoryWriteSlots / emitSlotLiveGates. The global --_writeWidth is
 * emitted by emitWriteWidthGate (one per tick, not per slot).
 */
export function emitWriteSlotProperties() {
  const lines = [];
  for (let i = 0; i < NUM_WRITE_SLOTS; i++) {
    lines.push(`@property --memAddr${i} {
  syntax: '<integer>';
  inherits: true;
  initial-value: -1;
}

@property --memVal${i} {
  syntax: '<integer>';
  inherits: true;
  initial-value: 0;
}`);
  }
  return lines.join('\n\n');
}
