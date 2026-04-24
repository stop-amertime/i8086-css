// opcode-names.mjs — map 8086 opcode bytes to human-readable names.
//
// Best-effort: for group opcodes (Grp 1/2/3/4/5 and the 80-83 family)
// we can't fully decode without the ModR/M byte, so we emit something
// like "GRP1 Eb,Ib (80)". That's usually enough for an agent to know
// what category of instruction failed.
//
// The intent is debug sugar, not a full disassembler. If a real
// disassembler is needed, feed the sidecar bytes into a standalone
// tool — this is for in-band annotation of divergence reports.

export function opcodeName(opcodeByte, secondByte = null) {
  const op = opcodeByte & 0xFF;
  const known = BASE_NAMES[op];
  if (known) return known;
  // Grouped opcodes need ModR/M.reg to pick within the group.
  if (op >= 0x80 && op <= 0x83 && secondByte != null) {
    const sub = (secondByte >> 3) & 7;
    const name = GROUP_ARITH[sub];
    return `${name} ${op === 0x80 || op === 0x82 ? 'Eb' : 'Ev'},${op === 0x81 ? 'Iv' : 'Ib'}`;
  }
  if ((op === 0xF6 || op === 0xF7) && secondByte != null) {
    const sub = (secondByte >> 3) & 7;
    return `GRP3 ${GROUP_F6F7[sub] ?? '?'} ${op === 0xF6 ? 'Eb' : 'Ev'}`;
  }
  if (op === 0xFF && secondByte != null) {
    const sub = (secondByte >> 3) & 7;
    return `GRP5 ${GROUP_FF[sub] ?? '?'}`;
  }
  if (op === 0xFE && secondByte != null) {
    const sub = (secondByte >> 3) & 7;
    return `GRP4 ${['INC','DEC','?','?','?','?','?','?'][sub]} Eb`;
  }
  if (op === 0xD0 || op === 0xD1 || op === 0xD2 || op === 0xD3) {
    if (secondByte != null) {
      const sub = (secondByte >> 3) & 7;
      return `${GROUP_SHIFT[sub]} ${op & 1 ? 'Ev' : 'Eb'},${op & 2 ? 'CL' : '1'}`;
    }
    return `GRP2 ${op & 1 ? 'Ev' : 'Eb'},${op & 2 ? 'CL' : '1'}`;
  }
  return `UNK(${op.toString(16).padStart(2, '0')})`;
}

