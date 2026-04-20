// Miscellaneous instructions: HLT, NOP, LODSB, MOV r/m imm, flag manipulation, etc.

// ===== REP PREFIX HELPERS =====
// These helpers wrap string operation expressions to handle REP/REPE/REPNE prefixes.
// When hasREP=1 and CX=0, the string op is skipped (register/memory unchanged).
// When hasREP=1 and CX>1, IP stays at the prefix byte for re-execution.
// When hasREP=1 and CX=1, this is the last iteration — IP advances normally.

/** Wrap a register expression so that REP with CX=0 preserves the old value. */
function repGuardReg(expr, oldVal) {
  return `if(style(--hasREP: 1) and style(--_repActive: 0): ${oldVal}; else: ${expr})`;
}

/** Wrap a memory write address so that REP with CX=0 suppresses the write. */
function repGuardAddr(addr) {
  return `if(style(--hasREP: 1) and style(--_repActive: 0): -1; else: ${addr})`;
}

/** IP expression for string ops: re-execute if repeating, else advance.
 *  instrLen = byte length of the string op itself (always 1 for these). */
function repIP(instrLen = 1) {
  // _repContinue=1 when hasREP=1 and CX>1 → re-execute: IP stays at prefix byte.
  // The dispatch IP wrapper adds + prefixLen, so we emit (IP - prefixLen) here
  // so the final result is IP - prefixLen + prefixLen = IP (unchanged).
  // When not repeating (no REP, or last iteration, or CX=0): advance normally.
  return `if(style(--_repContinue: 1): calc(var(--__1IP) - var(--prefixLen)); else: calc(var(--__1IP) + ${instrLen}))`;
}

/** CX expression for string ops under REP: decrement CX, or keep if no REP.
 *  For CX=0 with REP, CX stays at 0 (max(0, 0-1) = 0). */
function repCX() {
  return `if(style(--hasREP: 0): var(--__1CX); else: max(0, calc(var(--__1CX) - 1)))`;
}

/** IP expression for REPE/REPNE string ops (CMPS/SCAS).
 *  For REPE (repType=1): stop if ZF=0 after comparison.
 *  For REPNE (repType=2): stop if ZF=1 after comparison.
 *  zfExpr = expression that evaluates to 1 when ZF would be set (operands equal). */
function repCondIP(zfExpr, instrLen = 1) {
  // Continue if: hasREP=1 AND CX>1 AND condition holds
  // REPE (repType=1): continue if equal (zf=1)  → stop if zf=0
  // REPNE (repType=2): continue if not equal (zf=0) → stop if zf=1
  // Combined: continue if (repType=1 and equal) or (repType=2 and not equal)
  //   = repType + zf != 3  (1+1=2, 1+0=1, 2+1=3, 2+0=2; stop when sum=3)
  //   Actually: REPE stops when zf=0, REPNE stops when zf=1
  //   Continue when: (repType=1 and zf=1) or (repType=2 and zf=0)
  //   = |repType - 1 - zf| < 1  → repType-1 == zf → repType == zf+1
  // Simpler: use if-chain. But we can't nest too deep.
  // Let's just use: repType=1 means stop if zfExpr=0, repType=2 means stop if zfExpr=1
  // _repContinue already checks CX>1. We also need the ZF condition.
  // Express as: _repContinue=1 AND ((repType=1 AND equal) OR (repType=2 AND not_equal))
  return `if(` +
    `style(--_repContinue: 1) and style(--repType: 1) and style(--_repZF: 1): calc(var(--__1IP) - var(--prefixLen)); ` +
    `style(--_repContinue: 1) and style(--repType: 2) and style(--_repZF: 0): calc(var(--__1IP) - var(--prefixLen)); ` +
    `else: calc(var(--__1IP) + ${instrLen}))`;
}

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
    repGuardReg(`--mergelow(var(--__1AX), var(--_strSrcByte))`, `var(--__1AX)`),
    `LODSB`);
  dispatch.addEntry('SI', 0xAC,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1SI)`),
    `LODSB SI adjust`);
  dispatch.addEntry('CX', 0xAC, repCX(), `REP LODSB CX`);
  dispatch.addEntry('IP', 0xAC, repIP(), `LODSB`);

  // LODSW: AX = mem[DS:SI], SI += (DF ? -2 : 2)
  dispatch.addEntry('AX', 0xAD,
    repGuardReg(`calc(var(--_strSrcByte) + var(--_strSrcHiByte) * 256)`, `var(--__1AX)`),
    `LODSW`);
  dispatch.addEntry('SI', 0xAD,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1SI)`),
    `LODSW SI adjust`);
  dispatch.addEntry('CX', 0xAD, repCX(), `REP LODSW CX`);
  dispatch.addEntry('IP', 0xAD, repIP(), `LODSW`);
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
  // Memory write — use immByte/immWord (already decoded) instead of separate readMem
  dispatch.addMemWrite(0xC7,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `var(--immByte)`,
    `MOV r/m16, imm16 → mem lo`);
  dispatch.addMemWrite(0xC7,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(var(--immWord), 8)`,
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
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--AL)`,
    `STOSB`);
  dispatch.addEntry('DI', 0xAA,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1DI)`),
    `STOSB DI adjust`);
  dispatch.addEntry('CX', 0xAA, repCX(), `REP STOSB CX`);
  dispatch.addEntry('IP', 0xAA, repIP(), `STOSB`);

  // STOSW: mem[ES:DI] = AX (word), DI += (DF ? -2 : 2)
  dispatch.addMemWrite(0xAB,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--AL)`,
    `STOSW lo`);
  dispatch.addMemWrite(0xAB,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI) + 1)`),
    `var(--AH)`,
    `STOSW hi`);
  dispatch.addEntry('DI', 0xAB,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `STOSW DI adjust`);
  dispatch.addEntry('CX', 0xAB, repCX(), `REP STOSW CX`);
  dispatch.addEntry('IP', 0xAB, repIP(), `STOSW`);
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
 * MOVSB (0xA4): copy byte from DS:SI to ES:DI, adjust SI and DI.
 * MOVSW (0xA5): copy word from DS:SI to ES:DI, adjust SI and DI.
 */
export function emitMOVS(dispatch) {
  // MOVSB: mem[ES:DI] = mem[DS:SI], SI += (DF?-1:1), DI += (DF?-1:1)
  dispatch.addMemWrite(0xA4,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--_strSrcByte)`,
    `MOVSB`);
  dispatch.addEntry('SI', 0xA4,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1SI)`),
    `MOVSB SI adjust`);
  dispatch.addEntry('DI', 0xA4,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1DI)`),
    `MOVSB DI adjust`);
  dispatch.addEntry('CX', 0xA4, repCX(), `REP MOVSB CX`);
  dispatch.addEntry('IP', 0xA4, repIP(), `MOVSB`);

  // MOVSW: copy word (2 bytes)
  dispatch.addMemWrite(0xA5,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--_strSrcByte)`,
    `MOVSW lo`);
  dispatch.addMemWrite(0xA5,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI) + 1)`),
    `var(--_strSrcHiByte)`,
    `MOVSW hi`);
  dispatch.addEntry('SI', 0xA5,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1SI)`),
    `MOVSW SI adjust`);
  dispatch.addEntry('DI', 0xA5,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `MOVSW DI adjust`);
  dispatch.addEntry('CX', 0xA5, repCX(), `REP MOVSW CX`);
  dispatch.addEntry('IP', 0xA5, repIP(), `MOVSW`);
}

/**
 * CMPSB (0xA6): compare byte at DS:SI with byte at ES:DI, set flags.
 * CMPSW (0xA7): compare word at DS:SI with word at ES:DI, set flags.
 */
export function emitCMPS(dispatch) {
  // CMPSB: flags = sub(mem[DS:SI], mem[ES:DI])
  dispatch.addEntry('flags', 0xA6,
    repGuardReg(`calc(--subFlags8(var(--_strSrcByte), var(--_strDstByte)) + --and(var(--__1flags), 1792))`, `var(--__1flags)`),
    `CMPSB flags`);
  dispatch.addEntry('SI', 0xA6,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1SI)`),
    `CMPSB SI adjust`);
  dispatch.addEntry('DI', 0xA6,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1DI)`),
    `CMPSB DI adjust`);
  dispatch.addEntry('CX', 0xA6, repCX(), `REPE/NE CMPSB CX`);
  dispatch.addEntry('IP', 0xA6, repCondIP(), `CMPSB`);

  // CMPSW: compare words
  dispatch.addEntry('flags', 0xA7,
    repGuardReg(`calc(--subFlags16(calc(var(--_strSrcByte) + var(--_strSrcHiByte) * 256), calc(var(--_strDstByte) + var(--_strDstHiByte) * 256)) + --and(var(--__1flags), 1792))`, `var(--__1flags)`),
    `CMPSW flags`);
  dispatch.addEntry('SI', 0xA7,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1SI)`),
    `CMPSW SI adjust`);
  dispatch.addEntry('DI', 0xA7,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `CMPSW DI adjust`);
  dispatch.addEntry('CX', 0xA7, repCX(), `REPE/NE CMPSW CX`);
  dispatch.addEntry('IP', 0xA7, repCondIP(), `CMPSW`);
}

