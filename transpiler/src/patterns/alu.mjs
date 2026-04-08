// ALU instruction emitters: ADD, SUB, CMP, AND, OR, XOR, ADC, SBB, etc.
// Phase 1: only ADD r/m16,reg16 (0x01) and ADD AX,imm16 (0x05) for test binary.

/**
 * ADD r/m16, reg16 (opcode 0x01): d=0, w=1
 * Adds reg to r/m. If mod=11, destination is a register; else memory.
 *
 * The test binary uses: ADD AX, BX (encoded as 01 D8 = ADD r/m16, reg16 with mod=11, rm=0, reg=3)
 */
export function emitADD_01(dispatch) {
  const regOrder16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];

  // Register destination (mod=11): rm selects destination, add regVal16
  for (let r = 0; r < 8; r++) {
    const reg = regOrder16[r];
    dispatch.addEntry(reg, 0x01,
      `if(style(--mod: 3) and style(--rm: ${r}): --lowerBytes(calc(var(--rmVal16) + var(--regVal16)), 16); else: var(--__1${reg}))`,
      `ADD r/m16, reg16 → ${reg} (if rm=${r})`);
  }

  // Memory write: if mod!=3, result goes to memory at ea (word)
  dispatch.addMemWrite(0x01,
    `if(style(--mod: 3): -1; else: var(--ea))`,
    `--lowerBytes(calc(var(--rmVal16) + var(--regVal16)), 8)`,
    `ADD r/m16, reg16 → mem low byte`);
  dispatch.addMemWrite(0x01,
    `if(style(--mod: 3): -1; else: calc(var(--ea) + 1))`,
    `--lowerBytes(--rightShift(calc(var(--rmVal16) + var(--regVal16)), 8), 8)`,
    `ADD r/m16, reg16 → mem high byte`);

  // IP: 2 + modrmExtra
  dispatch.addEntry('IP', 0x01, `calc(var(--__1IP) + 2 + var(--modrmExtra))`, `ADD r/m16, reg16`);

  // Flags: full ADD flags
  dispatch.addEntry('flags', 0x01,
    `--addFlags16(var(--rmVal16), var(--regVal16))`,
    `ADD r/m16, reg16 flags`);
}

/**
 * ADD r/m16, reg16 (opcode 0x00): d=0, w=0 — byte version
 */
export function emitADD_00(dispatch) {
  // Phase 2 — TODO
}

/**
 * ADD AX, imm16 (opcode 0x05)
 * 3-byte instruction: 05 imm16
 */
export function emitADD_AXimm16(dispatch) {
  dispatch.addEntry('AX', 0x05,
    `--lowerBytes(calc(var(--__1AX) + var(--imm16)), 16)`,
    `ADD AX, imm16`);
  dispatch.addEntry('IP', 0x05, `calc(var(--__1IP) + 3)`, `ADD AX, imm16`);
  dispatch.addEntry('flags', 0x05,
    `--addFlags16(var(--__1AX), var(--imm16))`,
    `ADD AX, imm16 flags`);
}

/**
 * ADD AL, imm8 (opcode 0x04)
 * 2-byte instruction: 04 imm8
 */
export function emitADD_ALimm8(dispatch) {
  dispatch.addEntry('AX', 0x04,
    `--mergelow(var(--__1AX), --lowerBytes(calc(var(--AL) + var(--imm8)), 8))`,
    `ADD AL, imm8`);
  dispatch.addEntry('IP', 0x04, `calc(var(--__1IP) + 2)`, `ADD AL, imm8`);
  dispatch.addEntry('flags', 0x04,
    `--addFlags8(var(--AL), var(--imm8))`,
    `ADD AL, imm8 flags`);
}
