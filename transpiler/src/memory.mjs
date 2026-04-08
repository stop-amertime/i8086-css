// Memory infrastructure: --readMem dispatch, per-byte write properties,
// memory layout with embedded program binary, BIOS, and IVT.

const BIOS_LINEAR = 0xF0000; // F000:0000
const BIOS_SEG = 0xF000;

// IVT handler offsets within the BIOS segment (must match bios.asm)
const IVT_HANDLERS = {
  0x10: 0x0000, // INT 10h - Video
  0x16: 0x0155, // INT 16h - Keyboard
  0x1A: 0x018A, // INT 1Ah - Timer
  0x20: 0x01A0, // INT 20h - Program exit
  0x21: 0x01AB, // INT 21h - DOS services
};

/**
 * Emit the --readMem @function.
 * Writable memory bytes are read from var(--mN), embedded/BIOS bytes are constants.
 */
export function emitReadMem(opts) {
  const { memSize, programBytes, biosBytes, embeddedData, programOffset } = opts;

  // Build address → value map for constant (embedded) data
  const constants = new Map();

  // Program binary at programOffset
  for (let i = 0; i < programBytes.length; i++) {
    constants.set(programOffset + i, programBytes[i]);
  }

  // BIOS at F000:0000 (linear 0xF0000)
  for (let i = 0; i < biosBytes.length; i++) {
    constants.set(BIOS_LINEAR + i, biosBytes[i]);
  }

  // Extra embedded data
  for (const { addr, bytes } of embeddedData) {
    for (let i = 0; i < bytes.length; i++) {
      constants.set(addr + i, bytes[i]);
    }
  }

  // IVT: addresses 0x0000-0x03FF
  // Each entry is 4 bytes: offset (word), segment (word)
  const ivt = new Uint8Array(0x400);
  for (const [intNum, handlerOff] of Object.entries(IVT_HANDLERS)) {
    const addr = Number(intNum) * 4;
    ivt[addr] = handlerOff & 0xFF;
    ivt[addr + 1] = (handlerOff >> 8) & 0xFF;
    ivt[addr + 2] = BIOS_SEG & 0xFF;
    ivt[addr + 3] = (BIOS_SEG >> 8) & 0xFF;
  }
  for (let i = 0; i < 0x400; i++) {
    if (ivt[i] !== 0) constants.set(i, ivt[i]);
  }

  // Collect all addresses that appear in readMem
  // Writable memory: 0..memSize-1 (read from --mN variables)
  // Constants: everything in the constants map
  // Addresses that are both writable AND have a constant initial value
  // use the --mN variable (initialized to the constant).

  const lines = [];
  lines.push(`@function --readMem(--at <integer>) returns <integer> {`);
  lines.push(`  result: if(`);

  // Writable memory region: addresses 0..memSize-1
  // Read from --__1mN (previous tick's value) not --mN (current tick's write rule)
  // to avoid circular dependency: readMem → mN → memAddr → opcode → q0 → readMem
  for (let addr = 0; addr < memSize; addr++) {
    lines.push(`    style(--at: ${addr}): var(--__1m${addr});`);
  }

  // Constant regions (program, BIOS, embedded data) — only addresses outside writable range
  const sortedConst = [...constants.entries()]
    .filter(([addr]) => addr >= memSize)
    .sort(([a], [b]) => a - b);

  for (const [addr, val] of sortedConst) {
    lines.push(`    style(--at: ${addr}): ${val};`);
  }

  lines.push(`  else: 0);`);
  lines.push(`}`);
  return lines.join('\n');
}

/**
 * Emit @property declarations and write rules for writable memory bytes.
 * Each byte --mN checks 3 memory write slots.
 */
export function emitMemoryProperties(opts) {
  const { memSize, programBytes, programOffset } = opts;
  const lines = [];

  // @property declarations for writable memory
  for (let addr = 0; addr < memSize; addr++) {
    // Initial value: program byte if in range, else 0
    const progIdx = addr - programOffset;
    const init = (progIdx >= 0 && progIdx < programBytes.length) ? programBytes[progIdx] : 0;
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
 * Each byte checks the 3 memory write slots.
 */
export function emitMemoryWriteRules(opts) {
  const { memSize } = opts;
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    lines.push(`  --m${addr}: if(
    style(--memAddr0: ${addr}): var(--memVal0);
    style(--memAddr1: ${addr}): var(--memVal1);
    style(--memAddr2: ${addr}): var(--memVal2);
  else: var(--__1m${addr}));`);
  }
  return lines.join('\n');
}

/**
 * Emit buffer reads for memory bytes (--__1mN: var(--__2mN, init))
 */
export function emitMemoryBufferReads(opts) {
  const { memSize, programBytes, programOffset } = opts;
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    const progIdx = addr - programOffset;
    const init = (progIdx >= 0 && progIdx < programBytes.length) ? programBytes[progIdx] : 0;
    lines.push(`  --__1m${addr}: var(--__2m${addr}, ${init});`);
  }
  return lines.join('\n');
}

/**
 * Emit store keyframe entries for memory bytes (--__2mN: var(--__0mN, init))
 */
export function emitMemoryStoreKeyframe(opts) {
  const { memSize, programBytes, programOffset } = opts;
  const lines = [];
  for (let addr = 0; addr < memSize; addr++) {
    const progIdx = addr - programOffset;
    const init = (progIdx >= 0 && progIdx < programBytes.length) ? programBytes[progIdx] : 0;
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
 */
export function emitWriteSlotProperties() {
  const lines = [];
  for (let i = 0; i < 3; i++) {
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