const BASE_NAMES = {
  0x00: 'ADD Eb,Gb',   0x01: 'ADD Ev,Gv',   0x02: 'ADD Gb,Eb',   0x03: 'ADD Gv,Ev',
  0x04: 'ADD AL,Ib',   0x05: 'ADD AX,Iv',   0x06: 'PUSH ES',     0x07: 'POP ES',
  0x08: 'OR Eb,Gb',    0x09: 'OR Ev,Gv',    0x0A: 'OR Gb,Eb',    0x0B: 'OR Gv,Ev',
  0x0C: 'OR AL,Ib',    0x0D: 'OR AX,Iv',    0x0E: 'PUSH CS',     0x0F: '(extended)',
  0x10: 'ADC Eb,Gb',   0x11: 'ADC Ev,Gv',   0x12: 'ADC Gb,Eb',   0x13: 'ADC Gv,Ev',
  0x14: 'ADC AL,Ib',   0x15: 'ADC AX,Iv',   0x16: 'PUSH SS',     0x17: 'POP SS',
  0x18: 'SBB Eb,Gb',   0x19: 'SBB Ev,Gv',   0x1A: 'SBB Gb,Eb',   0x1B: 'SBB Gv,Ev',
  0x1C: 'SBB AL,Ib',   0x1D: 'SBB AX,Iv',   0x1E: 'PUSH DS',     0x1F: 'POP DS',
  0x20: 'AND Eb,Gb',   0x21: 'AND Ev,Gv',   0x22: 'AND Gb,Eb',   0x23: 'AND Gv,Ev',
  0x24: 'AND AL,Ib',   0x25: 'AND AX,Iv',   0x26: 'ES:',         0x27: 'DAA',
  0x28: 'SUB Eb,Gb',   0x29: 'SUB Ev,Gv',   0x2A: 'SUB Gb,Eb',   0x2B: 'SUB Gv,Ev',
  0x2C: 'SUB AL,Ib',   0x2D: 'SUB AX,Iv',   0x2E: 'CS:',         0x2F: 'DAS',
  0x30: 'XOR Eb,Gb',   0x31: 'XOR Ev,Gv',   0x32: 'XOR Gb,Eb',   0x33: 'XOR Gv,Ev',
  0x34: 'XOR AL,Ib',   0x35: 'XOR AX,Iv',   0x36: 'SS:',         0x37: 'AAA',
  0x38: 'CMP Eb,Gb',   0x39: 'CMP Ev,Gv',   0x3A: 'CMP Gb,Eb',   0x3B: 'CMP Gv,Ev',
  0x3C: 'CMP AL,Ib',   0x3D: 'CMP AX,Iv',   0x3E: 'DS:',         0x3F: 'AAS',
  0x40: 'INC AX',      0x41: 'INC CX',      0x42: 'INC DX',      0x43: 'INC BX',
  0x44: 'INC SP',      0x45: 'INC BP',      0x46: 'INC SI',      0x47: 'INC DI',
  0x48: 'DEC AX',      0x49: 'DEC CX',      0x4A: 'DEC DX',      0x4B: 'DEC BX',
  0x4C: 'DEC SP',      0x4D: 'DEC BP',      0x4E: 'DEC SI',      0x4F: 'DEC DI',
  0x50: 'PUSH AX',     0x51: 'PUSH CX',     0x52: 'PUSH DX',     0x53: 'PUSH BX',
  0x54: 'PUSH SP',     0x55: 'PUSH BP',     0x56: 'PUSH SI',     0x57: 'PUSH DI',
  0x58: 'POP AX',      0x59: 'POP CX',      0x5A: 'POP DX',      0x5B: 'POP BX',
  0x5C: 'POP SP',      0x5D: 'POP BP',      0x5E: 'POP SI',      0x5F: 'POP DI',
  0x60: 'PUSHA',       0x61: 'POPA',        0x62: 'BOUND',       0x63: 'ARPL',
  0x68: 'PUSH Iv',     0x69: 'IMUL Gv,Ev,Iv',0x6A: 'PUSH Ib',    0x6B: 'IMUL Gv,Ev,Ib',
  0x6C: 'INSB',        0x6D: 'INSW',        0x6E: 'OUTSB',       0x6F: 'OUTSW',
  0x70: 'JO',  0x71: 'JNO', 0x72: 'JB',   0x73: 'JNB', 0x74: 'JZ',  0x75: 'JNZ',
  0x76: 'JBE', 0x77: 'JA',  0x78: 'JS',   0x79: 'JNS', 0x7A: 'JP',  0x7B: 'JNP',
  0x7C: 'JL',  0x7D: 'JNL', 0x7E: 'JLE',  0x7F: 'JG',
  0x80: 'GRP1 Eb,Ib',  0x81: 'GRP1 Ev,Iv',  0x82: 'GRP1 Eb,Ib',  0x83: 'GRP1 Ev,Ib',
  0x84: 'TEST Eb,Gb',  0x85: 'TEST Ev,Gv',  0x86: 'XCHG Eb,Gb',  0x87: 'XCHG Ev,Gv',
  0x88: 'MOV Eb,Gb',   0x89: 'MOV Ev,Gv',   0x8A: 'MOV Gb,Eb',   0x8B: 'MOV Gv,Ev',
  0x8C: 'MOV Ew,Sw',   0x8D: 'LEA Gv,M',    0x8E: 'MOV Sw,Ew',   0x8F: 'POP Ev',
  0x90: 'NOP',         0x91: 'XCHG CX,AX',  0x92: 'XCHG DX,AX',  0x93: 'XCHG BX,AX',
  0x94: 'XCHG SP,AX',  0x95: 'XCHG BP,AX',  0x96: 'XCHG SI,AX',  0x97: 'XCHG DI,AX',
  0x98: 'CBW',         0x99: 'CWD',         0x9A: 'CALL Ap',     0x9B: 'WAIT',
  0x9C: 'PUSHF',       0x9D: 'POPF',        0x9E: 'SAHF',        0x9F: 'LAHF',
  0xA0: 'MOV AL,Ob',   0xA1: 'MOV AX,Ov',   0xA2: 'MOV Ob,AL',   0xA3: 'MOV Ov,AX',
  0xA4: 'MOVSB',       0xA5: 'MOVSW',       0xA6: 'CMPSB',       0xA7: 'CMPSW',
  0xA8: 'TEST AL,Ib',  0xA9: 'TEST AX,Iv',  0xAA: 'STOSB',       0xAB: 'STOSW',
  0xAC: 'LODSB',       0xAD: 'LODSW',       0xAE: 'SCASB',       0xAF: 'SCASW',
  0xB0: 'MOV AL,Ib',   0xB1: 'MOV CL,Ib',   0xB2: 'MOV DL,Ib',   0xB3: 'MOV BL,Ib',
  0xB4: 'MOV AH,Ib',   0xB5: 'MOV CH,Ib',   0xB6: 'MOV DH,Ib',   0xB7: 'MOV BH,Ib',
  0xB8: 'MOV AX,Iv',   0xB9: 'MOV CX,Iv',   0xBA: 'MOV DX,Iv',   0xBB: 'MOV BX,Iv',
  0xBC: 'MOV SP,Iv',   0xBD: 'MOV BP,Iv',   0xBE: 'MOV SI,Iv',   0xBF: 'MOV DI,Iv',
  0xC2: 'RET Iw',      0xC3: 'RET',         0xC4: 'LES Gv,Mp',   0xC5: 'LDS Gv,Mp',
  0xC6: 'MOV Eb,Ib',   0xC7: 'MOV Ev,Iv',
  0xC8: 'ENTER',       0xC9: 'LEAVE',       0xCA: 'RETF Iw',     0xCB: 'RETF',
  0xCC: 'INT3',        0xCD: 'INT Ib',      0xCE: 'INTO',        0xCF: 'IRET',
  0xE0: 'LOOPNZ',      0xE1: 'LOOPZ',       0xE2: 'LOOP',        0xE3: 'JCXZ',
  0xE4: 'IN AL,Ib',    0xE5: 'IN AX,Ib',    0xE6: 'OUT Ib,AL',   0xE7: 'OUT Ib,AX',
  0xE8: 'CALL Jv',     0xE9: 'JMP Jv',      0xEA: 'JMP Ap',      0xEB: 'JMP Jb',
  0xEC: 'IN AL,DX',    0xED: 'IN AX,DX',    0xEE: 'OUT DX,AL',   0xEF: 'OUT DX,AX',
  0xF0: 'LOCK',        0xF2: 'REPNE',       0xF3: 'REP',         0xF4: 'HLT',
  0xF5: 'CMC',         0xF8: 'CLC',         0xF9: 'STC',         0xFA: 'CLI',
  0xFB: 'STI',         0xFC: 'CLD',         0xFD: 'STD',
};

