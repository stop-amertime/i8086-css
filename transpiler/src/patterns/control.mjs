// Control flow: JMP, Jcc, CALL, RET, LOOP

// Flag bit positions for condition checks
// CF=bit0, PF=bit2, AF=bit4, ZF=bit6, SF=bit7, OF=bit11

/**
 * Conditional jump condition expressions.
 * Each maps an opcode to a CSS expression that evaluates to 1 if the jump
 * should be taken, 0 otherwise. Uses --bit() on the flags register.
 */
const JCC_CONDITIONS = [
  // 0x70: JO  — OF=1
  { opcode: 0x70, name: 'JO',   taken: `--bit(var(--__1flags), 11)` },
  // 0x71: JNO — OF=0
  { opcode: 0x71, name: 'JNO',  taken: `calc(1 - --bit(var(--__1flags), 11))` },
  // 0x72: JB/JC — CF=1
  { opcode: 0x72, name: 'JB',   taken: `--bit(var(--__1flags), 0)` },
  // 0x73: JNB/JNC — CF=0
  { opcode: 0x73, name: 'JNB',  taken: `calc(1 - --bit(var(--__1flags), 0))` },
  // 0x74: JZ/JE — ZF=1
  { opcode: 0x74, name: 'JZ',   taken: `--bit(var(--__1flags), 6)` },
  // 0x75: JNZ/JNE — ZF=0
  { opcode: 0x75, name: 'JNZ',  taken: `calc(1 - --bit(var(--__1flags), 6))` },
  // 0x76: JBE/JNA — CF=1 or ZF=1
  { opcode: 0x76, name: 'JBE',  taken: `min(1, calc(--bit(var(--__1flags), 0) + --bit(var(--__1flags), 6)))` },
  // 0x77: JA/JNBE — CF=0 and ZF=0
  { opcode: 0x77, name: 'JA',   taken: `calc((1 - --bit(var(--__1flags), 0)) * (1 - --bit(var(--__1flags), 6)))` },
  // 0x78: JS — SF=1
  { opcode: 0x78, name: 'JS',   taken: `--bit(var(--__1flags), 7)` },
  // 0x79: JNS — SF=0
  { opcode: 0x79, name: 'JNS',  taken: `calc(1 - --bit(var(--__1flags), 7))` },
  // 0x7A: JP/JPE — PF=1
  { opcode: 0x7A, name: 'JP',   taken: `--bit(var(--__1flags), 2)` },
  // 0x7B: JNP/JPO — PF=0
  { opcode: 0x7B, name: 'JNP',  taken: `calc(1 - --bit(var(--__1flags), 2))` },
  // 0x7C: JL/JNGE — SF!=OF
  { opcode: 0x7C, name: 'JL',   taken: `calc(--bit(var(--__1flags), 7) + --bit(var(--__1flags), 11) - 2 * --bit(var(--__1flags), 7) * --bit(var(--__1flags), 11))` },
  // 0x7D: JGE/JNL — SF=OF
  { opcode: 0x7D, name: 'JGE',  taken: `calc(1 - --bit(var(--__1flags), 7) - --bit(var(--__1flags), 11) + 2 * --bit(var(--__1flags), 7) * --bit(var(--__1flags), 11))` },
  // 0x7E: JLE/JNG — ZF=1 or SF!=OF
  { opcode: 0x7E, name: 'JLE',  taken: `min(1, calc(--bit(var(--__1flags), 6) + --bit(var(--__1flags), 7) + --bit(var(--__1flags), 11) - 2 * --bit(var(--__1flags), 7) * --bit(var(--__1flags), 11)))` },
  // 0x7F: JG/JNLE — ZF=0 and SF=OF
  { opcode: 0x7F, name: 'JG',   taken: `calc((1 - --bit(var(--__1flags), 6)) * (1 - --bit(var(--__1flags), 7) - --bit(var(--__1flags), 11) + 2 * --bit(var(--__1flags), 7) * --bit(var(--__1flags), 11)))` },
];

/**
 * All conditional jumps (Jcc): 0x70-0x7F
 * Format: opcode, rel8 — 2-byte instruction
 * IP = IP + 2 + (condition ? sign_extend(rel8) : 0)
 */
export function emitJcc(dispatch) {
  for (const { opcode, name, taken } of JCC_CONDITIONS) {
    // rel8 is at q1, sign-extended
    // If taken: IP = IP + 2 + sign_extend(q1)
    // If not taken: IP = IP + 2
    // Combined: IP = IP + 2 + taken * sign_extend(q1)
    dispatch.addEntry('IP', opcode,
      `--lowerBytes(calc(var(--__1IP) + 2 + ${taken} * --u2s1(var(--q1))), 16)`,
      `${name} short`);
  }
}

