// ALU instruction emitters: ADD, ADC, SUB, SBB, AND, OR, XOR, CMP, TEST
// All standard ALU ops follow the same 6-opcode pattern:
//   base+0: r/m8, reg8    (d=0, w=0)
//   base+1: r/m16, reg16  (d=0, w=1)
//   base+2: reg8, r/m8    (d=1, w=0)
//   base+3: reg16, r/m16  (d=1, w=1)
//   base+4: AL, imm8
//   base+5: AX, imm16

const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const SPLIT_REGS = [
  { reg: 'AX', lowIdx: 0, highIdx: 4 },
  { reg: 'CX', lowIdx: 1, highIdx: 5 },
  { reg: 'DX', lowIdx: 2, highIdx: 6 },
  { reg: 'BX', lowIdx: 3, highIdx: 7 },
];

/**
 * ALU operation definitions.
 * resultExpr: CSS expression for the result given dst and src operands.
 * flagsFn8/16: CSS function call for flag computation.
 * writesResult: whether the result is written back (false for CMP/TEST).
 */
const ALU_OPS = {
  ADD: {
    base: 0x00,
    resultExpr16: (dst, src) => `--lowerBytes(calc(${dst} + ${src}), 16)`,
    resultExpr8:  (dst, src) => `--lowerBytes(calc(${dst} + ${src}), 8)`,
    // 1792 = 0x700 = TF|IF|DF preserved from previous tick
    flagsFn16: (dst, src) => `calc(--addFlags16(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    flagsFn8:  (dst, src) => `calc(--addFlags8(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    writesResult: true,
  },
  OR: {
    base: 0x08,
    resultExpr16: (dst, src) => `--or(${dst}, ${src})`,
    resultExpr8:  (dst, src) => `--or8(${dst}, ${src})`,
    // 1808 = 0x710 = TF|IF|DF|AF preserved (AF undefined for logic ops)
    flagsFn16: (dst, src) => `calc(--orFlags16(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    flagsFn8:  (dst, src) => `calc(--orFlags8(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    writesResult: true,
  },
  ADC: {
    base: 0x10,
    resultExpr16: (dst, src) => `--lowerBytes(calc(${dst} + ${src} + var(--_cf)), 16)`,
    resultExpr8:  (dst, src) => `--lowerBytes(calc(${dst} + ${src} + var(--_cf)), 8)`,
    flagsFn16: (dst, src) => `calc(--adcFlags16(${dst}, ${src}, var(--_cf)) + --and(var(--__1flags), 1792))`,
    flagsFn8:  (dst, src) => `calc(--adcFlags8(${dst}, ${src}, var(--_cf)) + --and(var(--__1flags), 1792))`,
    writesResult: true,
  },
  SBB: {
    base: 0x18,
    resultExpr16: (dst, src) => `--lowerBytes(calc(${dst} - ${src} - var(--_cf) + 65536), 16)`,
    resultExpr8:  (dst, src) => `--lowerBytes(calc(${dst} - ${src} - var(--_cf) + 256), 8)`,
    flagsFn16: (dst, src) => `calc(--sbbFlags16(${dst}, ${src}, var(--_cf)) + --and(var(--__1flags), 1792))`,
    flagsFn8:  (dst, src) => `calc(--sbbFlags8(${dst}, ${src}, var(--_cf)) + --and(var(--__1flags), 1792))`,
    writesResult: true,
  },
  AND: {
    base: 0x20,
    resultExpr16: (dst, src) => `--and(${dst}, ${src})`,
    resultExpr8:  (dst, src) => `--and8(${dst}, ${src})`,
    flagsFn16: (dst, src) => `calc(--andFlags16(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    flagsFn8:  (dst, src) => `calc(--andFlags8(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    writesResult: true,
  },
  SUB: {
    base: 0x28,
    resultExpr16: (dst, src) => `--lowerBytes(calc(${dst} - ${src} + 65536), 16)`,
    resultExpr8:  (dst, src) => `--lowerBytes(calc(${dst} - ${src} + 256), 8)`,
    flagsFn16: (dst, src) => `calc(--subFlags16(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    flagsFn8:  (dst, src) => `calc(--subFlags8(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    writesResult: true,
  },
  XOR: {
    base: 0x30,
    resultExpr16: (dst, src) => `--xor(${dst}, ${src})`,
    resultExpr8:  (dst, src) => `--xor8(${dst}, ${src})`,
    flagsFn16: (dst, src) => `calc(--xorFlags16(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    flagsFn8:  (dst, src) => `calc(--xorFlags8(${dst}, ${src}) + --and(var(--__1flags), 1808))`,
    writesResult: true,
  },
  CMP: {
    base: 0x38,
    resultExpr16: null, // no writeback
    resultExpr8: null,
    flagsFn16: (dst, src) => `calc(--subFlags16(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    flagsFn8:  (dst, src) => `calc(--subFlags8(${dst}, ${src}) + --and(var(--__1flags), 1792))`,
    writesResult: false,
  },
};

/**
 * Emit all 6 opcodes for a standard ALU operation.
 */
function emitALU(dispatch, op) {
  const { base, resultExpr16, resultExpr8, flagsFn16, flagsFn8, writesResult } = ALU_OPS[op];

  // --- base+1: r/m16, reg16 (d=0, w=1) ---
  const op1 = base + 1;
  if (writesResult) {
    const res16 = resultExpr16('var(--rmVal16)', 'var(--regVal16)');
    // Register destination (mod=11)
    for (let r = 0; r < 8; r++) {
      dispatch.addEntry(REG16[r], op1,
        `if(style(--mod: 3) and style(--rm: ${r}): ${res16}; else: var(--__1${REG16[r]}))`,
        `${op} r/m16, reg16 → ${REG16[r]}`);
    }
    // Memory write (word)
    dispatch.addMemWrite(op1,
      `if(style(--mod: 3): -1; else: var(--ea))`,
      `--lowerBytes(${res16}, 8)`,
      `${op} r/m16, reg16 → mem lo`);
    dispatch.addMemWrite(op1,
      `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
      `--rightShift(${res16}, 8)`,
      `${op} r/m16, reg16 → mem hi`);
  }
  dispatch.addEntry('IP', op1, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `${op} r/m16, reg16`);
  dispatch.addEntry('flags', op1, flagsFn16('var(--rmVal16)', 'var(--regVal16)'), `${op} r/m16, reg16 flags`);

  // --- base+0: r/m8, reg8 (d=0, w=0) ---
  const op0 = base;
  if (writesResult) {
    const res8 = resultExpr8('var(--rmVal8)', 'var(--regVal8)');
    // Register destination (mod=11): rm selects 8-bit register
    for (const { reg, lowIdx, highIdx } of SPLIT_REGS) {
      dispatch.addEntry(reg, op0,
        `if(style(--mod: 3) and style(--rm: ${lowIdx}): --mergelow(var(--__1${reg}), ${res8}); ` +
        `style(--mod: 3) and style(--rm: ${highIdx}): --mergehigh(var(--__1${reg}), ${res8}); ` +
        `else: var(--__1${reg}))`,
        `${op} r/m8, reg8 → ${reg}`);
    }
    // Memory write (byte)
    dispatch.addMemWrite(op0,
      `if(style(--mod: 3): -1; else: var(--ea))`,
      res8,
      `${op} r/m8, reg8 → mem`);
  }
  dispatch.addEntry('IP', op0, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `${op} r/m8, reg8`);
  dispatch.addEntry('flags', op0, flagsFn8('var(--rmVal8)', 'var(--regVal8)'), `${op} r/m8, reg8 flags`);

  // --- base+3: reg16, r/m16 (d=1, w=1) ---
  const op3 = base + 3;
  if (writesResult) {
    const res16d1 = resultExpr16('var(--regVal16)', 'var(--rmVal16)');
    for (let r = 0; r < 8; r++) {
      dispatch.addEntry(REG16[r], op3,
        `if(style(--reg: ${r}): ${res16d1}; else: var(--__1${REG16[r]}))`,
        `${op} reg16, r/m16 → ${REG16[r]}`);
    }
  }
  dispatch.addEntry('IP', op3, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `${op} reg16, r/m16`);
  dispatch.addEntry('flags', op3, flagsFn16('var(--regVal16)', 'var(--rmVal16)'), `${op} reg16, r/m16 flags`);

  // --- base+2: reg8, r/m8 (d=1, w=0) ---
  const op2 = base + 2;
  if (writesResult) {
    const res8d1 = resultExpr8('var(--regVal8)', 'var(--rmVal8)');
    for (const { reg, lowIdx, highIdx } of SPLIT_REGS) {
      dispatch.addEntry(reg, op2,
        `if(style(--reg: ${lowIdx}): --mergelow(var(--__1${reg}), ${res8d1}); ` +
        `style(--reg: ${highIdx}): --mergehigh(var(--__1${reg}), ${res8d1}); ` +
        `else: var(--__1${reg}))`,
        `${op} reg8, r/m8 → ${reg}`);
    }
  }
  dispatch.addEntry('IP', op2, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `${op} reg8, r/m8`);
  dispatch.addEntry('flags', op2, flagsFn8('var(--regVal8)', 'var(--rmVal8)'), `${op} reg8, r/m8 flags`);

  // --- base+5: AX, imm16 ---
  const op5 = base + 5;
  if (writesResult) {
    dispatch.addEntry('AX', op5,
      resultExpr16('var(--__1AX)', 'var(--imm16)'),
      `${op} AX, imm16`);
  }
  dispatch.addEntry('IP', op5, `calc(var(--__1IP) + 3)`, `${op} AX, imm16`);
  dispatch.addEntry('flags', op5, flagsFn16('var(--__1AX)', 'var(--imm16)'), `${op} AX, imm16 flags`);

  // --- base+4: AL, imm8 ---
  const op4 = base + 4;
  if (writesResult) {
    const res8imm = resultExpr8('var(--AL)', 'var(--imm8)');
    dispatch.addEntry('AX', op4,
      `--mergelow(var(--__1AX), ${res8imm})`,
      `${op} AL, imm8`);
  }
  dispatch.addEntry('IP', op4, `calc(var(--__1IP) + 2)`, `${op} AL, imm8`);
  dispatch.addEntry('flags', op4, flagsFn8('var(--AL)', 'var(--imm8)'), `${op} AL, imm8 flags`);
}

/**
 * TEST r/m, reg (0x84-0x85) — special case, only 2 opcodes, no d bit
 */
function emitTEST_rm_reg(dispatch) {
  // 0x85: TEST r/m16, reg16
  dispatch.addEntry('IP', 0x85, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `TEST r/m16, reg16`);
  dispatch.addEntry('flags', 0x85, `calc(--andFlags16(var(--rmVal16), var(--regVal16)) + --and(var(--__1flags), 1808))`, `TEST r/m16, reg16`);

  // 0x84: TEST r/m8, reg8
  dispatch.addEntry('IP', 0x84, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `TEST r/m8, reg8`);
  dispatch.addEntry('flags', 0x84, `calc(--andFlags8(var(--rmVal8), var(--regVal8)) + --and(var(--__1flags), 1808))`, `TEST r/m8, reg8`);
}

/**
 * TEST AL/AX, imm (0xA8-0xA9)
 */
function emitTEST_acc_imm(dispatch) {
  // 0xA9: TEST AX, imm16
  dispatch.addEntry('IP', 0xA9, `calc(var(--__1IP) + 3)`, `TEST AX, imm16`);
  dispatch.addEntry('flags', 0xA9, `calc(--andFlags16(var(--__1AX), var(--imm16)) + --and(var(--__1flags), 1808))`, `TEST AX, imm16`);

  // 0xA8: TEST AL, imm8
  dispatch.addEntry('IP', 0xA8, `calc(var(--__1IP) + 2)`, `TEST AL, imm8`);
  dispatch.addEntry('flags', 0xA8, `calc(--andFlags8(var(--AL), var(--imm8)) + --and(var(--__1flags), 1808))`, `TEST AL, imm8`);
}

/**
 * INC reg16 (0x40-0x47)
 * Preserves CF! Only sets PF, AF, ZF, SF, OF.
 */
function emitINC(dispatch) {
  for (let r = 0; r < 8; r++) {
    const opcode = 0x40 + r;
    dispatch.addEntry(REG16[r], opcode,
      `--lowerBytes(calc(var(--__1${REG16[r]}) + 1), 16)`,
      `INC ${REG16[r]}`);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `INC ${REG16[r]}`);
    dispatch.addEntry('flags', opcode,
      `--incFlags16(var(--__1${REG16[r]}), --lowerBytes(calc(var(--__1${REG16[r]}) + 1), 16), var(--__1flags))`,
      `INC ${REG16[r]} flags`);
  }
}

/**
 * DEC reg16 (0x48-0x4F)
 * Preserves CF! Only sets PF, AF, ZF, SF, OF.
 */
function emitDEC(dispatch) {
  for (let r = 0; r < 8; r++) {
    const opcode = 0x48 + r;
    dispatch.addEntry(REG16[r], opcode,
      `--lowerBytes(calc(var(--__1${REG16[r]}) - 1 + 65536), 16)`,
      `DEC ${REG16[r]}`);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `DEC ${REG16[r]}`);
    dispatch.addEntry('flags', opcode,
      `--decFlags16(var(--__1${REG16[r]}), --lowerBytes(calc(var(--__1${REG16[r]}) - 1 + 65536), 16), var(--__1flags))`,
      `DEC ${REG16[r]} flags`);
  }
}

/**
 * Register all ALU-related opcodes.
 */
export function emitAllALU(dispatch) {
  for (const op of Object.keys(ALU_OPS)) {
    emitALU(dispatch, op);
  }
  emitTEST_rm_reg(dispatch);
  emitTEST_acc_imm(dispatch);
  emitINC(dispatch);
  emitDEC(dispatch);
}