/**
 * SCASB (0xAE): compare AL with byte at ES:DI, set flags, adjust DI.
 * SCASW (0xAF): compare AX with word at ES:DI, set flags, adjust DI.
 */
export function emitSCAS(dispatch) {
  dispatch.addEntry('flags', 0xAE,
    repGuardReg(`calc(--subFlags8(var(--AL), var(--_strDstByte)) + --and(var(--__1flags), 1792))`, `var(--__1flags)`),
    `SCASB flags`);
  dispatch.addEntry('DI', 0xAE,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 1 - --bit(var(--__1flags), 10) * 2), 16)`, `var(--__1DI)`),
    `SCASB DI adjust`);
  dispatch.addEntry('CX', 0xAE, repCX(), `REPE/NE SCASB CX`);
  dispatch.addEntry('IP', 0xAE, repCondIP(), `SCASB`);

  dispatch.addEntry('flags', 0xAF,
    repGuardReg(`calc(--subFlags16(var(--__1AX), --read2(calc(var(--__1ES) * 16 + var(--__1DI)))) + --and(var(--__1flags), 1792))`, `var(--__1flags)`),
    `SCASW flags`);
  dispatch.addEntry('DI', 0xAF,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `SCASW DI adjust`);
  dispatch.addEntry('CX', 0xAF, repCX(), `REPE/NE SCASW CX`);
  dispatch.addEntry('IP', 0xAF, repCondIP(), `SCASW`);
}

/**
 * XCHG reg16, r/m16 (0x87): exchange register with r/m operand.
 * XCHG reg8, r/m8 (0x86): exchange 8-bit register with r/m operand.
 */
export function emitXCHG_RM(dispatch) {
  const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
  const SPLIT_REGS = [
    { reg: 'AX', lowIdx: 0, highIdx: 4 },
    { reg: 'CX', lowIdx: 1, highIdx: 5 },
    { reg: 'DX', lowIdx: 2, highIdx: 6 },
    { reg: 'BX', lowIdx: 3, highIdx: 7 },
  ];

  // 0x87: XCHG reg16, r/m16
  // reg field register gets rmVal16, rm operand gets regVal16
  for (let r = 0; r < 8; r++) {
    const regName = REG16[r];
    // This register is the destination when reg field = r
    // It's also the source (for memory write) when rm = r and mod=3
    const branches = [];
    // When this reg is selected by the reg field: gets rmVal16
    branches.push(`style(--reg: ${r}): var(--rmVal16)`);
    // When this reg is selected by rm field (mod=3): gets regVal16
    for (let regF = 0; regF < 8; regF++) {
      if (regF === r) continue; // Already covered above (reg=r means rm is the source)
      branches.push(`style(--mod: 3) and style(--rm: ${r}) and style(--reg: ${regF}): var(--regVal16)`);
    }
    dispatch.addEntry(regName, 0x87,
      `if(${branches.join('; ')}; else: var(--__1${regName}))`,
      `XCHG r/m16 → ${regName}`);
  }
  // Memory write: when mod!=3, write regVal16 to EA
  dispatch.addMemWrite(0x87,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `--lowerBytes(var(--regVal16), 8)`,
    `XCHG r/m16 → mem lo`);
  dispatch.addMemWrite(0x87,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(var(--regVal16), 8)`,
    `XCHG r/m16 → mem hi`);
  dispatch.addEntry('IP', 0x87, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `XCHG r/m16`);

  // 0x86: XCHG reg8, r/m8
  for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
    const branches = [];
    // Special case: both reg and rm select halves of the SAME register (e.g., XCHG AL,AH)
    // Both halves must change simultaneously — a full byte swap.
    // XCHG low,high (reg=low,rm=high): new_low=rmVal8(=high), new_high=regVal8(=low)
    branches.push(`style(--mod: 3) and style(--reg: ${lowIdx}) and style(--rm: ${highIdx}): calc(var(--rmVal8) + var(--regVal8) * 256)`);
    // XCHG high,low (reg=high,rm=low): new_low=regVal8(=high), new_high=rmVal8(=low)
    branches.push(`style(--mod: 3) and style(--reg: ${highIdx}) and style(--rm: ${lowIdx}): calc(var(--regVal8) + var(--rmVal8) * 256)`);
    // reg field selects this register's low byte
    branches.push(`style(--reg: ${lowIdx}): --mergelow(var(--__1${regName}), var(--rmVal8))`);
    // reg field selects this register's high byte
    branches.push(`style(--reg: ${highIdx}): --mergehigh(var(--__1${regName}), var(--rmVal8))`);
    // rm field selects this register's low byte (mod=3): gets regVal8
    branches.push(`style(--mod: 3) and style(--rm: ${lowIdx}): --mergelow(var(--__1${regName}), var(--regVal8))`);
    // rm field selects this register's high byte (mod=3): gets regVal8
    branches.push(`style(--mod: 3) and style(--rm: ${highIdx}): --mergehigh(var(--__1${regName}), var(--regVal8))`);
    dispatch.addEntry(regName, 0x86,
      `if(${branches.join('; ')}; else: var(--__1${regName}))`,
      `XCHG r/m8 → ${regName}`);
  }
  // Memory write for byte XCHG
  dispatch.addMemWrite(0x86,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `var(--regVal8)`,
    `XCHG r/m8 → mem`);
  dispatch.addEntry('IP', 0x86, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `XCHG r/m8`);
}

