// Shift and rotate instructions: 0xD0-0xD3 (shift by 1/CL)
// reg field selects operation:
// 0=ROL, 1=ROR, 2=RCL, 3=RCR, 4=SHL/SAL, 5=SHR, 6=-(unused), 7=SAR

const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const SPLIT_REGS = [
  { reg: 'AX', lowIdx: 0, highIdx: 4 },
  { reg: 'CX', lowIdx: 1, highIdx: 5 },
  { reg: 'DX', lowIdx: 2, highIdx: 6 },
  { reg: 'BX', lowIdx: 3, highIdx: 7 },
];

/**
 * Group 0xD1: shift/rotate r/m16 by 1
 * This is the most common variant (SHL AX,1 etc.)
 */
export function emitShift_D1(dispatch) {
  // SHL (reg=4): result = rm << 1, CF = old bit 15
  // SHR (reg=5): result = rm >> 1, CF = old bit 0
  // SAR (reg=7): result = rm >> 1 (signed), CF = old bit 0
  // ROL (reg=0): result = (rm << 1) | (rm >> 15), CF = new bit 0
  // ROR (reg=1): result = (rm >> 1) | (rm << 15), CF = new bit 15
  // For now implement SHL, SHR, SAR (most commonly used)

  for (let r = 0; r < 8; r++) {
    const regName = REG16[r];
    dispatch.addEntry(regName, 0xD1,
      `if(` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 4): --lowerBytes(calc(var(--rmVal16) * 2), 16); ` +  // SHL
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 5): round(down, var(--rmVal16) / 2); ` +  // SHR
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 7): calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 15) * 32768); ` +  // SAR
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 0): --lowerBytes(calc(var(--rmVal16) * 2 + --bit(var(--rmVal16), 15)), 16); ` +  // ROL
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 1): calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 0) * 32768); ` +  // ROR
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 2): --lowerBytes(calc(var(--rmVal16) * 2 + var(--_cf)), 16); ` +  // RCL
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 3): calc(round(down, var(--rmVal16) / 2) + var(--_cf) * 32768); ` +  // RCR
      `else: var(--__1${regName}))`,
      `Shift D1 → ${regName}`);
  }

  // Memory write: if mod!=3, 2 μops for 16-bit write
  dispatch.addMemWrite(0xD1,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `if(` +
    `style(--reg: 4): --lowerBytes(calc(var(--rmVal16) * 2), 8); ` +
    `style(--reg: 5): --lowerBytes(round(down, var(--rmVal16) / 2), 8); ` +
    `style(--reg: 7): --lowerBytes(calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 15) * 32768), 8); ` +
    `style(--reg: 0): --lowerBytes(calc(var(--rmVal16) * 2 + --bit(var(--rmVal16), 15)), 8); ` +
    `style(--reg: 1): --lowerBytes(calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 0) * 32768), 8); ` +
    `style(--reg: 2): --lowerBytes(calc(var(--rmVal16) * 2 + var(--_cf)), 8); ` +
    `style(--reg: 3): --lowerBytes(calc(round(down, var(--rmVal16) / 2) + var(--_cf) * 32768), 8); ` +
    `else: 0)`,
    `Shift D1 → mem lo`, 0);
  dispatch.addMemWrite(0xD1,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `if(` +
    `style(--reg: 4): --rightShift(--lowerBytes(calc(var(--rmVal16) * 2), 16), 8); ` +
    `style(--reg: 5): --rightShift(round(down, var(--rmVal16) / 2), 8); ` +
    `style(--reg: 7): --rightShift(calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 15) * 32768), 8); ` +
    `style(--reg: 0): --rightShift(--lowerBytes(calc(var(--rmVal16) * 2 + --bit(var(--rmVal16), 15)), 16), 8); ` +
    `style(--reg: 1): --rightShift(calc(round(down, var(--rmVal16) / 2) + --bit(var(--rmVal16), 0) * 32768), 8); ` +
    `style(--reg: 2): --rightShift(--lowerBytes(calc(var(--rmVal16) * 2 + var(--_cf)), 16), 8); ` +
    `style(--reg: 3): --rightShift(calc(round(down, var(--rmVal16) / 2) + var(--_cf) * 32768), 8); ` +
    `else: 0)`,
    `Shift D1 → mem hi`, 1);

  // Flags
  dispatch.addEntry('flags', 0xD1,
    `if(` +
    `style(--reg: 4): calc(--shlFlags16(var(--rmVal16)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 5): calc(--shrFlags16(var(--rmVal16)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 7): calc(--sarFlags16(var(--rmVal16)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 2): calc(var(--__1flags) - --bit(var(--__1flags), 0) + --bit(var(--rmVal16), 15)); ` +
    `style(--reg: 3): calc(var(--__1flags) - --bit(var(--__1flags), 0) + --bit(var(--rmVal16), 0)); ` +
    `else: var(--__1flags))`,
    `Shift D1 flags`);

  dispatch.addEntry('IP', 0xD1,
    `if(style(--mod: 3): calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen)); else: var(--__1IP))`,
    `Shift D1 IP`, 0);
  dispatch.addEntry('IP', 0xD1,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen))`,
    `Shift D1 retire`, 1);
  dispatch.setUopAdvance(0xD1,
    `if(style(--mod: 3): 0; style(--__1uOp: 0): 1; else: 0)`);
}

