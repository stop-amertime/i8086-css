// Per-instruction 8086 cycle counts.
//
// Each instruction increments --cycleCount by the real 8086 cycle cost.
// This drives accurate PIT timer derivation — the PIT counts down in
// real 8086 cycles, not in CSS ticks.

const CC = (n) => `calc(var(--__1cycleCount) + ${n})`;
const CC_MOD = (reg, mem) =>
  `calc(var(--__1cycleCount) + if(style(--mod: 3): ${reg}; else: ${mem}))`;

export function emitCycleCounts(dispatch) {
  const hold = `var(--__1cycleCount)`;

  // --- MOV ---
  for (const op of [0x88, 0x89]) {
    dispatch.addEntry('cycleCount', op, CC_MOD(2, 9), `MOV r/m,r clocks`);
  }
  for (const op of [0x8a, 0x8b]) {
    dispatch.addEntry('cycleCount', op, CC_MOD(2, 8), `MOV r,r/m clocks`);
  }
  dispatch.addEntry('cycleCount', 0xC6, CC_MOD(4, 10), `MOV r/m,imm8 clocks`);
  dispatch.addEntry('cycleCount', 0xC7, CC_MOD(4, 10), `MOV r/m,imm16 clocks`);
  for (let op = 0xB0; op <= 0xBF; op++) {
    dispatch.addEntry('cycleCount', op, CC(4), `MOV reg,imm clocks`);
  }
  for (let op = 0xA0; op <= 0xA3; op++) {
    dispatch.addEntry('cycleCount', op, CC(10), `MOV acc/mem clocks`);
  }
  dispatch.addEntry('cycleCount', 0x8C, CC_MOD(2, 9), `MOV r/m,seg clocks`);
  dispatch.addEntry('cycleCount', 0x8E, CC_MOD(2, 8), `MOV seg,r/m clocks`);

  // --- PUSH/POP ---
  for (let op = 0x50; op <= 0x57; op++) {
    dispatch.addEntry('cycleCount', op, CC(11), `PUSH reg clocks`);
  }
  for (const op of [0x06, 0x0E, 0x16, 0x1E]) {
    dispatch.addEntry('cycleCount', op, CC(10), `PUSH seg clocks`);
  }
  for (let op = 0x58; op <= 0x5F; op++) {
    dispatch.addEntry('cycleCount', op, CC(8), `POP reg clocks`);
  }
  for (const op of [0x07, 0x0F, 0x17, 0x1F]) {
    dispatch.addEntry('cycleCount', op, CC(8), `POP seg clocks`);
  }

  // --- XCHG ---
  dispatch.addEntry('cycleCount', 0x86, CC_MOD(3, 17), `XCHG r/m,r8 clocks`);
  dispatch.addEntry('cycleCount', 0x87, CC_MOD(3, 17), `XCHG r/m,r16 clocks`);
  for (let op = 0x91; op <= 0x97; op++) {
    dispatch.addEntry('cycleCount', op, CC(3), `XCHG AX,reg clocks`);
  }

  // --- XLAT ---
  dispatch.addEntry('cycleCount', 0xD7, CC(11), `XLAT clocks`);

  // --- IN/OUT ---
  dispatch.addEntry('cycleCount', 0xE4, CC(10), `IN AL,imm8 clocks`);
  dispatch.addEntry('cycleCount', 0xE5, CC(10), `IN AX,imm8 clocks`);
  dispatch.addEntry('cycleCount', 0xE6, CC(10), `OUT imm8,AL clocks`);
  dispatch.addEntry('cycleCount', 0xE7, CC(10), `OUT imm8,AX clocks`);
  dispatch.addEntry('cycleCount', 0xEC, CC(8), `IN AL,DX clocks`);
  dispatch.addEntry('cycleCount', 0xED, CC(8), `IN AX,DX clocks`);
  dispatch.addEntry('cycleCount', 0xEE, CC(8), `OUT DX,AL clocks`);
  dispatch.addEntry('cycleCount', 0xEF, CC(8), `OUT DX,AX clocks`);

  // --- LEA, LDS, LES ---
  dispatch.addEntry('cycleCount', 0x8D, CC(2), `LEA clocks`);
  dispatch.addEntry('cycleCount', 0xC5, CC(16), `LDS clocks`);
  dispatch.addEntry('cycleCount', 0xC4, CC(16), `LES clocks`);

  // --- LAHF/SAHF ---
  dispatch.addEntry('cycleCount', 0x9F, CC(4), `LAHF clocks`);
  dispatch.addEntry('cycleCount', 0x9E, CC(4), `SAHF clocks`);

  // --- PUSHF/POPF ---
  dispatch.addEntry('cycleCount', 0x9C, CC(10), `PUSHF clocks`);
  dispatch.addEntry('cycleCount', 0x9D, CC(8), `POPF clocks`);

  // --- ALU reg/mem (ADD, ADC, SUB, SBB, AND, OR, XOR, CMP) ---
  const aluOps = [
    [0x00, 0x01], [0x02, 0x03], // ADD
    [0x10, 0x11], [0x12, 0x13], // ADC
    [0x28, 0x29], [0x2A, 0x2B], // SUB
    [0x18, 0x19], [0x1A, 0x1B], // SBB
    [0x20, 0x21], [0x22, 0x23], // AND
    [0x08, 0x09], [0x0A, 0x0B], // OR
    [0x30, 0x31], [0x32, 0x33], // XOR
  ];
  for (const [op8, op16] of aluOps) {
    const d = (op8 >> 1) & 1;
    if (d === 0) {
      dispatch.addEntry('cycleCount', op8, CC_MOD(3, 16), `ALU r/m,r clocks`);
      dispatch.addEntry('cycleCount', op16, CC_MOD(3, 16), `ALU r/m,r clocks`);
    } else {
      dispatch.addEntry('cycleCount', op8, CC_MOD(3, 9), `ALU r,r/m clocks`);
      dispatch.addEntry('cycleCount', op16, CC_MOD(3, 9), `ALU r,r/m clocks`);
    }
  }

  // ALU acc,imm: 4 clocks
  for (const op of [0x04, 0x05, 0x14, 0x15, 0x2C, 0x2D, 0x1C, 0x1D,
                     0x24, 0x25, 0x0C, 0x0D, 0x34, 0x35]) {
    dispatch.addEntry('cycleCount', op, CC(4), `ALU acc,imm clocks`);
  }

  // CMP r/m (0x38-0x3B): mod==11?3:9
  for (const op of [0x38, 0x39, 0x3A, 0x3B]) {
    dispatch.addEntry('cycleCount', op, CC_MOD(3, 9), `CMP r/m clocks`);
  }
  dispatch.addEntry('cycleCount', 0x3C, CC(4), `CMP acc,imm clocks`);
  dispatch.addEntry('cycleCount', 0x3D, CC(4), `CMP acc,imm clocks`);

  // TEST r/m (0x84-0x85): mod==11?3:9
  dispatch.addEntry('cycleCount', 0x84, CC_MOD(3, 9), `TEST r/m clocks`);
  dispatch.addEntry('cycleCount', 0x85, CC_MOD(3, 9), `TEST r/m clocks`);
  dispatch.addEntry('cycleCount', 0xA8, CC(4), `TEST acc,imm clocks`);
  dispatch.addEntry('cycleCount', 0xA9, CC(4), `TEST acc,imm clocks`);

  // --- INC/DEC reg (0x40-0x4F): 2 clocks ---
  for (let op = 0x40; op <= 0x4F; op++) {
    dispatch.addEntry('cycleCount', op, CC(2), `INC/DEC reg clocks`);
  }

  // --- BCD ---
  dispatch.addEntry('cycleCount', 0x37, CC(4), `AAA clocks`);
  dispatch.addEntry('cycleCount', 0x27, CC(4), `DAA clocks`);
  dispatch.addEntry('cycleCount', 0x3F, CC(4), `AAS clocks`);
  dispatch.addEntry('cycleCount', 0x2F, CC(4), `DAS clocks`);
  dispatch.addEntry('cycleCount', 0xD4, CC(83), `AAM clocks`);
  dispatch.addEntry('cycleCount', 0xD5, CC(60), `AAD clocks`);

  // --- CBW/CWD ---
  dispatch.addEntry('cycleCount', 0x98, CC(2), `CBW clocks`);
  dispatch.addEntry('cycleCount', 0x99, CC(5), `CWD clocks`);

  // --- String ops (per-iteration cost) ---
  dispatch.addEntry('cycleCount', 0xA4, CC(17), `MOVSB clocks`);
  dispatch.addEntry('cycleCount', 0xA5, CC(17), `MOVSW clocks`);
  dispatch.addEntry('cycleCount', 0xA6, CC(22), `CMPSB clocks`);
  dispatch.addEntry('cycleCount', 0xA7, CC(22), `CMPSW clocks`);
  dispatch.addEntry('cycleCount', 0xAE, CC(15), `SCASB clocks`);
  dispatch.addEntry('cycleCount', 0xAF, CC(15), `SCASW clocks`);
  dispatch.addEntry('cycleCount', 0xAC, CC(13), `LODSB clocks`);
  dispatch.addEntry('cycleCount', 0xAD, CC(13), `LODSW clocks`);
  dispatch.addEntry('cycleCount', 0xAA, CC(10), `STOSB clocks`);
  dispatch.addEntry('cycleCount', 0xAB, CC(10), `STOSW clocks`);

  // --- CALL/RET ---
  dispatch.addEntry('cycleCount', 0xE8, CC(19), `CALL near clocks`);
  dispatch.addEntry('cycleCount', 0x9A, CC(28), `CALL far clocks`);
  dispatch.addEntry('cycleCount', 0xC3, CC(8), `RET clocks`);
  dispatch.addEntry('cycleCount', 0xC2, CC(12), `RET imm16 clocks`);
  dispatch.addEntry('cycleCount', 0xCB, CC(18), `RETF clocks`);
  dispatch.addEntry('cycleCount', 0xCA, CC(17), `RETF imm16 clocks`);

  // --- JMP ---
  dispatch.addEntry('cycleCount', 0xE9, CC(15), `JMP near clocks`);
  dispatch.addEntry('cycleCount', 0xEB, CC(15), `JMP short clocks`);
  dispatch.addEntry('cycleCount', 0xEA, CC(15), `JMP far clocks`);

  // --- Jcc (0x70-0x7F): use 16 (taken) as approximation ---
  for (let op = 0x70; op <= 0x7F; op++) {
    dispatch.addEntry('cycleCount', op, CC(16), `Jcc clocks`);
  }

  // --- LOOP/LOOPE/LOOPNE/JCXZ ---
  dispatch.addEntry('cycleCount', 0xE2, CC(17), `LOOP clocks`);
  dispatch.addEntry('cycleCount', 0xE1, CC(18), `LOOPE clocks`);
  dispatch.addEntry('cycleCount', 0xE0, CC(19), `LOOPNE clocks`);
  dispatch.addEntry('cycleCount', 0xE3, CC(18), `JCXZ clocks`);

  // --- INT/IRET ---
  dispatch.addEntry('cycleCount', 0xCD, CC(51), `INT clocks`);
  dispatch.addEntry('cycleCount', 0xCC, CC(52), `INT3 clocks`);
  dispatch.addEntry('cycleCount', 0xCE, CC(53), `INTO clocks`);
  dispatch.addEntry('cycleCount', 0xCF, CC(24), `IRET clocks`);

  // --- Flag manipulation ---
  for (const op of [0xF8, 0xF5, 0xF9, 0xFC, 0xFD, 0xFA, 0xFB]) {
    dispatch.addEntry('cycleCount', op, CC(2), `flag manip clocks`);
  }

  // --- HLT / NOP / WAIT ---
  dispatch.addEntry('cycleCount', 0xF4, CC(2), `HLT clocks`);
  dispatch.addEntry('cycleCount', 0x90, CC(3), `NOP clocks`);
  dispatch.addEntry('cycleCount', 0x9B, CC(3), `WAIT clocks`);

  // --- Shifts (0xD0-0xD3) ---
  dispatch.addEntry('cycleCount', 0xD0, CC_MOD(2, 15), `shift by 1 (byte) clocks`);
  dispatch.addEntry('cycleCount', 0xD1, CC_MOD(2, 15), `shift by 1 (word) clocks`);
  dispatch.addEntry('cycleCount', 0xD2, CC(20), `shift by CL (byte) clocks`);
  dispatch.addEntry('cycleCount', 0xD3, CC(20), `shift by CL (word) clocks`);

  // --- Group 80-83 (ALU imm to r/m) ---
  for (const op of [0x80, 0x81, 0x82, 0x83]) {
    dispatch.addEntry('cycleCount', op, CC_MOD(4, 17), `ALU imm,r/m clocks`);
  }

  // --- Group FE (INC/DEC r/m byte) ---
  dispatch.addEntry('cycleCount', 0xFE, CC_MOD(3, 15), `INC/DEC r/m8 clocks`);

  // --- Group FF ---
  dispatch.addEntry('cycleCount', 0xFF,
    `if(` +
    `style(--reg: 0): ${CC_MOD(3, 15)}; ` +
    `style(--reg: 1): ${CC_MOD(3, 15)}; ` +
    `style(--reg: 2): ${CC_MOD(16, 21)}; ` +
    `style(--reg: 3): ${CC(37)}; ` +
    `style(--reg: 4): ${CC_MOD(11, 18)}; ` +
    `style(--reg: 5): ${CC(24)}; ` +
    `style(--reg: 6): ${CC_MOD(11, 16)}; ` +
    `else: ${hold})`,
    `Group FF clocks`);

  // --- Group F6/F7 ---
  dispatch.addEntry('cycleCount', 0xF6,
    `if(` +
    `style(--reg: 0): ${CC_MOD(5, 11)}; ` +
    `style(--reg: 2): ${CC_MOD(3, 16)}; ` +
    `style(--reg: 3): ${CC_MOD(3, 16)}; ` +
    `style(--reg: 4): ${CC(70)}; ` +
    `style(--reg: 5): ${CC(80)}; ` +
    `style(--reg: 6): ${CC(80)}; ` +
    `style(--reg: 7): ${CC(101)}; ` +
    `else: ${hold})`,
    `Group F6 clocks`);
  dispatch.addEntry('cycleCount', 0xF7,
    `if(` +
    `style(--reg: 0): ${CC_MOD(5, 11)}; ` +
    `style(--reg: 2): ${CC_MOD(3, 16)}; ` +
    `style(--reg: 3): ${CC_MOD(3, 16)}; ` +
    `style(--reg: 4): ${CC(118)}; ` +
    `style(--reg: 5): ${CC(128)}; ` +
    `style(--reg: 6): ${CC(144)}; ` +
    `style(--reg: 7): ${CC(165)}; ` +
    `else: ${hold})`,
    `Group F7 clocks`);

  // --- POP r/m (0x8F) ---
  dispatch.addEntry('cycleCount', 0x8F, CC_MOD(8, 17), `POP r/m clocks`);
}
