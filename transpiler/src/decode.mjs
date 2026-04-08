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
 *
 * Prefix handling:
 *   Up to 2 prefix bytes are detected before the opcode:
 *   - Segment overrides: 0x26 (ES), 0x2E (CS), 0x36 (SS), 0x3E (DS)
 *   - REP prefixes: 0xF2 (REPNE), 0xF3 (REP/REPE)
 *   The instruction queue (q0-q5) is shifted to always start at the opcode,
 *   so existing dispatch emitters work unchanged. The IP dispatch is wrapped
 *   in calc(... + prefixLen) by the DispatchTable to account for prefix bytes.
 */
export function emitDecodeProperties() {
  return `
  /* ===== INSTRUCTION FETCH & DECODE ===== */

  /* Raw fetch: up to 8 bytes from CS:IP (enough for 2 prefix + 6-byte instruction) */
  --csBase: calc(var(--__1CS) * 16);
  --ipAddr: calc(var(--csBase) + var(--__1IP));
  --raw0: --readMem(var(--ipAddr));
  --raw1: --readMem(calc(var(--ipAddr) + 1));
  --raw2: --readMem(calc(var(--ipAddr) + 2));
  --raw3: --readMem(calc(var(--ipAddr) + 3));
  --raw4: --readMem(calc(var(--ipAddr) + 4));
  --raw5: --readMem(calc(var(--ipAddr) + 5));
  --raw6: --readMem(calc(var(--ipAddr) + 6));
  --raw7: --readMem(calc(var(--ipAddr) + 7));

  /* ===== PREFIX DETECTION ===== */
  /* A byte is a prefix if it's one of: 0x26(ES) 0x2E(CS) 0x36(SS) 0x3E(DS) 0xF2(REPNE) 0xF3(REP)
     We detect whether raw0 and raw1 are prefixes to compute prefixLen (0, 1, or 2). */
  --isPrefix0: if(
    style(--raw0: 38): 1;
    style(--raw0: 46): 1;
    style(--raw0: 54): 1;
    style(--raw0: 62): 1;
    style(--raw0: 242): 1;
    style(--raw0: 243): 1;
  else: 0);
  --isPrefix1: if(
    style(--isPrefix0: 0): 0;
    style(--raw1: 38): 1;
    style(--raw1: 46): 1;
    style(--raw1: 54): 1;
    style(--raw1: 62): 1;
    style(--raw1: 242): 1;
    style(--raw1: 243): 1;
  else: 0);
  --prefixLen: calc(var(--isPrefix0) + var(--isPrefix1));

  /* Segment override: check prefix bytes for 0x26/0x2E/0x36/0x3E.
     Value is the segment register * 16, or 0 for "no override".
     Check raw0 first, then raw1 (later prefix wins, matching 8086 behavior). */
  --segOverride: if(
    style(--isPrefix1: 1) and style(--raw1: 38): calc(var(--__1ES) * 16);
    style(--isPrefix1: 1) and style(--raw1: 46): calc(var(--__1CS) * 16);
    style(--isPrefix1: 1) and style(--raw1: 54): calc(var(--__1SS) * 16);
    style(--isPrefix1: 1) and style(--raw1: 62): calc(var(--__1DS) * 16);
    style(--isPrefix0: 1) and style(--raw0: 38): calc(var(--__1ES) * 16);
    style(--isPrefix0: 1) and style(--raw0: 46): calc(var(--__1CS) * 16);
    style(--isPrefix0: 1) and style(--raw0: 54): calc(var(--__1SS) * 16);
    style(--isPrefix0: 1) and style(--raw0: 62): calc(var(--__1DS) * 16);
  else: 0);
  /* Flag: 1 if a segment override prefix is active */
  --hasSegOverride: if(
    style(--isPrefix0: 1) and style(--raw0: 38): 1;
    style(--isPrefix0: 1) and style(--raw0: 46): 1;
    style(--isPrefix0: 1) and style(--raw0: 54): 1;
    style(--isPrefix0: 1) and style(--raw0: 62): 1;
    style(--isPrefix1: 1) and style(--raw1: 38): 1;
    style(--isPrefix1: 1) and style(--raw1: 46): 1;
    style(--isPrefix1: 1) and style(--raw1: 54): 1;
    style(--isPrefix1: 1) and style(--raw1: 62): 1;
  else: 0);

  /* REP prefix: 0=none, 1=REP/REPE (0xF3), 2=REPNE (0xF2).
     Check raw0 first, then raw1 (later wins). */
  --repType: if(
    style(--isPrefix1: 1) and style(--raw1: 243): 1;
    style(--isPrefix1: 1) and style(--raw1: 242): 2;
    style(--isPrefix0: 1) and style(--raw0: 243): 1;
    style(--isPrefix0: 1) and style(--raw0: 242): 2;
  else: 0);
  --hasREP: min(1, var(--repType));

  /* ===== PREFIX-ADJUSTED INSTRUCTION QUEUE ===== */
  /* q0 = opcode (at IP + prefixLen), q1 = ModR/M byte, q2-q5 = subsequent bytes.
     This shifting means all existing dispatch emitters work without modification. */
  --q0: if(style(--prefixLen: 0): var(--raw0); style(--prefixLen: 1): var(--raw1); else: var(--raw2));
  --q1: if(style(--prefixLen: 0): var(--raw1); style(--prefixLen: 1): var(--raw2); else: var(--raw3));
  --q2: if(style(--prefixLen: 0): var(--raw2); style(--prefixLen: 1): var(--raw3); else: var(--raw4));
  --q3: if(style(--prefixLen: 0): var(--raw3); style(--prefixLen: 1): var(--raw4); else: var(--raw5));
  --q4: if(style(--prefixLen: 0): var(--raw4); style(--prefixLen: 1): var(--raw5); else: var(--raw6));
  --q5: if(style(--prefixLen: 0): var(--raw5); style(--prefixLen: 1): var(--raw6); else: var(--raw7));

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

  /* Effective address computation.
     If a segment override prefix is active, use the override segment instead of default. */
  --eaSegDefault: --defaultSeg(var(--mod), var(--rm), var(--__1DS), var(--__1SS));
  --eaSeg: if(style(--hasSegOverride: 1): var(--segOverride); else: var(--eaSegDefault));
  --eaOff: --eaOffset(var(--mod), var(--rm),
    var(--__1BX), var(--__1SI), var(--__1DI), var(--__1BP),
    var(--disp8), var(--disp16));
  --ea: calc(var(--eaSeg) + var(--eaOff));

  /* Immediate values after ModR/M (position depends on modrmExtra).
     immOff = prefixLen + 2 + modrmExtra (offset from raw ipAddr). */
  --immOff: calc(var(--prefixLen) + 2 + var(--modrmExtra));
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

  /* Zero flag extracted for conditional branches */
  --_zf: --bit(var(--__1flags), 6);

  /* Pre-computed CX-1 for LOOP instruction (avoids nested function call) */
  --_loopCX: --lowerBytes(calc(var(--__1CX) - 1 + 65536), 16);

  /* Pre-computed segment register value by reg field (for MOV r/m16, segreg) */
  --segRegVal: --getSegReg(var(--reg), var(--__1ES), var(--__1CS), var(--__1SS), var(--__1DS));

  /* Pre-computed stack word reads for POP/IRET (avoids nested --and(--read2(...))) */
  --_stackBase: calc(var(--__1SS) * 16 + var(--__1SP));
  --_stackWord0: --read2(var(--_stackBase));
  --_stackWord2: --read2(calc(var(--_stackBase) + 4));

  /* Pre-computed signed operands for IMUL (avoids deep nesting in dispatch) */
  --_sAX: calc(var(--__1AX) - --bit(var(--__1AX), 15) * 65536);
  --_sRM16: calc(var(--rmVal16) - --bit(var(--rmVal16), 15) * 65536);
  --_imulProd16: calc(var(--_sAX) * var(--_sRM16));
  --_sAL: calc(var(--AL) - --bit(var(--AL), 7) * 256);
  --_sRM8: calc(var(--rmVal8) - --bit(var(--rmVal8), 7) * 256);
  --_imulProd8: calc(var(--_sAL) * var(--_sRM8));

  /* REP execution state:
     --_repActive: 1 when hasREP=1 AND CX>0 (should execute string op this tick)
     --_repContinue: 1 when hasREP=1 AND CX>1 (should re-execute next tick)
     When hasREP=1 and CX=0, the string op is skipped entirely. */
  --_repActive: calc(var(--hasREP) * min(1, var(--__1CX)));
  --_repContinue: calc(var(--hasREP) * min(1, max(0, calc(var(--__1CX) - 1))));

  /* Pre-computed ZF for REPE/REPNE with comparison string ops.
     This is needed because IP and flags are computed in parallel — IP can't read
     the new ZF from the flags dispatch. Instead, we compute whether the comparison
     result is zero (operands equal) directly from the source operands.
     CMPSB (0xA6=166): mem[DS:SI] - mem[ES:DI]
     CMPSW (0xA7=167): word[DS:SI] - word[ES:DI]
     SCASB (0xAE=174): AL - mem[ES:DI]
     SCASW (0xAF=175): AX - word[ES:DI]
     --_repZF = 1 when the comparison result would be zero (ZF=1). */
  --_cmpDiff: if(
    style(--opcode: 166): calc(--readMem(calc(var(--_strSrcSeg) + var(--__1SI))) - --readMem(calc(var(--__1ES) * 16 + var(--__1DI))));
    style(--opcode: 167): calc(--read2(calc(var(--_strSrcSeg) + var(--__1SI))) - --read2(calc(var(--__1ES) * 16 + var(--__1DI))));
    style(--opcode: 174): calc(var(--AL) - --readMem(calc(var(--__1ES) * 16 + var(--__1DI))));
    style(--opcode: 175): calc(var(--__1AX) - --read2(calc(var(--__1ES) * 16 + var(--__1DI))));
  else: 1);
  --_repZF: if(style(--_cmpDiff: 0): 1; else: 0);

  /* Source segment for string operations (DS:SI).
     Segment override affects the source segment but NOT the destination (ES:DI). */
  --_strSrcSeg: if(style(--hasSegOverride: 1): var(--segOverride); else: calc(var(--__1DS) * 16));

  /* Pre-computed CL shift count for D2/D3 (shift by CL) */
  --_clMasked: --lowerBytes(var(--CL), 5);
  --_pow2CL: --pow2(var(--_clMasked));
  /* pow2(width - CL) for rotates: pow2(16 - cl) and pow2(8 - cl) */
  --_pow2inv16: --pow2(calc(16 - var(--_clMasked)));
  --_pow2inv8: --pow2(calc(8 - var(--_clMasked)));
  /* CF bit index for SHL: bit (width - CL) of original value */
  --_shlCFidx16: max(0, calc(16 - var(--_clMasked)));
  --_shlCFidx8: max(0, calc(8 - var(--_clMasked)));
`;
}