/**
 * Group 0xD0: shift/rotate r/m8 by 1
 */
export function emitShift_D0(dispatch) {
  for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
    dispatch.addEntry(regName, 0xD0,
      `if(` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 4): --mergelow(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) * 2), 8)); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 5): --mergelow(var(--__1${regName}), round(down, var(--rmVal8) / 2)); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 7): --mergelow(var(--__1${regName}), calc(round(down, var(--rmVal8) / 2) + --bit(var(--rmVal8), 7) * 128)); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 2): --mergelow(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) * 2 + var(--_cf)), 8)); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 3): --mergelow(var(--__1${regName}), calc(round(down, var(--rmVal8) / 2) + var(--_cf) * 128)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 4): --mergehigh(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) * 2), 8)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 5): --mergehigh(var(--__1${regName}), round(down, var(--rmVal8) / 2)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 7): --mergehigh(var(--__1${regName}), calc(round(down, var(--rmVal8) / 2) + --bit(var(--rmVal8), 7) * 128)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 2): --mergehigh(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) * 2 + var(--_cf)), 8)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 3): --mergehigh(var(--__1${regName}), calc(round(down, var(--rmVal8) / 2) + var(--_cf) * 128)); ` +
      `else: var(--__1${regName}))`,
      `Shift D0 → ${regName}`);
  }

  // Memory write
  dispatch.addMemWrite(0xD0,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `if(` +
    `style(--reg: 4): --lowerBytes(calc(var(--rmVal8) * 2), 8); ` +
    `style(--reg: 5): round(down, var(--rmVal8) / 2); ` +
    `style(--reg: 7): calc(round(down, var(--rmVal8) / 2) + --bit(var(--rmVal8), 7) * 128); ` +
    `style(--reg: 2): --lowerBytes(calc(var(--rmVal8) * 2 + var(--_cf)), 8); ` +
    `style(--reg: 3): calc(round(down, var(--rmVal8) / 2) + var(--_cf) * 128); ` +
    `else: 0)`,
    `Shift D0 → mem`);

  // RCL/RCR: only CF changes; leave PF/ZF/SF unchanged
  dispatch.addEntry('flags', 0xD0,
    `if(` +
    `style(--reg: 4): calc(--shlFlags8(var(--rmVal8)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 5): calc(--shrFlags8(var(--rmVal8)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 7): calc(--sarFlags8(var(--rmVal8)) + --and(var(--__1flags), 3856)); ` +
    `style(--reg: 2): calc(var(--__1flags) - --bit(var(--__1flags), 0) + --bit(var(--rmVal8), 7)); ` +  // RCL: new CF = old bit 7
    `style(--reg: 3): calc(var(--__1flags) - --bit(var(--__1flags), 0) + --bit(var(--rmVal8), 0)); ` +  // RCR: new CF = old bit 0
    `else: var(--__1flags))`,
    `Shift D0 flags`);

  dispatch.addEntry('IP', 0xD0, `calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen))`, `Shift D0`);
}

/**
 * Shift flag helper functions (emitted as CSS @functions).
 * Shift by 1 is simpler: CF = shifted-out bit, OF = sign change detection.
 */
export function emitShiftFlagFunctions() {
  return `
