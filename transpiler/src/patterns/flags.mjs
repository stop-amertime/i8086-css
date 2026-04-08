// Flag computation @functions.
// These mirror the JS emulator's flag-setting logic.
//
// IMPORTANT: Chrome's CSS @function implementation does NOT support passing
// a function call result directly as an argument to another function call.
// e.g. --xor(--xor(a, b), c) FAILS. You must use intermediate variables:
//   --t: --xor(a, b); then --xor(var(--t), c)

// Parity table for low 8 bits (1=even parity, 0=odd)
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

export function emitFlagFunctions() {
  return `
/* ===== FLAG COMPUTATION ===== */

@function --parity(--val <integer>) returns <integer> {
  --low8: --lowerBytes(var(--val), 8);
  result: if(
${PARITY.map((p, i) => `    style(--low8: ${i}): ${p * 4};`).join('\n')}
  else: 0);
}

/* ===== ADD FLAGS ===== */

@function --addFlags16(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 16);
  --_rs: --rightShift(var(--raw), 16);
  --cf: min(1, var(--_rs));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dsi: --xor(var(--_xor_ds), 65535);
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_dsi), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 15) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --addFlags8(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 8);
  --_rs: --rightShift(var(--raw), 8);
  --cf: min(1, var(--_rs));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dsi: --xor(var(--_xor_ds), 255);
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_dsi), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 7) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

/* ===== SUB FLAGS ===== */

@function --subFlags16(--dst <integer>, --src <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--dst) - var(--src) + 65536), 16);
  --_borrow_s: sign(calc(var(--src) - var(--dst) - 0.5));
  --_borrow_m: max(0, var(--_borrow_s));
  --cf: round(down, calc(var(--_borrow_m) + 0.5));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_ds), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 15) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --subFlags8(--dst <integer>, --src <integer>) returns <integer> {
  --res: --lowerBytes(calc(var(--dst) - var(--src) + 256), 8);
  --_borrow_s: sign(calc(var(--src) - var(--dst) - 0.5));
  --_borrow_m: max(0, var(--_borrow_s));
  --cf: round(down, calc(var(--_borrow_m) + 0.5));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_ds), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 7) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

/* ===== LOGIC FLAGS (AND/OR/XOR/TEST) ===== */

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

/* ===== COMPOSITE LOGIC FLAG FUNCTIONS ===== */
/* These combine a bitwise op + flag computation in one function,
   avoiding the nested function call limitation. */

@function --orFlags16(--a <integer>, --b <integer>) returns <integer> {
  --res: --or(var(--a), var(--b));
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

@function --orFlags8(--a <integer>, --b <integer>) returns <integer> {
  --_full: --or(var(--a), var(--b));
  --res: --lowerBytes(var(--_full), 8);
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
  --_full: --and(var(--a), var(--b));
  --res: --lowerBytes(var(--_full), 8);
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
  --_full: --xor(var(--a), var(--b));
  --res: --lowerBytes(var(--_full), 8);
  --pf: --parity(var(--res));
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  result: calc(var(--pf) + var(--zf) + var(--sf) + 2);
}

/* ===== INC/DEC FLAGS ===== */
/* Preserve CF from old flags. */

@function --incFlags16(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rd1: --xor(var(--_xor_rd), 1);
  --af: calc(--bit(var(--_xor_rd1), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --of: if(style(--res: 32768): 2048; else: 0);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --decFlags16(--dst <integer>, --res <integer>, --oldFlags <integer>) returns <integer> {
  --cf: --bit(var(--oldFlags), 0);
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rd1: --xor(var(--_xor_rd), 1);
  --af: calc(--bit(var(--_xor_rd1), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --of: if(style(--res: 32767): 2048; else: 0);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

/* ===== ADC FLAGS ===== */

@function --adcFlags16(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src) + var(--carry));
  --res: --lowerBytes(var(--raw), 16);
  --_rs: --rightShift(var(--raw), 16);
  --cf: min(1, var(--_rs));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dsi: --xor(var(--_xor_ds), 65535);
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_dsi), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 15) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --adcFlags8(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src) + var(--carry));
  --res: --lowerBytes(var(--raw), 8);
  --_rs: --rightShift(var(--raw), 8);
  --cf: min(1, var(--_rs));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dsi: --xor(var(--_xor_ds), 255);
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_dsi), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 7) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

/* ===== SBB FLAGS ===== */

@function --sbbFlags16(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --total: calc(var(--src) + var(--carry));
  --res: --lowerBytes(calc(var(--dst) - var(--total) + 65536), 16);
  --_borrow_s: sign(calc(var(--total) - var(--dst) - 0.5));
  --_borrow_m: max(0, var(--_borrow_s));
  --cf: round(down, calc(var(--_borrow_m) + 0.5));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_ds), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 15) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

@function --sbbFlags8(--dst <integer>, --src <integer>, --carry <integer>) returns <integer> {
  --total: calc(var(--src) + var(--carry));
  --res: --lowerBytes(calc(var(--dst) - var(--total) + 256), 8);
  --_borrow_s: sign(calc(var(--total) - var(--dst) - 0.5));
  --_borrow_m: max(0, var(--_borrow_s));
  --cf: round(down, calc(var(--_borrow_m) + 0.5));
  --pf: --parity(var(--res));
  --_xor_rd: --xor(var(--res), var(--dst));
  --_xor_rds: --xor(var(--_xor_rd), var(--src));
  --af: calc(--bit(var(--_xor_rds), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --_xor_ds: --xor(var(--dst), var(--src));
  --_xor_dr: --xor(var(--dst), var(--res));
  --_and_of: --and(var(--_xor_ds), var(--_xor_dr));
  --of: calc(--bit(var(--_and_of), 7) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}
`;
}
