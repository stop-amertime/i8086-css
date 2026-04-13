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
  INT_08H: 0x08,
  INT_09H: 0x09,
  INT_10H: 0x10,
  INT_11H: 0x11,
  INT_12H: 0x12,
  INT_13H: 0x13,
  INT_15H: 0x15,
  INT_16H: 0x16,
  INT_19H: 0x19,
  INT_1AH: 0x1A,
  INT_20H: 0x20,
};

// IVT entries: interrupt number -> routine ID
export const IVT_ENTRIES = {
  0x08: ROUTINE_IDS.INT_08H,
  0x09: ROUTINE_IDS.INT_09H,
  0x10: ROUTINE_IDS.INT_10H,
  0x11: ROUTINE_IDS.INT_11H,
  0x12: ROUTINE_IDS.INT_12H,
  0x13: ROUTINE_IDS.INT_13H,
  0x15: ROUTINE_IDS.INT_15H,
  0x16: ROUTINE_IDS.INT_16H,
  0x19: ROUTINE_IDS.INT_19H,
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
      { uOp: 0, expr: 'calc(var(--__1IP) + 2 + var(--prefixLen))', comment: 'INT 20h: skip sentinel+ID' },
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
      { uOp: 4, expr: 'calc(var(--__1IP) + 2 + var(--prefixLen))', comment: 'INT 09h: skip sentinel+ID on retire' },
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

/**
 * INT 16h (keyboard read/peek): multi-μop handler with folded IRET.
 *
 * Uses --biosAH (latched at instruction boundary) instead of --AH for
 * subfunction dispatch. This is necessary because the handler modifies AX
 * at μop 0, which would taint --AH on subsequent ticks.
 *
 * IMPORTANT: The IRET pop must be a single μop that sets IP, CS, FLAGS,
 * and SP simultaneously. Spreading the pop across multiple μops corrupts
 * the decode pipeline: popping IP changes --__1IP on the next tick, causing
 * --opcode to read from the wrong address and breaking the uOp dispatch.
 * IRET is read-only (stack pops via --read2), so all pops fit in one μop.
 *
 * AH=00h (blocking read):
 *   μop 0: Hold if BDA buffer empty. When non-empty: AX = key word.
 *   μop 1: Write new head lo to BDA 0x041A
 *   μop 2: Write new head hi to BDA 0x041B
 *   μop 3: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 *
 * AH=01h (non-blocking peek):
 *   μop 0: AX = peek key word if non-empty. Compute ZF.
 *   μop 1: Folded IRET — pop IP+CS+FLAGS+ZF, SP += 6, retire
 */
function int16hEntries() {
  const q1 = ROUTINE_IDS.INT_16H;
  // All AH dispatch uses --biosAH (latched, stable across μops)
  const AH = '--biosAH';

  const ssBase = `calc(var(--__1SS) * 16)`;
  const headWord = `--read2(${BDA_KBD_HEAD})`;
  const tailWord = `--read2(${BDA_KBD_TAIL})`;
  const bufNotEmpty = `sign(max(calc(${headWord} - ${tailWord}), calc(${tailWord} - ${headWord})))`;
  const keyWord = `--read2(calc(${BDA_BASE} + ${headWord}))`;
  const newHead = `calc(mod(calc(${headWord} + 2 - ${BDA_KBD_BUF_START}), ${BDA_KBD_BUF_SIZE}) + ${BDA_KBD_BUF_START})`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const zfBit = `calc(64 * calc(1 - ${bufNotEmpty}))`;
  const axExpr = `calc(var(--__1AX) * calc(1 - ${bufNotEmpty}) + ${keyWord} * ${bufNotEmpty})`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;
  const popFlagsZF = `calc(--and(${stackedFlags}, 3989) + 2 + ${zfBit})`;

  return {
    regEntries: [
      // μop 0: STI + set AX (both subfunctions)
      { reg: 'flags', uOp: 0, expr: `--or(var(--__1flags), 512)`, comment: 'INT 16h: STI' },
      { reg: 'AX', uOp: 0, expr: axExpr, comment: 'INT 16h: AX=key if non-empty' },

      // μop 1: AH=01h IRET (retirement); AH=00h writes memory (no reg change)
      { reg: 'IP', uOp: 1, expr: `if(style(${AH}: 1): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 16h AH=01h: IRET pop IP' },
      { reg: 'CS', uOp: 1, expr: `if(style(${AH}: 1): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 16h AH=01h: IRET pop CS' },
      { reg: 'flags', uOp: 1, expr: `if(style(${AH}: 1): ${popFlagsZF}; else: var(--__1flags))`,
        comment: 'INT 16h AH=01h: IRET pop FLAGS+ZF' },
      { reg: 'SP', uOp: 1, expr: `if(style(${AH}: 1): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 16h AH=01h: IRET SP+=6' },

      // μop 3: AH=00h IRET (retirement)
      { reg: 'IP', uOp: 3, expr: `if(style(${AH}: 0): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 16h AH=00h: IRET pop IP' },
      { reg: 'CS', uOp: 3, expr: `if(style(${AH}: 0): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 16h AH=00h: IRET pop CS' },
      { reg: 'flags', uOp: 3, expr: `if(style(${AH}: 0): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 16h AH=00h: IRET pop FLAGS' },
      { reg: 'SP', uOp: 3, expr: `if(style(${AH}: 0): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 16h AH=00h: IRET SP+=6' },
    ],
    memWrites: [
      { uOp: 1, addr: `if(style(${AH}: 0): ${BDA_KBD_HEAD}; else: -1)`,
        val: `--lowerBytes(${newHead}, 8)`, comment: 'INT 16h AH=00h: head lo' },
      { uOp: 2, addr: `if(style(${AH}: 0): ${BDA_KBD_HEAD + 1}; else: -1)`,
        val: `--rightShift(${newHead}, 8)`, comment: 'INT 16h AH=00h: head hi' },
    ],
    maxUop: 3,
    ipEntries: [],
    // uOp advance uses --biosAH (latched, stable)
    uopAdvance: `if(` +
      `style(${AH}: 0): if(` +
        `style(--__1uOp: 0): calc(${bufNotEmpty}); ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 0; ` +
      `else: 0); ` +
      `style(${AH}: 1): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 0; ` +
      `else: 0); ` +
    `else: 0)`,
    q1,
  };
}

/**
 * INT 10h (Video Services): multi-subfunction handler with folded IRET.
 *
 * Dispatches on AH for subfunctions:
 *
 * IMPORTANT: The IRET pop must be a single μop that sets IP, CS, FLAGS,
 * and SP simultaneously. See INT 16h comment for rationale.
 *
 * AH=02h (set cursor position):
 *   μop 0: Write DL (col) to BDA 0x0450
 *   μop 1: Write DH (row) to BDA 0x0451
 *   μop 2: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 *
 * AH=03h (get cursor position):
 *   μop 0: DX = (row << 8) | col from BDA, CX = 0
 *   μop 1: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 *
 * AH=0Eh (teletype output — printable chars only):
 *   μop 0: (implicit cursor read via expressions)
 *   μop 1: Write char (AL) to VGA text buffer
 *   μop 2: Write attribute 0x07 to VGA text buffer
 *   μop 3: Write new cursor col to BDA 0x0450
 *   μop 4: Write new cursor row to BDA 0x0451
 *   μop 5: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 *
 * AH=0Fh (get video mode):
 *   μop 0: AX = (cols << 8) | mode, BX = BX & 0x00FF (clear BH)
 *   μop 1: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 */
function int10hEntries() {
  const q1 = ROUTINE_IDS.INT_10H;

  // Stack base for folded IRET
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;

  // BDA cursor position
  const BDA_CURSOR_COL = 0x0450;  // 1104 decimal
  const BDA_CURSOR_ROW = 0x0451;  // 1105 decimal
  const BDA_VIDEO_MODE = 0x0449;  // 1097 decimal
  const BDA_NUM_COLS = 0x044A;    // 1098 decimal

  // VGA text buffer base
  const VGA_TEXT_BASE = 0xB8000;  // 753664 decimal

  // Read current cursor position from BDA
  const cursorCol = `--readMem(${BDA_CURSOR_COL})`;
  const cursorRow = `--readMem(${BDA_CURSOR_ROW})`;

  // VGA address for current cursor position: VGA_BASE + (row * 80 + col) * 2
  const vgaAddr = `calc(${VGA_TEXT_BASE} + (${cursorRow} * 80 + ${cursorCol}) * 2)`;

  // Cursor advance: newCol = (col + 1) mod 80
  const newCol = `mod(calc(${cursorCol} + 1), 80)`;
  // Row increment: 1 when newCol wraps to 0, else 0
  const rowIncrement = `calc(1 - min(1, ${newCol}))`;
  // New row: clamped to 24
  const newRow = `min(24, calc(${cursorRow} + ${rowIncrement}))`;

  // AH=0Eh teletype: 6 μops (0-5), IRET at μop 5
  // AH=02h set cursor: 3 μops (0-2), IRET at μop 2
  // AH=03h get cursor: 2 μops (0-1), IRET at μop 1
  // AH=0Fh get mode:   2 μops (0-1), IRET at μop 1
  // Maximum μop across all subfunctions = 5 (AH=0Eh)

  return {
    regEntries: [
      // --- AH=03h: get cursor position → DX, CX ---
      { reg: 'DX', uOp: 0,
        expr: `if(style(--biosAH: 3): calc(--readMem(${BDA_CURSOR_ROW}) * 256 + --readMem(${BDA_CURSOR_COL})); else: var(--__1DX))`,
        comment: 'INT 10h AH=03h: DX=cursor pos' },
      { reg: 'CX', uOp: 0,
        expr: `if(style(--biosAH: 3): 0; else: var(--__1CX))`,
        comment: 'INT 10h AH=03h: CX=0 cursor shape' },

      // --- AH=0Fh: get video mode → AX, BX ---
      { reg: 'AX', uOp: 0,
        expr: `if(style(--biosAH: 15): calc(--readMem(${BDA_NUM_COLS}) * 256 + --readMem(${BDA_VIDEO_MODE})); else: var(--__1AX))`,
        comment: 'INT 10h AH=0Fh: AX=cols:mode' },
      { reg: 'BX', uOp: 0,
        expr: `if(style(--biosAH: 15): --and(var(--__1BX), 255); else: var(--__1BX))`,
        comment: 'INT 10h AH=0Fh: BH=0' },

      // --- AH=03h/0Fh IRET at μop 1 ---
      { reg: 'IP', uOp: 1,
        expr: `if(style(--biosAH: 3): ${popIP}; style(--biosAH: 15): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=03h/0Fh: IRET pop IP' },
      { reg: 'CS', uOp: 1,
        expr: `if(style(--biosAH: 3): ${popCS}; style(--biosAH: 15): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=03h/0Fh: IRET pop CS' },
      { reg: 'flags', uOp: 1,
        expr: `if(style(--biosAH: 3): ${popFlagsNormal}; style(--biosAH: 15): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=03h/0Fh: IRET pop FLAGS' },
      { reg: 'SP', uOp: 1,
        expr: `if(style(--biosAH: 3): calc(var(--__1SP) + 6); style(--biosAH: 15): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=03h/0Fh: IRET SP+=6' },

      // --- AH=02h IRET at μop 2 ---
      { reg: 'IP', uOp: 2,
        expr: `if(style(--biosAH: 2): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=02h: IRET pop IP' },
      { reg: 'CS', uOp: 2,
        expr: `if(style(--biosAH: 2): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=02h: IRET pop CS' },
      { reg: 'flags', uOp: 2,
        expr: `if(style(--biosAH: 2): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=02h: IRET pop FLAGS' },
      { reg: 'SP', uOp: 2,
        expr: `if(style(--biosAH: 2): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=02h: IRET SP+=6' },

      // --- AH=0Eh IRET at μop 5 ---
      { reg: 'IP', uOp: 5,
        expr: `if(style(--biosAH: 14): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=0Eh: IRET pop IP' },
      { reg: 'CS', uOp: 5,
        expr: `if(style(--biosAH: 14): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=0Eh: IRET pop CS' },
      { reg: 'flags', uOp: 5,
        expr: `if(style(--biosAH: 14): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=0Eh: IRET pop FLAGS' },
      { reg: 'SP', uOp: 5,
        expr: `if(style(--biosAH: 14): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=0Eh: IRET SP+=6' },
    ],
    memWrites: [
      // --- AH=02h: set cursor position ---
      { uOp: 0,
        addr: `if(style(--biosAH: 2): ${BDA_CURSOR_COL}; else: -1)`,
        val: `var(--DL)`,
        comment: 'INT 10h AH=02h: col to BDA' },
      { uOp: 1,
        addr: `if(style(--biosAH: 2): ${BDA_CURSOR_ROW}; else: -1)`,
        val: `var(--DH)`,
        comment: 'INT 10h AH=02h: row to BDA' },

      // --- AH=0Eh: teletype output ---
      { uOp: 1,
        addr: `if(style(--biosAH: 14): ${vgaAddr}; else: -1)`,
        val: `var(--AL)`,
        comment: 'INT 10h AH=0Eh: char to VGA' },
      { uOp: 2,
        addr: `if(style(--biosAH: 14): calc(${vgaAddr} + 1); else: -1)`,
        val: `7`,
        comment: 'INT 10h AH=0Eh: attr to VGA' },
      { uOp: 3,
        addr: `if(style(--biosAH: 14): ${BDA_CURSOR_COL}; else: -1)`,
        val: newCol,
        comment: 'INT 10h AH=0Eh: new col to BDA' },
      { uOp: 4,
        addr: `if(style(--biosAH: 14): ${BDA_CURSOR_ROW}; else: -1)`,
        val: newRow,
        comment: 'INT 10h AH=0Eh: new row to BDA' },
    ],
    maxUop: 5,
    ipEntries: [],
    // uOp advance per AH subfunction:
    //   AH=02h: 0→1→2→0
    //   AH=03h: 0→1→0
    //   AH=0Eh: 0→1→2→3→4→5→0
    //   AH=0Fh: 0→1→0
    //   default: 0 (no-op, single μop retire)
    uopAdvance: `if(` +
      `style(--biosAH: 2): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 0; ` +
      `else: 0); ` +
      `style(--biosAH: 3): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 0; ` +
      `else: 0); ` +
      `style(--biosAH: 14): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 4; ` +
        `style(--__1uOp: 4): 5; ` +
        `style(--__1uOp: 5): 0; ` +
      `else: 0); ` +
      `style(--biosAH: 15): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 0; ` +
      `else: 0); ` +
    `else: 0)`,
    q1,
  };
}

/**
 * INT 1Ah (Timer): simplified handler returning tick count = 0.
 *
 * AH=00h: CX=0, DX=0 (tick count high/low), AL=0 (midnight flag)
 * μop 0: Set CX=0, DX=0, AX = (AH << 8) | 0 (clear AL)
 * μop 1: Folded IRET — pop IP+CS+FLAGS, SP += 6, retire
 */
function int1ahEntries() {
  const q1 = ROUTINE_IDS.INT_1AH;

  // Stack base for folded IRET
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;

  return {
    regEntries: [
      // μop 0: CX=0 (tick count high), DX=0 (tick count low), AL=0 (midnight flag)
      { reg: 'CX', uOp: 0, expr: '0', comment: 'INT 1Ah: CX=0 tick high' },
      { reg: 'DX', uOp: 0, expr: '0', comment: 'INT 1Ah: DX=0 tick low' },
      // Clear AL (midnight flag), keep AH: AX = AH * 256
      { reg: 'AX', uOp: 0, expr: 'calc(var(--AH) * 256)', comment: 'INT 1Ah: AL=0 midnight' },

      // μop 1: IRET — pop IP+CS+FLAGS, SP+=6 (retirement)
      { reg: 'IP', uOp: 1, expr: popIP, comment: 'INT 1Ah: IRET pop IP' },
      { reg: 'CS', uOp: 1, expr: popCS, comment: 'INT 1Ah: IRET pop CS' },
      { reg: 'flags', uOp: 1, expr: popFlagsNormal, comment: 'INT 1Ah: IRET pop FLAGS' },
      { reg: 'SP', uOp: 1, expr: 'calc(var(--__1SP) + 6)', comment: 'INT 1Ah: IRET SP+=6' },
    ],
    memWrites: [],
    maxUop: 1,
    ipEntries: [],
    uopAdvance: `if(` +
      `style(--__1uOp: 0): 1; ` +
      `style(--__1uOp: 1): 0; ` +
    `else: 0)`,
    q1,
  };
}

/**
 * INT 08h (Timer IRQ): increment BDA tick counter, call INT 1Ch hook, EOI.
 *
 * μop 0: Increment ticks_lo (BDA 0x046C) — write lo byte
 * μop 1: Write ticks_lo hi byte
 * μop 2: Write ticks_hi lo byte (BDA 0x046E)
 * μop 3: Write ticks_hi hi byte
 * μop 4: EOI, retire (no INT 1Ch hook — it's just IRET anyway)
 */
function int08hEntries() {
  const q1 = ROUTINE_IDS.INT_08H;

  // Read current tick count (32-bit: ticks_hi:ticks_lo)
  const ticksLo = `--read2(${BDA_BASE + 0x6C})`;
  const ticksHi = `--read2(${BDA_BASE + 0x6E})`;
  // Increment: newLo = (ticksLo + 1) mod 65536
  const newTicksLo = `mod(calc(${ticksLo} + 1), 65536)`;
  // Carry: 1 when ticksLo was 65535 (i.e., newTicksLo == 0)
  const carry = `calc(1 - min(1, ${newTicksLo}))`;
  const newTicksHi = `calc(${ticksHi} + ${carry})`;

  // EOI: clear lowest set bit in picInService
  const eoiExpr = `--and(var(--__1picInService), --not(--pow2(--lowestBit(var(--__1picInService)))))`;

  return {
    regEntries: [
      { reg: 'picInService', uOp: 4, expr: eoiExpr, comment: 'INT 08h: EOI' },
    ],
    memWrites: [
      { uOp: 0, addr: `${BDA_BASE + 0x6C}`, val: `--lowerBytes(${newTicksLo}, 8)`, comment: 'INT 08h: ticks_lo lo' },
      { uOp: 1, addr: `${BDA_BASE + 0x6D}`, val: `--rightShift(${newTicksLo}, 8)`, comment: 'INT 08h: ticks_lo hi' },
      { uOp: 2, addr: `${BDA_BASE + 0x6E}`, val: `--lowerBytes(${newTicksHi}, 8)`, comment: 'INT 08h: ticks_hi lo' },
      { uOp: 3, addr: `${BDA_BASE + 0x6F}`, val: `--rightShift(${newTicksHi}, 8)`, comment: 'INT 08h: ticks_hi hi' },
    ],
    maxUop: 4,
    ipEntries: [
      { uOp: 4, expr: 'calc(var(--__1IP) + 2 + var(--prefixLen))', comment: 'INT 08h: skip sentinel+ID on retire' },
    ],
    uopAdvance: `if(` +
      `style(--__1uOp: 0): 1; ` +
      `style(--__1uOp: 1): 2; ` +
      `style(--__1uOp: 2): 3; ` +
      `style(--__1uOp: 3): 4; ` +
      `style(--__1uOp: 4): 0; ` +
    `else: 0)`,
    q1,
  };
}

/**
 * INT 11h (Equipment List): return word from BDA 0x0410.
 * μop 0: AX = BDA equipment word
 * μop 1: IRET
 */
function int11hEntries() {
  const q1 = ROUTINE_IDS.INT_11H;
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;

  return {
    regEntries: [
      { reg: 'AX', uOp: 0, expr: `--read2(${BDA_BASE + 0x10})`, comment: 'INT 11h: AX=equipment' },
      { reg: 'IP', uOp: 1, expr: popIP, comment: 'INT 11h: IRET pop IP' },
      { reg: 'CS', uOp: 1, expr: popCS, comment: 'INT 11h: IRET pop CS' },
      { reg: 'flags', uOp: 1, expr: popFlagsNormal, comment: 'INT 11h: IRET pop FLAGS' },
      { reg: 'SP', uOp: 1, expr: 'calc(var(--__1SP) + 6)', comment: 'INT 11h: IRET SP+=6' },
    ],
    memWrites: [],
    maxUop: 1,
    ipEntries: [],
    uopAdvance: `if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0)`,
    q1,
  };
}

/**
 * INT 12h (Memory Size): return word from BDA 0x0413.
 * μop 0: AX = memory size in KiB
 * μop 1: IRET
 */
function int12hEntries() {
  const q1 = ROUTINE_IDS.INT_12H;
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;

  return {
    regEntries: [
      { reg: 'AX', uOp: 0, expr: `--read2(${BDA_BASE + 0x13})`, comment: 'INT 12h: AX=memsize' },
      { reg: 'IP', uOp: 1, expr: popIP, comment: 'INT 12h: IRET pop IP' },
      { reg: 'CS', uOp: 1, expr: popCS, comment: 'INT 12h: IRET pop CS' },
      { reg: 'flags', uOp: 1, expr: popFlagsNormal, comment: 'INT 12h: IRET pop FLAGS' },
      { reg: 'SP', uOp: 1, expr: 'calc(var(--__1SP) + 6)', comment: 'INT 12h: IRET SP+=6' },
    ],
    memWrites: [],
    maxUop: 1,
    ipEntries: [],
    uopAdvance: `if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0)`,
    q1,
  };
}

/**
 * INT 13h (Disk Services): multi-subfunction handler.
 *
 * AH=00h (reset): no-op, return AH=0 CF=0
 * AH=02h (read sectors): copy from embedded disk image to ES:BX
 *   μop 0: Compute LBA, set biosSrc, biosDst, biosCnt = AL*512, clear AH
 *   μop 1: Copy one byte: mem[biosDst] = readMem(biosSrc), advance ptrs, dec cnt
 *          Loops back to μop 1 while biosCnt > 0
 *   μop 2: IRET (AH already 0, CF already clear from flags manipulation)
 * AH=08h (get params): return floppy geometry
 * AH=15h (get type): return AH=01 (floppy without change detection)
 *
 * For AH=00h/08h/15h: single μop work + IRET
 */
function int13hEntries() {
  const q1 = ROUTINE_IDS.INT_13H;
  const AH = '--biosAH';
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  // Clear CF (bit 0) in stacked flags
  const popFlagsClearCF = `calc(--and(${stackedFlags}, 4052) + 2)`;

  // Disk geometry constants (1.44MB floppy)
  const DISK_SPT = 18;
  const DISK_SEG_ADDR = 0xD0000;  // Where disk image is embedded

  // CHS → LBA: (CH * 2 + DH) * 18 + (CL - 1)
  // CH = cylinder (high byte of CX), CL = sector (low byte of CX, 1-based)
  // DH = head (high byte of DX)
  const cylinder = `--rightShift(var(--__1CX), 8)`;
  const sector1 = `--lowerBytes(var(--__1CX), 8)`;  // 1-based
  const head = `--rightShift(var(--__1DX), 8)`;
  const lba = `calc((${cylinder} * 2 + ${head}) * ${DISK_SPT} + ${sector1} - 1)`;

  // Source: DISK_SEG_ADDR + LBA * 512
  const srcAddr = `calc(${DISK_SEG_ADDR} + ${lba} * 512)`;
  // Destination: ES * 16 + BX
  const dstAddr = `calc(var(--__1ES) * 16 + var(--__1BX))`;
  // Count: AL * 512 (AL = low byte of AX)
  const sectorCount = `--lowerBytes(var(--__1AX), 8)`;
  const byteCount = `calc(${sectorCount} * 512)`;

  // AH=08h return values
  const maxCyl = 79;   // 0-based
  const maxSec = 18;   // 1-based max
  const maxHead = 1;   // 0-based

  return {
    regEntries: [
      // --- AH=00h (reset): AX = 0 (AH=0 success) ---
      // --- AH=02h (read): set up copy, AX = sectorCount (AH=0, AL=sectors read) ---
      // --- AH=08h (get params): set geometry registers ---
      // --- AH=15h (get type): AH=01 ---
      { reg: 'AX', uOp: 0,
        expr: `if(style(${AH}: 0): 0; ` +
              `style(${AH}: 2): ${sectorCount}; ` +
              `style(${AH}: 8): 0; ` +
              `style(${AH}: 21): 256; ` +  // AH=01, AL=0
              `else: var(--__1AX))`,
        comment: 'INT 13h: AX result' },

      // AH=08h: BX = drive type (04h = 1.44MB)
      { reg: 'BX', uOp: 0,
        expr: `if(style(${AH}: 8): 4; else: var(--__1BX))`,
        comment: 'INT 13h AH=08h: BX=drive type' },

      // AH=08h: CX = (maxCyl << 8) | maxSec
      { reg: 'CX', uOp: 0,
        expr: `if(style(${AH}: 8): calc(${maxCyl} * 256 + ${maxSec}); else: var(--__1CX))`,
        comment: 'INT 13h AH=08h: CX=cyl:sec' },

      // AH=08h: DX = (maxHead << 8) | 1 (1 floppy drive)
      { reg: 'DX', uOp: 0,
        expr: `if(style(${AH}: 8): calc(${maxHead} * 256 + 1); else: var(--__1DX))`,
        comment: 'INT 13h AH=08h: DX=head:drives' },

      // AH=02h: set up copy registers
      { reg: 'biosSrc', uOp: 0,
        expr: `if(style(${AH}: 2): ${srcAddr}; else: var(--__1biosSrc))`,
        comment: 'INT 13h AH=02h: biosSrc=disk addr' },
      { reg: 'biosDst', uOp: 0,
        expr: `if(style(${AH}: 2): ${dstAddr}; else: var(--__1biosDst))`,
        comment: 'INT 13h AH=02h: biosDst=ES:BX' },
      { reg: 'biosCnt', uOp: 0,
        expr: `if(style(${AH}: 2): ${byteCount}; else: var(--__1biosCnt))`,
        comment: 'INT 13h AH=02h: biosCnt=AL*512' },

      // μop 1: copy loop — advance src, dst, dec cnt
      { reg: 'biosSrc', uOp: 1,
        expr: `if(style(${AH}: 2): calc(var(--__1biosSrc) + 1); else: var(--__1biosSrc))`,
        comment: 'INT 13h: biosSrc++' },
      { reg: 'biosDst', uOp: 1,
        expr: `if(style(${AH}: 2): calc(var(--__1biosDst) + 1); else: var(--__1biosDst))`,
        comment: 'INT 13h: biosDst++' },
      { reg: 'biosCnt', uOp: 1,
        expr: `if(style(${AH}: 2): calc(var(--__1biosCnt) - 1); else: var(--__1biosCnt))`,
        comment: 'INT 13h: biosCnt--' },

      // IRET μop: AH=00h/08h/15h at μop 1, AH=02h at μop 2
      // For AH=00h/08h/15h:
      { reg: 'IP', uOp: 1,
        expr: `if(style(${AH}: 0): ${popIP}; ` +
              `style(${AH}: 8): ${popIP}; ` +
              `style(${AH}: 21): ${popIP}; ` +
              `else: var(--__1IP))`,
        comment: 'INT 13h AH=00h/08h/15h: IRET pop IP' },
      { reg: 'CS', uOp: 1,
        expr: `if(style(${AH}: 0): ${popCS}; ` +
              `style(${AH}: 8): ${popCS}; ` +
              `style(${AH}: 21): ${popCS}; ` +
              `else: var(--__1CS))`,
        comment: 'INT 13h AH=00h/08h/15h: IRET pop CS' },
      { reg: 'flags', uOp: 1,
        expr: `if(style(${AH}: 0): ${popFlagsClearCF}; ` +
              `style(${AH}: 8): ${popFlagsClearCF}; ` +
              `style(${AH}: 21): ${popFlagsClearCF}; ` +
              `else: var(--__1flags))`,
        comment: 'INT 13h AH=00h/08h/15h: IRET pop FLAGS (CF=0)' },
      { reg: 'SP', uOp: 1,
        expr: `if(style(${AH}: 0): calc(var(--__1SP) + 6); ` +
              `style(${AH}: 8): calc(var(--__1SP) + 6); ` +
              `style(${AH}: 21): calc(var(--__1SP) + 6); ` +
              `else: var(--__1SP))`,
        comment: 'INT 13h AH=00h/08h/15h: IRET SP+=6' },

      // AH=02h IRET at μop 2
      { reg: 'IP', uOp: 2, expr: `if(style(${AH}: 2): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 13h AH=02h: IRET pop IP' },
      { reg: 'CS', uOp: 2, expr: `if(style(${AH}: 2): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 13h AH=02h: IRET pop CS' },
      { reg: 'flags', uOp: 2, expr: `if(style(${AH}: 2): ${popFlagsClearCF}; else: var(--__1flags))`,
        comment: 'INT 13h AH=02h: IRET pop FLAGS (CF=0)' },
      { reg: 'SP', uOp: 2, expr: `if(style(${AH}: 2): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 13h AH=02h: IRET SP+=6' },
    ],
    memWrites: [
      // μop 1: AH=02h copy loop — write readMem(biosSrc) to biosDst
      { uOp: 1,
        addr: `if(style(${AH}: 2): var(--__1biosDst); else: -1)`,
        val: `--readMem(var(--__1biosSrc))`,
        comment: 'INT 13h AH=02h: copy byte' },
    ],
    maxUop: 2,
    ipEntries: [],
    // uOp advance:
    //   AH=00h: 0→1→0 (reset: single work μop + IRET)
    //   AH=02h: 0→1→(1 while cnt>0)→2→0
    //   AH=08h: 0→1→0 (get params: single work μop + IRET)
    //   AH=15h: 0→1→0 (get type: single work μop + IRET)
    uopAdvance: `if(` +
      `style(${AH}: 0): if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0); ` +
      `style(${AH}: 2): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): if(style(--__1biosCnt: 1): 2; else: 1); ` +
        `style(--__1uOp: 2): 0; ` +
      `else: 0); ` +
      `style(${AH}: 8): if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0); ` +
      `style(${AH}: 21): if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0); ` +
    `else: 0)`,
    q1,
  };
}

/**
 * INT 15h (Misc System Services): multi-subfunction handler.
 *
 * AH=4Fh (keyboard intercept): just IRET (pass through)
 * AH=88h (extended memory size): AX=0, CF=0
 * AH=90h/91h (OS hooks): AH=0, IRET
 * AH=C0h (system config): AH=0, ES:BX=config_table, CF=0
 *   Config table is at a fixed address in ROM; the generator places it.
 * Default: AH=86h, CF=1 (unsupported)
 *
 * For simplicity, all subfunctions are single μop + IRET.
 */
function int15hEntries() {
  const q1 = ROUTINE_IDS.INT_15H;
  const AH = '--biosAH';
  const ssBase = `calc(var(--__1SS) * 16)`;
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;
  const popFlagsClearCF = `calc(--and(${stackedFlags}, 4052) + 2)`;
  const popFlagsSetCF = `calc(--or(--and(${stackedFlags}, 4052), 1) + 2)`;

  return {
    regEntries: [
      // μop 0: set return values based on AH
      // AH=88h: AX=0 (no extended memory)
      // AH=90h/91h: clear AH (keep AL) → AX = AL
      // AH=C0h: AX = AL (clear AH)
      // Default: AH=86h → AX = 0x8600 | AL
      { reg: 'AX', uOp: 0,
        expr: `if(style(${AH}: 79): var(--__1AX); ` +     // 4Fh: no change
              `style(${AH}: 136): 0; ` +                   // 88h: AX=0
              `style(${AH}: 144): --lowerBytes(var(--__1AX), 8); ` +  // 90h: AH=0
              `style(${AH}: 145): --lowerBytes(var(--__1AX), 8); ` +  // 91h: AH=0
              `style(${AH}: 192): --lowerBytes(var(--__1AX), 8); ` +  // C0h: AH=0
              `else: calc(34304 + --lowerBytes(var(--__1AX), 8)))`,    // default: AH=86h
        comment: 'INT 15h: AX result' },

      // μop 1: IRET
      { reg: 'IP', uOp: 1, expr: popIP, comment: 'INT 15h: IRET pop IP' },
      { reg: 'CS', uOp: 1, expr: popCS, comment: 'INT 15h: IRET pop CS' },
      // CF=0 for 4Fh/88h/90h/91h/C0h; CF=1 for default
      { reg: 'flags', uOp: 1,
        expr: `if(style(${AH}: 79): ${popFlagsClearCF}; ` +
              `style(${AH}: 136): ${popFlagsClearCF}; ` +
              `style(${AH}: 144): ${popFlagsClearCF}; ` +
              `style(${AH}: 145): ${popFlagsClearCF}; ` +
              `style(${AH}: 192): ${popFlagsClearCF}; ` +
              `else: ${popFlagsSetCF})`,
        comment: 'INT 15h: IRET pop FLAGS' },
      { reg: 'SP', uOp: 1, expr: 'calc(var(--__1SP) + 6)', comment: 'INT 15h: IRET SP+=6' },
    ],
    memWrites: [],
    maxUop: 1,
    ipEntries: [],
    uopAdvance: `if(style(--__1uOp: 0): 1; style(--__1uOp: 1): 0; else: 0)`,
    q1,
  };
}

/**
 * INT 19h (Bootstrap): halt (same as INT 20h).
 */
function int19hEntries() {
  const q1 = ROUTINE_IDS.INT_19H;
  return {
    regEntries: [
      { reg: 'halt', uOp: 0, expr: '1', comment: 'INT 19h: halt' },
    ],
    memWrites: [],
    maxUop: 0,
    ipEntries: [
      { uOp: 0, expr: 'calc(var(--__1IP) + 2 + var(--prefixLen))', comment: 'INT 19h: skip sentinel+ID' },
    ],
    uopAdvance: `0`,
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
    int08hEntries(),
    int09hEntries(),
    int10hEntries(),
    int11hEntries(),
    int12hEntries(),
    int13hEntries(),
    int15hEntries(),
    int16hEntries(),
    int19hEntries(),
    int1ahEntries(),
    int20hEntries(),
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
    const holdExpr = 'var(--__1IP)';
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
