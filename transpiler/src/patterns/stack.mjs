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

    // SP always decrements
    dispatch.addEntry('SP', opcode,
      `calc(var(--__1SP) - 2)`,
      `PUSH ${reg} (SP-=2)`);

    // Value to push: for PUSH SP, it's SP-2 (post-decrement value)
    const pushVal = r === 4
      ? `calc(var(--__1SP) - 2)`
      : `var(--__1${reg})`;

    // Memory write: low byte at SS:SP-2, high byte at SS:SP-1
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
      `--lowerBytes(${pushVal}, 8)`,
      `PUSH ${reg} lo`);
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 1)`,
      `--rightShift(--lowerBytes(${pushVal}, 16), 8)`,
      `PUSH ${reg} hi`);

    // IP += 1
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `PUSH ${reg}`);
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
    dispatch.addEntry('SP', opcode,
      `calc(var(--__1SP) - 2)`,
      `PUSH ${reg} (SP-=2)`);
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
      `--lowerBytes(var(--__1${reg}), 8)`,
      `PUSH ${reg} lo`);
    dispatch.addMemWrite(opcode,
      `calc(var(--__1SS) * 16 + var(--__1SP) - 1)`,
      `--rightShift(var(--__1${reg}), 8)`,
      `PUSH ${reg} hi`);
    dispatch.addEntry('IP', opcode, `calc(var(--__1IP) + 1)`, `PUSH ${reg}`);
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
  dispatch.addEntry('SP', 0x9C,
    `calc(var(--__1SP) - 2)`,
    `PUSHF (SP-=2)`);
  dispatch.addMemWrite(0x9C,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `PUSHF lo`);
  dispatch.addMemWrite(0x9C,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 1)`,
    `--rightShift(var(--__1flags), 8)`,
    `PUSHF hi`);
  dispatch.addEntry('IP', 0x9C, `calc(var(--__1IP) + 1)`, `PUSHF`);
}

/**
 * POPF (0x9D): pop flags register (mask to valid bits + bit 1 always set)
 */
export function emitPOPF(dispatch) {
  // 0xFD7 = all valid flag bits. Bit 1 always set.
  dispatch.addEntry('flags', 0x9D,
    `calc(--and(--read2(calc(var(--__1SS) * 16 + var(--__1SP))), 4055) + 2)`,
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
