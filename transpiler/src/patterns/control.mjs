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
      `--lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + ${taken} * --u2s1(var(--q1))), 16)`,
      `${name} short`);
  }
}

/**
 * JMP short (0xEB): IP = IP + 2 + sign_extend(rel8)
 */
export function emitJMP_short(dispatch) {
  dispatch.addEntry('IP', 0xEB,
    `--lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + --u2s1(var(--q1))), 16)`,
    `JMP short`);
}

/**
 * JMP near (0xE9): IP = IP + 3 + sign_extend(rel16)
 */
export function emitJMP_near(dispatch) {
  dispatch.addEntry('IP', 0xE9,
    `--lowerBytes(calc(var(--__1IP) + 3 + var(--prefixLen) + --u2s2(calc(var(--q1) + var(--q2) * 256))), 16)`,
    `JMP near`);
}

/**
 * CALL near (0xE8): push IP+3, then IP = IP + 3 + sign_extend(rel16)
 * Uses 2 memory write slots for the push (low byte, high byte of return address).
 * SP decreases by 2.
 */
export function emitCALL_near(dispatch) {
  // CALL near (0xE8): 2 μops — push return address, jump.
  // Return address = IP + 3 (after the 3-byte CALL instruction)
  const retAddr = `calc(var(--__1IP) + 3 + var(--prefixLen))`;

  // μop 0: SP -= 2, write retAddr lo at SS:(origSP-2)
  dispatch.addEntry('SP', 0xE8,
    `calc(var(--__1SP) - 2)`,
    `CALL near (SP-=2)`, 0);
  dispatch.addMemWrite(0xE8,
    `calc(var(--__1SS) * 16 + var(--__1SP) - 2)`,
    `--lowerBytes(${retAddr}, 8)`,
    `CALL near push ret lo`, 0);

  // μop 1: write retAddr hi at SS:(origSP-1) = SS:(__1SP+1), jump, retire
  dispatch.addMemWrite(0xE8,
    `calc(var(--__1SS) * 16 + var(--__1SP) + 1)`,
    `--rightShift(${retAddr}, 8)`,
    `CALL near push ret hi`, 1);
  dispatch.addEntry('IP', 0xE8,
    `--lowerBytes(calc(var(--__1IP) + 3 + var(--prefixLen) + --u2s2(calc(var(--q1) + var(--q2) * 256))), 16)`,
    `CALL near`, 1);
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
  // INT imm8 (0xCD): 6 μops, one memory write per cycle.
  //
  // μop 0: SP -= 6, write FLAGS lo at SS:(origSP-2)
  // μop 1: write FLAGS hi at SS:(origSP-1)
  // μop 2: write CS lo at SS:(origSP-4)
  // μop 3: write CS hi at SS:(origSP-3)
  // μop 4: write retIP lo at SS:(origSP-6)
  // μop 5: write retIP hi at SS:(origSP-5), load CS:IP from IVT, clear IF+TF, retire
  //
  // FLAGS clearing deferred to μop 5 so μops 0-1 can read original flags from --__1flags.
  // Nothing in the INT sequence observes the cleared flags before retirement.

  const ssBase = `var(--__1SS) * 16`;

  // μop 0: SP -= 6, write FLAGS lo
  // --__1SP is original SP. Write at SS:(origSP - 2).
  dispatch.addEntry('SP', 0xCD, `calc(var(--__1SP) - 6)`, `INT (SP-=6)`, 0);
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1flags), 8)`,
    `INT push FLAGS lo`, 0);

  // μop 1: write FLAGS hi
  // --__1SP = origSP-6. origSP-1 = __1SP+5.
  // --__1flags still has IF+TF (clearing deferred).
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) + 5)`,
    `--rightShift(var(--__1flags), 8)`,
    `INT push FLAGS hi`, 1);

  // μop 2: write CS lo
  // origSP-4 = __1SP+2
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) + 2)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `INT push CS lo`, 2);

  // μop 3: write CS hi
  // origSP-3 = __1SP+3
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) + 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `INT push CS hi`, 3);

  // μop 4: write retIP lo (return address = origIP+2)
  // origSP-6 = __1SP. --__1IP is still original IP (IP hasn't changed).
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP))`,
    `--lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen)), 8)`,
    `INT push IP lo`, 4);

  // μop 5: write retIP hi, load CS:IP from IVT, clear IF+TF, retire
  // origSP-5 = __1SP+1
  dispatch.addMemWrite(0xCD,
    `calc(${ssBase} + var(--__1SP) + 1)`,
    `--rightShift(calc(var(--__1IP) + 2 + var(--prefixLen)), 8)`,
    `INT push IP hi`, 5);
  dispatch.addEntry('IP', 0xCD,
    `--read2(calc(var(--q1) * 4))`,
    `INT load IP from IVT`, 5);
  dispatch.addEntry('CS', 0xCD,
    `--read2(calc(var(--q1) * 4 + 2))`,
    `INT load CS from IVT`, 5);
  dispatch.addEntry('flags', 0xCD,
    `--and(var(--__1flags), 64767)`,
    `INT clear IF+TF`, 5);
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
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2 + var(--prefixLen)); else: --lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + --u2s1(var(--q1))), 16))`,
    `LOOP`);
}

