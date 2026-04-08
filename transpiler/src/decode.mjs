// Opcode fetch, prefix handling, ModR/M decode, EA computation.
// These are CSS @functions and computed properties emitted into the .cpu rule.

/**
 * Emit @function for ModR/M effective address computation.
 * Returns the linear (seg*16 + offset) address for a memory operand.
 *
 * In CSS we can't branch on segment override prefix dynamically,
 * so the segment is computed separately and passed in.
 */
export function emitDecodeFunction() {
  return `
/* ===== INSTRUCTION DECODE ===== */

/* ModR/M instruction length delta: how many extra bytes does the ModR/M consume?
   mod=00, rm=110: +2 (direct address)
   mod=01: +1 (8-bit displacement)
   mod=10: +2 (16-bit displacement)
   mod=11: +0 (register)
   otherwise: +0 */
@function --modrmLen(--mod <integer>, --rm <integer>) returns <integer> {
  result: if(
    style(--mod: 3): 0;
    style(--mod: 1): 1;
    style(--mod: 2): 2;
    style(--mod: 0) and style(--rm: 6): 2;
  else: 0);
}

/* Effective address offset (16-bit, before adding segment).
   Inputs: mod, rm, and the instruction bytes after ModR/M (disp8/disp16).
   disp8 = sign-extended byte at queue[2]
   disp16 = word at queue[2..3] */
@function --eaOffset(--mod <integer>, --rm <integer>,
                     --bx <integer>, --si <integer>, --di <integer>, --bp <integer>,
                     --disp8 <integer>, --disp16 <integer>) returns <integer> {
  --disp: if(
    style(--mod: 1): var(--disp8);
    style(--mod: 2): var(--disp16);
  else: 0);
  result: --lowerBytes(if(
    style(--mod: 0) and style(--rm: 6): var(--disp16);
    style(--rm: 0): calc(var(--bx) + var(--si) + var(--disp));
    style(--rm: 1): calc(var(--bx) + var(--di) + var(--disp));
    style(--rm: 2): calc(var(--bp) + var(--si) + var(--disp));
    style(--rm: 3): calc(var(--bp) + var(--di) + var(--disp));
    style(--rm: 4): calc(var(--si) + var(--disp));
    style(--rm: 5): calc(var(--di) + var(--disp));
    style(--rm: 6): calc(var(--bp) + var(--disp));
    style(--rm: 7): calc(var(--bx) + var(--disp));
  else: 0), 16);
}

/* Default segment for a ModR/M address: SS for BP-based, DS for everything else.
   Returns seg*16 for direct addition to EA offset. */
@function --defaultSeg(--mod <integer>, --rm <integer>,
                       --ds <integer>, --ss <integer>) returns <integer> {
  result: if(
    style(--mod: 3): 0;
    style(--rm: 2): calc(var(--ss) * 16);
    style(--rm: 3): calc(var(--ss) * 16);
    style(--mod: 0) and style(--rm: 6): calc(var(--ds) * 16);
    style(--rm: 6): calc(var(--ss) * 16);
  else: calc(var(--ds) * 16));
}

/* Read a register by index (word mode).
   reg: 0=AX, 1=CX, 2=DX, 3=BX, 4=SP, 5=BP, 6=SI, 7=DI */
@function --getReg16(--r <integer>,
                     --ax <integer>, --cx <integer>, --dx <integer>, --bx <integer>,
                     --sp <integer>, --bp <integer>, --si <integer>, --di <integer>) returns <integer> {
  result: if(
    style(--r: 0): var(--ax);
    style(--r: 1): var(--cx);
    style(--r: 2): var(--dx);
    style(--r: 3): var(--bx);
    style(--r: 4): var(--sp);
    style(--r: 5): var(--bp);
    style(--r: 6): var(--si);
    style(--r: 7): var(--di);
  else: 0);
}

/* Read a register by index (byte mode).
   reg: 0=AL, 1=CL, 2=DL, 3=BL, 4=AH, 5=CH, 6=DH, 7=BH */
@function --getReg8(--r <integer>,
                    --al <integer>, --cl <integer>, --dl <integer>, --bl <integer>,
                    --ah <integer>, --ch <integer>, --dh <integer>, --bh <integer>) returns <integer> {
  result: if(
    style(--r: 0): var(--al);
    style(--r: 1): var(--cl);
    style(--r: 2): var(--dl);
    style(--r: 3): var(--bl);
    style(--r: 4): var(--ah);
    style(--r: 5): var(--ch);
    style(--r: 6): var(--dh);
    style(--r: 7): var(--bh);
  else: 0);
}

/* Read a segment register by index.
   reg: 0=ES, 1=CS, 2=SS, 3=DS */
@function --getSegReg(--r <integer>,
                      --es <integer>, --cs <integer>, --ss <integer>, --ds <integer>) returns <integer> {
  result: if(
    style(--r: 0): var(--es);
    style(--r: 1): var(--cs);
    style(--r: 2): var(--ss);
    style(--r: 3): var(--ds);
  else: 0);
}

/* Read the R/M operand: if mod=11, read register; else read memory at EA.
   For word mode. */
@function --getRM16(--mod <integer>, --rm <integer>, --ea <integer>,
                    --ax <integer>, --cx <integer>, --dx <integer>, --bx <integer>,
                    --sp <integer>, --bp <integer>, --si <integer>, --di <integer>) returns <integer> {
  result: if(
    style(--mod: 3): --getReg16(var(--rm), var(--ax), var(--cx), var(--dx), var(--bx),
                                var(--sp), var(--bp), var(--si), var(--di));
  else: --read2(var(--ea)));
}

/* Read the R/M operand: byte mode. */
@function --getRM8(--mod <integer>, --rm <integer>, --ea <integer>,
                   --al <integer>, --cl <integer>, --dl <integer>, --bl <integer>,
                   --ah <integer>, --ch <integer>, --dh <integer>, --bh <integer>) returns <integer> {
  result: if(
    style(--mod: 3): --getReg8(var(--rm), var(--al), var(--cl), var(--dl), var(--bl),
                               var(--ah), var(--ch), var(--dh), var(--bh));
  else: --readMem(var(--ea)));
}
`;
}

