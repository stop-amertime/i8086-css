// Memory infrastructure: --readMem dispatch, per-byte write properties,
// memory layout with embedded program binary, BIOS, and IVT.
//
// Memory is sparse: only addresses in the provided address set are emitted.
// Reads to unmapped addresses return 0; writes are silently dropped.

const BIOS_LINEAR = 0xF0000; // F000:0000
const BIOS_SEG = 0xF000;

/**
 * Build IVT (Interrupt Vector Table) bytes from a handler map.
 * Handlers should come from tools/lib/bios-symbols.mjs loadIvtHandlers(),
 * which parses them fresh from the NASM listing. Nothing in this repo
 * should hardcode handler offsets — they change every BIOS rebuild.
 *
 * Returns {addr, bytes} suitable for embeddedData.
 * Each IVT entry is 4 bytes: IP_lo, IP_hi, CS_lo, CS_hi.
 */
export function buildIVTData(handlers) {
  if (!handlers || Object.keys(handlers).length === 0) {
    throw new Error('buildIVTData: handlers map is required — pass loadIvtHandlers(lstPath)');
  }
  const ivt = new Array(0x400).fill(0);
  for (const [intNum, handlerOff] of Object.entries(handlers)) {
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
 * When `graphics` is true, also includes the Mode 13h framebuffer at 0xA0000
 * (320x200 = 64000 bytes, one byte per pixel as a palette index).
 */
export function comMemoryZones(programBytes, programOffset, memBytes, graphics = false) {
  // memBytes = size of conventional memory area starting at 0
  // (includes IVT + BDA + program + stack)
  const zones = [
    [0x0000, memBytes],                // IVT + BDA + program + stack (contiguous)
    [0xB8000, 0xB8FA0],               // VGA text mode (80x25x2 = 4000 bytes)
  ];
  if (graphics) {
    zones.push([0xA0000, 0xAFA00]);   // VGA Mode 13h framebuffer (320x200 = 64000 bytes)
  }
  return zones;
}

/**
 * Canonical memory zones for DOS boot mode.
 *
 * CSS-DOS is a DOS/PC emulator — the memory layout must match what a real
 * PC-compatible machine looks like, because that's what DOS programs assume.
 * See CLAUDE.md ("What CSS-DOS is (and isn't)") for the full rule set.
 *
 * memBytes = total conventional memory size (default 640KB = 0xA0000).
 *
 * The EDRDOS kernel always relocates its code and data structures to the
 * top ~160KB of conventional memory, regardless of what program runs.
 * The middle area (between the kernel image and DOS high area) is where
 * user programs load — its size depends on the program.
 *
 * Canonical layout (default, no pruning):
 *   0x00000-0x00600  IVT + BDA + free area (always needed)
 *   0x00600-0x1A000  Kernel binary + decompressed code/data (~105 KB)
 *   0x1A000-0x30000  Kernel init workspace + temp relocation (~88 KB)
 *   0x30000-0x86000  User program area (grows with program size)
 *   0x86000-0xA0000  DOS data/code segments, relocated BIOS, CONFIG,
 *                    COMMAND.COM, system MCBs (~104 KB, always needed)
 *   0xA0000-0xAFA00  VGA Mode 13h framebuffer (64000 bytes) — always emitted
 *   0xB8000-0xB8FA0  VGA text mode buffer (4000 bytes) — always emitted
 *
 * Both VGA regions are emitted by default because a real PC always has
 * them. Programs that never touch them just get a zero-filled region in
 * the CSS.
 *
 * ### Bake-time pruning (optional)
 *
 * The `prune` option lets callers omit specific regions from the output as
 * a size optimization. This is prune-only: it never relocates or fakes
 * anything. Passing a prune flag is an author's promise that the program
 * does not write to that region. If it does, the write silently vanishes.
 *
 *   prune.gfx      — drop the Mode 13h framebuffer (saves 64000 bytes of CSS)
 *   prune.textVga  — drop the VGA text buffer      (saves 4000 bytes of CSS)
 *
 * `memBytes` is the other pruning knob: lowering it shrinks the conventional
 * RAM region. The kernel high area (top 104KB) is always included regardless.
 */
export function dosMemoryZones(programBytes, programOffset, memBytes, embeddedData, prune = {}) {
  // Use one contiguous block for all conventional memory. The kernel
  // relocates itself to high memory and its code segment can span a wide
  // range of addresses, so splitting into low/high zones with a gap causes
  // the CPU to execute into unmapped memory. The ~640KB CSS cost is
  // acceptable for correctness.
  const zones = [];
  zones.push([0x0000, memBytes]);
  if (!prune.gfx) {
    zones.push([0xA0000, 0xAFA00]);         // VGA Mode 13h framebuffer (320x200)
  }
  if (!prune.textVga) {
    zones.push([0xB8000, 0xB8FA0]);         // VGA text mode (80x25x2)
  }

  // Include embedded data regions (e.g., disk image at 0xD0000)
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
 * Emit the per-byte write rules for writable memory (inside .cpu).
 * v3: each byte checks the single memory write slot (--memAddr).
 */
export function emitMemoryWriteRules(opts) {
  const { addresses } = opts;
  const lines = [];
  for (const addr of addresses) {
    lines.push(`  --m${addr}: if(style(--memAddr: ${addr}): var(--memVal); else: var(--__1m${addr}));`);
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
 * Emit @property declarations for the single memory write slot.
 * v3: one write per cycle (--memAddr, --memVal).
 */
export function emitWriteSlotProperties() {
  return `@property --memAddr {
  syntax: '<integer>';
  inherits: true;
  initial-value: -1;
}

@property --memVal {
  syntax: '<integer>';
  inherits: true;
  initial-value: 0;
}`;
}