/* ===== SHIFT FLAGS (by 1) ===== */

@function --shlFlags16(--val <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--val) * 2), 16);
  --cf: --bit(var(--val), 15);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --shrFlags16(--val <integer>) returns <integer> {
  --res: round(down, var(--val) / 2);
  --cf: --bit(var(--val), 0);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --sarFlags16(--val <integer>) returns <integer> {
  --res: calc(round(down, var(--val) / 2) + --bit(var(--val), 15) * 32768);
  --cf: --bit(var(--val), 0);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --shlFlags8(--val <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--val) * 2), 8);
  --cf: --bit(var(--val), 7);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --shrFlags8(--val <integer>) returns <integer> {
  --res: round(down, var(--val) / 2);
  --cf: --bit(var(--val), 0);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --sarFlags8(--val <integer>) returns <integer> {
  --res: calc(round(down, var(--val) / 2) + --bit(var(--val), 7) * 128);
  --cf: --bit(var(--val), 0);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zf) + var(--sf) + 2);
}
`;
}

/**
 * Group 0xD3: shift/rotate r/m16 by CL
 * Variable-count shifts use closed-form expressions via pow2 lookup.
 * SHL = val * 2^CL, SHR = val / 2^CL, ROL/ROR = combination.
 * RCL/RCR by CL are deferred (extremely rare, needs iterative CF threading).
 *
 * Pre-computed decode properties available:
 *   --_clMasked  = CL & 0x1F (shift count, 0-31)
 *   --_pow2CL    = 2^(CL & 0x1F)
 *   --_pow2inv16 = 2^(16 - CL & 0x1F)  (for rotates)
 *
 * CF for variable-count shifts (when CL >= 1):
 *   SHL: last bit shifted out = bit (16 - CL) of original value
 *   SHR: last bit shifted out = bit (CL - 1) of original value
 *   SAR: same as SHR
 *   ROL: CF = bit 0 of result
 *   ROR: CF = MSB of result
 * When CL=0: flags unchanged (handled at call site).
 */
export function emitShift_D3(dispatch) {
  // Result expressions for each shift type (16-bit, variable count)
  // SHL: (val << cl) & 0xFFFF
  const shl16 = `--lowerBytes(round(nearest, calc(var(--rmVal16) * var(--_pow2CL))), 16)`;
  // SHR: val >> cl (logical)
  const shr16 = `round(down, var(--rmVal16) / max(1, var(--_pow2CL)))`;
  // SAR: arithmetic right shift = SHR + sign extension
  // sign fill = signBit * (0xFFFF - floor(0xFFFF / pow2CL))
  // = bit15 * (65535 - round(down, 65535 / pow2CL))
  const sar16 = `calc(round(down, var(--rmVal16) / max(1, var(--_pow2CL))) + --bit(var(--rmVal16), 15) * max(0, calc(65535 - round(down, 65535 / max(1, var(--_pow2CL))))))`;
  // ROL: (val << cl) | (val >> (16-cl))  — both masked to 16 bits
  const rol16 = `--lowerBytes(calc(round(nearest, var(--rmVal16) * var(--_pow2CL)) + round(down, var(--rmVal16) / max(1, var(--_pow2inv16)))), 16)`;
  // ROR: (val >> cl) | (val << (16-cl))
  const ror16 = `--lowerBytes(calc(round(down, var(--rmVal16) / max(1, var(--_pow2CL))) + round(nearest, var(--rmVal16) * var(--_pow2inv16))), 16)`;

  for (let r = 0; r < 8; r++) {
    const regName = REG16[r];
    dispatch.addEntry(regName, 0xD3,
      `if(` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 4): ${shl16}; ` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 5): ${shr16}; ` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 7): ${sar16}; ` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 0): ${rol16}; ` +
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: 1): ${ror16}; ` +
      `else: var(--__1${regName}))`,
      `Shift D3 → ${regName}`);
  }

  // Memory writes for mod != 3 (2 μops)
  dispatch.addMemWrite(0xD3,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `if(` +
    `style(--reg: 4): --lowerBytes(${shl16}, 8); ` +
    `style(--reg: 5): --lowerBytes(${shr16}, 8); ` +
    `style(--reg: 7): --lowerBytes(${sar16}, 8); ` +
    `style(--reg: 0): --lowerBytes(${rol16}, 8); ` +
    `style(--reg: 1): --lowerBytes(${ror16}, 8); ` +
    `else: 0)`,
    `Shift D3 → mem lo`, 0);
  dispatch.addMemWrite(0xD3,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `if(` +
    `style(--reg: 4): --rightShift(${shl16}, 8); ` +
    `style(--reg: 5): --rightShift(${shr16}, 8); ` +
    `style(--reg: 7): --rightShift(${sar16}, 8); ` +
    `style(--reg: 0): --rightShift(${rol16}, 8); ` +
    `style(--reg: 1): --rightShift(${ror16}, 8); ` +
    `else: 0)`,
    `Shift D3 → mem hi`, 1);

  // Flags: when CL=0 flags unchanged; otherwise compute per-operation flags
  // CF for SHL: bit (16-CL) of original = --bit(rmVal16, --_shlCFidx16),
  //   but need to zero it when CL > 16: multiply by max(0, min(1, 17-CL))
  // CF for SHR/SAR: bit (CL-1) of original = --bit(rmVal16, CL-1)
  // CF for ROL: bit 0 of result. CF for ROR: bit 15 of result.
  dispatch.addEntry('flags', 0xD3,
    `if(style(--_clMasked: 0): var(--__1flags); ` +
    `style(--reg: 4): calc(--shlFlagsN16(var(--rmVal16), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 5): calc(--shrFlagsN16(var(--rmVal16), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 7): calc(--sarFlagsN16(var(--rmVal16), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 0): calc(var(--__1flags) - var(--_cf) + --bit(${rol16}, 0)); ` +
    `style(--reg: 1): calc(var(--__1flags) - var(--_cf) + --bit(${ror16}, 15)); ` +
    `else: var(--__1flags))`,
    `Shift D3 flags`);

  dispatch.addEntry('IP', 0xD3,
    `if(style(--mod: 3): calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen)); else: var(--__1IP))`,
    `Shift D3 IP`, 0);
  dispatch.addEntry('IP', 0xD3,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen))`,
    `Shift D3 retire`, 1);
  dispatch.setUopAdvance(0xD3,
    `if(style(--mod: 3): 0; style(--__1uOp: 0): 1; else: 0)`);
}

/**
 * Group 0xD2: shift/rotate r/m8 by CL
 */
export function emitShift_D2(dispatch) {
  // Result expressions (8-bit, variable count)
  const shl8 = `--lowerBytes(round(nearest, calc(var(--rmVal8) * var(--_pow2CL))), 8)`;
  const shr8 = `round(down, var(--rmVal8) / max(1, var(--_pow2CL)))`;
  const sar8 = `calc(round(down, var(--rmVal8) / max(1, var(--_pow2CL))) + --bit(var(--rmVal8), 7) * max(0, calc(255 - round(down, 255 / max(1, var(--_pow2CL))))))`;
  const rol8 = `--lowerBytes(calc(round(nearest, var(--rmVal8) * var(--_pow2CL)) + round(down, var(--rmVal8) / max(1, var(--_pow2inv8)))), 8)`;
  const ror8 = `--lowerBytes(calc(round(down, var(--rmVal8) / max(1, var(--_pow2CL))) + round(nearest, var(--rmVal8) * var(--_pow2inv8))), 8)`;

  for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
    dispatch.addEntry(regName, 0xD2,
      `if(` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 4): --mergelow(var(--__1${regName}), ${shl8}); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 5): --mergelow(var(--__1${regName}), ${shr8}); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 7): --mergelow(var(--__1${regName}), ${sar8}); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 0): --mergelow(var(--__1${regName}), ${rol8}); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 1): --mergelow(var(--__1${regName}), ${ror8}); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 4): --mergehigh(var(--__1${regName}), ${shl8}); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 5): --mergehigh(var(--__1${regName}), ${shr8}); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 7): --mergehigh(var(--__1${regName}), ${sar8}); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 0): --mergehigh(var(--__1${regName}), ${rol8}); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 1): --mergehigh(var(--__1${regName}), ${ror8}); ` +
      `else: var(--__1${regName}))`,
      `Shift D2 → ${regName}`);
  }

  // Memory write
  dispatch.addMemWrite(0xD2,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `if(` +
    `style(--reg: 4): ${shl8}; ` +
    `style(--reg: 5): ${shr8}; ` +
    `style(--reg: 7): ${sar8}; ` +
    `style(--reg: 0): ${rol8}; ` +
    `style(--reg: 1): ${ror8}; ` +
    `else: 0)`,
    `Shift D2 → mem`);

  // Flags
  dispatch.addEntry('flags', 0xD2,
    `if(style(--_clMasked: 0): var(--__1flags); ` +
    `style(--reg: 4): calc(--shlFlagsN8(var(--rmVal8), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 5): calc(--shrFlagsN8(var(--rmVal8), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 7): calc(--sarFlagsN8(var(--rmVal8), var(--_clMasked)) + --and(var(--__1flags), 1808)); ` +
    `style(--reg: 0): calc(var(--__1flags) - var(--_cf) + --bit(${rol8}, 0)); ` +
    `style(--reg: 1): calc(var(--__1flags) - var(--_cf) + --bit(${ror8}, 7)); ` +
    `else: var(--__1flags))`,
    `Shift D2 flags`);

  dispatch.addEntry('IP', 0xD2, `calc(var(--__1IP) + 2 + var(--modrmExtra) + var(--prefixLen))`, `Shift D2`);
}

