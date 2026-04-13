// BIOS microcode emitters: opcode 0xD6 (214) + routine ID dispatch.
//
// ROM layout at each handler address: [0xD6, routineID, 0xCF]
//   0xD6 = BIOS sentinel opcode
//   routineID = which handler (read as --q1)
//   0xCF = IRET (safety fallback, normally not reached)
//
// All BIOS handlers share opcode 214 and are distinguished by --q1
// (the routine ID byte after 0xD6 in ROM). Each handler contributes
// sub-expressions that are merged into a single addEntry call per
// (register, uOp) slot, dispatching on --q1 internally.
//
// Architecture: each handler returns a descriptor of its entries:
//   { regEntries: [...], memWrites: [...], maxUop: N, uopAdvanceExpr: '...' }
// emitAllBiosHandlers merges these into composite q1-guarded expressions
// and calls dispatch.addEntry / addMemWrite once per slot.

export const BIOS_OPCODE = 0xD6;  // 214 decimal

export const ROUTINE_IDS = {
  INT_09H: 0x09,
  INT_10H: 0x10,
  INT_16H: 0x16,
  INT_1AH: 0x1A,
  INT_20H: 0x20,
};

// IVT entries: interrupt number -> routine ID
export const IVT_ENTRIES = {
  0x09: ROUTINE_IDS.INT_09H,
  0x10: ROUTINE_IDS.INT_10H,
  0x16: ROUTINE_IDS.INT_16H,
  0x1A: ROUTINE_IDS.INT_1AH,
  0x20: ROUTINE_IDS.INT_20H,
};

/**
 * Build BIOS ROM bytes and IVT handler map.
 * Returns { handlers: {intNum -> offset}, romBytes: Uint8Array }
 *
 * Each handler is a 3-byte stub: [0xD6, routineID, 0xCF].
 * The offset is relative to the start of this ROM blob (not the
 * absolute linear address -- the caller places it in the BIOS region).
 */
export function buildBiosRom() {
  const rom = [];
  const handlers = {};
  for (const [intNum, routineId] of Object.entries(IVT_ENTRIES)) {
    handlers[parseInt(intNum)] = rom.length;
    rom.push(BIOS_OPCODE);   // 0xD6
    rom.push(routineId);      // routine ID
    rom.push(0xCF);           // IRET fallback
  }
  return { handlers, romBytes: new Uint8Array(rom) };
}

// =====================================================================
// Handler descriptors
// =====================================================================

// BDA constants for the keyboard ring buffer
const BDA_BASE = 0x0400;
const BDA_KBD_HEAD = 0x041A;   // 2 bytes: offset relative to BDA_BASE
const BDA_KBD_TAIL = 0x041C;   // 2 bytes: offset relative to BDA_BASE
const BDA_KBD_BUF_START = 0x1E; // buffer offset start (relative to BDA)
const BDA_KBD_BUF_SIZE = 32;    // 16 words = 32 bytes

/**
 * INT 20h (halt): single-μop handler.
 * Sets halt=1, advances IP past the 2-byte sentinel.
 */
function int20hEntries() {
  const q1 = ROUTINE_IDS.INT_20H;
  return {
    regEntries: [
      { reg: 'halt', uOp: 0, expr: '1', comment: 'INT 20h: halt' },
    ],
    memWrites: [],
    maxUop: 0,
    // IP advance: skip past 0xD6 + routineID
    ipEntries: [
      { uOp: 0, expr: 'calc(var(--__1IP) + 2)', comment: 'INT 20h: skip sentinel+ID' },
    ],
    // Single-μop: uOp stays 0
    uopAdvance: `0`,
    q1,
  };
}

/**
 * INT 09h (keyboard IRQ → BDA ring buffer): multi-μop handler.
 *
 * Reads --_kbdAscii and --_kbdScancode, inserts into BDA keyboard buffer
 * at the current tail pointer, advances the tail, then sends EOI.
 *
 * μop 0: Write ASCII byte at BDA_BASE + tail
 * μop 1: Write scancode byte at BDA_BASE + tail + 1
 * μop 2: Write new tail lo byte to BDA 0x041C
 * μop 3: Write new tail hi byte to BDA 0x041D
 * μop 4: EOI (clear lowest in-service bit), retire
 *
 * On key release (scancode == 0): skip from μop 0 directly to μop 4.
 */