/**
 * LOOPE/LOOPZ (0xE1): decrement CX, jump if CX != 0 AND ZF=1
 */
export function emitLOOPE(dispatch) {
  const newCX = `--lowerBytes(calc(var(--__1CX) - 1 + 65536), 16)`;
  dispatch.addEntry('CX', 0xE1, newCX, `LOOPE (CX-=1)`);
  dispatch.addEntry('IP', 0xE1,
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2 + var(--prefixLen)); else: if(style(--_zf: 0): calc(var(--__1IP) + 2 + var(--prefixLen)); else: --lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + --u2s1(var(--q1))), 16)))`,
    `LOOPE`);
}

/**
 * LOOPNE/LOOPNZ (0xE0): decrement CX, jump if CX != 0 AND ZF=0
 */
export function emitLOOPNE(dispatch) {
  const newCX = `--lowerBytes(calc(var(--__1CX) - 1 + 65536), 16)`;
  dispatch.addEntry('CX', 0xE0, newCX, `LOOPNE (CX-=1)`);
  dispatch.addEntry('IP', 0xE0,
    `if(style(--_loopCX: 0): calc(var(--__1IP) + 2 + var(--prefixLen)); else: if(style(--_zf: 1): calc(var(--__1IP) + 2 + var(--prefixLen)); else: --lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + --u2s1(var(--q1))), 16)))`,
    `LOOPNE`);
}

/**
 * JCXZ (0xE3): jump if CX = 0
 */
export function emitJCXZ(dispatch) {
  dispatch.addEntry('IP', 0xE3,
    `if(style(--__1CX: 0): --lowerBytes(calc(var(--__1IP) + 2 + var(--prefixLen) + --u2s1(var(--q1))), 16); else: calc(var(--__1IP) + 2 + var(--prefixLen)))`,
    `JCXZ`);
}

/**
 * CALL far (0x9A): push CS, push IP+5, load CS:IP from immediate.
 * Format: 0x9A, IP_lo, IP_hi, CS_lo, CS_hi (5 bytes)
 */
export function emitCALL_far(dispatch) {
  // CALL far (0x9A): 4 μops — push CS, push IP+5, load CS:IP.
  // Format: 0x9A, IP_lo, IP_hi, CS_lo, CS_hi (5 bytes)
  //
  // Stack layout after SP-=4:
  //   [SP+0,SP+1] = return IP (lower address)
  //   [SP+2,SP+3] = old CS    (higher address)

  const ssBase = `var(--__1SS) * 16`;

  // μop 0: SP -= 4, write CS lo at SS:(origSP-2)
  dispatch.addEntry('SP', 0x9A, `calc(var(--__1SP) - 4)`, `CALL far (SP-=4)`, 0);
  dispatch.addMemWrite(0x9A,
    `calc(${ssBase} + var(--__1SP) - 2)`,
    `--lowerBytes(var(--__1CS), 8)`,
    `CALL far push CS lo`, 0);

  // μop 1: write CS hi at SS:(origSP-1) = SS:(__1SP+3)
  dispatch.addMemWrite(0x9A,
    `calc(${ssBase} + var(--__1SP) + 3)`,
    `--rightShift(var(--__1CS), 8)`,
    `CALL far push CS hi`, 1);

  // μop 2: write retIP lo at SS:(origSP-4) = SS:(__1SP)
  // --__1IP is still original IP (hasn't changed)
  dispatch.addMemWrite(0x9A,
    `calc(${ssBase} + var(--__1SP))`,
    `--lowerBytes(calc(var(--__1IP) + 5 + var(--prefixLen)), 8)`,
    `CALL far push IP lo`, 2);

  // μop 3: write retIP hi at SS:(origSP-3) = SS:(__1SP+1), load CS:IP, retire
  dispatch.addMemWrite(0x9A,
    `calc(${ssBase} + var(--__1SP) + 1)`,
    `--rightShift(calc(var(--__1IP) + 5 + var(--prefixLen)), 8)`,
    `CALL far push IP hi`, 3);
  dispatch.addEntry('IP', 0x9A,
    `calc(var(--q1) + var(--q2) * 256)`,
    `CALL far load IP`, 3);
  dispatch.addEntry('CS', 0x9A,
    `calc(var(--q3) + var(--q4) * 256)`,
    `CALL far load CS`, 3);
}

/**
 * RET far (0xCB): pop IP, pop CS.
 */
export function emitRET_far(dispatch) {
  const ssBase = `calc(var(--__1SS) * 16)`;
  dispatch.addEntry('IP', 0xCB,
    `--read2(calc(${ssBase} + var(--__1SP)))`,
    `RET far pop IP`);
  dispatch.addEntry('CS', 0xCB,
    `--read2(calc(${ssBase} + var(--__1SP) + 2))`,
    `RET far pop CS`);
  dispatch.addEntry('SP', 0xCB,
    `calc(var(--__1SP) + 4)`,
    `RET far (SP+=4)`);
}

/**
 * RET far imm16 (0xCA): pop IP, pop CS, then SP += imm16.
 */
export function emitRET_far_imm(dispatch) {
  const ssBase = `calc(var(--__1SS) * 16)`;
  dispatch.addEntry('IP', 0xCA,
    `--read2(calc(${ssBase} + var(--__1SP)))`,
    `RET far imm pop IP`);
  dispatch.addEntry('CS', 0xCA,
    `--read2(calc(${ssBase} + var(--__1SP) + 2))`,
    `RET far imm pop CS`);
  dispatch.addEntry('SP', 0xCA,
    `calc(var(--__1SP) + 4 + var(--q1) + var(--q2) * 256)`,
    `RET far imm (SP+=4+imm16)`);
}

/**
 * JMP far (0xEA): load CS:IP from immediate.
 * Format: 0xEA, IP_lo, IP_hi, CS_lo, CS_hi (5 bytes)
 */
export function emitJMP_far(dispatch) {
  dispatch.addEntry('IP', 0xEA,
    `calc(var(--q1) + var(--q2) * 256)`,
    `JMP far load IP`);
  dispatch.addEntry('CS', 0xEA,
    `calc(var(--q3) + var(--q4) * 256)`,
    `JMP far load CS`);
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
  emitCALL_far(dispatch);
  emitRET_far(dispatch);
  emitRET_far_imm(dispatch);
  emitJMP_far(dispatch);
}
