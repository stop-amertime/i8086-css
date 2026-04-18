// Group opcode emitters: 0xFE, 0xFF, 0xF6, 0xF7, 0x80-0x83
// These use the reg field of ModR/M to select the sub-operation.

// Wrap logic flag expressions to preserve AF (bit 4) from previous tick.
// On 8086, AF is undefined for AND/OR/XOR — real hardware preserves it.
// Wrap logic flag expressions to preserve AF+TF+IF+DF from previous tick.
const pKeep = (flagExpr, mask = 1808) => `calc(${flagExpr} + --and(var(--__1flags), ${mask}))`;

const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];
const SPLIT_REGS = [
  { reg: 'AX', lowIdx: 0, highIdx: 4 },
  { reg: 'CX', lowIdx: 1, highIdx: 5 },
  { reg: 'DX', lowIdx: 2, highIdx: 6 },
  { reg: 'BX', lowIdx: 3, highIdx: 7 },
];

/**
 * Group 0xFE: byte operations on r/m8
 * reg=0: INC r/m8
 * reg=1: DEC r/m8
 */
export function emitGroup_FE(dispatch) {
  // Both INC and DEC write to r/m8, which is either a register or memory.
  // The result depends on reg field:
  //   reg=0: rm + 1 (INC)
  //   reg=1: rm - 1 (DEC)
  // For register destinations (mod=11):
  for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
    dispatch.addEntry(regName, 0xFE,
      `if(` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 0): --mergelow(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) + 1), 8)); ` +
      `style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: 1): --mergelow(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) - 1 + 256), 8)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 0): --mergehigh(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) + 1), 8)); ` +
      `style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: 1): --mergehigh(var(--__1${regName}), --lowerBytes(calc(var(--rmVal8) - 1 + 256), 8)); ` +
      `else: var(--__1${regName}))`,
      `Group FE INC/DEC r/m8 → ${regName}`);
  }

  // Memory write: if mod!=3
  dispatch.addMemWrite(0xFE,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `if(style(--reg: 0): --lowerBytes(calc(var(--rmVal8) + 1), 8); else: --lowerBytes(calc(var(--rmVal8) - 1 + 256), 8))`,
    `Group FE INC/DEC r/m8 → mem`);

  // Flags: INC preserves CF, DEC preserves CF
  dispatch.addEntry('flags', 0xFE,
    `if(style(--reg: 0): --incFlags8(var(--rmVal8), --lowerBytes(calc(var(--rmVal8) + 1), 8), var(--__1flags)); ` +
    `else: --decFlags8(var(--rmVal8), --lowerBytes(calc(var(--rmVal8) - 1 + 256), 8), var(--__1flags)))`,
    `Group FE flags`);

  dispatch.addEntry('IP', 0xFE, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `Group FE`);
}

/**
 * Group 0xF7: word operations on r/m16
 * reg=0: TEST r/m16, imm16
 * reg=2: NOT r/m16
 * reg=3: NEG r/m16
 * reg=4: MUL r/m16 (unsigned: DX:AX = AX * r/m16)
 * reg=5: IMUL r/m16 (signed: DX:AX = AX * r/m16)
 * reg=6: DIV r/m16 (unsigned: AX = DX:AX / r/m16, DX = DX:AX % r/m16)
 * reg=7: IDIV r/m16 (signed: AX = DX:AX / r/m16, DX = DX:AX % r/m16)
 */
export function emitGroup_F7(dispatch) {
  // This is complex because different sub-ops write different registers.
  // DIV (reg=6): AX = quotient, DX = remainder
  // MUL (reg=4): DX:AX = AX * src
  // NEG (reg=3): r/m = 0 - r/m, sets flags
  // NOT (reg=2): r/m = ~r/m, no flag change
  // TEST (reg=0): r/m & imm16, flags only

  // IMUL uses pre-computed decode properties: --_imulProd16, --_sAX, --_sRM16
  const imulProd16 = `var(--_imulProd16)`;

  // AX: DIV writes quotient, MUL writes low product, IMUL writes low product,
  // IDIV writes signed quotient, NEG/NOT may write if rm=0
  dispatch.addEntry('AX', 0xF7,
    `if(` +
    `style(--reg: 6): round(down, calc((var(--__1DX) * 65536 + var(--__1AX)) / max(1, var(--rmVal16)))); ` +
    `style(--reg: 7): --lowerBytes(calc(round(to-zero, calc(var(--_sDXAX) / var(--_safeSDivisor16))) + 65536), 16); ` +
    `style(--reg: 4): --lowerBytes(calc(var(--__1AX) * var(--rmVal16)), 16); ` +
    `style(--reg: 5): --lowerBytes(${imulProd16}, 16); ` +
    `style(--reg: 3) and style(--mod: 3) and style(--rm: 0): --lowerBytes(calc(0 - var(--rmVal16) + 65536), 16); ` +
    `style(--reg: 2) and style(--mod: 3) and style(--rm: 0): --not(var(--rmVal16)); ` +
    `else: var(--__1AX))`,
    `Group F7 AX`);

  // DX: DIV writes remainder, MUL writes high product, IMUL writes high product,
  // IDIV writes signed remainder
  dispatch.addEntry('DX', 0xF7,
    `if(` +
    `style(--reg: 6): mod(calc(var(--__1DX) * 65536 + var(--__1AX)), max(1, var(--rmVal16))); ` +
    `style(--reg: 7): --lowerBytes(calc(var(--_sDXAX) - round(to-zero, calc(var(--_sDXAX) / var(--_safeSDivisor16))) * var(--_safeSDivisor16) + 65536), 16); ` +
    `style(--reg: 4): --lowerBytes(--rightShift(calc(var(--__1AX) * var(--rmVal16)), 16), 16); ` +
    `style(--reg: 5): --lowerBytes(--rightShift(${imulProd16}, 16), 16); ` +
    `style(--reg: 3) and style(--mod: 3) and style(--rm: 2): --lowerBytes(calc(0 - var(--rmVal16) + 65536), 16); ` +
    `style(--reg: 2) and style(--mod: 3) and style(--rm: 2): --not(var(--rmVal16)); ` +
    `else: var(--__1DX))`,
    `Group F7 DX`);

  // Other registers: NEG/NOT when mod=11 and rm selects that register
  for (let r = 0; r < 8; r++) {
    if (r === 0 || r === 2) continue; // AX and DX handled above
    const regName = REG16[r];
    dispatch.addEntry(regName, 0xF7,
      `if(` +
      `style(--reg: 3) and style(--mod: 3) and style(--rm: ${r}): --lowerBytes(calc(0 - var(--rmVal16) + 65536), 16); ` +
      `style(--reg: 2) and style(--mod: 3) and style(--rm: ${r}): --not(var(--rmVal16)); ` +
      `else: var(--__1${regName}))`,
      `Group F7 ${regName}`);
  }

  // Memory writes for NEG/NOT when mod!=3
  dispatch.addMemWrite(0xF7,
    `if(style(--mod: 3): -1; style(--reg: 3): var(--ea); style(--reg: 2): var(--ea); else: -1)`,
    `if(style(--reg: 3): --lowerBytes(calc(0 - var(--rmVal16) + 65536), 8); style(--reg: 2): --lowerBytes(--not(var(--rmVal16)), 8); else: 0)`,
    `Group F7 NEG/NOT → mem lo`);
  dispatch.addMemWrite(0xF7,
    `if(style(--mod: 3): -1; style(--reg: 3): calc(var(--ea) + 1); style(--reg: 2): calc(var(--ea) + 1); else: -1)`,
    `if(style(--reg: 3): --rightShift(--lowerBytes(calc(0 - var(--rmVal16) + 65536), 16), 8); style(--reg: 2): --rightShift(--not(var(--rmVal16)), 8); else: 0)`,
    `Group F7 NEG/NOT → mem hi`);

  // Flags: MUL/IMUL set CF+OF based on upper half; DIV/IDIV undefined
  // MUL CF=OF: DX != 0 → bit at 0 and 11
  // IMUL CF=OF: DX:AX != sign-extend(AX) → DX != (bit(AX,15)*65535)
  dispatch.addEntry('flags', 0xF7,
    `if(` +
    `style(--reg: 0): ${pKeep('--andFlags16(var(--rmVal16), var(--immWord))')}; ` +
    `style(--reg: 3): ${pKeep('--subFlags16(0, var(--rmVal16))', 1792)}; ` +
    `style(--reg: 2): var(--__1flags); ` +
    `style(--reg: 4): calc(var(--__1flags) - --bit(var(--__1flags), 0) - --bit(var(--__1flags), 11) * 2048 + min(1, --lowerBytes(--rightShift(calc(var(--__1AX) * var(--rmVal16)), 16), 16)) * 2049); ` +
    `style(--reg: 5): calc(var(--__1flags) - --bit(var(--__1flags), 0) - --bit(var(--__1flags), 11) * 2048 + min(1, abs(--lowerBytes(round(down, ${imulProd16} / 65536), 16) - --bit(--lowerBytes(${imulProd16}, 16), 15) * 65535)) * 2049); ` +
    `else: var(--__1flags))`,
    `Group F7 flags`);

  // IP: TEST has extra imm16 (2 bytes), others don't
  dispatch.addEntry('IP', 0xF7,
    `if(style(--reg: 0): calc(var(--__1IP) + 2 + var(--modrmExtra) + 2); else: calc(var(--__1IP) + 2 + var(--modrmExtra)))`,
    `Group F7`);
}

/**
 * Group 0xF6: byte operations on r/m8
 * reg=0: TEST r/m8, imm8
 * reg=2: NOT r/m8
 * reg=3: NEG r/m8
 * reg=4: MUL r/m8 (AX = AL * r/m8)
 * reg=5: IMUL r/m8 (signed: AX = AL * r/m8)
 * reg=6: DIV r/m8 (AL = AX / r/m8, AH = AX % r/m8)
 * reg=7: IDIV r/m8 (signed: AL = AX / r/m8, AH = AX % r/m8)
 */
export function emitGroup_F6(dispatch) {
  // IMUL byte uses pre-computed decode property: --_imulProd8
  const imulProd8 = `var(--_imulProd8)`;

  // AX gets written for MUL, IMUL, DIV, and IDIV
  dispatch.addEntry('AX', 0xF6,
    `if(` +
    `style(--reg: 6): calc(round(down, var(--__1AX) / max(1, var(--rmVal8))) + mod(var(--__1AX), max(1, var(--rmVal8))) * 256); ` +
    `style(--reg: 7): calc(--lowerBytes(calc(round(to-zero, calc(var(--_sAX) / var(--_safeSDivisor8))) + 256), 8) + --lowerBytes(calc(var(--_sAX) - round(to-zero, calc(var(--_sAX) / var(--_safeSDivisor8))) * var(--_safeSDivisor8) + 256), 8) * 256); ` +
    `style(--reg: 4): calc(var(--AL) * var(--rmVal8)); ` +
    `style(--reg: 5): --lowerBytes(${imulProd8}, 16); ` +
    // NEG/NOT on AL (rm=0, mod=11)
    `style(--reg: 3) and style(--mod: 3) and style(--rm: 0): --mergelow(var(--__1AX), --lowerBytes(calc(0 - var(--rmVal8) + 256), 8)); ` +
    `style(--reg: 2) and style(--mod: 3) and style(--rm: 0): --mergelow(var(--__1AX), --lowerBytes(--not(var(--rmVal8)), 8)); ` +
    // NEG/NOT on AH (rm=4, mod=11)
    `style(--reg: 3) and style(--mod: 3) and style(--rm: 4): --mergehigh(var(--__1AX), --lowerBytes(calc(0 - var(--rmVal8) + 256), 8)); ` +
    `style(--reg: 2) and style(--mod: 3) and style(--rm: 4): --mergehigh(var(--__1AX), --lowerBytes(--not(var(--rmVal8)), 8)); ` +
    `else: var(--__1AX))`,
    `Group F6 AX`);

  // Other split regs for NEG/NOT r/m8 (mod=11)
  for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
    if (regName === 'AX') continue;
    dispatch.addEntry(regName, 0xF6,
      `if(` +
      `style(--reg: 3) and style(--mod: 3) and style(--rm: ${lowIdx}): --mergelow(var(--__1${regName}), --lowerBytes(calc(0 - var(--rmVal8) + 256), 8)); ` +
      `style(--reg: 2) and style(--mod: 3) and style(--rm: ${lowIdx}): --mergelow(var(--__1${regName}), --lowerBytes(--not(var(--rmVal8)), 8)); ` +
      `style(--reg: 3) and style(--mod: 3) and style(--rm: ${highIdx}): --mergehigh(var(--__1${regName}), --lowerBytes(calc(0 - var(--rmVal8) + 256), 8)); ` +
      `style(--reg: 2) and style(--mod: 3) and style(--rm: ${highIdx}): --mergehigh(var(--__1${regName}), --lowerBytes(--not(var(--rmVal8)), 8)); ` +
      `else: var(--__1${regName}))`,
      `Group F6 ${regName}`);
  }

  // Memory writes for NEG/NOT when mod!=3
  dispatch.addMemWrite(0xF6,
    `if(style(--mod: 3): -1; style(--reg: 3): var(--ea); style(--reg: 2): var(--ea); else: -1)`,
    `if(style(--reg: 3): --lowerBytes(calc(0 - var(--rmVal8) + 256), 8); style(--reg: 2): --lowerBytes(--not(var(--rmVal8)), 8); else: 0)`,
    `Group F6 NEG/NOT → mem`);

  // Flags: MUL/IMUL set CF+OF; others as before
  // MUL byte: CF=OF=1 if AH (upper byte of product) != 0
  // IMUL byte: CF=OF=1 if AH != sign-extension of AL in result
  dispatch.addEntry('flags', 0xF6,
    `if(` +
    `style(--reg: 0): ${pKeep('--andFlags8(var(--rmVal8), var(--immByte))')}; ` +
    `style(--reg: 3): ${pKeep('--subFlags8(0, var(--rmVal8))', 1792)}; ` +
    `style(--reg: 2): var(--__1flags); ` +
    `style(--reg: 4): calc(var(--__1flags) - --bit(var(--__1flags), 0) - --bit(var(--__1flags), 11) * 2048 + min(1, round(down, calc(var(--AL) * var(--rmVal8)) / 256)) * 2049); ` +
    `style(--reg: 5): calc(var(--__1flags) - --bit(var(--__1flags), 0) - --bit(var(--__1flags), 11) * 2048 + min(1, abs(--rightShift(--lowerBytes(${imulProd8}, 16), 8) - --bit(--lowerBytes(${imulProd8}, 8), 7) * 255)) * 2049); ` +
    `else: var(--__1flags))`,
    `Group F6 flags`);

  // IP: TEST has extra imm8 (1 byte)
  dispatch.addEntry('IP', 0xF6,
    `if(style(--reg: 0): calc(var(--__1IP) + 2 + var(--modrmExtra) + 1); else: calc(var(--__1IP) + 2 + var(--modrmExtra)))`,
    `Group F6`);
}

/**
 * Add 8-bit INC/DEC flag functions to flags.mjs output
 */
export function emitIncDecFlags8() {
  return `