/**
 * POP r/m16 (0x8F): pop word from stack into r/m16.
 * Only reg=0 is defined.
 */
export function emitPOP_RM(dispatch) {
  const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];

  // Pop value from stack into register (mod=3)
  for (let r = 0; r < 8; r++) {
    if (r === 4) continue; // SP handled separately
    dispatch.addEntry(REG16[r], 0x8F,
      `if(style(--mod: 3) and style(--rm: ${r}): --read2(calc(var(--__1SS) * 16 + var(--__1SP))); else: var(--__1${REG16[r]}))`,
      `POP r/m16 → ${REG16[r]}`);
  }
  // SP: gets popped value if rm=4, otherwise SP+=2
  dispatch.addEntry('SP', 0x8F,
    `if(style(--mod: 3) and style(--rm: 4): --read2(calc(var(--__1SS) * 16 + var(--__1SP))); else: calc(var(--__1SP) + 2))`,
    `POP r/m16 SP`);

  // Memory write: when mod!=3, write popped value to EA
  dispatch.addMemWrite(0x8F,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `--lowerBytes(--read2(calc(var(--__1SS) * 16 + var(--__1SP))), 8)`,
    `POP r/m16 → mem lo`);
  dispatch.addMemWrite(0x8F,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(--read2(calc(var(--__1SS) * 16 + var(--__1SP))), 8)`,
    `POP r/m16 → mem hi`);

  dispatch.addEntry('IP', 0x8F, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `POP r/m16`);
}

/**
 * LAHF (0x9F): AH = flags low byte (SF, ZF, AF, PF, CF).
 * SAHF (0x9E): flags low byte = (AH & 0xD7) | 0x02, preserving upper byte.
 */
export function emitLAHF_SAHF(dispatch) {
  // LAHF: AH = flags & 0xFF → mergehigh(AX, flags & 0xFF)
  dispatch.addEntry('AX', 0x9F,
    `--mergehigh(var(--__1AX), --lowerBytes(var(--__1flags), 8))`,
    `LAHF`);
  dispatch.addEntry('IP', 0x9F, `calc(var(--__1IP) + 1)`, `LAHF`);

  // SAHF: flags = (flags & 0xFF00) | (AH & 0xD5) | 0x02
  // 0xD5 = 213 clears bit 1 so +2 safely forces it on (avoids double-counting)
  // Preserves bits 0,2,4,6,7 of AH (CF,PF,AF,ZF,SF)
  dispatch.addEntry('flags', 0x9E,
    `calc(--rightShift(var(--__1flags), 8) * 256 + --and(var(--AH), 213) + 2)`,
    `SAHF`);
  dispatch.addEntry('IP', 0x9E, `calc(var(--__1IP) + 1)`, `SAHF`);
}

/**
 * Peripheral helper computed properties emitted into the .cpu rule.
 *
 * These aren't dispatched — they're derived each tick from the new
 * --cycleCount (which the instruction's cycle-count entry has already
 * set for this tick) and the __1 versions of the PIT state vars.
 *
 * --_pitTicks: PIT input pulses consumed this retirement.
 *   The 8086 runs at ~4.77 MHz, the PIT at ~1.193 MHz — a 4:1 ratio.
 *   So each increment of cycleCount/4 is one PIT tick.
 * --_pitDecrement: how much to subtract from the counter. Mode 3
 *   (square wave) decrements by 2 per PIT tick; other modes by 1.
 * --_pitFired: 1 iff the counter would cross zero this tick and the
 *   PIT is armed (pitReload != 0). Used to raise IRQ 0 on picPending.
 *   Computed via sign(decrement - counter + 1): positive when the
 *   decrement is at least counter (i.e. counter reaches 0 or below),
 *   clamped to [0, 1].
 */
export function emitPeripheralCompute() {
  const pitTicks = `calc(round(down, var(--cycleCount) / 4) - round(down, var(--__1cycleCount) / 4))`;
  const pitDecrement = `if(style(--__1pitMode: 3): calc(var(--_pitTicks) * 2); else: var(--_pitTicks))`;
  const pitFired = `if(style(--__1pitReload: 0): 0; else: min(1, max(0, sign(calc(var(--_pitDecrement) - var(--__1pitCounter) + 1)))))`;
  return [
    `  /* Peripheral clocks derived from this tick's --cycleCount */`,
    `  --_pitTicks: ${pitTicks};`,
    `  --_pitDecrement: ${pitDecrement};`,
    `  --_pitFired: ${pitFired};`,
  ].join('\n');
}

/**
 * Expression for --pitCounter's per-tick countdown: decrement by
 * --_pitDecrement, reload from --__1pitReload on zero crossing. Holds
 * at 0 while idle (pitReload == 0). Used both as the register-level
 * default (opcodes with no PIT dispatch entry) and as the `else:` of
 * the port-write entries (OUT to a non-PIT port must still tick).
 */
export function pitCounterDefaultExpr() {
  return `if(
    style(--__1pitReload: 0): 0;
    else: calc(
      var(--__1pitCounter) - var(--_pitDecrement)
      + max(0, sign(calc(var(--_pitDecrement) - var(--__1pitCounter) + 1))) * var(--__1pitReload)
    )
  )`;
}

/**
 * Default expression for --picPending. ORs in bit 0 when the PIT crosses
 * zero (_pitFired) and bit 1 on a keyboard press edge (_kbdEdge).
 *
 * The IRQ-acknowledge branch (clearing --_irqBit) is applied via the
 * register-level IRQ_OVERRIDES in emit-css.mjs, not here — the override
 * takes priority over this default when --_irqActive fires.
 */
export function picPendingDefaultExpr() {
  return `--or(
    --or(var(--__1picPending), var(--_pitFired)),
    calc(var(--_kbdEdge) * 2)
  )`;
}

/**
 * Compute properties for IRQ delivery. Emitted as standalone lines in
 * the .cpu rule — not dispatch-routed.
 *
 *   --_kbdPress:    1 iff --keyboard went 0 → non-zero this tick (make code).
 *   --_kbdRelease:  1 iff --keyboard went non-zero → 0 this tick (break code).
 *   --_kbdEdge:     --_kbdPress | --_kbdRelease — either raises IRQ 1.
 *   --_kbdPort60:   what port 0x60 IN returns on this tick. Normally the
 *                   current scancode (high byte of --keyboard). On a release
 *                   tick, the previous scancode with bit 7 set (break code).
 *   --_picEffective: pending-and-unmasked IRQs, masked to 0 when another
 *                    IRQ is already in service (prevents nesting).
 *   --_ifFlag:      interrupt-enable flag (bit 9 of FLAGS).
 *   --_irqActive:   1 iff an IRQ should fire at this instruction boundary.
 *   --_irq0Pending: 1 iff IRQ 0 (PIT) is the effective pending IRQ.
 *                   IRQ 0 has priority over IRQ 1 on real PICs.
 *   --picVector:    INT vector for the acknowledged IRQ (8 or 9 for now).
 *   --_irqBit:      bitmask (1 or 2) of the IRQ being acknowledged.
 *
 * Phase 3 only handles IRQ 0 (timer) and IRQ 1 (keyboard) — the only ones
 * Doom8088 cares about. Adding more IRQs would generalize --picVector
 * and --_irqBit through a lowestBit helper like v3's irq.mjs did.
 *
 * Break-scancode synthesis (#27): Doom8088 tracks held keys via the high bit
 * of scancodes read from port 0x60. On a release tick we fire IRQ 1 and port
 * 0x60 must return the *previous* scancode with bit 7 set.
 */
export function emitIRQCompute() {
  const kbdPress = `if(
    style(--keyboard: 0): 0;
    style(--__1prevKeyboard: 0): 1;
    else: 0
  )`;
  const kbdRelease = `if(
    style(--__1prevKeyboard: 0): 0;
    style(--keyboard: 0): 1;
    else: 0
  )`;
  // On a release tick --keyboard is 0, so port 0x60 would normally return 0.
  // Substitute prevKeyboard_scancode | 0x80 instead. On a non-release tick
  // return the current scancode. Guard against a release with prevKeyboard=0
  // (can't happen by construction of --_kbdRelease, but keep it defensive).
  const kbdPort60 = `if(
    style(--_kbdRelease: 1): --or(--rightShift(var(--__1prevKeyboard), 8), 128);
    else: --rightShift(var(--keyboard), 8)
  )`;
  const picEffective = `if(
    style(--__1picInService: 0): --and(var(--__1picPending), --not(var(--__1picMask)));
    else: 0
  )`;
  return [
    `  /* IRQ delivery state */`,
    `  --_kbdPress: ${kbdPress};`,
    `  --_kbdRelease: ${kbdRelease};`,
    `  --_kbdEdge: --or(var(--_kbdPress), var(--_kbdRelease));`,
    `  --_kbdPort60: ${kbdPort60};`,
    `  --_picEffective: ${picEffective};`,
    `  --_ifFlag: --bit(var(--__1flags), 9);`,
    `  --_irqActive: if(style(--_ifFlag: 0): 0; style(--_picEffective: 0): 0; else: 1);`,
    `  --_irq0Pending: --and(var(--_picEffective), 1);`,
    `  --picVector: if(style(--_irq0Pending: 1): 8; else: 9);`,
    `  --_irqBit: if(style(--_irq0Pending: 1): 1; else: 2);`,
  ].join('\n');
}

/**
 * I/O port instructions: IN and OUT.
 *
 * Reads:
 *   Port 0x21 (PIC data) returns --picMask. Programs that do the standard
 *     read-modify-write (in al,0x21; and al,~bit; out 0x21,al) rely on this.
 *   Port 0x60 (keyboard) returns the scancode (high byte of --keyboard).
 *   All other ports return 0.
 *
 * Writes (state lives in --picMask/--picInService/--pitMode/--pitReload/
 * --pitCounter/--pitWriteState — declared in template.mjs STATE_VARS):
 *   Port 0x20 (PIC command): EOI clears the lowest-priority in-service bit.
 *     Phase 1 treats any write as a non-specific EOI (Doom8088 only sends
 *     0x20, which is the correct encoding).
 *   Port 0x21 (PIC data):    writes AL to --picMask.
 *   Port 0x40 (PIT ch0 data): lo/hi sequenced write to --pitReload; the
 *     hi-byte write also loads --pitCounter.
 *   Port 0x43 (PIT control): sets --pitMode from bits 3-1 of AL and resets
 *     reload/counter/writeState. Channel select (bits 7-6) is ignored for
 *     Phase 1 — we only track channel 0.
 *
 * Unhandled ports (speaker 0x61, CRTC 0x3D4/0x3D5, palette DAC 0x3C8/0x3C9,
 * secondary PIC 0xA0/0xA1, PIT ch1/ch2 0x41/0x42) remain no-ops.
 *
 * Dispatch entries on OUT opcodes fall back to var(--__1NAME) when the port
 * doesn't match — the entry fires on every OUT of this opcode shape, so it
 * must explicitly hold the state for unrelated ports.
 *
 * Opcode shapes:
 *   IN AL, imm8  (0xE4): 2-byte, port in q1.
 *   IN AX, imm8  (0xE5): 2-byte, port in q1.
 *   OUT imm8, AL (0xE6): 2-byte, port in q1.
 *   OUT imm8, AX (0xE7): 2-byte, port in q1, AX written (no PIC/PIT effect).
 *   IN AL, DX   (0xEC): 1-byte, port in --__1DX.
 *   IN AX, DX   (0xED): 1-byte, port in --__1DX.
 *   OUT DX, AL  (0xEE): 1-byte, port in --__1DX.
 *   OUT DX, AX  (0xEF): 1-byte, port in --__1DX, no PIC/PIT effect.
 */
export function emitIO(dispatch) {
  // --- Reads ---

  // IN AL, imm8 (0xE4):
  //   port 0x21 → picMask (so programs can read-modify-write the mask)
  //   port 0x60 → scancode = rightShift(keyboard, 8)
  //   other    → 0
  dispatch.addEntry('AX', 0xE4,
    `--mergelow(var(--__1AX), if(style(--q1: 33): var(--__1picMask); style(--q1: 96): var(--_kbdPort60); else: 0))`,
    `IN AL, imm8 (0x21=picMask, 0x60=kbdPort60)`);
  dispatch.addEntry('IP', 0xE4, `calc(var(--__1IP) + 2)`, `IN AL, imm8`);

  // IN AX, imm8 (0xE5):
  //   port 0x21 → picMask
  //   port 0x60 → full keyboard word
  dispatch.addEntry('AX', 0xE5,
    `if(style(--q1: 33): var(--__1picMask); style(--q1: 96): var(--__1keyboard); else: 0)`,
    `IN AX, imm8 (0x21=picMask, 0x60=keyboard)`);
  dispatch.addEntry('IP', 0xE5, `calc(var(--__1IP) + 2)`, `IN AX, imm8`);

  // IN AL, DX (0xEC):
  //   DX=0x21 → picMask
  //   DX=0x60 → scancode
  dispatch.addEntry('AX', 0xEC,
    `--mergelow(var(--__1AX), if(style(--__1DX: 33): var(--__1picMask); style(--__1DX: 96): var(--_kbdPort60); else: 0))`,
    `IN AL, DX (0x21=picMask, 0x60=kbdPort60)`);
  dispatch.addEntry('IP', 0xEC, `calc(var(--__1IP) + 1)`, `IN AL, DX`);

  // IN AX, DX (0xED):
  //   DX=0x21 → picMask
  //   DX=0x60 → full keyboard word
  dispatch.addEntry('AX', 0xED,
    `if(style(--__1DX: 33): var(--__1picMask); style(--__1DX: 96): var(--__1keyboard); else: 0)`,
    `IN AX, DX (0x21=picMask, 0x60=keyboard)`);
  dispatch.addEntry('IP', 0xED, `calc(var(--__1IP) + 1)`, `IN AX, DX`);

  // --- Writes ---

  dispatch.addEntry('IP', 0xE6, `calc(var(--__1IP) + 2)`, `OUT imm8, AL`);
  dispatch.addEntry('IP', 0xE7, `calc(var(--__1IP) + 2)`, `OUT imm8, AX`);
  dispatch.addEntry('IP', 0xEE, `calc(var(--__1IP) + 1)`, `OUT DX, AL`);
  dispatch.addEntry('IP', 0xEF, `calc(var(--__1IP) + 1)`, `OUT DX, AX`);

  // AL, inline (can't use --AL alias in the state-var expressions below
  // because we read it across many different --__1AX values — the alias
  // would need to be re-derived per tick anyway and the cost is identical).
  const al = `--lowerBytes(var(--__1AX), 8)`;

  // Non-specific EOI on OUT 0x20 (any value). Clear the lowest-priority
  // in-service bit using the (x & (x-1)) bit-clear-lowest trick. When
  // picInService=0 this yields 0 (no effect), which is correct.
  const picEoiExpr = `--and(var(--__1picInService), calc(var(--__1picInService) - 1))`;

  // picInService: OUT to 0x20 → EOI. Other ports → hold.
  dispatch.addEntry('picInService', 0xE6,
    `if(style(--q1: 32): ${picEoiExpr}; else: var(--__1picInService))`,
    `OUT 0x20: non-specific EOI`);
  dispatch.addEntry('picInService', 0xEE,
    `if(style(--__1DX: 32): ${picEoiExpr}; else: var(--__1picInService))`,
    `OUT DX=0x20: non-specific EOI`);

  // picMask: OUT to 0x21 → AL becomes the new mask. Other ports → hold.
  dispatch.addEntry('picMask', 0xE6,
    `if(style(--q1: 33): ${al}; else: var(--__1picMask))`,
    `OUT 0x21: set PIC mask`);
  dispatch.addEntry('picMask', 0xEE,
    `if(style(--__1DX: 33): ${al}; else: var(--__1picMask))`,
    `OUT DX=0x21: set PIC mask`);

  // pitMode: OUT to 0x43 (control word) → bits 3-1 of AL.
  const pitModeExpr = `--lowerBytes(--rightShift(--and(${al}, 14), 1), 3)`;
  dispatch.addEntry('pitMode', 0xE6,
    `if(style(--q1: 67): ${pitModeExpr}; else: var(--__1pitMode))`,
    `OUT 0x43: PIT control word`);
  dispatch.addEntry('pitMode', 0xEE,
    `if(style(--__1DX: 67): ${pitModeExpr}; else: var(--__1pitMode))`,
    `OUT DX=0x43: PIT control word`);

  // pitWriteState: toggled by OUT 0x40, reset by OUT 0x43. Hold otherwise.
  dispatch.addEntry('pitWriteState', 0xE6,
    `if(style(--q1: 67): 0; style(--q1: 64): calc(1 - var(--__1pitWriteState)); else: var(--__1pitWriteState))`,
    `OUT 0x43/0x40: PIT writeState`);
  dispatch.addEntry('pitWriteState', 0xEE,
    `if(style(--__1DX: 67): 0; style(--__1DX: 64): calc(1 - var(--__1pitWriteState)); else: var(--__1pitWriteState))`,
    `OUT DX=0x43/0x40: PIT writeState`);

  // pitReload: OUT 0x43 resets to 0. OUT 0x40 with writeState=0 sets lo byte,
  // writeState=1 sets hi byte. Hold otherwise.
  const pitReloadImm = `if(
    style(--q1: 67): 0;
    style(--q1: 64) and style(--__1pitWriteState: 0): calc(--and(var(--__1pitReload), 65280) + ${al});
    style(--q1: 64) and style(--__1pitWriteState: 1): calc(--and(var(--__1pitReload), 255) + ${al} * 256);
    else: var(--__1pitReload)
  )`;
  const pitReloadDx = `if(
    style(--__1DX: 67): 0;
    style(--__1DX: 64) and style(--__1pitWriteState: 0): calc(--and(var(--__1pitReload), 65280) + ${al});
    style(--__1DX: 64) and style(--__1pitWriteState: 1): calc(--and(var(--__1pitReload), 255) + ${al} * 256);
    else: var(--__1pitReload)
  )`;
  dispatch.addEntry('pitReload', 0xE6, pitReloadImm, `OUT 0x40/0x43: PIT reload`);
  dispatch.addEntry('pitReload', 0xEE, pitReloadDx, `OUT DX=0x40/0x43: PIT reload`);

  // pitCounter: OUT 0x43 resets to 0. OUT 0x40 with writeState=1 loads the
  // new full reload into the counter (matches real PIT behavior — the counter
  // starts ticking only after both bytes are written). On OUT to any other
  // port (e.g. 0x20, 0x21), fall through to the normal per-tick countdown —
  // the PIT must keep running while the program is talking to other devices.
  const pitTick = pitCounterDefaultExpr();
  const pitCounterImm = `if(
    style(--q1: 67): 0;
    style(--q1: 64) and style(--__1pitWriteState: 1): calc(--and(var(--__1pitReload), 255) + ${al} * 256);
    else: ${pitTick}
  )`;
  const pitCounterDx = `if(
    style(--__1DX: 67): 0;
    style(--__1DX: 64) and style(--__1pitWriteState: 1): calc(--and(var(--__1pitReload), 255) + ${al} * 256);
    else: ${pitTick}
  )`;
  dispatch.addEntry('pitCounter', 0xE6, pitCounterImm, `OUT 0x40/0x43: PIT counter load`);
  dispatch.addEntry('pitCounter', 0xEE, pitCounterDx, `OUT DX=0x40/0x43: PIT counter load`);

  // --- VGA DAC (ports 0x3C8 write-index, 0x3C9 data) ---
  //
  // Real-hardware DAC protocol:
  //   OUT 0x3C8, n        set write index to n, reset sub-index to 0
  //   OUT 0x3C9, R        store R at palette[n], sub-index -> 1
  //   OUT 0x3C9, G        store G at palette[n], sub-index -> 2
  //   OUT 0x3C9, B        store B at palette[n], sub-index -> 0, n -> n+1
  // A program typically sets the index once, then writes 3*N bytes in a loop.
  //
  // We shadow the 256*3 = 768 palette bytes to out-of-1MB linear addresses
  // (kiln/memory.mjs DAC_LINEAR). Calcite reads them back when rendering the
  // Mode 13h framebuffer. Values are stored as-is (6-bit 0..63); the frame-
  // buffer renderer does the 6-to-8-bit expansion.
  //
  // Port 0x3C7 (DAC read index) is not implemented here — fire doesn't read
  // the DAC back. Add when a program needs it.

  const DAC_LINEAR = 0x100000;

  // OUT 0x3C8 — set write index, reset sub-index.
  // Written as "968" and "969" in CSS since style() takes integer literals.
  dispatch.addEntry('dacWriteIndex', 0xE6,
    `if(style(--q1: 968): ${al}; style(--q1: 969) and style(--__1dacSubIndex: 2): calc(var(--__1dacWriteIndex) + 1); else: var(--__1dacWriteIndex))`,
    `OUT 0x3C8: set DAC write index; 0x3C9: auto-advance on wrap`);
  dispatch.addEntry('dacWriteIndex', 0xEE,
    `if(style(--__1DX: 968): ${al}; style(--__1DX: 969) and style(--__1dacSubIndex: 2): calc(var(--__1dacWriteIndex) + 1); else: var(--__1dacWriteIndex))`,
    `OUT DX=0x3C8: set DAC write index; DX=0x3C9: auto-advance on wrap`);

  // dacSubIndex: OUT 0x3C8 resets to 0. OUT 0x3C9 advances (0→1→2→0).
  dispatch.addEntry('dacSubIndex', 0xE6,
    `if(style(--q1: 968): 0; style(--q1: 969) and style(--__1dacSubIndex: 2): 0; style(--q1: 969): calc(var(--__1dacSubIndex) + 1); else: var(--__1dacSubIndex))`,
    `OUT 0x3C8/0x3C9: DAC sub-index state`);
  dispatch.addEntry('dacSubIndex', 0xEE,
    `if(style(--__1DX: 968): 0; style(--__1DX: 969) and style(--__1dacSubIndex: 2): 0; style(--__1DX: 969): calc(var(--__1dacSubIndex) + 1); else: var(--__1dacSubIndex))`,
    `OUT DX=0x3C8/0x3C9: DAC sub-index state`);

  // OUT 0x3C9 — write a byte to DAC_LINEAR + writeIndex*3 + subIndex.
  // The address expression evaluates to -1 (unused-slot sentinel) on any
  // other opcode/port, so this slot is a no-op outside DAC writes.
  // Also mask AL to 6 bits (0..63) — real VGA hardware truncates the DAC
  // value to 6 bits; programs that write 0..255 get the low 6 bits.
  const dacAddrImm = `if(style(--q1: 969): calc(${DAC_LINEAR} + var(--__1dacWriteIndex) * 3 + var(--__1dacSubIndex)); else: -1)`;
  const dacAddrDx  = `if(style(--__1DX: 969): calc(${DAC_LINEAR} + var(--__1dacWriteIndex) * 3 + var(--__1dacSubIndex)); else: -1)`;
  const dacVal     = `--and(${al}, 63)`;
  dispatch.addMemWrite(0xE6, dacAddrImm, dacVal, `OUT 0x3C9: DAC byte (6-bit)`);
  dispatch.addMemWrite(0xEE, dacAddrDx,  dacVal, `OUT DX=0x3C9: DAC byte (6-bit)`);
}

/**
 * XLAT (0xD7): AL = mem[DS:BX + AL]. Table lookup.
 */
export function emitXLAT(dispatch) {
  dispatch.addEntry('AX', 0xD7,
    `--mergelow(var(--__1AX), var(--_xlatByte))`,
    `XLAT`);
  dispatch.addEntry('IP', 0xD7, `calc(var(--__1IP) + 1)`, `XLAT`);
}

/**
 * INT 3 (0xCC): software breakpoint — hardcoded interrupt 3, 1-byte instruction.
 * Same as INT 0xCD but interrupt number = 3, return IP = IP + 1.
 */
export function emitINT3(dispatch) {
  dispatch.addEntry('SP', 0xCC, `calc(var(--__1SP) - 6)`, `INT 3 (SP-=6)`);

  // Load new IP from IVT[3*4] = IVT[12]
  dispatch.addEntry('IP', 0xCC,
    `--read2(12)`,
    `INT 3 load IP from IVT`);

  // Load new CS from IVT[3*4+2] = IVT[14]
  dispatch.addEntry('CS', 0xCC,
    `--read2(14)`,
    `INT 3 load CS from IVT`);

  // Clear IF (bit 9) and TF (bit 8): flags & 0xFCFF = flags & 64767
  dispatch.addEntry('flags', 0xCC,
    `--and(var(--__1flags), 64767)`,
    `INT 3 clear IF+TF`);

  const ssBase = `calc(var(--__1SS) * 16)`;
  const retIP = `calc(var(--__1IP) + 1)`;

  // Push FLAGS at SP-2/SP-1 (highest address, pushed first)
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INT 3 push FLAGS lo`);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 1)`,
    `--rightShift(var(--__1flags), 8)`,
    `INT 3 push FLAGS hi`);

  // Push CS at SP-4/SP-3
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 4)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INT 3 push CS lo`);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `INT 3 push CS hi`);

  // Push return IP at SP-6/SP-5 (lowest address, pushed last)
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 6)`,
    `--lowerBytes(${retIP}, 8)`,
    `INT 3 push IP lo`);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 5)`,
    `--rightShift(${retIP}, 8)`,
    `INT 3 push IP hi`);
}