/**
 * JMP short (0xEB): IP = IP + 2 + sign_extend(rel8)
 */
export function emitJMP_short(dispatch) {
  dispatch.addEntry('IP', 0xEB,
    `--lowerBytes(calc(var(--__1IP) + 2 + --u2s1(var(--q1))), 16)`,
    `JMP short`);
}

/**
 * JMP near (0xE9): IP = IP + 3 + sign_extend(rel16)
 */
export function emitJMP_near(dispatch) {
  dispatch.addEntry('IP', 0xE9,
    `--lowerBytes(calc(var(--__1IP) + 3 + --u2s2(calc(var(--q1) + var(--q2) * 256))), 16)`,
    `JMP near`);
}

/**
 * CALL near (0xE8): push IP+3, then IP = IP + 3 + sign_extend(rel16)
 * Uses 2 memory write slots for the push (low byte, high byte of return address).
 * SP decreases by 2.
 */
export function emitCALL_near(dispatch) {
  // Return address = IP + 3 (after the 3-byte CALL instruction)
  const retAddr = `calc(var(--__1IP) + 3)`;
  // New SP = SP - 2
  dispatch.addEntry('SP', 0xE8,
    `calc(var(--__1SP) - 2)`,
    `CALL near (SP-=2)`);
  // Push return address to stack: write at SS:SP (after decrement)
  // low byte at SS*16 + SP-2, high byte at SS*16 + SP-1
  dispatch.addMemWrite(0xE8,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
    `--lowerBytes(${retAddr}, 8)`,
    `CALL near push ret lo`);
  dispatch.addMemWrite(0xE8,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 1)`,
    `--rightShift(${retAddr}, 8)`,
    `CALL near push ret hi`);
  // Jump
  dispatch.addEntry('IP', 0xE8,
    `--lowerBytes(calc(var(--__1IP) + 3 + --u2s2(calc(var(--q1) + var(--q2) * 256))), 16)`,
    `CALL near`);
}

/**
 * RET near (0xC3): pop IP from stack. SP += 2.
 */
export function emitRET(dispatch) {
  // Read return address from SS:SP
  dispatch.addEntry('IP', 0xC3,
    `--read2(calc(var(--__1SS) * 16 + var(--__1SP)))`,
    `RET near`);
  dispatch.addEntry('SP', 0xC3,
    `calc(var(--__1SP) + 2)`,
    `RET near (SP+=2)`);
}

/**
 * RET near imm16 (0xC2): pop IP, then SP += imm16
 */
export function emitRET_imm(dispatch) {
  dispatch.addEntry('IP', 0xC2,
    `--read2(calc(var(--__1SS) * 16 + var(--__1SP)))`,
    `RET imm16`);
  dispatch.addEntry('SP', 0xC2,
    `calc(var(--__1SP) + 2 + var(--q1) + var(--q2) * 256)`,
    `RET imm16 (SP+=2+imm16)`);
}

/**
 * INT imm8 (0xCD): software interrupt.
 * Push FLAGS, clear IF+TF, push CS, push IP+2, load IP+CS from IVT.
 * Uses 6 memory write slots (3 word pushes).
 */
export function emitINT(dispatch) {
  // Interrupt number is at q1 (byte after opcode)
  // IVT entry at intNum * 4: 2 bytes IP, 2 bytes CS
  // Stack: SP -= 6 (push FLAGS, CS, IP+2)

  dispatch.addEntry('SP', 0xCD, `calc(var(--__1SP) - 6)`, `INT (SP-=6)`);

  // New IP from IVT: read2(intNum * 4)
  dispatch.addEntry('IP', 0xCD,
    `--read2(calc(var(--q1) * 4))`,
    `INT load IP from IVT`);

  // New CS from IVT: read2(intNum * 4 + 2)
  dispatch.addEntry('CS', 0xCD,
    `--read2(calc(var(--q1) * 4 + 2))`,
    `INT load CS from IVT`);

  // FLAGS: clear IF (bit 9) and TF (bit 8) — keep other bits
  // new flags = old flags & ~0x0300 = old flags & 0xFCFF
  // But this is the pushed value; the new flags register value has IF+TF cleared
  dispatch.addEntry('flags', 0xCD,
    `--and(var(--__1flags), 64767)`,
    `INT clear IF+TF`);
  // 64767 = 0xFCFF = ~(IF|TF) & 0xFFFF

  const ssBase = `calc(var(--__1SS) * 16)`;
  const retIP = `calc(var(--__1IP) + 2)`;

  // 8086 INT pushes: FLAGS first (to highest addr), then CS, then IP (to lowest addr)
  // After SP -= 6, stack layout is:
  //   [SP+0, SP+1] = return IP   (pushed last)
  //   [SP+2, SP+3] = CS          (pushed second)
  //   [SP+4, SP+5] = FLAGS       (pushed first)

  // Push FLAGS (at SP-2, SP-1) — pushed first, goes to highest address
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INT push FLAGS lo`);
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 1)`,
    `--rightShift(var(--__1flags), 8)`,
    `INT push FLAGS hi`);

  // Push CS (at SP-4, SP-3)
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 4)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INT push CS lo`);
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `INT push CS hi`);

  // Push return IP (at SP-6, SP-5) — pushed last, goes to lowest address
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 6)`,
    `--lowerBytes(${retIP}, 8)`,
    `INT push IP lo`);
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 5)`,
    `--rightShift(${retIP}, 8)`,
    `INT push IP hi`);
}