@function --incFlags8(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rd1: --xor(var(--_xor_rd), 1);
  --af: calc(--bit(var(--_xor_rd1), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --of: if(style(--res: 128): 2048; else: 0);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --decFlags8(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rd1: --xor(var(--_xor_rd), 1);
  --af: calc(--bit(var(--_xor_rd1), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --of: if(style(--res: 127): 2048; else: 0);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}
`;
}

/**
 * Register all group opcodes.
 */
/**
 * Group 0x80: ALU r/m8, imm8
 * Group 0x82: same as 0x80
 * reg=0:ADD, 1:OR, 2:ADC, 3:SBB, 4:AND, 5:SUB, 6:XOR, 7:CMP
 *
 * For register destinations (mod=11), each 8-bit reg maps to a 16-bit reg.
 * immByte is the immediate operand after ModR/M+disp.
 */
export function emitGroup_80(dispatch) {
  // Result expressions for each sub-operation (8-bit)
  // All read rmVal8 as dst, immByte as src
  const subOps = [
    { reg: 0, name: 'ADD', result: `--lowerBytes(calc(var(--rmVal8) + var(--immByte)), 8)`, flags: pKeep(`--addFlags8(var(--rmVal8), var(--immByte))`, 1792), writes: true },
    { reg: 1, name: 'OR',  result: `--or8(var(--rmVal8), var(--immByte))`, flags: pKeep(`--orFlags8(var(--rmVal8), var(--immByte))`), writes: true },
    { reg: 2, name: 'ADC', result: `--lowerBytes(calc(var(--rmVal8) + var(--immByte) + var(--_cf)), 8)`, flags: pKeep(`--adcFlags8(var(--rmVal8), var(--immByte), var(--_cf))`, 1792), writes: true },
    { reg: 3, name: 'SBB', result: `--lowerBytes(calc(var(--rmVal8) - var(--immByte) - var(--_cf) + 256), 8)`, flags: pKeep(`--sbbFlags8(var(--rmVal8), var(--immByte), var(--_cf))`, 1792), writes: true },
    { reg: 4, name: 'AND', result: `--and8(var(--rmVal8), var(--immByte))`, flags: pKeep(`--andFlags8(var(--rmVal8), var(--immByte))`), writes: true },
    { reg: 5, name: 'SUB', result: `--lowerBytes(calc(var(--rmVal8) - var(--immByte) + 256), 8)`, flags: pKeep(`--subFlags8(var(--rmVal8), var(--immByte))`, 1792), writes: true },
    { reg: 6, name: 'XOR', result: `--xor8(var(--rmVal8), var(--immByte))`, flags: pKeep(`--xorFlags8(var(--rmVal8), var(--immByte))`), writes: true },
    { reg: 7, name: 'CMP', result: null, flags: pKeep(`--subFlags8(var(--rmVal8), var(--immByte))`, 1792), writes: false },
  ];

  // For opcodes 0x80 and 0x82 (same behavior)
  for (const opcode of [0x80, 0x82]) {
    // Register writes: each 16-bit register can be destination when mod=11
    for (const { reg: regName, lowIdx, highIdx } of SPLIT_REGS) {
      const branches = [];
      for (const { reg: subReg, result, writes } of subOps) {
        if (!writes) continue;
        branches.push(`style(--mod: 3) and style(--rm: ${lowIdx}) and style(--reg: ${subReg}): --mergelow(var(--__1${regName}), ${result})`);
        branches.push(`style(--mod: 3) and style(--rm: ${highIdx}) and style(--reg: ${subReg}): --mergehigh(var(--__1${regName}), ${result})`);
      }
      dispatch.addEntry(regName, opcode,
        `if(${branches.join('; ')}; else: var(--__1${regName}))`,
        `Group ${opcode.toString(16)} r/m8,imm8 → ${regName}`);
    }

    // Memory write for non-CMP sub-ops when mod!=3
    const memBranches = subOps.filter(s => s.writes).map(s =>
      `style(--reg: ${s.reg}): ${s.result}`
    );
    dispatch.addMemWrite(opcode,
      `if(style(--mod: 3): -1; style(--reg: 7): -1; else: var(--ea))`,
      `if(${memBranches.join('; ')}; else: 0)`,
      `Group ${opcode.toString(16)} r/m8,imm8 → mem`);

    // Flags: all sub-ops set flags
    const flagBranches = subOps.map(s =>
      `style(--reg: ${s.reg}): ${s.flags}`
    );
    dispatch.addEntry('flags', opcode,
      `if(${flagBranches.join('; ')}; else: var(--__1flags))`,
      `Group ${opcode.toString(16)} flags`);

    // IP: 2 + modrmExtra + 1 (for the immediate byte)
    dispatch.addEntry('IP', opcode,
      `calc(var(--__1IP) + 2 + var(--modrmExtra) + 1)`,
      `Group ${opcode.toString(16)}`);
  }
}

/**
 * Group 0x81: ALU r/m16, imm16
 * reg=0:ADD, 1:OR, 2:ADC, 3:SBB, 4:AND, 5:SUB, 6:XOR, 7:CMP
 */
export function emitGroup_81(dispatch) {
  const subOps = [
    { reg: 0, name: 'ADD', result: `--lowerBytes(calc(var(--rmVal16) + var(--immWord)), 16)`, flags: pKeep(`--addFlags16(var(--rmVal16), var(--immWord))`, 1792), writes: true },
    { reg: 1, name: 'OR',  result: `--or(var(--rmVal16), var(--immWord))`, flags: pKeep(`--orFlags16(var(--rmVal16), var(--immWord))`), writes: true },
    { reg: 2, name: 'ADC', result: `--lowerBytes(calc(var(--rmVal16) + var(--immWord) + var(--_cf)), 16)`, flags: pKeep(`--adcFlags16(var(--rmVal16), var(--immWord), var(--_cf))`, 1792), writes: true },
    { reg: 3, name: 'SBB', result: `--lowerBytes(calc(var(--rmVal16) - var(--immWord) - var(--_cf) + 65536), 16)`, flags: pKeep(`--sbbFlags16(var(--rmVal16), var(--immWord), var(--_cf))`, 1792), writes: true },
    { reg: 4, name: 'AND', result: `--and(var(--rmVal16), var(--immWord))`, flags: pKeep(`--andFlags16(var(--rmVal16), var(--immWord))`), writes: true },
    { reg: 5, name: 'SUB', result: `--lowerBytes(calc(var(--rmVal16) - var(--immWord) + 65536), 16)`, flags: pKeep(`--subFlags16(var(--rmVal16), var(--immWord))`, 1792), writes: true },
    { reg: 6, name: 'XOR', result: `--xor(var(--rmVal16), var(--immWord))`, flags: pKeep(`--xorFlags16(var(--rmVal16), var(--immWord))`), writes: true },
    { reg: 7, name: 'CMP', result: null, flags: pKeep(`--subFlags16(var(--rmVal16), var(--immWord))`, 1792), writes: false },
  ];

  for (let r = 0; r < 8; r++) {
    const branches = subOps.filter(s => s.writes).map(s =>
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: ${s.reg}): ${s.result}`
    );
    dispatch.addEntry(REG16[r], 0x81,
      `if(${branches.join('; ')}; else: var(--__1${REG16[r]}))`,
      `Group 81 r/m16,imm16 → ${REG16[r]}`);
  }

  // Memory writes (word)
  const memLoBranches = subOps.filter(s => s.writes).map(s =>
    `style(--reg: ${s.reg}): --lowerBytes(${s.result}, 8)`
  );
  dispatch.addMemWrite(0x81,
    `if(style(--mod: 3): -1; style(--reg: 7): -1; else: var(--ea))`,
    `if(${memLoBranches.join('; ')}; else: 0)`,
    `Group 81 r/m16,imm16 → mem lo`);
  const memHiBranches = subOps.filter(s => s.writes).map(s =>
    `style(--reg: ${s.reg}): --rightShift(${s.result}, 8)`
  );
  dispatch.addMemWrite(0x81,
    `if(style(--mod: 3): -1; style(--reg: 7): -1; else: calc(var(--ea) + 1))`,
    `if(${memHiBranches.join('; ')}; else: 0)`,
    `Group 81 r/m16,imm16 → mem hi`);

  const flagBranches = subOps.map(s =>
    `style(--reg: ${s.reg}): ${s.flags}`
  );
  dispatch.addEntry('flags', 0x81,
    `if(${flagBranches.join('; ')}; else: var(--__1flags))`,
    `Group 81 flags`);

  dispatch.addEntry('IP', 0x81,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + 2)`,
    `Group 81`);
}

/**
 * Group 0x83: ALU r/m16, sign-extended imm8
 * Same sub-operations as 0x81 but immediate is sign-extended from 8 to 16 bits.
 */
export function emitGroup_83(dispatch) {
  // immByte sign-extended to 16 bits: --u2s1(var(--immByte)) gives signed value
  // But we need unsigned 16-bit for the operation: (immByte >= 128) ? immByte | 0xFF00 : immByte
  // In CSS: immByte + bit(immByte, 7) * 65280
  const sext = `calc(var(--immByte) + --bit(var(--immByte), 7) * 65280)`;

  const subOps = [
    { reg: 0, name: 'ADD', result: `--lowerBytes(calc(var(--rmVal16) + ${sext}), 16)`, flags: pKeep(`--addFlags16(var(--rmVal16), ${sext})`, 1792), writes: true },
    { reg: 1, name: 'OR',  result: `--or(var(--rmVal16), ${sext})`, flags: pKeep(`--orFlags16(var(--rmVal16), ${sext})`), writes: true },
    { reg: 2, name: 'ADC', result: `--lowerBytes(calc(var(--rmVal16) + ${sext} + var(--_cf)), 16)`, flags: pKeep(`--adcFlags16(var(--rmVal16), ${sext}, var(--_cf))`, 1792), writes: true },
    { reg: 3, name: 'SBB', result: `--lowerBytes(calc(var(--rmVal16) - ${sext} - var(--_cf) + 65536), 16)`, flags: pKeep(`--sbbFlags16(var(--rmVal16), ${sext}, var(--_cf))`, 1792), writes: true },
    { reg: 4, name: 'AND', result: `--and(var(--rmVal16), ${sext})`, flags: pKeep(`--andFlags16(var(--rmVal16), ${sext})`), writes: true },
    { reg: 5, name: 'SUB', result: `--lowerBytes(calc(var(--rmVal16) - ${sext} + 65536), 16)`, flags: pKeep(`--subFlags16(var(--rmVal16), ${sext})`, 1792), writes: true },
    { reg: 6, name: 'XOR', result: `--xor(var(--rmVal16), ${sext})`, flags: pKeep(`--xorFlags16(var(--rmVal16), ${sext})`), writes: true },
    { reg: 7, name: 'CMP', result: null, flags: pKeep(`--subFlags16(var(--rmVal16), ${sext})`, 1792), writes: false },
  ];

  for (let r = 0; r < 8; r++) {
    const branches = subOps.filter(s => s.writes).map(s =>
      `style(--mod: 3) and style(--rm: ${r}) and style(--reg: ${s.reg}): ${s.result}`
    );
    dispatch.addEntry(REG16[r], 0x83,
      `if(${branches.join('; ')}; else: var(--__1${REG16[r]}))`,
      `Group 83 r/m16,sximm8 → ${REG16[r]}`);
  }

  // Memory writes
  const memLoBranches = subOps.filter(s => s.writes).map(s =>
    `style(--reg: ${s.reg}): --lowerBytes(${s.result}, 8)`
  );
  dispatch.addMemWrite(0x83,
    `if(style(--mod: 3): -1; style(--reg: 7): -1; else: var(--ea))`,
    `if(${memLoBranches.join('; ')}; else: 0)`,
    `Group 83 → mem lo`);
  const memHiBranches = subOps.filter(s => s.writes).map(s =>
    `style(--reg: ${s.reg}): --rightShift(${s.result}, 8)`
  );
  dispatch.addMemWrite(0x83,
    `if(style(--mod: 3): -1; style(--reg: 7): -1; else: calc(var(--ea) + 1))`,
    `if(${memHiBranches.join('; ')}; else: 0)`,
    `Group 83 → mem hi`);

  const flagBranches = subOps.map(s =>
    `style(--reg: ${s.reg}): ${s.flags}`
  );
  dispatch.addEntry('flags', 0x83,
    `if(${flagBranches.join('; ')}; else: var(--__1flags))`,
    `Group 83 flags`);

  dispatch.addEntry('IP', 0x83,
    `calc(var(--__1IP) + 2 + var(--modrmExtra) + 1)`,
    `Group 83`);
}

/**
 * Group 0xFF: word operations on r/m16
 * reg=0: INC r/m16
 * reg=1: DEC r/m16
 * reg=2: CALL near indirect (IP = r/m16, push old IP)
 * reg=3: CALL FAR indirect (push CS+IP, load CS:IP from [EA])
 * reg=4: JMP near indirect (IP = r/m16)
 * reg=5: JMP FAR indirect (load CS:IP from [EA])
 * reg=6: PUSH r/m16
 */
export function emitGroup_FF(dispatch) {
  // Registers that can be INC/DEC targets (mod=11):
  // All 8 regs. But SP also affected by CALL (push) and PUSH.
  // Handle SP separately from others.

  for (let r = 0; r < 8; r++) {
    if (r === 4) continue; // SP handled separately
    const regName = REG16[r];
    dispatch.addEntry(regName, 0xFF,
      `if(` +
      `style(--reg: 0) and style(--mod: 3) and style(--rm: ${r}): --lowerBytes(calc(var(--rmVal16) + 1), 16); ` +
      `style(--reg: 1) and style(--mod: 3) and style(--rm: ${r}): --lowerBytes(calc(var(--rmVal16) - 1 + 65536), 16); ` +
      `else: var(--__1${regName}))`,
      `Group FF INC/DEC → ${regName}`);
  }

  // SP: INC SP (reg=0,mod=3,rm=4), DEC SP (reg=1,mod=3,rm=4),
  //     CALL near indirect (reg=2, SP-=2), CALL FAR indirect (reg=3, SP-=4),
  //     PUSH r/m (reg=6, SP-=2)
  dispatch.addEntry('SP', 0xFF,
    `if(` +
    `style(--reg: 0) and style(--mod: 3) and style(--rm: 4): --lowerBytes(calc(var(--rmVal16) + 1), 16); ` +
    `style(--reg: 1) and style(--mod: 3) and style(--rm: 4): --lowerBytes(calc(var(--rmVal16) - 1 + 65536), 16); ` +
    `style(--reg: 2): calc(var(--__1SP) - 2); ` +
    `style(--reg: 3): calc(var(--__1SP) - 4); ` +
    `style(--reg: 6): calc(var(--__1SP) - 2); ` +
    `else: var(--__1SP))`,
    `Group FF SP`);

  // CS: only CALL FAR indirect (reg=3) and JMP FAR indirect (reg=5) change CS.
  // New CS = word at [EA+2] = read2(ea+2)
  dispatch.addEntry('CS', 0xFF,
    `if(` +
    `style(--reg: 3): --read2(calc(var(--ea) + 2)); ` +
    `style(--reg: 5): --read2(calc(var(--ea) + 2)); ` +
    `else: var(--__1CS))`,
    `Group FF CS`);

  // Memory writes:
  // INC/DEC to memory (mod!=3): write result back (slots 0-1)
  // CALL near indirect (reg=2): push return address (slots 0-1)
  // CALL FAR indirect (reg=3): push CS (slots 0-1), push return IP (slots 2-3)
  // PUSH (reg=6): push the r/m value (slots 0-1)

  const ssBase = `var(--__1SS) * 16`;
  const retIP = `calc(var(--__1IP) + var(--prefixLen) + 2 + var(--modrmExtra))`;

  // Slot 0: INC/DEC mem lo, CALL near push lo, CALL FAR push CS lo, PUSH push lo
  dispatch.addMemWrite(0xFF,
    `if(` +
    `style(--mod: 3) and style(--reg: 0): -1; ` +
    `style(--mod: 3) and style(--reg: 1): -1; ` +
    `style(--reg: 0): var(--ea); ` +
    `style(--reg: 1): var(--ea); ` +
    `style(--reg: 2): calc(${ssBase} + var(--__1SP) - 2); ` +
    `style(--reg: 3): calc(${ssBase} + var(--__1SP) - 2); ` +
    `style(--reg: 6): calc(${ssBase} + var(--__1SP) - 2); ` +
    `else: -1)`,
    `if(` +
    `style(--reg: 0): --lowerBytes(calc(var(--rmVal16) + 1), 8); ` +
    `style(--reg: 1): --lowerBytes(calc(var(--rmVal16) - 1 + 65536), 8); ` +
    `style(--reg: 2): --lowerBytes(${retIP}, 8); ` +
    `style(--reg: 3): --lowerBytes(var(--__1CS), 8); ` +
    `style(--reg: 6): --lowerBytes(var(--rmVal16), 8); ` +
    `else: 0)`,
    `Group FF mem/push lo`);

  // Slot 1: INC/DEC mem hi, CALL near push hi, CALL FAR push CS hi, PUSH push hi
  dispatch.addMemWrite(0xFF,
    `if(` +
    `style(--mod: 3) and style(--reg: 0): -1; ` +
    `style(--mod: 3) and style(--reg: 1): -1; ` +
    `style(--reg: 0): calc(var(--ea) + 1); ` +
    `style(--reg: 1): calc(var(--ea) + 1); ` +
    `style(--reg: 2): calc(${ssBase} + var(--__1SP) - 1); ` +
    `style(--reg: 3): calc(${ssBase} + var(--__1SP) - 1); ` +
    `style(--reg: 6): calc(${ssBase} + var(--__1SP) - 1); ` +
    `else: -1)`,
    `if(` +
    `style(--reg: 0): --rightShift(--lowerBytes(calc(var(--rmVal16) + 1), 16), 8); ` +
    `style(--reg: 1): --rightShift(--lowerBytes(calc(var(--rmVal16) - 1 + 65536), 16), 8); ` +
    `style(--reg: 2): --rightShift(${retIP}, 8); ` +
    `style(--reg: 3): --rightShift(var(--__1CS), 8); ` +
    `style(--reg: 6): --rightShift(var(--rmVal16), 8); ` +
    `else: 0)`,
    `Group FF mem/push hi`);

  // Slots 2-3: CALL FAR indirect push return IP (only reg=3 uses these)
  dispatch.addMemWrite(0xFF,
    `if(style(--reg: 3): calc(${ssBase} + var(--__1SP) - 4); else: -1)`,
    `if(style(--reg: 3): --lowerBytes(${retIP}, 8); else: 0)`,
    `Group FF CALL FAR push IP lo`);

  dispatch.addMemWrite(0xFF,
    `if(style(--reg: 3): calc(${ssBase} + var(--__1SP) - 3); else: -1)`,
    `if(style(--reg: 3): --rightShift(${retIP}, 8); else: 0)`,
    `Group FF CALL FAR push IP hi`);

  // Flags: INC/DEC set flags (preserving CF), others don't
  dispatch.addEntry('flags', 0xFF,
    `if(` +
    `style(--reg: 0): --incFlags16(var(--rmVal16), --lowerBytes(calc(var(--rmVal16) + 1), 16), var(--__1flags)); ` +
    `style(--reg: 1): --decFlags16(var(--rmVal16), --lowerBytes(calc(var(--rmVal16) - 1 + 65536), 16), var(--__1flags)); ` +
    `else: var(--__1flags))`,
    `Group FF flags`);

  // IP: CALL near/JMP near use rmVal16, CALL FAR/JMP FAR also use rmVal16.
  // rmVal16 is an absolute address — subtract prefixLen to cancel the
  // automatic calc(... + prefixLen) wrapper that emitRegisterDispatch adds.
  dispatch.addEntry('IP', 0xFF,
    `if(` +
    `style(--reg: 2): calc(var(--rmVal16) - var(--prefixLen)); ` +
    `style(--reg: 3): calc(var(--rmVal16) - var(--prefixLen)); ` +
    `style(--reg: 4): calc(var(--rmVal16) - var(--prefixLen)); ` +
    `style(--reg: 5): calc(var(--rmVal16) - var(--prefixLen)); ` +
    `else: calc(var(--__1IP) + 2 + var(--modrmExtra)))`,
    `Group FF IP`);
}

export function emitAllGroups(dispatch) {
  emitGroup_FE(dispatch);
  emitGroup_F7(dispatch);
  emitGroup_F6(dispatch);
  emitGroup_80(dispatch);
  emitGroup_81(dispatch);
  emitGroup_83(dispatch);
  emitGroup_FF(dispatch);
}