/**
 * INTO (0xCE): interrupt on overflow. If OF (bit 11) is set, trigger INT 4.
 * Otherwise just advance IP by 1.
 */
export function emitINTO(dispatch) {
  // OF = bit 11 of flags. Use arithmetic mux since --_of isn't a decode property.
  // ofBit is 0 or 1. Arithmetic: of*trueVal + (1-of)*falseVal
  const ofBit = `--bit(var(--__1flags), 11)`;
  const ssBase = `calc(var(--__1SS) * 16)`;
  const retIP = `calc(var(--__1IP) + 1)`;

  // SP: if OF, SP -= 6; else unchanged
  dispatch.addEntry('SP', 0xCE,
    `calc(var(--__1SP) - ${ofBit} * 6)`,
    `INTO (SP-=6 if OF)`);

  // IP: if OF, load from IVT[16]; else IP + 1
  dispatch.addEntry('IP', 0xCE,
    `calc(${ofBit} * --read2(16) + (1 - ${ofBit}) * (var(--__1IP) + 1))`,
    `INTO load IP`);

  // CS: if OF, load from IVT[18]; else unchanged
  dispatch.addEntry('CS', 0xCE,
    `calc(${ofBit} * --read2(18) + (1 - ${ofBit}) * var(--__1CS))`,
    `INTO load CS`);

  // flags: if OF, clear IF+TF; else unchanged
  dispatch.addEntry('flags', 0xCE,
    `calc(${ofBit} * --and(var(--__1flags), 64767) + (1 - ${ofBit}) * var(--__1flags))`,
    `INTO clear IF+TF if OF`);

  // Memory pushes — addr uses arithmetic mux: of*real_addr + (1-of)*(-1)
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 2) + (1 - ${ofBit}) * (-1))`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INTO push FLAGS lo`);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 1) + (1 - ${ofBit}) * (-1))`,
    `--rightShift(var(--__1flags), 8)`,
    `INTO push FLAGS hi`);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 4) + (1 - ${ofBit}) * (-1))`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INTO push CS lo`);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 3) + (1 - ${ofBit}) * (-1))`,
    `--rightShift(var(--__1CS), 8)`,
    `INTO push CS hi`);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 6) + (1 - ${ofBit}) * (-1))`,
    `--lowerBytes(${retIP}, 8)`,
    `INTO push IP lo`);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 5) + (1 - ${ofBit}) * (-1))`,
    `--rightShift(${retIP}, 8)`,
    `INTO push IP hi`);
}

