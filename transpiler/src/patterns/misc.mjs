// Miscellaneous instructions: HLT, NOP, LODSB, MOV r/m imm, flag manipulation, etc.

/**
 * HLT (opcode 0xF4): halt execution.
 */
export function emitHLT(dispatch) {
  dispatch.addEntry('halt', 0xF4, `1`, `HLT`);
  dispatch.addEntry('IP', 0xF4, `var(--__1IP)`, `HLT (IP unchanged)`);
}

/**
 * NOP (opcode 0x90): no operation.
 */
export function emitNOP(dispatch) {
  dispatch.addEntry('IP', 0x90, `calc(var(--__1IP) + 1)`, `NOP`);
}

/**
 * LODSB (0xAC): load byte at DS:SI into AL, adjust SI by DF.
 * LODSW (0xAD): load word at DS:SI into AX, adjust SI by DF.
 */
export function emitLODS(dispatch) {
  // LODSB: AL = mem[DS:SI], SI += (DF ? -1 : 1)
  dispatch.addEntry('AX', 0xAC,
    `--mergelow(var(--__1AX), --readMem(calc(var(--__1DS) * 16 + var(--__1SI))))`,
    `LODSB`);
  // SI: DF (bit 10) controls direction. DF=0: SI++, DF=1: SI--
  dispatch.addEntry('SI', 0xAC,
    `--lowerBytes(calc(var(--__1SI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`,
    `LODSB SI adjust`);
  dispatch.addEntry('IP', 0xAC, `calc(var(--__1IP) + 1)`, `LODSB`);

  // LODSW: AX = mem[DS:SI], SI += (DF ? -2 : 2)
  dispatch.addEntry('AX', 0xAD,
    `--read2(calc(var(--__1DS) * 16 + var(--__1SI)))`,
    `LODSW`);
  dispatch.addEntry('SI', 0xAD,
    `--lowerBytes(calc(var(--__1SI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`,
    `LODSW SI adjust`);
  dispatch.addEntry('IP', 0xAD, `calc(var(--__1IP) + 1)`, `LODSW`);
}

/**
 * MOV r/m8, imm8 (0xC6) and MOV r/m16, imm16 (0xC7).
 * ModR/M byte selects destination. Immediate follows ModR/M+disp.
 */
