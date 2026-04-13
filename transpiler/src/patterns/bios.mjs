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

/**
 * INT 16h (keyboard read/peek): multi-μop handler with folded IRET.
 *
 * AH=00h (blocking read):
 *   μop 0: Hold if BDA buffer empty. When non-empty: AX = key word.
 *   μop 1: Write new head lo to BDA 0x041A
 *   μop 2: Write new head hi to BDA 0x041B
 *   μop 3: Folded IRET — pop IP from SS:SP
 *   μop 4: Folded IRET — pop CS from SS:SP+2
 *   μop 5: Folded IRET — pop FLAGS from SS:SP+4, SP += 6, retire
 *
 * AH=01h (non-blocking peek):
 *   μop 0: AX = peek key word if non-empty. Set ZF: 1=empty, 0=available.
 *   μop 1: Folded IRET — pop IP from SS:SP
 *   μop 2: Folded IRET — pop CS from SS:SP+2
 *   μop 3: Folded IRET — pop FLAGS from SS:SP+4 with ZF merge, SP += 6, retire
 *
 * The folded IRET pops the FLAGS/CS/IP that the INT 0x16 instruction pushed.
 * AH=01h merges its computed ZF into the popped FLAGS before returning.
 */
function int16hEntries() {
  const q1 = ROUTINE_IDS.INT_16H;

  // Stack base: SS:SP (SP already decremented by 6 from the INT instruction)
  const ssBase = `calc(var(--__1SS) * 16)`;

  // BDA keyboard buffer head and tail (16-bit words, BDA-relative offsets)
  const headWord = `--read2(${BDA_KBD_HEAD})`;
  const tailWord = `--read2(${BDA_KBD_TAIL})`;

  // Buffer non-empty: 1 if head != tail, 0 if equal
  // sign(max(h-t, t-h)) = 0 when equal, 1 when different
  const bufNotEmpty = `sign(max(calc(${headWord} - ${tailWord}), calc(${tailWord} - ${headWord})))`;

  // Key word at BDA_BASE + head offset
  const keyWord = `--read2(calc(${BDA_BASE} + ${headWord}))`;

  // New head: (head + 2 - 0x1E) mod 32 + 0x1E (ring buffer wrap)
  const newHead = `calc(mod(calc(${headWord} + 2 - ${BDA_KBD_BUF_START}), ${BDA_KBD_BUF_SIZE}) + ${BDA_KBD_BUF_START})`;

  // Stacked FLAGS at SS:SP+4 (pushed by INT instruction)
  const stackedFlags = `--read2(calc(${ssBase} + var(--__1SP) + 4))`;

  // ZF bit (64) for AH=01h: 64 when buffer empty, 0 when non-empty
  // bufNotEmpty=1 → ZF=0 (key available), bufNotEmpty=0 → ZF=1 (empty)
  const zfBit = `calc(64 * calc(1 - ${bufNotEmpty}))`;

  // AX expression for μop 0 (shared by both AH=00h and AH=01h):
  // When buffer non-empty: read key word. When empty: hold AX unchanged.
  // For AH=00h, when empty the μop holds (re-evaluates), so AX=__1AX is fine.
  // For AH=01h, when empty the caller checks ZF not AX, so AX=__1AX is fine.
  const axExpr = `calc(var(--__1AX) * calc(1 - ${bufNotEmpty}) + ${keyWord} * ${bufNotEmpty})`;

  // IRET expressions — pop IP, CS, FLAGS from the stack the INT pushed
  const popIP = `--read2(calc(${ssBase} + var(--__1SP)))`;
  const popCS = `--read2(calc(${ssBase} + var(--__1SP) + 2))`;
  // Normal FLAGS restore (same as IRET opcode): mask 0x0FD5=4053, force bit 1
  const popFlagsNormal = `calc(--and(${stackedFlags}, 4053) + 2)`;
  // FLAGS with ZF merge for AH=01h: clear bit 6 from masked FLAGS, OR in computed ZF
  // 4053 & ~64 = 3989 (0x0F95)
  const popFlagsZF = `calc(--and(${stackedFlags}, 3989) + 2 + ${zfBit})`;

  return {
    regEntries: [
      // μop 0: AX = key word if non-empty (both AH=00h and AH=01h)
      { reg: 'AX', uOp: 0, expr: axExpr, comment: 'INT 16h: AX=key if non-empty' },

      // μop 1: AH=01h pops IP here; AH=00h writes memory (no reg change)
      { reg: 'IP', uOp: 1, expr: `if(style(--AH: 1): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 16h AH=01h: pop IP' },

      // μop 2: AH=01h pops CS here; AH=00h writes memory (no reg change)
      { reg: 'CS', uOp: 2, expr: `if(style(--AH: 1): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 16h AH=01h: pop CS' },

      // μop 3: AH=00h pops IP here; AH=01h pops FLAGS+SP (retirement)
      { reg: 'IP', uOp: 3, expr: `if(style(--AH: 0): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 16h AH=00h: pop IP' },
      { reg: 'flags', uOp: 3, expr: `if(style(--AH: 1): ${popFlagsZF}; else: var(--__1flags))`,
        comment: 'INT 16h AH=01h: pop FLAGS+ZF' },
      { reg: 'SP', uOp: 3, expr: `if(style(--AH: 1): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 16h AH=01h: SP+=6' },

      // μop 4: AH=00h pops CS (AH=01h already retired at μop 3)
      { reg: 'CS', uOp: 4, expr: `if(style(--AH: 0): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 16h AH=00h: pop CS' },

      // μop 5: AH=00h pops FLAGS + SP+=6 (retirement)
      { reg: 'flags', uOp: 5, expr: `if(style(--AH: 0): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 16h AH=00h: pop FLAGS' },
      { reg: 'SP', uOp: 5, expr: `if(style(--AH: 0): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 16h AH=00h: SP+=6' },
    ],
    memWrites: [
      // μop 1: AH=00h writes new head lo byte to BDA 0x041A
      { uOp: 1, addr: `if(style(--AH: 0): ${BDA_KBD_HEAD}; else: -1)`,
        val: `--lowerBytes(${newHead}, 8)`, comment: 'INT 16h AH=00h: head lo' },
      // μop 2: AH=00h writes new head hi byte to BDA 0x041B
      { uOp: 2, addr: `if(style(--AH: 0): ${BDA_KBD_HEAD + 1}; else: -1)`,
        val: `--rightShift(${newHead}, 8)`, comment: 'INT 16h AH=00h: head hi' },
    ],
    maxUop: 5,
    // IP entries: INT 16h handles IP via regEntries (folded IRET), not ipEntries.
    // The IP hold during μops 0-2 for AH=00h is handled by regEntries returning
    // var(--__1IP) when not the pop μop.
    // But we need an ipEntry to prevent the merger's hold fallback from overriding.
    // Actually, IP is in regEntries — let's check how the merger handles that.
    // The merger has separate regEntries and ipEntries. IP in regEntries goes through
    // mergeQ1Entries (fallback = var(--__1IP)), while ipEntries go through
    // mergeQ1EntriesWithFallback (fallback = hold expr).
    // Since we put IP in regEntries, the IP hold for non-INT-16h handlers at μops 1,3
    // will be var(--__1IP) which is fine for holding.
    ipEntries: [],
    // uOp advance:
    //   AH=00h: 0(hold if empty)→1→2→3→4→5→0
    //   AH=01h: 0→1→2→3→0
    uopAdvance: `if(` +
      `style(--AH: 0): if(` +
        `style(--__1uOp: 0): calc(${bufNotEmpty}); ` +  // 0→0 (hold) or 0→1 (advance)
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 4; ` +
        `style(--__1uOp: 4): 5; ` +
        `style(--__1uOp: 5): 0; ` +
      `else: 0); ` +
      `style(--AH: 1): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 0; ` +
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
 * AH=02h (set cursor position):
 *   μop 0: Write DL (col) to BDA 0x0450
 *   μop 1: Write DH (row) to BDA 0x0451
 *   μop 2-4: Folded IRET
 *
 * AH=03h (get cursor position):
 *   μop 0: DX = (row << 8) | col from BDA, CX = 0
 *   μop 1-3: Folded IRET
 *
 * AH=0Eh (teletype output — printable chars only):
 *   μop 0: Read cursor row/col from BDA 0x0450/0x0451
 *          (implicitly via expressions; compute VGA address)
 *   μop 1: Write char (AL) to VGA text buffer at computed address
 *   μop 2: Write attribute 0x07 to VGA text buffer at address + 1
 *   μop 3: Write new cursor col to BDA 0x0450
 *   μop 4: Write new cursor row to BDA 0x0451
 *   μop 5: Folded IRET — pop IP
 *   μop 6: Folded IRET — pop CS
 *   μop 7: Folded IRET — pop FLAGS, SP += 6, retire
 *
 * AH=0Fh (get video mode):
 *   μop 0: AX = (cols << 8) | mode, BX = BX & 0x00FF (clear BH)
 *   μop 1-3: Folded IRET
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
  // When newCol=0: 1 - min(1, 0) = 1. When newCol>0: 1 - min(1, N) = 0.
  const rowIncrement = `calc(1 - min(1, ${newCol}))`;
  // New row: clamped to 24
  const newRow = `min(24, calc(${cursorRow} + ${rowIncrement}))`;

  // AH=0Eh teletype: 8 μops (0-7), IRET at μops 5-7
  // AH=02h set cursor: 5 μops (0-4), IRET at μops 2-4
  // AH=03h get cursor: 4 μops (0-3), IRET at μops 1-3
  // AH=0Fh get mode:   4 μops (0-3), IRET at μops 1-3

  // We need to handle different IRET timings per subfunction.
  // Maximum μop across all subfunctions = 7 (AH=0Eh)

  return {
    regEntries: [
      // --- AH=03h: get cursor position → DX, CX ---
      // μop 0: DX = (row * 256 + col), CX = 0
      { reg: 'DX', uOp: 0,
        expr: `if(style(--AH: 3): calc(--readMem(${BDA_CURSOR_ROW}) * 256 + --readMem(${BDA_CURSOR_COL})); else: var(--__1DX))`,
        comment: 'INT 10h AH=03h: DX=cursor pos' },
      { reg: 'CX', uOp: 0,
        expr: `if(style(--AH: 3): 0; else: var(--__1CX))`,
        comment: 'INT 10h AH=03h: CX=0 cursor shape' },

      // --- AH=0Fh: get video mode → AX, BX ---
      // μop 0: AX = (cols * 256 + mode), BX = BX & 0x00FF
      { reg: 'AX', uOp: 0,
        expr: `if(style(--AH: 15): calc(--readMem(${BDA_NUM_COLS}) * 256 + --readMem(${BDA_VIDEO_MODE})); else: var(--__1AX))`,
        comment: 'INT 10h AH=0Fh: AX=cols:mode' },
      { reg: 'BX', uOp: 0,
        expr: `if(style(--AH: 15): --and(var(--__1BX), 255); else: var(--__1BX))`,
        comment: 'INT 10h AH=0Fh: BH=0' },

      // --- AH=03h IRET: μops 1-3 ---
      // --- AH=0Fh IRET: μops 1-3 ---
      // μop 1: pop IP for AH=03h and AH=0Fh
      { reg: 'IP', uOp: 1,
        expr: `if(style(--AH: 3): ${popIP}; style(--AH: 15): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=03h/0Fh: pop IP' },
      // μop 2: pop CS for AH=03h and AH=0Fh; write to BDA for AH=02h (handled via memWrites)
      { reg: 'CS', uOp: 2,
        expr: `if(style(--AH: 3): ${popCS}; style(--AH: 15): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=03h/0Fh: pop CS' },
      // μop 3: pop FLAGS + SP for AH=03h and AH=0Fh
      { reg: 'flags', uOp: 3,
        expr: `if(style(--AH: 3): ${popFlagsNormal}; style(--AH: 15): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=03h/0Fh: pop FLAGS' },
      { reg: 'SP', uOp: 3,
        expr: `if(style(--AH: 3): calc(var(--__1SP) + 6); style(--AH: 15): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=03h/0Fh: SP+=6' },

      // --- AH=02h IRET: μops 2-4 ---
      // μop 2: pop IP for AH=02h (note: μop 2 already has CS for AH=03h/0Fh above)
      { reg: 'IP', uOp: 2,
        expr: `if(style(--AH: 2): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=02h: pop IP' },
      // μop 3: pop CS for AH=02h (note: μop 3 already has FLAGS for AH=03h/0Fh)
      { reg: 'CS', uOp: 3,
        expr: `if(style(--AH: 2): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=02h: pop CS' },
      // μop 4: pop FLAGS + SP for AH=02h
      { reg: 'flags', uOp: 4,
        expr: `if(style(--AH: 2): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=02h: pop FLAGS' },
      { reg: 'SP', uOp: 4,
        expr: `if(style(--AH: 2): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=02h: SP+=6' },

      // --- AH=0Eh IRET: μops 5-7 ---
      // μop 5: pop IP for AH=0Eh
      { reg: 'IP', uOp: 5,
        expr: `if(style(--AH: 14): ${popIP}; else: var(--__1IP))`,
        comment: 'INT 10h AH=0Eh: pop IP' },
      // μop 6: pop CS for AH=0Eh
      { reg: 'CS', uOp: 6,
        expr: `if(style(--AH: 14): ${popCS}; else: var(--__1CS))`,
        comment: 'INT 10h AH=0Eh: pop CS' },
      // μop 7: pop FLAGS + SP for AH=0Eh (retirement)
      { reg: 'flags', uOp: 7,
        expr: `if(style(--AH: 14): ${popFlagsNormal}; else: var(--__1flags))`,
        comment: 'INT 10h AH=0Eh: pop FLAGS' },
      { reg: 'SP', uOp: 7,
        expr: `if(style(--AH: 14): calc(var(--__1SP) + 6); else: var(--__1SP))`,
        comment: 'INT 10h AH=0Eh: SP+=6' },
    ],
    memWrites: [
      // --- AH=02h: set cursor position ---
      // μop 0: Write DL (col) to BDA 0x0450
      { uOp: 0,
        addr: `if(style(--AH: 2): ${BDA_CURSOR_COL}; else: -1)`,
        val: `var(--DL)`,
        comment: 'INT 10h AH=02h: col to BDA' },
      // μop 1: Write DH (row) to BDA 0x0451
      { uOp: 1,
        addr: `if(style(--AH: 2): ${BDA_CURSOR_ROW}; else: -1)`,
        val: `var(--DH)`,
        comment: 'INT 10h AH=02h: row to BDA' },

      // --- AH=0Eh: teletype output ---
      // μop 1: Write char byte (AL) to VGA address
      // (shared uOp 1 with AH=02h row write — use AH dispatch in addr)
      { uOp: 1,
        addr: `if(style(--AH: 14): ${vgaAddr}; else: -1)`,
        val: `var(--AL)`,
        comment: 'INT 10h AH=0Eh: char to VGA' },
      // μop 2: Write attribute byte (0x07) to VGA address + 1
      { uOp: 2,
        addr: `if(style(--AH: 14): calc(${vgaAddr} + 1); else: -1)`,
        val: `7`,
        comment: 'INT 10h AH=0Eh: attr to VGA' },
      // μop 3: Write new cursor col to BDA 0x0450
      { uOp: 3,
        addr: `if(style(--AH: 14): ${BDA_CURSOR_COL}; else: -1)`,
        val: newCol,
        comment: 'INT 10h AH=0Eh: new col to BDA' },
      // μop 4: Write new cursor row to BDA 0x0451
      { uOp: 4,
        addr: `if(style(--AH: 14): ${BDA_CURSOR_ROW}; else: -1)`,
        val: newRow,
        comment: 'INT 10h AH=0Eh: new row to BDA' },
    ],
    maxUop: 7,
    ipEntries: [],
    // uOp advance per AH subfunction:
    //   AH=02h: 0→1→2→3→4→0
    //   AH=03h: 0→1→2→3→0
    //   AH=0Eh: 0→1→2→3→4→5→6→7→0
    //   AH=0Fh: 0→1→2→3→0
    //   default: 0 (no-op, single μop retire)
    uopAdvance: `if(` +
      `style(--AH: 2): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 4; ` +
        `style(--__1uOp: 4): 0; ` +
      `else: 0); ` +
      `style(--AH: 3): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 0; ` +
      `else: 0); ` +
      `style(--AH: 14): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 4; ` +
        `style(--__1uOp: 4): 5; ` +
        `style(--__1uOp: 5): 6; ` +
        `style(--__1uOp: 6): 7; ` +
        `style(--__1uOp: 7): 0; ` +
      `else: 0); ` +
      `style(--AH: 15): if(` +
        `style(--__1uOp: 0): 1; ` +
        `style(--__1uOp: 1): 2; ` +
        `style(--__1uOp: 2): 3; ` +
        `style(--__1uOp: 3): 0; ` +
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
 * μop 1-3: Folded IRET
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

      // μop 1: pop IP
      { reg: 'IP', uOp: 1, expr: popIP, comment: 'INT 1Ah: pop IP' },
      // μop 2: pop CS
      { reg: 'CS', uOp: 2, expr: popCS, comment: 'INT 1Ah: pop CS' },
      // μop 3: pop FLAGS + SP+=6 (retirement)
      { reg: 'flags', uOp: 3, expr: popFlagsNormal, comment: 'INT 1Ah: pop FLAGS' },
      { reg: 'SP', uOp: 3, expr: 'calc(var(--__1SP) + 6)', comment: 'INT 1Ah: SP+=6' },
    ],
    memWrites: [],
    maxUop: 3,
    ipEntries: [],
    uopAdvance: `if(` +
      `style(--__1uOp: 0): 1; ` +
      `style(--__1uOp: 1): 2; ` +
      `style(--__1uOp: 2): 3; ` +
      `style(--__1uOp: 3): 0; ` +
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
    int16hEntries(),
    int10hEntries(),
    int1ahEntries(),
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