/**
 * BCD (Binary-Coded Decimal) instructions.
 *
 * AAM (0xD4): ASCII Adjust for Multiply.
 *   Format: 0xD4, imm8 (base, usually 0x0A).
 *   AH = floor(AL / base), AL = AL mod base.
 *   Flags: ZF, SF, PF from new AL. CF=OF=AF left undefined (set to 0).
 *   IP += 2.
 *
 * AAD (0xD5): ASCII Adjust for Division.
 *   Format: 0xD5, imm8 (base, usually 0x0A).
 *   AL = (AH * base + AL) & 0xFF, AH = 0.
 *   Flags: ZF, SF, PF from new AL.
 *   IP += 2.
 *
 * DAA (0x27), DAS (0x2F), AAA (0x37), AAS (0x3F): complex and rarely used.
 *   Implemented as IP-advance-only stubs to prevent crashes.
 */
export function emitBCD(dispatch) {
  // ---- AAM (0xD4) ----
  // q1 holds the imm8 base byte. Guard against divide-by-zero with max(1, ...).
  // new AH = floor(AL / base),  new AL = AL mod base
  // AX = new AH * 256 + new AL
  dispatch.addEntry('AX', 0xD4,
    `calc(round(down, var(--AL) / max(1, var(--q1))) * 256 + mod(var(--AL), max(1, var(--q1))))`,
    `AAM`);
  // Flags from new AL. mod() is a CSS math function (not a CSS @function), so it is
  // safe to pass inline as the argument to --logicFlags8.
  dispatch.addEntry('flags', 0xD4,
    `calc(--logicFlags8(mod(var(--AL), max(1, var(--q1)))) + --and(var(--__1flags), 1808))`,
    `AAM flags`);
  dispatch.addEntry('IP', 0xD4, `calc(var(--__1IP) + 2)`, `AAM`);

  // ---- AAD (0xD5) ----
  // new AL = (AH * base + AL) & 0xFF,  new AH = 0 → AX = new AL
  // We inline --lowerBytes as mod(..., 256) to avoid nesting a CSS @function call.
  dispatch.addEntry('AX', 0xD5,
    `mod(calc(var(--AH) * var(--q1) + var(--AL)), 256)`,
    `AAD`);
  // Flags from new AL (same mod expression — pure CSS math, safe as argument).
  dispatch.addEntry('flags', 0xD5,
    `calc(--logicFlags8(mod(calc(var(--AH) * var(--q1) + var(--AL)), 256)) + --and(var(--__1flags), 1808))`,
    `AAD flags`);
  dispatch.addEntry('IP', 0xD5, `calc(var(--__1IP) + 2)`, `AAD`);

  // ---- BCD helpers (all pure CSS math — no @function nesting) ----
  // CF = bit 0 of flags = mod(flags, 2)
  // AF = bit 4 of flags = mod(round(down, flags / 16), 2)
  // lowerBytes(x, 8) = mod(x + 256, 256) — the +256 guards against negative
  // mergelow(old, new) = round(down, old / 256) * 256 + new

  // ---- AAA (0x37): ASCII Adjust after Addition ----
  // If low nibble of AL > 9 or AF: AL += 6, AH += 1, CF=AF=1. Then AL &= 0x0F.
  dispatch.addEntry('AX', 0x37, (() => {
    const lowNib = `mod(var(--AL), 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const adj = `min(1, calc(${nibGt9} + ${af}))`;
    const newAL = `mod(calc(var(--AL) + ${adj} * 6), 16)`;
    const newAH = `mod(calc(var(--AH) + ${adj} + 256), 256)`;
    return `calc(${newAH} * 256 + ${newAL})`;
  })(), `AAA`);
  dispatch.addEntry('flags', 0x37, (() => {
    const lowNib = `mod(var(--AL), 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const adj = `min(1, calc(${nibGt9} + ${af}))`;
    const newAL = `mod(calc(var(--AL) + ${adj} * 6), 16)`;
    return `calc(--logicFlags8(${newAL}) + ${adj} + ${adj} * 16 + --and(var(--__1flags), 1792))`;
  })(), `AAA flags`);
  dispatch.addEntry('IP', 0x37, `calc(var(--__1IP) + 1)`, `AAA`);

  // ---- AAS (0x3F): ASCII Adjust after Subtraction ----
  dispatch.addEntry('AX', 0x3F, (() => {
    const lowNib = `mod(var(--AL), 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const adj = `min(1, calc(${nibGt9} + ${af}))`;
    const newAL = `mod(calc(var(--AL) - ${adj} * 6 + 16), 16)`;
    const newAH = `mod(calc(var(--AH) - ${adj} + 256), 256)`;
    return `calc(${newAH} * 256 + ${newAL})`;
  })(), `AAS`);
  dispatch.addEntry('flags', 0x3F, (() => {
    const lowNib = `mod(var(--AL), 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const adj = `min(1, calc(${nibGt9} + ${af}))`;
    const newAL = `mod(calc(var(--AL) - ${adj} * 6 + 16), 16)`;
    return `calc(--logicFlags8(${newAL}) + ${adj} + ${adj} * 16 + --and(var(--__1flags), 1792))`;
  })(), `AAS flags`);
  dispatch.addEntry('IP', 0x3F, `calc(var(--__1IP) + 1)`, `AAS`);

  // ---- DAA (0x27): Decimal Adjust after Addition ----
  // Phase 1: if (AL & 0xF) > 9 or AF: AL += 6
  // Phase 2: if oldAL > 0x99 or oldCF: AL += 0x60
  // newAL = (oldAL + adj1 + adj2) & 0xFF
  dispatch.addEntry('AX', 0x27, (() => {
    const oldAL = `var(--AL)`;
    const lowNib = `mod(${oldAL}, 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const cond1 = `min(1, calc(${nibGt9} + ${af}))`;
    const adj1 = `calc(${cond1} * 6)`;

    const oldCF = `mod(var(--__1flags), 2)`;
    const gt99 = `round(down, ${oldAL} / 154)`;
    const cond2 = `min(1, calc(${gt99} + ${oldCF}))`;
    const adj2 = `calc(${cond2} * 96)`;

    // newAL = mod(oldAL + adj1 + adj2, 256), merge into AX preserving AH
    const newAL = `mod(calc(${oldAL} + ${adj1} + ${adj2}), 256)`;
    return `calc(round(down, var(--__1AX) / 256) * 256 + ${newAL})`;
  })(), `DAA`);
  dispatch.addEntry('flags', 0x27, (() => {
    const oldAL = `var(--AL)`;
    const lowNib = `mod(${oldAL}, 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const cond1 = `min(1, calc(${nibGt9} + ${af}))`;
    const adj1 = `calc(${cond1} * 6)`;

    const oldCF = `mod(var(--__1flags), 2)`;
    const gt99 = `round(down, ${oldAL} / 154)`;
    const cond2 = `min(1, calc(${gt99} + ${oldCF}))`;
    const adj2 = `calc(${cond2} * 96)`;

    const newAL = `mod(calc(${oldAL} + ${adj1} + ${adj2}), 256)`;
    return `calc(--logicFlags8(${newAL}) + ${cond2} + ${cond1} * 16 + --and(var(--__1flags), 1792))`;
  })(), `DAA flags`);
  dispatch.addEntry('IP', 0x27, `calc(var(--__1IP) + 1)`, `DAA`);

  // ---- DAS (0x2F): Decimal Adjust after Subtraction ----
  // Phase 1: if (AL & 0xF) > 9 or AF: AL -= 6
  // Phase 2: if oldAL > 0x99 or oldCF: AL -= 0x60
  dispatch.addEntry('AX', 0x2F, (() => {
    const oldAL = `var(--AL)`;
    const lowNib = `mod(${oldAL}, 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const cond1 = `min(1, calc(${nibGt9} + ${af}))`;
    const adj1 = `calc(${cond1} * 6)`;

    const oldCF = `mod(var(--__1flags), 2)`;
    const gt99 = `round(down, ${oldAL} / 154)`;
    const cond2 = `min(1, calc(${gt99} + ${oldCF}))`;
    const adj2 = `calc(${cond2} * 96)`;

    // +256 to avoid negative before mod
    const newAL = `mod(calc(${oldAL} - ${adj1} - ${adj2} + 256), 256)`;
    return `calc(round(down, var(--__1AX) / 256) * 256 + ${newAL})`;
  })(), `DAS`);
  dispatch.addEntry('flags', 0x2F, (() => {
    const oldAL = `var(--AL)`;
    const lowNib = `mod(${oldAL}, 16)`;
    const nibGt9 = `round(down, ${lowNib} / 10)`;
    const af = `mod(round(down, var(--__1flags) / 16), 2)`;
    const cond1 = `min(1, calc(${nibGt9} + ${af}))`;
    const adj1 = `calc(${cond1} * 6)`;

    const oldCF = `mod(var(--__1flags), 2)`;
    const gt99 = `round(down, ${oldAL} / 154)`;
    const cond2 = `min(1, calc(${gt99} + ${oldCF}))`;
    const adj2 = `calc(${cond2} * 96)`;

    const newAL = `mod(calc(${oldAL} - ${adj1} - ${adj2} + 256), 256)`;
    return `calc(--logicFlags8(${newAL}) + ${cond2} + ${cond1} * 16 + --and(var(--__1flags), 1792))`;
  })(), `DAS flags`);
  dispatch.addEntry('IP', 0x2F, `calc(var(--__1IP) + 1)`, `DAS`);
}

/**
 * WAIT (0x9B), ESC (0xD8-0xDF), LOCK (0xF0): no-op stubs.
 * WAIT: FPU sync — no FPU, so just advance IP.
 * ESC: FPU escape — needs ModR/M decode (skip operand bytes), no operation.
 * LOCK: bus lock prefix — meaningless in single-threaded CSS, advance IP.
 */
export function emitNopStubs(dispatch) {
  // WAIT (0x9B): 1-byte, no-op
  dispatch.addEntry('IP', 0x9B, `calc(var(--__1IP) + 1)`, `WAIT`);

  // LOCK (0xF0): 1-byte prefix, treated as no-op
  dispatch.addEntry('IP', 0xF0, `calc(var(--__1IP) + 1)`, `LOCK`);

  // ESC 0-7 (0xD8-0xDF): has ModR/M byte, so IP += 2 + modrmExtra
  for (let i = 0; i < 8; i++) {
    dispatch.addEntry('IP', 0xD8 + i,
      `calc(var(--__1IP) + 2 + var(--modrmExtra))`,
      `ESC ${i}`);
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
  emitMOVS(dispatch);
  emitCMPS(dispatch);
  emitSCAS(dispatch);
  emitMOV_RMimm(dispatch);
  emitFlagManip(dispatch);
  emitCBW_CWD(dispatch);
  emitXCHG_AXreg(dispatch);
  emitXCHG_RM(dispatch);
  emitPOP_RM(dispatch);
  emitLAHF_SAHF(dispatch);
  emitIO(dispatch);
  emitXLAT(dispatch);
  emitINT3(dispatch);
  emitINTO(dispatch);
  emitBCD(dispatch);
  emitNopStubs(dispatch);
}