function int09hEntries() {
  const q1 = ROUTINE_IDS.INT_09H;

  // Read the current tail pointer (2 bytes at BDA 0x041C-0x041D)
  // This is an offset relative to BDA_BASE (e.g., 0x1E to 0x3C)
  const tailWord = `--read2(${BDA_KBD_TAIL})`;

  // The linear address to write the keystroke: BDA_BASE + tail
  const bufAddr = `calc(${BDA_BASE} + ${tailWord})`;

  // New tail: (tail + 2 - 0x1E) mod 32 + 0x1E
  // This wraps the tail pointer within the 32-byte buffer
  const newTail = `calc(mod(calc(${tailWord} + 2 - ${BDA_KBD_BUF_START}), ${BDA_KBD_BUF_SIZE}) + ${BDA_KBD_BUF_START})`;

  // EOI: clear lowest set bit in picInService
  // This is the same pattern as irq.mjs but for the BIOS handler
  const eoiExpr = `--and(var(--__1picInService), --not(--pow2(--lowestBit(var(--__1picInService)))))`;

  return {
    regEntries: [
      // μop 4: EOI — clear the in-service bit for the handled IRQ
      { reg: 'picInService', uOp: 4, expr: eoiExpr, comment: 'INT 09h: EOI' },
    ],
    memWrites: [
      // μop 0: write ASCII byte at buffer[tail]
      { uOp: 0, addr: bufAddr, val: 'var(--_kbdAscii)', comment: 'INT 09h: ASCII to buf' },
      // μop 1: write scancode byte at buffer[tail+1]
      { uOp: 1, addr: `calc(${BDA_BASE} + ${tailWord} + 1)`, val: 'var(--_kbdScancode)', comment: 'INT 09h: scancode to buf' },
      // μop 2: write new tail lo byte to BDA 0x041C
      { uOp: 2, addr: `${BDA_KBD_TAIL}`, val: `--lowerBytes(${newTail}, 8)`, comment: 'INT 09h: tail lo' },
      // μop 3: write new tail hi byte to BDA 0x041D
      { uOp: 3, addr: `${BDA_KBD_TAIL + 1}`, val: `--rightShift(${newTail}, 8)`, comment: 'INT 09h: tail hi' },
    ],
    maxUop: 4,
    // IP: hold at current value during μops 0-3, advance on μop 4 (retirement)
    ipEntries: [
      { uOp: 4, expr: 'calc(var(--__1IP) + 2)', comment: 'INT 09h: skip sentinel+ID on retire' },
    ],
    // uOp advance:
    //   scancode==0 (key release): 0→4 (skip buffer insert, go straight to EOI)
    //   normal: 0→1→2→3→4→0
    uopAdvance: `if(` +
      `style(--__1uOp: 0): if(style(--_kbdScancode: 0): 4; else: 1); ` +
      `style(--__1uOp: 1): 2; ` +
      `style(--__1uOp: 2): 3; ` +
      `style(--__1uOp: 3): 4; ` +
      `style(--__1uOp: 4): 0; ` +
    `else: 0)`,
    q1,
  };
}

// =====================================================================
// Merger: combine handler descriptors into dispatch entries
// =====================================================================

/**
 * Register all BIOS handler dispatch entries.
 *
 * Collects descriptors from all handlers, merges entries that share
 * the same (register, uOp) slot into composite q1-guarded expressions,
 * and calls dispatch.addEntry / addMemWrite once per slot.
 */