/**
 * Variable-count shift flag functions (SHL/SHR/SAR by CL).
 * Rotates only update CF (handled inline in dispatch), so no flag function needed.
 *
 * These receive the original value and the masked shift count (1-31, never 0).
 * CF computation:
 *   SHL: last bit shifted out = bit (width - count) of original
 *   SHR/SAR: last bit shifted out = bit (count - 1) of original
 */
export function emitShiftByNFlagFunctions() {
  return `
/* ===== SHIFT FLAGS (variable count by CL) ===== */

@function --shlFlagsN16(--val <integer>, --n <integer>) returns <integer> {
  --res: --lowerBytes(round(nearest, calc(var(--val) * pow(2, var(--n)))), 16);
  --cf: --bit(var(--val), max(0, calc(16 - var(--n))));
  --of: calc(abs(--bit(var(--res), 15) - var(--cf)) * 2048);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--of) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --shrFlagsN16(--val <integer>, --n <integer>) returns <integer> {
  --res: round(down, var(--val) / pow(2, var(--n)));
  --cf: --bit(var(--val), calc(var(--n) - 1));
  --of: calc(--bit(var(--val), 15) * 2048);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--of) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --sarFlagsN16(--val <integer>, --n <integer>) returns <integer> {
  --shr: round(down, var(--val) / pow(2, var(--n)));
  --res: calc(var(--shr) + --bit(var(--val), 15) * max(0, calc(65535 - round(down, 65535 / pow(2, var(--n))))));
  --cf: --bit(var(--val), calc(var(--n) - 1));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 15) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zfsf) + 2);
}

@function --shlFlagsN8(--val <integer>, --n <integer>) returns <integer> {
  --res: --lowerBytes(round(nearest, calc(var(--val) * pow(2, var(--n)))), 8);
  --cf: --bit(var(--val), max(0, calc(8 - var(--n))));
  --of: calc(abs(--bit(var(--res), 7) - var(--cf)) * 2048);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--of) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --shrFlagsN8(--val <integer>, --n <integer>) returns <integer> {
  --res: round(down, var(--val) / pow(2, var(--n)));
  --cf: --bit(var(--val), calc(var(--n) - 1));
  --of: calc(--bit(var(--val), 7) * 2048);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--of) + var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --sarFlagsN8(--val <integer>, --n <integer>) returns <integer> {
  --shr: round(down, var(--val) / pow(2, var(--n)));
  --res: calc(var(--shr) + --bit(var(--val), 7) * max(0, calc(255 - round(down, 255 / pow(2, var(--n))))));
  --cf: --bit(var(--val), calc(var(--n) - 1));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 7) * 128);
  result: calc(var(--cf) + var(--pf) + var(--zfsf) + 2);
}
`;
}

/**
 * Register all shift opcodes.
 */
export function emitAllShifts(dispatch) {
  emitShift_D1(dispatch);
  emitShift_D0(dispatch);
  emitShift_D3(dispatch);
  emitShift_D2(dispatch);
}