/**
 * IRET (0xCF): pop IP, pop CS, pop FLAGS.
 * SP += 6.
 */
export function emitIRET(dispatch) {
  const ssBase = `calc(var(--__1SS) * 16)`;

  // Pop IP from SP+0
  dispatch.addEntry('IP', 0xCF,
    `--read2(calc(${ssBase} + var(--__1SP)))`,
    `IRET pop IP`);
  // Pop CS from SP+2
  dispatch.addEntry('CS', 0xCF,
    `--read2(calc(${ssBase} + var(--__1SP) + 2))`,
    `IRET pop CS`);
  // Pop FLAGS from SP+4 (masked + bit 1 forced on)
  // Mask 0x0FD5 = 4053 preserves CF,PF,AF,ZF,SF,TF,IF,DF,OF but clears bit 1,3,5,12-15
  // Then + 2 forces bit 1 (reserved, always 1). Safe because bit 1 was cleared by mask.
  dispatch.addEntry('flags', 0xCF,
    `calc(--and(var(--_stackWord2), 4053) + 2)`,
    `IRET pop FLAGS`);
  dispatch.addEntry('SP', 0xCF,
    `calc(var(--__1SP) + 6)`,
    `IRET (SP+=6)`);
}

/**
 * LOOP (0xE2): decrement CX, jump if CX != 0
 */
export function emitLOOP(dispatch) {
  const newCX = `--lowerBytes(calc(var(--__1CX) - 1 + 65536), 16)`;
  dispatch.addEntry('CX', 0xE2, newCX, `LOOP (CX-=1)`);
  // IP = IP + 2 + (CX-1 != 0 ? rel8 : 0)
  // We need to check if the NEW CX is zero
  dispatch.addEntry('IP', 0xE2,
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2); else: --lowerBytes(calc(var(--__1IP) + 2 + --u2s1(var(--q1))), 16))`,
    `LOOP`);
}

/**
 * LOOPE/LOOPZ (0xE1): decrement CX, jump if CX != 0 AND ZF=1
 */
export function emitLOOPE(dispatch) {
  const newCX = `--lowerBytes(calc(var(--__1CX) - 1 + 65536), 16)`;
  dispatch.addEntry('CX', 0xE1, newCX, `LOOPE (CX-=1)`);
  dispatch.addEntry('IP', 0xE1,
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2); else: if(style(--_zf: 0): calc(var(--__1IP) + 2); else: --lowerBytes(calc(var(--__1IP) + 2 + --u2s1(var(--q1))), 16)))`,
    `LOOPE`);
}

/**
 * LOOPNE/LOOPNZ (0xE0): decrement CX, jump if CX != 0 AND ZF=0
 */
export function emitLOOPNE(dispatch) {
  const newCX = `--lowerBytes(calc(var(--__1CX) - 1 + 65536), 16)`;
  dispatch.addEntry('CX', 0xE0, newCX, `LOOPNE (CX-=1)`);
  dispatch.addEntry('IP', 0xE0,
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2); else: if(style(--_zf: 1): calc(var(--__1IP) + 2); else: --lowerBytes(calc(var(--__1IP) + 2 + --u2s1(var(--q1))), 16)))`,
    `LOOPNE`);
}

/**
 * JCXZ (0xE3): jump if CX = 0
 */
export function emitJCXZ(dispatch) {
  dispatch.addEntry('IP', 0xE3,
    `if(style(--__1CX: 0): --lowerBytes(calc(var(--__1IP) + 2 + --u2s1(var(--q1))), 16); else: calc(var(--__1IP) + 2))`,
    `JCXZ`);
}

/**
 * Register all control flow opcodes.
 */
export function emitAllControl(dispatch) {
  emitJcc(dispatch);
  emitJMP_short(dispatch);
  emitJMP_near(dispatch);
  emitCALL_near(dispatch);
  emitRET(dispatch);
  emitRET_imm(dispatch);
  emitINT(dispatch);
  emitIRET(dispatch);
  emitLOOP(dispatch);
  emitLOOPE(dispatch);
  emitLOOPNE(dispatch);
  emitJCXZ(dispatch);
}
