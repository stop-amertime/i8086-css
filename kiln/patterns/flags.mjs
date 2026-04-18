// Flag computation @functions.
// CONSTRAINTS:
// 1. Max 7 local variables per function (Chrome limit)
// 2. No nested function calls as arguments
// 3. Total call-chain complexity limited (deep xor nesting fails)
//
// Strategy: use inline arithmetic for AF (avoid expensive --xor chains),
// use --subOF/--addOF helpers for OF, combine ZF+SF into one local.

const PARITY = [
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
];

// AF inline formulas (avoid calling --xor which is too deep):
// ADD AF: carry from bit 3→4: (lo_dst + lo_src) >= 16
const ADD_AF = (dst, src) =>
  `calc(round(down, max(0, sign(mod(${dst}, 16) + mod(${src}, 16) - 15.5)) + 0.5) * 16)`;
// SUB AF: borrow from bit 4→3: lo_dst < lo_src
const SUB_AF = (dst, src) =>
  `calc(round(down, max(0, sign(mod(${src}, 16) - mod(${dst}, 16) - 0.5)) + 0.5) * 16)`;
// INC AF: (dst & 0xF) == 0xF → res low nibble wraps from F to 0
const INC_AF = (dst) =>
  `if(style(--_nibble: 15): 16; else: 0)`;
// DEC AF: (dst & 0xF) == 0x0 → res low nibble wraps from 0 to F
const DEC_AF = (dst) =>
  `if(style(--_nibble: 0): 16; else: 0)`;