const GROUP_ARITH = ['ADD','OR','ADC','SBB','AND','SUB','XOR','CMP'];
const GROUP_F6F7  = ['TEST','TEST','NOT','NEG','MUL','IMUL','DIV','IDIV'];
const GROUP_FF    = ['INC Ev','DEC Ev','CALL Ev','CALL Mp','JMP Ev','JMP Mp','PUSH Ev','?'];
const GROUP_SHIFT = ['ROL','ROR','RCL','RCR','SHL','SHR','?','SAR'];

// Decode a single instruction starting at linear addr. Reads up to 6
// bytes from the ref memory image. Returns a small record describing the
// instruction — used by fulldiff to annotate divergence reports.
export function disassembleAt(mem, linearAddr) {
  const bytes = [];
  for (let i = 0; i < 6; i++) bytes.push(mem[(linearAddr + i) & 0xFFFFF] & 0xFF);
  // Strip up to 4 prefix bytes so we hit the primary opcode.
  const prefixes = [];
  let i = 0;
  for (; i < 4; i++) {
    const b = bytes[i];
    if (b === 0xF0 || b === 0xF2 || b === 0xF3 ||
        b === 0x26 || b === 0x2E || b === 0x36 || b === 0x3E) {
      prefixes.push(b);
    } else break;
  }
  const op = bytes[i];
  const next = bytes[i + 1];
  const name = opcodeName(op, next);
  return {
    linear: linearAddr,
    bytes,
    bytesHex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
    prefixes,
    prefixesHex: prefixes.map(b => b.toString(16).padStart(2, '0')).join(' '),
    opcode: op,
    opcodeHex: op.toString(16).padStart(2, '0'),
    name,
  };
}