/**
 * Emit the computed decode properties inside .cpu.
 * These extract opcode, ModR/M fields, EA, and operands.
 */
export function emitDecodeProperties() {
  // The instruction bytes are fetched relative to IP in the code segment.
  // queue[0] = opcode, queue[1] = ModR/M byte, queue[2..5] = subsequent bytes.
  //
  // For Phase 1 we handle the simple non-prefixed case.
  // Prefix handling (segment overrides, REP) will be added in Phase 3.
  return `
  /* ===== INSTRUCTION FETCH & DECODE ===== */

  /* Fetch instruction bytes from CS:IP */
  --csBase: calc(var(--__1CS) * 16);
  --ipAddr: calc(var(--csBase) + var(--__1IP));
  --q0: --readMem(var(--ipAddr));
  --q1: --readMem(calc(var(--ipAddr) + 1));
  --q2: --readMem(calc(var(--ipAddr) + 2));
  --q3: --readMem(calc(var(--ipAddr) + 3));
  --q4: --readMem(calc(var(--ipAddr) + 4));
  --q5: --readMem(calc(var(--ipAddr) + 5));

  /* Opcode (first non-prefix byte) */
  --opcode: var(--q0);

  /* d and w bits from opcode */
  --dBit: --rightShift(--and(var(--opcode), 2), 1);
  --wBit: --and(var(--opcode), 1);

  /* ModR/M decode */
  --mod: --rightShift(var(--q1), 6);
  --reg: --lowerBytes(--rightShift(var(--q1), 3), 3);
  --rm: --lowerBytes(var(--q1), 3);

  /* ModR/M instruction length (extra bytes consumed by ModR/M addressing) */
  --modrmExtra: --modrmLen(var(--mod), var(--rm));

  /* Displacement values for EA computation */
  --dispByte: var(--q2);
  --disp8: --u2s1(var(--q2));
  --disp16: calc(var(--q2) + var(--q3) * 256);

  /* Effective address computation */
  --eaSeg: --defaultSeg(var(--mod), var(--rm), var(--__1DS), var(--__1SS));
  --eaOff: --eaOffset(var(--mod), var(--rm),
    var(--__1BX), var(--__1SI), var(--__1DI), var(--__1BP),
    var(--disp8), var(--disp16));
  --ea: calc(var(--eaSeg) + var(--eaOff));

  /* Immediate values after ModR/M (position depends on modrmExtra) */
  /* immOff = 2 + modrmExtra (offset from opcode to first immediate byte) */
  --immOff: calc(2 + var(--modrmExtra));
  --immByte: --readMem(calc(var(--ipAddr) + var(--immOff)));
  --immWord: calc(--readMem(calc(var(--ipAddr) + var(--immOff))) + --readMem(calc(var(--ipAddr) + var(--immOff) + 1)) * 256);

  /* Operand reads for convenience */
  --rmVal8: --getRM8(var(--mod), var(--rm), var(--ea),
    var(--AL), var(--CL), var(--DL), var(--BL),
    var(--AH), var(--CH), var(--DH), var(--BH));
  --rmVal16: --getRM16(var(--mod), var(--rm), var(--ea),
    var(--__1AX), var(--__1CX), var(--__1DX), var(--__1BX),
    var(--__1SP), var(--__1BP), var(--__1SI), var(--__1DI));
  --regVal8: --getReg8(var(--reg),
    var(--AL), var(--CL), var(--DL), var(--BL),
    var(--AH), var(--CH), var(--DH), var(--BH));
  --regVal16: --getReg16(var(--reg),
    var(--__1AX), var(--__1CX), var(--__1DX), var(--__1BX),
    var(--__1SP), var(--__1BP), var(--__1SI), var(--__1DI));

  /* Immediate value at opcode+1 (for MOV reg,imm and other non-ModR/M immediates) */
  --imm8: var(--q1);
  --imm16: calc(var(--q1) + var(--q2) * 256);

  /* Carry flag extracted for ADC/SBB (avoids nested --bit() in dispatch expressions) */
  --_cf: --bit(var(--__1flags), 0);
`;
}
