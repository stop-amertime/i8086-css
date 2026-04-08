// Flag computation @functions.
// These mirror the JS emulator's flag-setting logic.

// Flag bit positions (same as 8086)
// CF=0x0001(bit0), PF=0x0004(bit2), AF=0x0010(bit4),
// ZF=0x0040(bit6), SF=0x0080(bit7), TF=0x0100(bit8),
// IF=0x0200(bit9), DF=0x0400(bit10), OF=0x0800(bit11)

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

/* Parity of low 8 bits via lookup dispatch.
   Returns 4 (PF bit) if even parity, 0 otherwise. */
@function --parity(--val <integer>) returns <integer> {
  --low8: --lowerBytes(var(--val), 8);
  result: if(
${PARITY.map((p, i) => `    style(--low8: ${i}): ${p * 4};`).join('\n')}
  else: 0);
}

/* ADD flags (16-bit): CF, PF, AF, ZF, SF, OF
   dst + src = res (before masking)
   CF: res > 0xFFFF (unsigned overflow)
   AF: (res ^ dst ^ src) & 0x10
   OF: (dst ^ src ^ 0xFFFF) & (dst ^ res) & 0x8000
   ZF: (res & 0xFFFF) == 0
   SF: (res >> 15) & 1
   PF: parity of low 8 bits of res */
@function --addFlags16(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 16);
  --cf: if(style(--_cf_check: 1): 1; else: 0);
  --_cf_check: round(down, var(--raw) / 65536);
  --cf: min(1, --rightShift(var(--raw), 16));
  --pf: --parity(var(--res));
  --af: calc(--bit(--xor(--xor(var(--res), var(--dst)), var(--src)), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 15) * 128);
  --of: calc(--bit(--and(--xor(--xor(var(--dst), var(--src)), 65535), --xor(var(--dst), var(--res))), 15) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}

/* ADD flags (8-bit) */
@function --addFlags8(--dst <integer>, --src <integer>) returns <integer> {
  --raw: calc(var(--dst) + var(--src));
  --res: --lowerBytes(var(--raw), 8);
  --cf: min(1, --rightShift(var(--raw), 8));
  --pf: --parity(var(--res));
  --af: calc(--bit(--xor(--xor(var(--res), var(--dst)), var(--src)), 4) * 16);
  --zf: if(style(--res: 0): 64; else: 0);
  --sf: calc(--bit(var(--res), 7) * 128);
  --of: calc(--bit(--and(--xor(--xor(var(--dst), var(--src)), 255), --xor(var(--dst), var(--res))), 7) * 2048);
  result: calc(var(--cf) + var(--pf) + var(--af) + var(--zf) + var(--sf) + var(--of) + 2);
}
`;
}
