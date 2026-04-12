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
    `MOV r/m16, imm16 → mem lo`, 0);
  dispatch.addMemWrite(0xC7,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(var(--immWord), 8)`,
    `MOV r/m16, imm16 → mem hi`, 1);
  dispatch.addEntry('IP', 0xC7,
    `if(style(--mod: 3): calc(var(--__1IP) + 2 + var(--modrmExtra) + 2); else: var(--__1IP))`,
    `MOV r/m16, imm16 IP`, 0);
  dispatch.addEntry('IP', 0xC7,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + 2)`,
    `MOV r/m16, imm16 retire`, 1);
  dispatch.setUopAdvance(0xC7,
    `if(style(--mod: 3): 0; style(--__1uOp: 0): 1; else: 0)`);

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
  // 2 μops: μop 0 writes lo, μop 1 writes hi + adjusts DI + retires
  dispatch.addMemWrite(0xAB,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--AL)`,
    `STOSW lo`, 0);
  dispatch.addMemWrite(0xAB,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI) + 1)`),
    `var(--AH)`,
    `STOSW hi`, 1);
  dispatch.addEntry('DI', 0xAB,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `STOSW DI adjust`, 1);
  dispatch.addEntry('CX', 0xAB, repCX(), `REP STOSW CX`, 1);
  dispatch.addEntry('IP', 0xAB, repIP(), `STOSW`, 1);
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

  // MOVSW: copy word (2 μops)
  dispatch.addMemWrite(0xA5,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI))`),
    `var(--_strSrcByte)`,
    `MOVSW lo`, 0);
  dispatch.addMemWrite(0xA5,
    repGuardAddr(`calc(var(--__1ES) * 16 + var(--__1DI) + 1)`),
    `var(--_strSrcHiByte)`,
    `MOVSW hi`, 1);
  dispatch.addEntry('SI', 0xA5,
    repGuardReg(`--lowerBytes(calc(var(--__1SI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1SI)`),
    `MOVSW SI adjust`, 1);
  dispatch.addEntry('DI', 0xA5,
    repGuardReg(`--lowerBytes(calc(var(--__1DI) + 2 - --bit(var(--__1flags), 10) * 4), 16)`, `var(--__1DI)`),
    `MOVSW DI adjust`, 1);
  dispatch.addEntry('CX', 0xA5, repCX(), `REP MOVSW CX`, 1);
  dispatch.addEntry('IP', 0xA5, repIP(), `MOVSW`, 1);
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
  // Memory write: when mod!=3, write regVal16 to EA (2 μops)
  dispatch.addMemWrite(0x87,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `--lowerBytes(var(--regVal16), 8)`,
    `XCHG r/m16 → mem lo`, 0);
  dispatch.addMemWrite(0x87,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(var(--regVal16), 8)`,
    `XCHG r/m16 → mem hi`, 1);
  dispatch.addEntry('IP', 0x87,
    `if(style(--mod: 3): calc(var(--__1IP) + 2 + var(--modrmExtra)); else: var(--__1IP))`,
    `XCHG r/m16 IP`, 0);
  dispatch.addEntry('IP', 0x87,
    `calc(var(--__1IP) + 2 + var(--modrmExtra))`,
    `XCHG r/m16 retire`, 1);
  dispatch.setUopAdvance(0x87,
    `if(style(--mod: 3): 0; style(--__1uOp: 0): 1; else: 0)`);

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

  // Memory write: when mod!=3, write popped value to EA (2 μops)
  dispatch.addMemWrite(0x8F,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `--lowerBytes(--read2(calc(var(--__1SS) * 16 + var(--__1SP))), 8)`,
    `POP r/m16 → mem lo`, 0);
  dispatch.addMemWrite(0x8F,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--rightShift(--read2(calc(var(--__1SS) * 16 + var(--__1SP))), 8)`,
    `POP r/m16 → mem hi`, 1);
  dispatch.addEntry('IP', 0x8F,
    `if(style(--mod: 3): calc(var(--__1IP) + 2 + var(--modrmExtra)); else: var(--__1IP))`,
    `POP r/m16 IP`, 0);
  dispatch.addEntry('IP', 0x8F,
    `calc(var(--__1IP) + 2 + var(--modrmExtra))`,
    `POP r/m16 retire`, 1);
  dispatch.setUopAdvance(0x8F,
    `if(style(--mod: 3): 0; style(--__1uOp: 0): 1; else: 0)`);
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
 * I/O port instructions: IN and OUT.
 *
 * Most ports have no hardware — IN returns 0 and OUT is a no-op.
 * Exception: port 0x60 (keyboard scancode) reads the low byte of --keyboard
 * (the scancode), enabling games that poll the keyboard controller directly.
 *
 * IN AL, imm8  (0xE4): 2-byte, port in q1. Returns scancode if port=0x60.
 * IN AX, imm8  (0xE5): 2-byte, port in q1. Returns keyboard word if port=0x60.
 * OUT imm8, AL (0xE6): 2-byte, no-op.
 * OUT imm8, AX (0xE7): 2-byte, no-op.
 * IN AL, DX   (0xEC): 1-byte, port in DX. Returns scancode if DX=0x60.
 * IN AX, DX   (0xED): 1-byte, port in DX. Returns keyboard word if DX=0x60.
 * OUT DX, AL  (0xEE): 1-byte, no-op.
 * OUT DX, AX  (0xEF): 1-byte, no-op.
 */
export function emitIO(dispatch) {
  // IN AL, imm8 (0xE4): port number is q1 (byte after opcode)
  // Port 0x60 → scancode = rightShift(keyboard, 8)
  dispatch.addEntry('AX', 0xE4,
    `--mergelow(var(--__1AX), if(style(--q1: 96): --rightShift(var(--__1keyboard), 8); else: 0))`,
    `IN AL, imm8 (port 0x60=scancode)`);
  dispatch.addEntry('IP', 0xE4, `calc(var(--__1IP) + 2)`, `IN AL, imm8`);

  // IN AX, imm8 (0xE5): port 0x60 → full keyboard word
  dispatch.addEntry('AX', 0xE5,
    `if(style(--q1: 96): var(--__1keyboard); else: 0)`,
    `IN AX, imm8 (port 0x60=keyboard)`);
  dispatch.addEntry('IP', 0xE5, `calc(var(--__1IP) + 2)`, `IN AX, imm8`);

  dispatch.addEntry('IP', 0xE6, `calc(var(--__1IP) + 2)`, `OUT imm8, AL`);
  dispatch.addEntry('IP', 0xE7, `calc(var(--__1IP) + 2)`, `OUT imm8, AX`);

  // IN AL, DX (0xEC): port number is in DX register
  // DX=0x60 (96 decimal) → scancode = rightShift(keyboard, 8)
  dispatch.addEntry('AX', 0xEC,
    `--mergelow(var(--__1AX), if(style(--__1DX: 96): --rightShift(var(--__1keyboard), 8); else: 0))`,
    `IN AL, DX (port 0x60=scancode)`);
  dispatch.addEntry('IP', 0xEC, `calc(var(--__1IP) + 1)`, `IN AL, DX`);

  // IN AX, DX (0xED): port 0x60 → full keyboard word
  dispatch.addEntry('AX', 0xED,
    `if(style(--__1DX: 96): var(--__1keyboard); else: 0)`,
    `IN AX, DX (port 0x60=keyboard)`);
  dispatch.addEntry('IP', 0xED, `calc(var(--__1IP) + 1)`, `IN AX, DX`);

  dispatch.addEntry('IP', 0xEE, `calc(var(--__1IP) + 1)`, `OUT DX, AL`);
  dispatch.addEntry('IP', 0xEF, `calc(var(--__1IP) + 1)`, `OUT DX, AX`);
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
  // INT 3 (0xCC): same 6-μop structure as INT 0xCD, but intNum=3, retIP=IP+1
  const ssBase = `var(--__1SS) * 16`;

  dispatch.addEntry('SP', 0xCC, `calc(var(--__1SP) - 6)`, `INT 3 (SP-=6)`, 0);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INT 3 push FLAGS lo`, 0);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) + 5)`,
    `--rightShift(var(--__1flags), 8)`,
    `INT 3 push FLAGS hi`, 1);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) + 2)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INT 3 push CS lo`, 2);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) + 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `INT 3 push CS hi`, 3);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP))`,
    `--lowerBytes(calc(var(--__1IP) + 1), 8)`,
    `INT 3 push IP lo`, 4);
  dispatch.addMemWrite(0xCC,
    `calc(${ssBase} + var(--__1SP) + 1)`,
    `--rightShift(calc(var(--__1IP) + 1), 8)`,
    `INT 3 push IP hi`, 5);
  dispatch.addEntry('IP', 0xCC, `--read2(12)`, `INT 3 load IP from IVT`, 5);
  dispatch.addEntry('CS', 0xCC, `--read2(14)`, `INT 3 load CS from IVT`, 5);
  dispatch.addEntry('flags', 0xCC, `--and(var(--__1flags), 64767)`, `INT 3 clear IF+TF`, 5);
}

/**
 * INTO (0xCE): interrupt on overflow. If OF (bit 11) is set, trigger INT 4.
 * Otherwise just advance IP by 1.
 */
export function emitINTO(dispatch) {
  // INTO (0xCE): if OF=1, fire INT 4 (6 μops). If OF=0, single-cycle (IP+=1).
  // Use custom uOp advance: if OF=0, always retire. If OF=1, 6-μop sequence.
  const ssBase = `var(--__1SS) * 16`;
  const ofBit = `--bit(var(--__1flags), 11)`;

  // μop 0: SP -= 6 (if OF), write FLAGS lo (if OF)
  dispatch.addEntry('SP', 0xCE,
    `calc(var(--__1SP) - ${ofBit} * 6)`,
    `INTO (SP-=6 if OF)`, 0);
  dispatch.addMemWrite(0xCE,
    `calc(${ofBit} * (${ssBase} + var(--__1SP) - 2) + (1 - ${ofBit}) * (-1))`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INTO push FLAGS lo`, 0);
  // μop 0 IP: advance if OF=0 (single-cycle)
  dispatch.addEntry('IP', 0xCE,
    `calc(var(--__1IP) + (1 - ${ofBit}))`,
    `INTO IP μop0`, 0);

  dispatch.addMemWrite(0xCE,
    `calc(${ssBase} + var(--__1SP) + 5)`,
    `--rightShift(var(--__1flags), 8)`,
    `INTO push FLAGS hi`, 1);
  dispatch.addMemWrite(0xCE,
    `calc(${ssBase} + var(--__1SP) + 2)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INTO push CS lo`, 2);
  dispatch.addMemWrite(0xCE,
    `calc(${ssBase} + var(--__1SP) + 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `INTO push CS hi`, 3);
  dispatch.addMemWrite(0xCE,
    `calc(${ssBase} + var(--__1SP))`,
    `--lowerBytes(calc(var(--__1IP) + 1), 8)`,
    `INTO push IP lo`, 4);
  dispatch.addMemWrite(0xCE,
    `calc(${ssBase} + var(--__1SP) + 1)`,
    `--rightShift(calc(var(--__1IP) + 1), 8)`,
    `INTO push IP hi`, 5);
  dispatch.addEntry('IP', 0xCE, `--read2(16)`, `INTO load IP from IVT`, 5);
  dispatch.addEntry('CS', 0xCE, `--read2(18)`, `INTO load CS from IVT`, 5);
  dispatch.addEntry('flags', 0xCE, `--and(var(--__1flags), 64767)`, `INTO clear IF+TF`, 5);

  // Custom uOp advance: OF=0 → always retire; OF=1 → 0→1→2→3→4→5→0
  // On μop 0, OF is in --__1flags. We use --bit(var(--__1flags), 11).
  // Problem: on μops 1-5, --__1flags hasn't changed (flags only cleared on μop 5).
  // So OF is still 1 on all μops. The advance: if OF=0 → 0; else standard chain.
  dispatch.setUopAdvance(0xCE,
    `if(` +
    `style(--__1uOp: 0): calc(${ofBit} * 1); ` +
    `style(--__1uOp: 1): 2; ` +
    `style(--__1uOp: 2): 3; ` +
    `style(--__1uOp: 3): 4; ` +
    `style(--__1uOp: 4): 5; ` +
    `else: 0)`);
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
