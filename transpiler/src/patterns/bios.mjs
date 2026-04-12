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

/**
 * Register all BIOS handler dispatch entries.
 *
 * For now: only INT 20h (halt). Other handlers added in Tasks 8-10.
 *
 * All handlers share opcode 214 and dispatch on --q1 (routine ID).
 * Each register slot gets ONE addEntry call with an internal
 * if(style(--q1: N)) chain.
 */
export function emitAllBiosHandlers(dispatch) {
  // INT 20h: set halt=1. Single uop, routine ID 0x20 (32 decimal).
  dispatch.addEntry('halt', BIOS_OPCODE,
    `if(style(--q1: ${ROUTINE_IDS.INT_20H}): 1; else: var(--__1halt))`,
    'BIOS INT 20h: halt', 0);

  // IP: advance past the 2-byte sentinel (0xD6 + routineID).
  // For INT 20h this doesn't matter (halt stops execution), but needed
  // for handlers that retire normally.
  dispatch.addEntry('IP', BIOS_OPCODE,
    `calc(var(--__1IP) + 2)`,
    'BIOS: skip sentinel+ID', 0);
}