export function emitFlagFunctions() {
  return `
/* ===== FLAG COMPUTATION ===== */

@function --parity(--val <integer>) returns <integer> {
  --low8: --lowerBytes(var(--val), 8);
  result: if(
${PARITY.map((p, i) => `    style(--low8: ${i}): ${p * 4};`).join('\n')}
  else: 0);
}

/* OF helpers — arithmetic only, no --xor/--and (avoids Chrome nesting depth limit).
   ADD OF: signs same on inputs, different on result → overflow.
     OF = (1 - |sign_dst - sign_src|) * |sign_dst - sign_res|
   SUB OF: signs differ on inputs, result sign differs from dst → overflow.
     OF = |sign_dst - sign_src| * |sign_dst - sign_res|
*/

@function --addOF16(--dst <integer>, --src <integer>, --res <integer>) returns <integer> {
  --sd: --bit(var(--dst), 15);
  --ss: --bit(var(--src), 15);
  --sr: --bit(var(--res), 15);
  result: calc((1 - abs(var(--sd) - var(--ss))) * abs(var(--sd) - var(--sr)) * 2048);
}

@function --addOF8(--dst <integer>, --src <integer>, --res <integer>) returns <integer> {
  --sd: --bit(var(--dst), 7);
  --ss: --bit(var(--src), 7);
  --sr: --bit(var(--res), 7);
  result: calc((1 - abs(var(--sd) - var(--ss))) * abs(var(--sd) - var(--sr)) * 2048);
}

@function --subOF16(--dst <integer>, --src <integer>, --res <integer>) returns <integer> {
  --sd: --bit(var(--dst), 15);
  --ss: --bit(var(--src), 15);
  --sr: --bit(var(--res), 15);
  result: calc(abs(var(--sd) - var(--ss)) * abs(var(--sd) - var(--sr)) * 2048);
}

@function --subOF8(--dst <integer>, --src <integer>, --res <integer>) returns <integer> {
  --sd: --bit(var(--dst), 7);
  --ss: --bit(var(--src), 7);
  --sr: --bit(var(--res), 7);
  result: calc(abs(var(--sd) - var(--ss)) * abs(var(--sd) - var(--sr)) * 2048);
}

/* ===== ADD FLAGS (6 locals) ===== */

@function --addFlags16(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 16);
  --cf: min(1, round(down, var(--raw) / 65536));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 15) * 128);
  --of: --addOF16(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${ADD_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

@function --addFlags8(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 8);
  --cf: min(1, round(down, var(--raw) / 256));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 7) * 128);
  --of: --addOF8(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${ADD_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

/* ===== SUB FLAGS (6 locals) ===== */

@function --subFlags16(--dst <integer>, --src <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--dst) - var(--src) + 65536), 16);
  --cf: round(down, max(0, sign(calc(var(--src) - var(--dst) - 0.5))) + 0.5);
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 15) * 128);
  --of: --subOF16(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${SUB_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

@function --subFlags8(--dst <integer>, --src <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--dst) - var(--src) + 256), 8);
  --cf: round(down, max(0, sign(calc(var(--src) - var(--dst) - 0.5))) + 0.5);
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 7) * 128);
  --of: --subOF8(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${SUB_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

/* ===== LOGIC FLAGS (3 locals) ===== */

@function --logicFlags16(--res <integer>) returns <integer> {
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --logicFlags8(--res <integer>) returns <integer> {
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

/* ===== COMPOSITE LOGIC FLAGS (4-5 locals) ===== */

@function --orFlags16(--a <integer>, --b <integer>) returns <integer> {
  --res: --or(var(--a), var(--b));
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --orFlags8(--a <integer>, --b <integer>) returns <integer> {
  --full: --or(var(--a), var(--b));
  --res: --lowerBytes(var(--full), 8);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --andFlags16(--a <integer>, --b <integer>) returns <integer> {
  --res: --and(var(--a), var(--b));
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --andFlags8(--a <integer>, --b <integer>) returns <integer> {
  --full: --and(var(--a), var(--b));
  --res: --lowerBytes(var(--full), 8);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --xorFlags16(--a <integer>, --b <integer>) returns <integer> {
  --res: --xor(var(--a), var(--b));
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --xorFlags8(--a <integer>, --b <integer>) returns <integer> {
  --full: --xor(var(--a), var(--b));
  --res: --lowerBytes(var(--full), 8);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

/* ===== INC/DEC FLAGS (6 locals) ===== */

@function --incFlags16(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_nibble: mod(var(--dst), 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --of: if(style(--res: 32768): 2048; else: 0);
  --keep: --and(var(--oldFlags), 1792);
  result: calc(var(--cf) + var(--pf) + ${INC_AF('var(--dst)')} + var(--zf) + var(--sf) + var(--of) + var(--keep) + 2);
}

@function --decFlags16(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_nibble: mod(var(--dst), 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --of: if(style(--res: 32767): 2048; else: 0);
  --keep: --and(var(--oldFlags), 1792);
  result: calc(var(--cf) + var(--pf) + ${DEC_AF('var(--dst)')} + var(--zf) + var(--sf) + var(--of) + var(--keep) + 2);
}

@function --incFlags8(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_nibble: mod(var(--dst), 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --of: if(style(--res: 128): 2048; else: 0);
  --keep: --and(var(--oldFlags), 1792);
  result: calc(var(--cf) + var(--pf) + ${INC_AF('var(--dst)')} + var(--zf) + var(--sf) + var(--of) + var(--keep) + 2);
}

@function --decFlags8(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_nibble: mod(var(--dst), 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --of: if(style(--res: 127): 2048; else: 0);
  --keep: --and(var(--oldFlags), 1792);
  result: calc(var(--cf) + var(--pf) + ${DEC_AF('var(--dst)')} + var(--zf) + var(--sf) + var(--of) + var(--keep) + 2);
}

/* ===== ADC FLAGS (6 locals) ===== */

@function --adcFlags16(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src) + var(--carry));
  --res: --lowerBytes(var(--raw), 16);
  --cf: min(1, round(down, var(--raw) / 65536));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 15) * 128);
  --of: --addOF16(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${ADD_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

@function --adcFlags8(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src) + var(--carry));
  --res: --lowerBytes(var(--raw), 8);
  --cf: min(1, round(down, var(--raw) / 256));
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 7) * 128);
  --of: --addOF8(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${ADD_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

/* ===== SBB FLAGS (7 locals) ===== */

@function --sbbFlags16(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --total: calc(var(--src) + var(--carry));
  --res: --lowerBytes(calc(var(--dst) - var(--total) + 65536), 16);
  --cf: round(down, max(0, sign(calc(var(--total) - var(--dst) - 0.5))) + 0.5);
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 15) * 128);
  --of: --subOF16(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${SUB_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}

@function --sbbFlags8(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --total: calc(var(--src) + var(--carry));
  --res: --lowerBytes(calc(var(--dst) - var(--total) + 256), 8);
  --cf: round(down, max(0, sign(calc(var(--total) - var(--dst) - 0.5))) + 0.5);
  --pf: --parity(var(--res));
  --zfsf: calc(if(style(--res: 0): 64; else: 0) + --bit(var(--res), 7) * 128);
  --of: --subOF8(var(--dst), var(--src), var(--res));
  result: calc(var(--cf) + var(--pf) + ${SUB_AF('var(--dst)', 'var(--src)')} + var(--zfsf) + var(--of) + 2);
}
`;
}