export function emitMOV_RMimm(dispatch) {
  const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
  const SPLIT_REGS = [
    { reg: 'AX', lowIdx: 0, highIdx: 4 },
    { reg: 'CX', lowIdx: 1, highIdx: 5 },
    { reg: 'DX', lowIdx: 2, highIdx: 6 },
    { reg: 'BX', lowIdx: 3, highIdx: 7 },
  ];

  // 0xC7: MOV r/m16, imm16 — immWord is after ModR/M+disp
  for (let r = 0; r < 8; r++) {
    dispatch.addEntry(REG16[r], 0xC7,
      `if(style(--mod: 3) and style(--rm: ${r}): var(--immWord); else: var(--__1${REG16[r]}))`,
      `MOV r/m16, imm16 → ${REG16[r]}`);
  }
  // Memory write
  dispatch.addMemWrite(0xC7,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `var(--immByte)`,
    `MOV r/m16, imm16 → mem lo`);
  dispatch.addMemWrite(0xC7,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--readMem(calc(var(--ipAddr) + var(--immOff) + 1))`,
    `MOV r/m16, imm16 → mem hi`);
  dispatch.addEntry('IP', 0xC7,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + 2)`,
    `MOV r/m16, imm16`);

  // 0xC6: MOV r/m8, imm8
  for (const { reg, lowIdx, highIdx } of SPLIT_REGS) {
    dispatch.addEntry(reg, 0xC6,
      `if(style(--mod: 3) and style(--rm: ${lowIdx}): --mergelow(var(--__1${reg}), var(--immByte)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}): --mergehigh(var(--__1${reg}), var(--immByte)); ` +
      `else: var(--__1${reg}))`,
      `MOV r/m8, imm8 → ${reg}`);
  }
  // Memory write
  dispatch.addMemWrite(0xC6,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `var(--immByte)`,
    `MOV r/m8, imm8 → mem`);
  dispatch.addEntry('IP', 0xC6,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + 1)`,
    `MOV r/m8, imm8`);
}

/**
 * Flag manipulation: CLC, STC, CMC, CLD, STD, CLI, STI
 */
export function emitFlagManip(dispatch) {
  // CLC (0xF8): CF = 0
  dispatch.addEntry('flags', 0xF8,
    `calc(var(--__1flags) - --bit(var(--__1flags), 0))`,
    `CLC`);
  dispatch.addEntry('IP', 0xF8, `calc(var(--__1IP) + 1)`, `CLC`);

  // STC (0xF9): CF = 1
  dispatch.addEntry('flags', 0xF9,
    `--or(var(--__1flags), 1)`,
    `STC`);
  dispatch.addEntry('IP', 0xF9, `calc(var(--__1IP) + 1)`, `STC`);

  // CMC (0xF5): CF = !CF
  dispatch.addEntry('flags', 0xF5,
    `--xor(var(--__1flags), 1)`,
    `CMC`);
  dispatch.addEntry('IP', 0xF5, `calc(var(--__1IP) + 1)`, `CMC`);

  // CLD (0xFC): DF = 0 (bit 10)
  dispatch.addEntry('flags', 0xFC,
    `calc(var(--__1flags) - --bit(var(--__1flags), 10) * 1024)`,
    `CLD`);
  dispatch.addEntry('IP', 0xFC, `calc(var(--__1IP) + 1)`, `CLD`);

  // STD (0xFD): DF = 1
  dispatch.addEntry('flags', 0xFD,
    `--or(var(--__1flags), 1024)`,
    `STD`);
  dispatch.addEntry('IP', 0xFD, `calc(var(--__1IP) + 1)`, `STD`);

  // CLI (0xFA): IF = 0 (bit 9)
  dispatch.addEntry('flags', 0xFA,
    `calc(var(--__1flags) - --bit(var(--__1flags), 9) * 512)`,
    `CLI`);
  dispatch.addEntry('IP', 0xFA, `calc(var(--__1IP) + 1)`, `CLI`);

  // STI (0xFB): IF = 1
  dispatch.addEntry('flags', 0xFB,
    `--or(var(--__1flags), 512)`,
    `STI`);
  dispatch.addEntry('IP', 0xFB, `calc(var(--__1IP) + 1)`, `STI`);
}

/**
 * CBW (0x98): sign-extend AL to AX.
 * CWD (0x99): sign-extend AX to DX:AX.
 */
export function emitCBW_CWD(dispatch) {
  // CBW: if AL bit 7 set, AH = 0xFF, else AH = 0x00
  dispatch.addEntry('AX', 0x98,
    `calc(var(--AL) + --bit(var(--AL), 7) * 65280)`,
    `CBW`);
  dispatch.addEntry('IP', 0x98, `calc(var(--__1IP) + 1)`, `CBW`);

  // CWD: if AX bit 15 set, DX = 0xFFFF, else DX = 0x0000
  dispatch.addEntry('DX', 0x99,
    `calc(--bit(var(--__1AX), 15) * 65535)`,
    `CWD`);
  dispatch.addEntry('IP', 0x99, `calc(var(--__1IP) + 1)`, `CWD`);
}

/**
 * STOSB (0xAA): store AL at ES:DI, adjust DI.
 * STOSW (0xAB): store AX at ES:DI, adjust DI.
 */
export function emitSTOS(dispatch) {
  // STOSB: mem[ES:DI] = AL, DI += (DF ? -1 : 1)
  dispatch.addMemWrite(0xAA,
    `calc(var(--__1ES) * 16 + var(--__1DI))`,
    `var(--AL)`,
    `STOSB`);
  dispatch.addEntry('DI', 0xAA,
    `--lowerBytes(calc(var(--__1DI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`,
    `STOSB DI adjust`);
  dispatch.addEntry('IP', 0xAA, `calc(var(--__1IP) + 1)`, `STOSB`);

  // STOSW: mem[ES:DI] = AX (word), DI += (DF ? -2 : 2)
  dispatch.addMemWrite(0xAB,
    `calc(var(--__1ES) * 16 + var(--__1DI))`,
    `var(--AL)`,
    `STOSW lo`);
  dispatch.addMemWrite(0xAB,
    `calc(var(--__1ES) * 16 + var(--__1DI) + 1)`,
    `var(--AH)`,
    `STOSW hi`);
  dispatch.addEntry('DI', 0xAB,
    `--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`,
    `STOSW DI adjust`);
  dispatch.addEntry('IP', 0xAB, `calc(var(--__1IP) + 1)`, `STOSW`);
}

/**
 * XCHG AX, reg16 (0x91-0x97) — exchange AX with another register.
 */
export function emitXCHG_AXreg(dispatch) {
  const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
  for (let r = 1; r < 8; r++) { // 0x91-0x97 (skip 0x90=NOP)
    const opcode = 0x90 + r;
    // AX gets the other register's value
    dispatch.addEntry('AX', opcode, `var(--__1${REG16[r]})`, `XCHG AX, ${REG16[r]}`);
    // The other register gets AX's value
    dispatch.addEntry(REG16[r], opcode, `var(--__1AX)`, `XCHG AX, ${REG16[r]}`);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `XCHG AX, ${REG16[r]}`);
  }
}

/**
 * Register all misc opcodes.
 */
export function emitAllMisc(dispatch) {
  emitHLT(dispatch);
  emitNOP(dispatch);
  emitLODS(dispatch);
  emitSTOS(dispatch);
  emitMOV_RMimm(dispatch);
  emitFlagManip(dispatch);
  emitCBW_CWD(dispatch);
  emitXCHG_AXreg(dispatch);
}
