// Memory infrastructure: --readMem dispatch, per-byte write properties,
// memory layout with embedded program binary, BIOS, and IVT.

const BIOS_LINEAR = 0xF0000; // F000:0000
const BIOS_SEG = 0xF000;

// IVT handler offsets within the BIOS segment (must match bios.asm)
// IVT handler offsets — must match ref-emu.mjs and bios.lst
const IVT_HANDLERS = {
  0x10: 0x0000, // INT 10h - Video
  0x16: 0x0155, // INT 16h - Keyboard
  0x1A: 0x0190, // INT 1Ah - Timer
  0x20: 0x0232, // INT 20h - Program terminate
  0x21: 0x01A9, // INT 21h - DOS services
};

/**
 * Emit the --readMem @function.
 * All memory bytes are writable CSS properties, read from var(--__1mN).
 */
export function emitReadMem(opts) {
  const { memSize, biosBytes } = opts;

  const lines = [];
  lines.push(`@function --readMem(--at <integer>) returns <integer> {`);
  lines.push(`  result: if(`);

  // Writable memory region: read from --__1mN (previous tick's value)
  for (let addr = 0; addr < memSize; addr++) {
    lines.push(`    style(--at: ${addr}): var(--__1m${addr});`);
  }

  // BIOS region (read-only constants) — always included regardless of memSize
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
 */
export function buildInitialMemory(opts) {
  const { memSize, programBytes, programOffset, biosBytes, embeddedData } = opts;
  const initMem = new Map();

  // IVT entries (addresses 0x0000-0x03FF)
  for (const [intNum, handlerOff] of Object.entries(IVT_HANDLERS)) {
    const addr = Number(intNum) * 4;
    const lo = handlerOff & 0xFF;
    const hi = (handlerOff >> 8) & 0xFF;
    const csLo = BIOS_SEG & 0xFF;
    const csHi = (BIOS_SEG >> 8) & 0xFF;
    if (lo && addr < memSize) initMem.set(addr, lo);
    if (hi && addr + 1 < memSize) initMem.set(addr + 1, hi);
    if (csLo && addr + 2 < memSize) initMem.set(addr + 2, csLo);
    if (csHi && addr + 3 < memSize) initMem.set(addr + 3, csHi);
  }

  // Program binary
  for (let i = 0; i < programBytes.length; i++) {
    const addr = programOffset + i;
    if (addr < memSize && programBytes[i] !== 0) {
      initMem.set(addr, programBytes[i]);
    }
  }

  // BIOS at F000:0000 (linear 0xF0000)
  for (let i = 0; i < biosBytes.length; i++) {
    const addr = BIOS_LINEAR + i;
    if (addr < memSize && biosBytes[i] !== 0) {
      initMem.set(addr, biosBytes[i]);
    }
  }

  // Extra embedded data
  for (const { addr: base, bytes } of (embeddedData || [])) {
    for (let i = 0; i < bytes.length; i++) {
      const addr = base + i;
      if (addr < memSize && bytes[i] !== 0) {
        initMem.set(addr, bytes[i]);
      }
    }
  }

  return initMem;
}

/**
 * Emit @property declarations and write rules for writable memory bytes.
 */
export function emitMemoryProperties(opts) {
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];

  for (let addr = 0; addr < memSize; addr++) {
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
 * Each byte checks all 6 memory write slots (INT needs 6: 3 word pushes).
 */
export function emitMemoryWriteRules(opts) {
  const { memSize } = opts;
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    lines.push(`  --m${addr}: if(
    style(--memAddr0: ${addr}): var(--memVal0);
    style(--memAddr1: ${addr}): var(--memVal1);
    style(--memAddr2: ${addr}): var(--memVal2);
    style(--memAddr3: ${addr}): var(--memVal3);
    style(--memAddr4: ${addr}): var(--memVal4);
    style(--memAddr5: ${addr}): var(--memVal5);
  else: var(--__1m${addr}));`);
  }
  return lines.join('\n');
}

/**
 * Emit buffer reads for memory bytes (--__1mN: var(--__2mN, init))
 */
export function emitMemoryBufferReads(opts) {
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    const init = initMem.get(addr) || 0;
    lines.push(`  --__1m${addr}: var(--__2m${addr}, ${init});`);
  }
  return lines.join('\n');
}

/**
 * Emit store keyframe entries for memory bytes (--__2mN: var(--__0mN, init))
 */
export function emitMemoryStoreKeyframe(opts) {
  const { memSize } = opts;
  const initMem = buildInitialMemory(opts);
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    const init = initMem.get(addr) || 0;
    lines.push(`    --__2m${addr}: var(--__0m${addr}, ${init});`);
  }
  return lines.join('\n');
}

/**
 * Emit execute keyframe entries for memory bytes (--__0mN: var(--mN))
 */
export function emitMemoryExecuteKeyframe(opts) {
  const { memSize } = opts;
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    lines.push(`    --__0m${addr}: var(--m${addr});`);
  }
  return lines.join('\n');
}

/**
 * Emit @property declarations for memory write slots.
 * 6 slots: INT needs 3 word pushes = 6 byte writes.
 */
export function emitWriteSlotProperties() {
  const lines = [];
  for (let i = 0; i < 6; i++) {
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
