// Stack operations: PUSH/POP reg16, PUSH/POP segreg, PUSHF, POPF

const REG16 = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'];

/**
 * PUSH reg16 (0x50-0x57)
 * SP -= 2, then write reg value to SS:SP
 * Special case: PUSH SP (0x54) pushes SP-2 (the value after decrement)
 */
export function emitPUSH_reg(dispatch) {
  for (let r = 0; r < 8; r++) {
    const opcode = 0x50 + r;
    const reg = REG16[r];

    // Value to push on μop 0: for PUSH SP, it's SP-2 (post-decrement value)
    const pushVal0 = r === 4
      ? `calc(var(--__1SP) - 2)`
      : `var(--__1${reg})`;

    // Value to push on μop 1: SP is already decremented, so for PUSH SP
    // --__1SP is already the pushed value. For other regs, value is stable.
    const pushVal1 = r === 4
      ? `var(--__1SP)`
      : `var(--__1${reg})`;

    // μop 0: SP -= 2, write low byte at SS:(SP-2)
    dispatch.addEntry('SP', opcode,
      `calc(var(--__1SP) - 2)`,
      `PUSH ${reg} (SP-=2)`, 0);
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
      `--lowerBytes(${pushVal0}, 8)`,
      `PUSH ${reg} lo`, 0);

    // μop 1: write high byte at SS:(origSP-1) = SS:(__1SP+1), retire
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) + 1)`,
      `--rightShift(${pushVal1}, 8)`,
      `PUSH ${reg} hi`, 1);

    // IP advances only on retirement (μop 1)
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `PUSH ${reg}`, 1);
  }
}

/**
 * POP reg16 (0x58-0x5F)
 * Read word from SS:SP, then SP += 2
 */
export function emitPOP_reg(dispatch) {
  for (let r = 0; r < 8; r++) {
    const opcode = 0x58 + r;
    const reg = REG16[r];

    // Read from stack
    dispatch.addEntry(reg, opcode,
      `--read2(calc(var(--__1SS) * 16 + var(--__1SP)))`,
      `POP ${reg}`);

    // SP += 2 (but if we're popping into SP, the popped value wins)
    if (r !== 4) {
      dispatch.addEntry('SP', opcode,
        `calc(var(--__1SP) + 2)`,
        `POP ${reg} (SP+=2)`);
    }
    // For POP SP (0x5C), SP gets the popped value directly (already handled above)

    // IP += 1
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `POP ${reg}`);
  }
}

/**
 * PUSH segreg (0x06=ES, 0x0E=CS, 0x16=SS, 0x1E=DS)
 */
export function emitPUSH_seg(dispatch) {
  const segs = [
    { opcode: 0x06, reg: 'ES' },
    { opcode: 0x0E, reg: 'CS' },
    { opcode: 0x16, reg: 'SS' },
    { opcode: 0x1E, reg: 'DS' },
  ];
  for (const { opcode, reg } of segs) {
    // μop 0: SP -= 2, write low byte
    dispatch.addEntry('SP', opcode,
      `calc(var(--__1SP) - 2)`,
      `PUSH ${reg} (SP-=2)`, 0);
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
      `--lowerBytes(var(--__1${reg}), 8)`,
      `PUSH ${reg} lo`, 0);

    // μop 1: write high byte at SS:(origSP-1) = SS:(__1SP+1), retire
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) + 1)`,
      `--rightShift(var(--__1${reg}), 8)`,
      `PUSH ${reg} hi`, 1);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `PUSH ${reg}`, 1);
  }
}

/**
 * POP segreg (0x07=ES, 0x0F=CS, 0x17=SS, 0x1F=DS)
 */
export function emitPOP_seg(dispatch) {
  const segs = [
    { opcode: 0x07, reg: 'ES' },
    { opcode: 0x0F, reg: 'CS' },
    { opcode: 0x17, reg: 'SS' },
    { opcode: 0x1F, reg: 'DS' },
  ];
  for (const { opcode, reg } of segs) {
    dispatch.addEntry(reg, opcode,
      `--read2(calc(var(--__1SS) * 16 + var(--__1SP)))`,
      `POP ${reg}`);
    dispatch.addEntry('SP', opcode,
      `calc(var(--__1SP) + 2)`,
      `POP ${reg} (SP+=2)`);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `POP ${reg}`);
  }
}

/**
 * PUSHF (0x9C): push flags register
 */
export function emitPUSHF(dispatch) {
  // μop 0: SP -= 2, write flags low byte
  dispatch.addEntry('SP', 0x9C,
    `calc(var(--__1SP) - 2)`,
    `PUSHF (SP-=2)`, 0);
  dispatch.addMemWrite(0x9C,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `PUSHF lo`, 0);

  // μop 1: write flags high byte, retire
  dispatch.addMemWrite(0x9C,
    `calc(var(--__1SS) * 16 + var(--__1SP) + 1)`,
    `--rightShift(var(--__1flags), 8)`,
    `PUSHF hi`, 1);
  dispatch.addEntry('IP', 0x9C, `calc(var(--__1IP) + 1)`, `PUSHF`, 1);
}

/**
 * POPF (0x9D): pop flags register (mask to valid bits + bit 1 always set)
 */
export function emitPOPF(dispatch) {
  // 0xFD5 = valid flag bits with bit 1 cleared. Then + 2 forces bit 1 on.
  dispatch.addEntry('flags', 0x9D,
    `calc(--and(var(--_stackWord0), 4053) + 2)`,
    `POPF`);
  dispatch.addEntry('SP', 0x9D,
    `calc(var(--__1SP) + 2)`,
    `POPF (SP+=2)`);
  dispatch.addEntry('IP', 0x9D, `calc(var(--__1IP) + 1)`, `POPF`);
}

/**
 * Register all stack opcodes.
 */
export function emitAllStack(dispatch) {
  emitPUSH_reg(dispatch);
  emitPOP_reg(dispatch);
  emitPUSH_seg(dispatch);
  emitPOP_seg(dispatch);
  emitPUSHF(dispatch);
  emitPOPF(dispatch);
}
