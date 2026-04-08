// Utility @function definitions ported from legacy/base_template.css
// These are proven to work in Chrome. Emitted verbatim.

export function emitCSSLib() {
  return `
/* ===== UTILITY @FUNCTIONS ===== */

@function --lowerBytes(--a <integer>, --b <integer>) returns <integer> {
  result: mod(var(--a), pow(2, var(--b)));
}

@function --rightShift(--a <integer>, --b <integer>) returns <integer> {
  result: round(down, var(--a) / pow(2, var(--b)));
}

@function --leftShift(--a <integer>, --b <integer>) returns <integer> {
  --shift: if(
    style(--b:0):1;
    style(--b:1):2;
    style(--b:2):4;
    style(--b:3):8;
    style(--b:4):16;
    style(--b:5):32;
    style(--b:6):64;
    style(--b:7):128;
    style(--b:8):256;
    style(--b:9):512;
    style(--b:10):1024;
    style(--b:11):2048;
    style(--b:12):4096;
    style(--b:13):8192;
    style(--b:14):16384;
    style(--b:15):32768;
  else:calc(var(--a) * pow(2, var(--b))));
  result: calc(var(--a) * var(--shift));
}

@function --int(--i <integer>) returns <integer> {
  result: var(--i);
}

@function --u2s1(--u <integer>) returns <integer> {
  result: calc(var(--u) - round(down, var(--u) / 128) * 256);
}

@function --u2s2(--u <integer>) returns <integer> {
  result: calc(var(--u) - max(0, round(down, var(--u) / 32768)) * 65536);
}

@function --bit(--val <integer>, --idx <integer>) returns <integer> {
  result: mod(--rightShift(var(--val), var(--idx)), 2);
}

/* ===== BITWISE @FUNCTIONS ===== */

${emitBitwiseXor()}

${emitBitwiseAnd()}

${emitBitwiseOr()}

${emitBitwiseNot()}

/* ===== 8-BIT BITWISE WRAPPERS ===== */
/* Chrome can't nest function calls as arguments, so these provide
   pre-composed 8-bit variants of the bitwise ops. */

@function --or8(--a <integer>, --b <integer>) returns <integer> {
  --full: --or(var(--a), var(--b));
  result: --lowerBytes(var(--full), 8);
}

@function --and8(--a <integer>, --b <integer>) returns <integer> {
  --full: --and(var(--a), var(--b));
  result: --lowerBytes(var(--full), 8);
}

@function --xor8(--a <integer>, --b <integer>) returns <integer> {
  --full: --xor(var(--a), var(--b));
  result: --lowerBytes(var(--full), 8);
}

/* ===== BYTE MERGE @FUNCTIONS ===== */

@function --mergelow(--old <integer>, --new <integer>) returns <integer> {
  result: calc(round(down, var(--old) / 256) * 256 + --lowerBytes(var(--new), 8));
}

@function --mergehigh(--old <integer>, --new <integer>) returns <integer> {
  result: calc(var(--new) * 256 + --lowerBytes(var(--old), 8));
}

/* ===== READ HELPERS ===== */

@function --read2(--at <integer>) returns <integer> {
  result: calc(--readMem(var(--at)) + --readMem(calc(var(--at) + 1)) * 256);
}
`;
}

// Generate a 16-bit bitwise function with per-bit decomposition
function emitBitDecomp(name, bitExpr) {
  const lines = [];
  lines.push(`@function --${name}(--a <integer>, --b <integer>) returns <integer> {`);
  // Decompose a into bits
  for (let i = 1; i <= 16; i++) {
    const div = Math.pow(2, i - 1);
    lines.push(i === 1
      ? `  --a1: mod(var(--a), 2);`
      : `  --a${i}: mod(round(down, var(--a) / ${div}), 2);`);
  }
  // Decompose b into bits
  for (let i = 1; i <= 16; i++) {
    const div = Math.pow(2, i - 1);
    lines.push(i === 1
      ? `  --b1: mod(var(--b), 2);`
      : `  --b${i}: mod(round(down, var(--b) / ${div}), 2);`);
  }
  // Combine
  const terms = [];
  for (let i = 1; i <= 16; i++) {
    const mult = i === 1 ? '' : ` * ${Math.pow(2, i - 1)}`;
    const expr = bitExpr(i);
    terms.push(i === 1 ? `    ${expr}` : `    calc(${expr})${mult}`);
  }
  lines.push(`  result: calc(`);
  lines.push(terms.join(' +\n'));
  lines.push(`  );`);
  lines.push(`}`);
  return lines.join('\n');
}

function emitBitwiseXor() {
  // XOR: a ^ b = a + b - 2*a*b (per bit)
  return emitBitDecomp('xor', i =>
    `min(1, var(--a${i}) + var(--b${i})) - var(--a${i}) * var(--b${i})`
  );
}

function emitBitwiseAnd() {
  // AND: a & b = a * b (per bit)
  return emitBitDecomp('and', i =>
    `var(--a${i}) * var(--b${i})`
  );
}

function emitBitwiseOr() {
  // OR: a | b = a + b - a*b (per bit)
  return emitBitDecomp('or', i =>
    `min(1, var(--a${i}) + var(--b${i}))`
  );
}

function emitBitwiseNot() {
  const lines = [];
  lines.push(`@function --not(--a <integer>) returns <integer> {`);
  for (let i = 1; i <= 16; i++) {
    const div = Math.pow(2, i - 1);
    lines.push(i === 1
      ? `  --a1: mod(var(--a), 2);`
      : `  --a${i}: mod(round(down, var(--a) / ${div}), 2);`);
  }
  const terms = [];
  for (let i = 1; i <= 16; i++) {
    const mult = i === 1 ? '' : ` * ${Math.pow(2, i - 1)}`;
    terms.push(`    (1 - var(--a${i}))${mult}`);
  }
  lines.push(`  result: calc(`);
  lines.push(terms.join(' +\n'));
  lines.push(`  );`);
  lines.push(`}`);
  return lines.join('\n');
}