export function emitAllBiosHandlers(dispatch) {
  const handlers = [
    int20hEntries(),
    int09hEntries(),
    // Future: int10hEntries(), int16hEntries(), int1ahEntries()
  ];

  // Compute the overall max uOp across all handlers
  const overallMaxUop = Math.max(...handlers.map(h => h.maxUop));

  // --- Merge register entries ---
  // Collect: Map<reg, Map<uOp, [{q1, expr, comment}]>>
  const regSlots = new Map();
  for (const handler of handlers) {
    for (const entry of handler.regEntries) {
      if (!regSlots.has(entry.reg)) regSlots.set(entry.reg, new Map());
      const uOpMap = regSlots.get(entry.reg);
      if (!uOpMap.has(entry.uOp)) uOpMap.set(entry.uOp, []);
      uOpMap.get(entry.uOp).push({ q1: handler.q1, expr: entry.expr, comment: entry.comment });
    }
  }

  // Emit merged register entries
  for (const [reg, uOpMap] of regSlots) {
    for (const [uOp, entries] of uOpMap) {
      const mergedExpr = mergeQ1Entries(entries, reg);
      const comment = entries.map(e => e.comment).join(' | ');
      dispatch.addEntry(reg, BIOS_OPCODE, mergedExpr, comment, uOp);
    }
  }

  // --- Merge IP entries ---
  // IP is special: handlers that don't touch IP at a given μop need a hold.
  // Collect: Map<uOp, [{q1, expr, comment}]>
  const ipSlots = new Map();
  for (const handler of handlers) {
    if (handler.ipEntries) {
      for (const entry of handler.ipEntries) {
        if (!ipSlots.has(entry.uOp)) ipSlots.set(entry.uOp, []);
        ipSlots.get(entry.uOp).push({ q1: handler.q1, expr: entry.expr, comment: entry.comment });
      }
    }
  }

  // For μop 0: INT 20h advances IP, INT 09h holds. We need a merged expression.
  // For μop 4: INT 09h advances IP, INT 20h doesn't exist at μop 4.
  // For any μop with IP entries, emit the merged expression with hold fallback.
  for (const [uOp, entries] of ipSlots) {
    const holdExpr = 'calc(var(--__1IP) - var(--prefixLen))';
    const mergedExpr = mergeQ1EntriesWithFallback(entries, holdExpr);
    const comment = entries.map(e => e.comment).join(' | ');
    dispatch.addEntry('IP', BIOS_OPCODE, mergedExpr, comment, uOp);
  }

  // --- Merge memory write entries ---
  // Collect: Map<uOp, [{q1, addr, val, comment}]>
  const memSlots = new Map();
  for (const handler of handlers) {
    for (const entry of handler.memWrites) {
      if (!memSlots.has(entry.uOp)) memSlots.set(entry.uOp, []);
      memSlots.get(entry.uOp).push({ q1: handler.q1, addr: entry.addr, val: entry.val, comment: entry.comment });
    }
  }

  // Emit merged memory writes
  for (const [uOp, entries] of memSlots) {
    const mergedAddr = mergeQ1EntriesWithFallback(
      entries.map(e => ({ q1: e.q1, expr: e.addr, comment: e.comment })),
      '-1'  // no-op address when no handler matches
    );
    const mergedVal = mergeQ1EntriesWithFallback(
      entries.map(e => ({ q1: e.q1, expr: e.val, comment: e.comment })),
      '0'
    );
    const comment = entries.map(e => e.comment).join(' | ');
    dispatch.addMemWrite(BIOS_OPCODE, mergedAddr, mergedVal, comment, uOp);
  }

  // --- Build composite uOp advance expression ---
  // Each handler provides its own uOp advance logic, guarded by q1.
  const uopBranches = handlers.map(h =>
    `style(--q1: ${h.q1}): ${h.uopAdvance}`
  );
  const uopExpr = `if(${uopBranches.join('; ')}; else: 0)`;
  dispatch.setUopAdvance(BIOS_OPCODE, uopExpr);
}

// =====================================================================
// Merge helpers
// =====================================================================

/**
 * Merge multiple q1-guarded entries into a single if(style(--q1: N)) expression.
 * Falls back to holding the register's previous value.
 */
function mergeQ1Entries(entries, reg) {
  if (entries.length === 1) {
    const e = entries[0];
    return `if(style(--q1: ${e.q1}): ${e.expr}; else: var(--__1${reg}))`;
  }
  const branches = entries.map(e =>
    `style(--q1: ${e.q1}): ${e.expr}`
  );
  return `if(${branches.join('; ')}; else: var(--__1${reg}))`;
}

/**
 * Merge q1-guarded entries with a custom fallback expression.
 */
function mergeQ1EntriesWithFallback(entries, fallbackExpr) {
  if (entries.length === 1) {
    const e = entries[0];
    return `if(style(--q1: ${e.q1}): ${e.expr}; else: ${fallbackExpr})`;
  }
  const branches = entries.map(e =>
    `style(--q1: ${e.q1}): ${e.expr}`
  );
  return `if(${branches.join('; ')}; else: ${fallbackExpr})`;
}
